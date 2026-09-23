'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 1024 * 1024;
const MAX_DISPLAY_TEXT = 256 * 1024;

const DEFAULT_TOOL_TIMEOUT_SEC = 30 * 60;
const MAX_DENIAL_REASON = 200;

// Tool name plus a short provider reason. Never tool input: it can carry task text or context.
function denialText(tool, reason) {
  const name = typeof tool === 'string' && tool ? tool.slice(0, 120) : 'unknown tool';
  const short = typeof reason === 'string' && reason ? reason.replace(/\s+/g, ' ').trim().slice(0, MAX_DENIAL_REASON) : 'permission denied';
  return `${name}: ${short}`;
}

// Cursor CLI has no per-process MCP config flag; `--plugin-dir` loads a local plugin whose mcp.json can define
// servers. Write that plugin into a private temporary directory (never the project or ~/.cursor) and remove it
// when the process ends. Cursor names plugin tools `plugin-<plugin dir basename>-<server>-<tool>` (observed), so
// both names are fixed: a resumed chat sees the same tool names, and a user-owned allow rule can name them.
const CURSOR_PLUGIN_DIR = 'agent-rooms';
const CURSOR_SERVER = 'agent_rooms';
function writeCursorPlugin(tempRoot, server) {
  const parent = fs.mkdtempSync(path.join(tempRoot, 'agent-rooms-cursor-'));
  const dir = path.join(parent, CURSOR_PLUGIN_DIR);
  fs.mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'agent-rooms', version: '0.1.0' }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { [CURSOR_SERVER]: server } }), { mode: 0o600 });
  return { parent, dir };
}

// Cursor stream-json tool calls (observed): `tool_call.started` carries `{ <kind>ToolCall: { args: { toolName } } }`;
// the matching `tool_call.completed` (same call_id) carries only `{ <kind>ToolCall: { result: { rejected: { reason } } } }`
// when the user's permission mode does not allow the tool.
function cursorToolName(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  for (const [kind, value] of Object.entries(toolCall)) {
    if (!kind.endsWith('ToolCall')) continue;
    if (typeof value?.args?.toolName === 'string' && value.args.toolName) return value.args.toolName;
    return kind.replace(/ToolCall$/, '');
  }
  return null;
}
function cursorRejection(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  for (const [kind, value] of Object.entries(toolCall)) {
    const rejected = value?.result?.rejected;
    if (!kind.endsWith('ToolCall') || !rejected || typeof rejected !== 'object') continue;
    return { tool: cursorToolName(toolCall), reason: typeof rejected.reason === 'string' ? rejected.reason : 'rejected' };
  }
  return null;
}

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

function cliRunner({ executableFor, spawnProcess = spawn, bridgeExecutable = process.execPath, environmentFor, toolTimeoutSec = DEFAULT_TOOL_TIMEOUT_SEC, tempRoot = os.tmpdir() } = {}) {
  if (typeof executableFor !== 'function') throw new TypeError('executableFor required');
  return {
    run({ provider, cwd, text, providerSessionId, signal, bridge, onOutput, onPermissionDenied = () => {}, roomTools = {} }) {
      const executable = executableFor(provider);
      if (!executable) throw new Error(`${provider} CLI is not installed`);
      if (!bridge) throw new Error('Room MCP bridge unavailable');
      const bridgeName = `agent_rooms_${bridge.sessionId.replaceAll('-', '_')}`;
      const bridgeScript = path.join(__dirname, 'room-mcp-bridge.mjs');
      // Only this room's own bridge tools, and room_spawn only when the room allows spawning.
      const roomToolNames = roomTools.allowSpawn === true ? ['room_send', 'room_spawn'] : ['room_send'];
      const bridgeEnv = {
        ELECTRON_RUN_AS_NODE: '1',
        AGENT_ROOMS_BRIDGE_PORT: String(bridge.port),
        AGENT_ROOMS_BRIDGE_TOKEN: bridge.token,
        AGENT_ROOMS_PEERS: JSON.stringify(bridge.peers),
        // The bridge registers only these tools, so providers without a per-tool filter never see room_spawn
        // unless the room allows it. The broker enforces the policy regardless.
        AGENT_ROOMS_TOOLS: roomToolNames.join(','),
      };
      const tomlTable = (values) => `{${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`;
      const preapprove = roomTools.preapprove === true;
      let args;
      let pluginDir;
      const removePlugin = () => {
        if (!pluginDir) return;
        try { fs.rmSync(pluginDir, { recursive: true, force: true }); } catch {}
        pluginDir = undefined;
      };
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
      } else if (provider === 'cursor') {
        // Print mode without --force: file changes are proposed, not applied, and the user's Cursor permission
        // config still governs tools. No documented per-process per-tool allow rule exists, so room-tool
        // pre-approval is not applied for Cursor; --approve-mcps would approve every configured server.
        // The prompt is argv after `--` (no documented stdin prompt input); spawn uses no shell.
        const plugin = writeCursorPlugin(tempRoot, { command: bridgeExecutable, args: [bridgeScript], env: bridgeEnv });
        pluginDir = plugin.parent;
        args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--plugin-dir', plugin.dir,
          ...(providerSessionId ? ['--resume', providerSessionId] : []), '--', text];
      } else throw new TypeError('Invalid provider');
      return new Promise((resolve, reject) => {
        // Never start a provider process for a task that was already cancelled.
        if (signal?.aborted) {
          removePlugin();
          reject(signal.reason instanceof Error ? signal.reason : new Error('Agent task cancelled'));
          return;
        }
        let child;
        try {
          child = spawnProcess(executable, args, {
            cwd, env: environmentFor ? environmentFor(executable) : { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
          });
        } catch (error) { removePlugin(); reject(error); return; }
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let buffer = '';
        let stderr = '';
        let sessionId = providerSessionId;
        let finalText;
        let streamedText = false;
        // Text streamed in separate assistant segments (e.g. a preamble before a tool call and the answer after
        // it) arrives with no separator; mark the boundary so the display gets a paragraph break, not "back.Always".
        let segmentBreak = false;
        const streamDelta = (delta) => {
          if (delta.length > MAX_DISPLAY_TEXT) { providerError = new Error('Provider text chunk exceeded display limit'); return; }
          const text = segmentBreak ? '\n\n' + delta.replace(/^\s+/, '') : delta;
          segmentBreak = false;
          streamedText = true;
          onOutput(text);
        };
        let providerError;
        let turnCompleted = false;
        let settled = false;
        const denied = new Set();
        const cursorTools = new Map();
        const deny = (id, tool, reason) => {
          const key = id || tool;
          if (key && denied.has(key)) return;
          if (key) denied.add(key);
          try { onPermissionDenied(denialText(tool, reason)); } catch {}
        };
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
        // The plugin dir (with this task's bridge token) must outlive the process, so remove it only on exit.
        child.on('close', removePlugin);
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
            // Each new content block (text after a tool_use, or a later message) starts a new segment.
            if (item.type === 'stream_event' && item.event?.type === 'content_block_start' && streamedText) segmentBreak = true;
            const delta = item.type === 'stream_event' && item.event?.delta?.type === 'text_delta' ? item.event.delta.text : null;
            if (typeof delta === 'string' && delta) streamDelta(delta);
            if (item.type === 'system' && item.subtype === 'permission_denied') deny(item.tool_use_id, item.tool_name, item.message);
            if (item.type === 'result' && Array.isArray(item.permission_denials))
              for (const d of item.permission_denials) deny(d?.tool_use_id, d?.tool_name);
            if (item.type === 'result') {
              if (item.is_error) providerError = new Error(typeof item.result === 'string' ? item.result : 'Claude task failed');
              if (typeof item.result === 'string') finalText = item.result;
            }
          } else if (provider === 'cursor') {
            if (typeof item.session_id === 'string' && item.session_id) sessionId = item.session_id;
            // With --stream-partial-output, deltas carry timestamp_ms; the buffered flush before a tool call
            // (model_call_id) and the final complete assistant message repeat already-streamed text.
            if (item.type === 'assistant' && typeof item.timestamp_ms === 'number' && item.model_call_id === undefined) {
              const delta = (item.message?.content || []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
              if (delta) streamDelta(delta);
            }
            // The pre-tool flush (model_call_id) and tool calls end the current text segment.
            if (streamedText && ((item.type === 'assistant' && item.model_call_id !== undefined) || item.type === 'tool_call'))
              segmentBreak = true;
            if (item.type === 'tool_call' && item.subtype === 'started' && typeof item.call_id === 'string' && cursorTools.size < 256)
              cursorTools.set(item.call_id, cursorToolName(item.tool_call));
            if (item.type === 'tool_call' && item.subtype === 'completed') {
              const rejection = cursorRejection(item.tool_call);
              if (rejection) deny(item.call_id, (typeof item.call_id === 'string' && cursorTools.get(item.call_id)) || rejection.tool, rejection.reason);
              cursorTools.delete(item.call_id);
            }
            if (item.type === 'result') {
              if (item.is_error) providerError = new Error(typeof item.result === 'string' && item.result ? item.result : 'Cursor task failed');
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
          // Workspace trust is the user's decision; never pass --trust/--force on their behalf.
          if (provider === 'cursor' && code !== 0 && stderr.includes('Workspace Trust Required')) {
            reject(new Error('Cursor has not trusted this folder yet. Open a Cursor terminal session in this room and answer its workspace trust prompt, then retry.'));
            return;
          }
          if (code !== 0) { reject(new Error(`${provider} exited ${sig || code}: ${stderr.slice(-1200)}`)); return; }
          if (provider === 'codex' && !turnCompleted) { reject(new Error('Codex turn did not complete')); return; }
          if (!sessionId || typeof finalText !== 'string') { reject(new Error(`${provider} did not return a complete structured result`)); return; }
          if (finalText.length > MAX_DISPLAY_TEXT) { reject(new Error('Provider final text exceeded display limit')); return; }
          if ((provider === 'claude' || provider === 'cursor') && !streamedText && finalText) onOutput(finalText);
          resolve({ text: finalText, providerSessionId: sessionId });
        });
        child.stdin.on('error', (error) => fail(error));
        child.stdin.end(text);
      });
    },
  };
}

module.exports = { cliRunner, providerMessage, denialText };
