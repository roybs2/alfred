import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import http from 'node:http';

const port = Number(process.env.AGENT_ROOMS_BRIDGE_PORT);
const token = process.env.AGENT_ROOMS_BRIDGE_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(2);

let peers = [];
try { peers = JSON.parse(process.env.AGENT_ROOMS_PEERS || '[]'); } catch {}
const directory = peers.map(({ name, id, provider }) => `${name} [${provider}, ${id}]`).join('; ') || 'none';
const server = new McpServer({ name: 'agent-rooms', version: '0.1.0' });

// node:http instead of fetch: delegated tasks can run far longer than undici's 300s headers timeout.
function post(payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request({
      host: '127.0.0.1', port, path: '/tool', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-agent-rooms-token': token },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch {}
        resolve({ status: res.statusCode, body });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function call(tool, args) {
  try {
    const { status, body } = await post({ tool, args });
    if (status !== 200 || !body.ok) throw new Error(body.error || `Room bridge returned ${status}`);
    return { content: [{ type: 'text', text: JSON.stringify(body.result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message || String(error) }] };
  }
}

server.registerTool('room_send', {
  description: `Send an exact task and optional exact context to an existing managed agent in this room, wait for its result. Address by unique name or ID. Current room agents: ${directory}`,
  inputSchema: {
    to: z.string().min(1).describe('Existing room agent name or ID'),
    task: z.string().min(1).describe('Task to send unchanged'),
    context: z.string().optional().describe('Additional context to pass unchanged'),
  },
}, async (args) => call('room_send', args));

server.registerTool('room_spawn', {
  description: 'Create a managed Claude or Codex agent in this room, give it a task, and wait for its result. Requires room collaboration policy.',
  inputSchema: {
    provider: z.enum(['claude', 'codex']),
    task: z.string().min(1).describe('Task to send unchanged'),
    context: z.string().optional().describe('Additional context to pass unchanged'),
    name: z.string().optional().describe('Name for the new room agent'),
  },
}, async (args) => call('room_spawn', args));

await server.connect(new StdioServerTransport());
