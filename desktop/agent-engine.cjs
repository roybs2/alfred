'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const MAX_TEXT = 256 * 1024;
const MAX_AGENTS = 12;
const MAX_QUEUED_TASKS = 16;
const MAX_DEPTH = 4;
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const PROVIDERS = ['claude', 'codex', 'cursor'];
const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
const MAX_DENIAL_TEXT = 300;

// Provider-reported usage only (never estimated by Alfred). All fields optional; each present one must be a
// finite non-negative number.
function validUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const { costUsd, inputTokens, outputTokens, ...rest } = usage;
  if (Object.keys(rest).length) return false;
  for (const value of [costUsd, inputTokens, outputTokens])
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return false;
  return costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined;
}

function nonempty(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0'))
    throw new TypeError(`Invalid ${label}`);
  return value;
}

class AgentEngine {
  constructor({ runner, emit = () => {}, timeoutMs = TASK_TIMEOUT_MS, bridge = null }) {
    this.runner = runner;
    this.emit = emit;
    this.timeoutMs = timeoutMs;
    this.bridge = bridge;
    this.sessions = new Map();
    this.rooms = new Map();
    this.waits = new Map();
  }

  setBridge(bridge) { this.bridge = bridge; }

  // preapproveRoomTools: the owner explicitly lets managed agents call this room's own room_send/room_spawn
  // tools without a provider permission prompt. It never widens any other tool permission. Off by default.
  setRoomPolicy({ roomId, allowSpawn, maxAgents, preapproveRoomTools = false }) {
    nonempty(roomId, 'room id', 80);
    if (typeof allowSpawn !== 'boolean' || typeof preapproveRoomTools !== 'boolean' ||
      !Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > MAX_AGENTS)
      throw new TypeError('Invalid room policy');
    const room = this.rooms.get(roomId) || { cwd: null, policy: { allowSpawn: false, maxAgents: 4, preapproveRoomTools: false } };
    const count = [...this.sessions.values()].filter((s) => s.roomId === roomId).length;
    if (count > maxAgents) throw new Error('Room already exceeds maxAgents');
    room.policy = { allowSpawn, maxAgents, preapproveRoomTools };
    this.rooms.set(roomId, room);
    return { roomId, ...room.policy };
  }

  createSession({ roomId, provider, cwd, name }, { spawnedBy = null } = {}) {
    nonempty(roomId, 'room id', 80);
    if (!PROVIDERS.includes(provider)) throw new TypeError('Invalid provider');
    nonempty(cwd, 'working directory', 4096);
    if (name !== undefined) nonempty(name, 'agent name', 80);
    const room = this.rooms.get(roomId) || { cwd: null, policy: { allowSpawn: false, maxAgents: 4, preapproveRoomTools: false } };
    if (room.cwd && room.cwd !== cwd) throw new Error('Room working directory mismatch');
    if (spawnedBy && !room.policy.allowSpawn) throw new Error('Room agent spawning is disabled');
    if ([...this.sessions.values()].filter((s) => s.roomId === roomId).length >= room.policy.maxAgents)
      throw new Error('Room agent limit reached');
    if (!room.cwd) room.cwd = cwd;
    this.rooms.set(roomId, room);
    const id = crypto.randomUUID();
    const session = { id, roomId, provider, name: name || `${PROVIDER_LABELS[provider]} ${id.slice(0, 8)}`, status: 'idle' };
    const item = { ...session, cwd, queue: [], active: null, providerSessionId: null, token: null };
    this.sessions.set(id, item);
    this.emit({ type: 'session-created', sessionId: id, roomId, session });
    return session;
  }

  // Renaming changes the live address agents use to reach this session (resolveDestination reads
  // session.name from the same session object), so this is the single source of truth for names —
  // never a display-only rename in the UI.
  renameSession(id, name) {
    const session = this.sessions.get(nonempty(id, 'session id', 80));
    if (!session) throw new Error('Unknown managed agent session');
    nonempty(name, 'agent name', 80);
    const trimmed = name.trim();
    if (!trimmed.length) throw new TypeError('Invalid agent name');
    const collision = [...this.sessions.values()].some(
      (s) => s.id !== id && s.roomId === session.roomId && s.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (collision) throw new Error('Another agent in this room already uses that name');
    session.name = trimmed;
    this.emit({ type: 'session-renamed', sessionId: id, roomId: session.roomId, name: trimmed });
    return { id, name: trimmed };
  }

  getRoomSessions(roomId) {
    return [...this.sessions.values()].filter((s) => s.roomId === roomId).map(({ id, name, provider, status }) => ({ id, name, provider, status }));
  }

  resolveDestination(source, to) {
    nonempty(to, 'destination', 80);
    const matches = [...this.sessions.values()].filter((s) => s.roomId === source.roomId && (s.id === to || s.name === to));
    if (matches.length === 1) return matches[0];
    const peers = this.getRoomSessions(source.roomId).map((s) => `${s.name} (${s.id})`).join(', ');
    throw new Error(matches.length ? `Ambiguous destination. Use session ID. Room agents: ${peers}` : `Unknown destination. Room agents: ${peers || 'none'}`);
  }

  runTask({ sessionId, text }) {
    const session = this.sessions.get(nonempty(sessionId, 'session id', 80));
    if (!session) throw new Error('Unknown managed agent session');
    return { taskId: this.enqueue(session, nonempty(text, 'task text'), 0).id };
  }

  enqueue(session, text, depth) {
    nonempty(text, 'task text');
    if (session.queue.length >= MAX_QUEUED_TASKS) throw new Error('Agent task queue is full');
    const id = crypto.randomUUID();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const task = { id, text, depth, promise, resolve, reject, settled: false, controller: null };
    session.queue.push(task);
    queueMicrotask(() => this.pump(session));
    return task;
  }

  finish(task, error, text) {
    if (task.settled) return;
    task.settled = true;
    if (error) task.reject(error); else task.resolve(text);
  }

  async pump(session) {
    if (session.active || !this.sessions.has(session.id)) return;
    const task = session.queue.shift();
    if (!task) return;
    session.active = task;
    session.status = 'running';
    session.token = crypto.randomBytes(32).toString('hex');
    task.controller = new AbortController();
    this.emit({ type: 'task-started', sessionId: session.id, roomId: session.roomId, taskId: task.id, text: task.text });
    const timer = setTimeout(() => this.cancelTask(session, task, new Error('Agent task timed out')), this.timeoutMs);
    task.controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    try {
      const bridge = this.bridge ? await this.bridge.start() : null;
      // The task may have been stopped while the broker was starting; never launch a provider for it.
      if (task.settled || task.controller.signal.aborted) return;
      const policy = this.rooms.get(session.roomId)?.policy;
      const result = await this.runner.run({
        provider: session.provider, cwd: session.cwd, text: task.text,
        roomTools: { allowSpawn: policy?.allowSpawn === true, preapprove: policy?.preapproveRoomTools === true },
        providerSessionId: session.providerSessionId, signal: task.controller.signal,
        bridge: bridge && { ...bridge, token: session.token, sessionId: session.id, roomId: session.roomId,
          peers: this.getRoomSessions(session.roomId) },
        onOutput: (text) => {
          if (!task.settled && this.sessions.get(session.id) === session)
            this.emit({ type: 'output', sessionId: session.id, roomId: session.roomId, taskId: task.id, text });
        },
        // Provider-reported tool permission denials: tool name and the provider's short reason only.
        onPermissionDenied: (text) => {
          if (task.settled || this.sessions.get(session.id) !== session || typeof text !== 'string' || !text) return;
          this.emit({ type: 'permission-denied', sessionId: session.id, roomId: session.roomId, taskId: task.id,
            text: text.slice(0, MAX_DENIAL_TEXT) });
        },
      });
      if (task.settled) return;
      if (task.controller.signal.aborted) throw task.controller.signal.reason || new Error('Agent task cancelled');
      if (!result || typeof result.text !== 'string' || !result.providerSessionId)
        throw new Error('Provider did not return a complete structured result');
      const usage = validUsage(result.usage) ? result.usage : undefined;
      session.providerSessionId = result.providerSessionId;
      this.finish(task, null, result.text);
      // usage is included only when the provider actually reported it (see agent-runner.cjs usageFrom); never estimated.
      const completed = { type: 'task-completed', sessionId: session.id, roomId: session.roomId, taskId: task.id, text: result.text };
      if (usage) completed.usage = usage;
      this.emit(completed);
    } catch (error) {
      if (task.settled) return;
      this.finish(task, error);
      if (this.sessions.get(session.id) === session)
        this.emit({ type: 'task-failed', sessionId: session.id, roomId: session.roomId, taskId: task.id, text: error.message || String(error) });
    } finally {
      clearTimeout(timer);
      if (session.active === task) session.active = null;
      session.token = null;
      if (this.sessions.get(session.id) === session) {
        session.status = 'idle';
        queueMicrotask(() => this.pump(session));
      }
    }
  }

  cancelTask(session, task, error) {
    if (task.settled) return;
    const queued = session.queue.indexOf(task);
    if (queued >= 0) session.queue.splice(queued, 1);
    this.finish(task, error);
    task.controller?.abort(error);
    if (this.sessions.get(session.id) === session)
      this.emit({ type: 'task-failed', sessionId: session.id, roomId: session.roomId, taskId: task.id, text: error.message });
  }

  stopSession(id) {
    const session = this.sessions.get(nonempty(id, 'session id', 80));
    if (!session) return;
    this.sessions.delete(id);
    if (![...this.sessions.values()].some((s) => s.roomId === session.roomId)) {
      const room = this.rooms.get(session.roomId);
      if (room) room.cwd = null;
    }
    for (const task of session.queue.splice(0)) {
      this.finish(task, new Error('Agent session stopped'));
      this.emit({ type: 'task-failed', sessionId: id, roomId: session.roomId, taskId: task.id, text: 'Agent session stopped' });
    }
    if (session.active) {
      this.finish(session.active, new Error('Agent session stopped'));
      session.active.controller?.abort(new Error('Agent session stopped'));
      this.emit({ type: 'task-failed', sessionId: id, roomId: session.roomId, taskId: session.active.id, text: 'Agent session stopped' });
    }
    this.waits.delete(id);
    for (const targets of this.waits.values()) targets.delete(id);
    this.emit({ type: 'session-stopped', sessionId: id, roomId: session.roomId });
  }

  stopAll() { for (const id of [...this.sessions.keys()]) this.stopSession(id); this.bridge?.close(); }

  verifyToken(token) {
    if (typeof token !== 'string') return null;
    const candidate = Buffer.from(token);
    return [...this.sessions.values()].find((s) => {
      if (!s.active || !s.token) return false;
      const expected = Buffer.from(s.token);
      return candidate.length === expected.length && crypto.timingSafeEqual(expected, candidate);
    }) || null;
  }

  hasPath(from, to, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of this.waits.get(from)?.keys() || []) if (this.hasPath(next, to, seen)) return true;
    return false;
  }

  async toolCall(source, tool, args) {
    if (this.sessions.get(source.id) !== source || !source.active) throw new Error('No active source task');
    const room = this.rooms.get(source.roomId);
    if (!room) throw new Error('Unknown room');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Invalid tool arguments');
    const taskText = nonempty(args.task, 'task text');
    const context = args.context === undefined ? undefined : nonempty(args.context, 'context');
    // Fixed deterministic line, part of the delivery envelope (see decisions.md): tells the receiving agent
    // its plain final answer is how it replies, since it has no other channel back to the sender. Task/context
    // text itself is never rewritten.
    const delivered = `From room agent ${source.name} (${source.id}), task ${source.active.id}.\n` +
      `Reply with your result as your final answer; it is returned to the sender automatically.\n\nTask:\n${taskText}` +
      (context === undefined ? '' : `\n\nContext:\n${context}`);
    nonempty(delivered, 'combined task and context');
    const nextDepth = source.active.depth + 1;
    if (nextDepth > MAX_DEPTH) throw new Error('Maximum collaboration depth reached');
    let target;
    let spawned = false;
    if (tool === 'room_send') {
      target = this.resolveDestination(source, args.to);
    } else if (tool === 'room_spawn') {
      if (!room.policy.allowSpawn) throw new Error('Room agent spawning is disabled');
      if (!PROVIDERS.includes(args.provider)) throw new TypeError('Invalid provider');
      target = this.createSession({ roomId: source.roomId, cwd: source.cwd, provider: args.provider, name: args.name }, { spawnedBy: source.id });
      target = this.sessions.get(target.id);
      spawned = true;
    } else throw new Error('Unknown room tool');
    if (this.hasPath(target.id, source.id)) throw new Error('Collaboration dependency cycle');
    // Count concurrent calls per target so one finishing call does not hide another pending edge.
    let waiting = this.waits.get(source.id);
    if (!waiting) this.waits.set(source.id, waiting = new Map());
    waiting.set(target.id, (waiting.get(target.id) || 0) + 1);
    const sourceTask = source.active;
    let childTask;
    const cancelChild = () => {
      if (spawned) this.stopSession(target.id);
      else if (childTask) this.cancelTask(target, childTask, new Error('Source task cancelled'));
    };
    try {
      childTask = this.enqueue(target, delivered, nextDepth);
      this.emit({ type: 'delegation', sessionId: source.id, roomId: source.roomId, taskId: sourceTask.id,
        targetSessionId: target.id, targetTaskId: childTask.id, text: `${source.name} → ${target.name}` });
      sourceTask.controller.signal.addEventListener('abort', cancelChild, { once: true });
      if (sourceTask.controller.signal.aborted) cancelChild();
      const result = await childTask.promise;
      return { sourceSessionId: source.id, sourceTaskId: sourceTask.id,
        sessionId: target.id, name: target.name, taskId: childTask.id, text: result };
    } finally {
      sourceTask.controller.signal.removeEventListener('abort', cancelChild);
      const remaining = (waiting.get(target.id) || 0) - 1;
      if (remaining > 0) waiting.set(target.id, remaining); else waiting.delete(target.id);
      if (!waiting.size && this.waits.get(source.id) === waiting) this.waits.delete(source.id);
    }
  }
}

class BridgeBroker {
  constructor(engine) { this.engine = engine; this.server = null; this.pending = null; }
  async start() {
    if (this.pending) return this.pending;
    const pending = this.pending = new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/tool') { res.writeHead(404).end(); return; }
        const source = this.engine.verifyToken(req.headers['x-agent-rooms-token']);
        if (!source) { res.writeHead(403).end(); return; }
        const activeTask = source.active;
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 2 * MAX_TEXT + 4096) throw new Error('Tool request too large');
          }
          const { tool, args } = JSON.parse(body);
          // Re-check after the async body read: the token must still belong to the same live task.
          if (this.engine.verifyToken(req.headers['x-agent-rooms-token']) !== source || source.active !== activeTask) {
            res.writeHead(403).end();
            return;
          }
          const result = await this.engine.toolCall(source, tool, args);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
      });
      server.on('error', (error) => { if (this.pending === pending) this.pending = null; reject(error); });
      server.listen(0, '127.0.0.1', () => {
        if (this.pending !== pending) { server.close(); reject(new Error('Room bridge closed')); return; }
        this.server = server;
        resolve({ port: server.address().port });
      });
    });
    return pending;
  }
  close() {
    const server = this.server;
    this.server = null;
    this.pending = null;
    if (!server) return;
    server.close();
    // Delegated tool calls can be long-lived; drop them so shutdown does not wait on open sockets.
    server.closeAllConnections?.();
  }
}

module.exports = { AgentEngine, BridgeBroker, PROVIDERS };
