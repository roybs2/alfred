'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 1024 * 1024;
const MAX_DISPLAY_TEXT = 256 * 1024;

const DEFAULT_TOOL_TIMEOUT_SEC = 30 * 60;

// Codex wraps upstream API errors as a JSON string inside `message`; surface the readable inner message.
function providerMessage(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    const parsed = JSON.parse(value);
    const inner = parsed?.error?.message || parsed?.message;
    if (typeof inner === 'string' && inner) return inner;
  } catch {}
  return value;
}

function cliRunner({ executableFor, spawnProcess = spawn, bridgeExecutable = process.execPath, environmentFor, toolTimeoutSec = DEFAULT_TOOL_TIMEOUT_SEC } = {}) {
  if (typeof executableFor !== 'function') throw new TypeError('executableFor required');
  return {
    run({ provider, cwd, text, providerSessionId, signal, bridge, onOutput, roomTools = {} }) {
      const executable = executableFor(provider);
      if (!executable) throw new Error(`${provider} CLI is not installed`);
      if (!bridge) throw new Error('Room MCP bridge unavailable');
      const bridgeName = `agent_rooms_${bridge.sessionId.replaceAll('-', '_')}`;
      const bridgeScript = path.join(__dirname, 'room-mcp-bridge.mjs');
      const bridgeEnv = {
        ELECTRON_RUN_AS_NODE: '1',
        AGENT_ROOMS_BRIDGE_PORT: String(bridge.port),
        AGENT_ROOMS_BRIDGE_TOKEN: bridge.token,
        AGENT_ROOMS_PEERS: JSON.stringify(bridge.peers),
      };
      const tomlTable = (values) => `{${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`;
      // Only this room's own bridge tools, and room_spawn only when the room allows spawning.
      const roomToolNames = roomTools.allowSpawn === true ? ['room_send', 'room_spawn'] : ['room_send'];
      const preapprove = roomTools.preapprove === true;
      let args;
      if (provider === 'claude') {
        const config = { mcpServers: { [bridgeName]: {
          command: bridgeExecutable,
          args: [bridgeScript],
          env: bridgeEnv,
        } } };
        args = ['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
          '--include-partial-messages',
          '--mcp-config', JSON.stringify(config), '--strict-mcp-config'];
        // Documented exact-name allow rules; user/managed deny and ask rules still take precedence.
        if (preapprove) args.push('--allowedTools', roomToolNames.map((tool) => `mcp__${bridgeName}__${tool}`).join(','));
        if (providerSessionId) args.push('--resume', providerSessionId);
      } else if (provider === 'codex') {
        const overrides = [
          `mcp_servers.${bridgeName}.command=${JSON.stringify(bridgeExecutable)}`,
          `mcp_servers.${bridgeName}.args=${JSON.stringify([bridgeScript])}`,
          `mcp_servers.${bridgeName}.env=${tomlTable(bridgeEnv)}`,
          `mcp_servers.${bridgeName}.required=true`,
          // room_send/room_spawn block until the delegated task finishes; Codex's default MCP tool timeout is 60s.
          `mcp_servers.${bridgeName}.tool_timeout_sec=${toolTimeoutSec}`,
          `mcp_servers.${bridgeName}.enabled_tools=${JSON.stringify(roomToolNames)}`,
          // Per-tool approval override for this bridge server only; the session approval_policy still applies.
          ...(preapprove ? roomToolNames.map((tool) => `mcp_servers.${bridgeName}.tools.${tool}.approval_mode="approve"`) : []),
        ];
        args = ['exec', ...(providerSessionId ? ['resume'] : []), '--json',
          ...overrides.flatMap((value) => ['-c', value]),
          ...(providerSessionId ? [providerSessionId] : []), '-'];
      } else throw new TypeError('Invalid provider');
      return new Promise((resolve, reject) => {
        // Never start a provider process for a task that was already cancelled.
        if (signal?.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Agent task cancelled'));
          return;
        }
        let child;
        try {
          child = spawnProcess(executable, args, {
            cwd, env: environmentFor ? environmentFor(executable) : { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
          });
        } catch (error) { reject(error); return; }
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let buffer = '';
        let stderr = '';
        let sessionId = providerSessionId;
        let finalText;
        let streamedText = false;
        let providerError;
        let turnCompleted = false;
        let settled = false;
        let killTimer;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          try { child.kill('SIGTERM'); } catch {}
          killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
          killTimer.unref?.();
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
          fail(signal.reason instanceof Error ? signal.reason : new Error('Agent task cancelled'));
        };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        child.on('error', fail);
        child.stderr.on('data', (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes > MAX_ERROR_BYTES) { fail(new Error('Provider error output exceeded limit')); return; }
          stderr += chunk.toString('utf8');
        });
        function event(line) {
          if (!line.trim()) return;
          let item;
          try { item = JSON.parse(line); } catch { providerError = new Error('Provider emitted invalid JSONL'); return; }
          if (provider === 'claude') {
            if (item.session_id) sessionId = item.session_id;
            if (item.type === 'system' && item.subtype === 'init') {
              const failed = (Array.isArray(item.mcp_server_errors) && item.mcp_server_errors.some((s) => String(s).includes(bridgeName))) ||
                (Array.isArray(item.mcp_servers) && item.mcp_servers.some((s) => s?.name === bridgeName && s.status && s.status !== 'connected'));
              const missing = !Array.isArray(item.mcp_servers) || !item.mcp_servers.some((s) => s?.name === bridgeName);
              // Stop before the model turn: the room tools would be unavailable and the turn would still be billed.
              if (failed || missing) { fail(new Error('Room MCP bridge failed to initialize')); return; }
            }
            const delta = item.type === 'stream_event' && item.event?.delta?.type === 'text_delta' ? item.event.delta.text : null;
            if (typeof delta === 'string' && delta) {
              if (delta.length > MAX_DISPLAY_TEXT) providerError = new Error('Provider text chunk exceeded display limit');
              else { streamedText = true; onOutput(delta); }
            }
            if (item.type === 'result') {
              if (item.is_error) providerError = new Error(typeof item.result === 'string' ? item.result : 'Claude task failed');
              if (typeof item.result === 'string') finalText = item.result;
            }
          } else {
            if (item.type === 'thread.started' && item.thread_id) sessionId = item.thread_id;
            if (item.type === 'item.completed' && item.item?.type === 'agent_message' && typeof item.item.text === 'string') {
              if (item.item.text.length > MAX_DISPLAY_TEXT) providerError = new Error('Provider text exceeded display limit');
              else { finalText = item.item.text; onOutput(item.item.text); }
            }
            if (item.type === 'turn.failed' || item.type === 'error')
              providerError = new Error(providerMessage(item.error?.message || item.message, 'Codex task failed'));
            if (item.type === 'turn.completed') turnCompleted = true;
          }
        }
        child.stdout.on('data', (chunk) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > MAX_OUTPUT_BYTES) { fail(new Error('Provider structured output exceeded limit')); return; }
          buffer += chunk.toString('utf8');
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            event(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        });
        child.on('close', (code, sig) => {
          if (killTimer) clearTimeout(killTimer);
          if (settled) return;
          settled = true;
          cleanup();
          if (buffer) event(buffer);
          if (providerError) { reject(providerError); return; }
          if (provider === 'codex' && code !== 0 && stderr.includes('required MCP servers failed to initialize') && stderr.includes(bridgeName)) {
            reject(new Error('Room MCP bridge failed to initialize'));
            return;
          }
          if (code !== 0) { reject(new Error(`${provider} exited ${sig || code}: ${stderr.slice(-1200)}`)); return; }
          if (provider === 'codex' && !turnCompleted) { reject(new Error('Codex turn did not complete')); return; }
          if (!sessionId || typeof finalText !== 'string') { reject(new Error(`${provider} did not return a complete structured result`)); return; }
          if (finalText.length > MAX_DISPLAY_TEXT) { reject(new Error('Provider final text exceeded display limit')); return; }
          if (provider === 'claude' && !streamedText && finalText) onOutput(finalText);
          resolve({ text: finalText, providerSessionId: sessionId });
        });
        child.stdin.on('error', (error) => fail(error));
        child.stdin.end(text);
      });
    },
  };
}

module.exports = { cliRunner, providerMessage };
