// Every tool an agent can be connected to. Each connector is read-only.
import { DEMO_CRM } from './demo-crm.js';

export { ToolError } from './demo-crm.js';

export const CONNECTORS = new Map([[DEMO_CRM.id, DEMO_CRM]]);

// What the room and the worker need to know about a connector (no code).
export const describeConnector = (c) => ({
  id: c.id,
  name: c.name,
  mcpName: c.mcpName,
  isDemo: c.isDemo,
  readOnly: c.readOnly,
  description: c.description,
  tools: c.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
});

// Asks Team Room to run a connector tool for a running job.
// Used by the MCP server that claude talks to, and by the fake runner.
export async function callTool({ url, workerId, jobId, connection, tool, input }) {
  const res = await fetch(`${url}/api/worker/jobs/${jobId}/tools`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId, connection, tool, input }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Team Room answered ${res.status}`);
  return data.result;
}
