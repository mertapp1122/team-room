// A minimal MCP server (stdio, JSON-RPC, one message per line) that claude starts
// for one job. It exposes one connector's read-only tools and forwards every call
// to Team Room, which checks the job and the connection and logs the lookup.
//
// Env: TEAMROOM_URL, TEAMROOM_WORKER, TEAMROOM_JOB, TEAMROOM_CONNECTION
import { createInterface } from 'node:readline';
import { CONNECTORS, callTool } from './index.js';

const { TEAMROOM_URL: url, TEAMROOM_WORKER: workerId, TEAMROOM_JOB: jobId, TEAMROOM_CONNECTION: connection } = process.env;
const connector = CONNECTORS.get(connection);
const FALLBACK_PROTOCOL = '2025-06-18';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

async function handle({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: `teamroom-${connector.id}`, version: '1.0.0' },
        instructions: `${connector.name}: ${connector.description}`,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: connector.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      };
    case 'tools/call': {
      try {
        const result = await callTool({ url, workerId, jobId, connection, tool: params?.name, input: params?.arguments ?? {} });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

if (!connector || !url || !workerId || !jobId) {
  process.stderr.write('mcp-server: missing TEAMROOM_* settings\n');
  process.exit(1);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (msg.id === undefined) return; // a notification, e.g. notifications/initialized
  try {
    send({ id: msg.id, result: await handle(msg) });
  } catch (err) {
    send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
