import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeArgs, mcpServersFor, parseClaudeOutput, prepareWorkspace } from '../src/agents/claude.js';
import { createRunner } from '../src/agents/runner.js';
import { CONNECTORS, callTool, describeConnector } from '../src/connectors/index.js';
import { loadSkills } from '../src/skills.js';
import { WORK_DIR, setup, testRunner } from './helpers.js';

const MCP_SERVER = fileURLToPath(new URL('../src/connectors/mcp-server.js', import.meta.url));
const crm = describeConnector(CONNECTORS.get('demo-crm'));

const reply = (text = 'ok') => ({ text, model: 'test-model', durationMs: 1, costUsd: 0 });

// Talks to the MCP server the way claude does: JSON-RPC over stdin/stdout, one message per line.
function mcpClient(env) {
  const child = spawn(process.execPath, [MCP_SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  return {
    request: (method, params) => new Promise((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    }),
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    close: () => child.kill(),
  };
}

test('the two team skills load from ./skills with name and description', async (t) => {
  const skills = loadSkills();
  assert.deepEqual(skills.map((s) => s.id), ['agency-offer', 'ai-visibility-check']);
  for (const s of skills) {
    assert.equal(s.name, s.id);
    assert.ok(s.description.length > 40, `${s.id} has a description`);
    assert.match(s.content, /^---\nname: /);
  }
  assert.match(skills[0].body, /\$799\/month/);
  assert.doesNotMatch(skills[0].body, /\$(?:[1-6]\d\d|7[0-8]\d)\b/, 'the offer skill never names a price under $799');

  const { base } = await setup(t);
  const api = await (await fetch(`${base}/api/skills`)).json();
  assert.equal(api.skills.length, 2);
});

test('demo CRM: fictional leads, search and read only', async (t) => {
  const { base } = await setup(t);
  const { records } = await (await fetch(`${base}/api/connections/demo-crm/records`)).json();
  assert.equal(records.length, 6);
  for (const lead of records) assert.match(lead.company, /\(demo\)$/);

  const { connections } = await (await fetch(`${base}/api/connections`)).json();
  assert.deepEqual(connections.map((c) => [c.id, c.enabled, c.readOnly]), [['demo-crm', true, true]]);
  assert.deepEqual(connections[0].tools.map((tool) => tool.name), ['search_leads', 'get_lead']);
});

test('claude gets only the Skill tool and the read-only CRM tools', () => {
  const access = { url: 'http://127.0.0.1:5500', workerId: 'w-1', jobId: 7 };
  const mcpServers = mcpServersFor([crm], access);
  const args = claudeArgs({ model: 'haiku', systemPrompt: 'SYS', skills: loadSkills(), connections: [crm], mcpServers, home: '/home/x' });
  const value = (flag) => args[args.indexOf(flag) + 1];

  assert.equal(value('--tools'), 'Skill');
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.deepEqual(value('--allowedTools').split(','), [
    'Skill(agency-offer)', 'Skill(ai-visibility-check)', 'mcp__crm__search_leads', 'mcp__crm__get_lead',
  ], 'team skills by name only, never the whole Skill tool');
  assert.ok(args.includes('--strict-mcp-config'));
  const server = JSON.parse(value('--mcp-config')).mcpServers.crm;
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.env, { TEAMROOM_URL: access.url, TEAMROOM_WORKER: 'w-1', TEAMROOM_JOB: '7', TEAMROOM_CONNECTION: 'demo-crm' });

  const bare = claudeArgs({ model: 'haiku', systemPrompt: 'SYS' });
  assert.equal(bare[bare.indexOf('--tools') + 1], '');
  assert.ok(!bare.includes('--allowedTools') && !bare.includes('--mcp-config'));
});

test('the agent workspace gets exactly the current team skills', (t) => {
  const cwd = join(WORK_DIR, 'workspace');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.claude', 'skills', 'old-skill'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'skills', 'old-skill', 'SKILL.md'), 'stale');

  prepareWorkspace(cwd, [...loadSkills(), { id: '../escape', content: 'nope' }]);
  const skillFile = (id) => join(cwd, '.claude', 'skills', id, 'SKILL.md');
  assert.equal(readFileSync(skillFile('agency-offer'), 'utf8'), loadSkills()[0].content);
  assert.ok(existsSync(skillFile('ai-visibility-check')));
  assert.ok(!existsSync(skillFile('old-skill')), 'removed skills disappear');
  assert.ok(!existsSync(join(cwd, '.claude', 'escape')), 'odd skill ids are skipped');
});

test('skills the agent loaded are read from claude output', () => {
  const stdout = JSON.stringify([
    { type: 'system', subtype: 'init', tools: ['Skill', 'mcp__crm__search_leads'], skills: ['agency-offer'], mcp_servers: [{ name: 'crm', status: 'connected' }], email: 'x@example.com' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'agency-offer' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__crm__get_lead', input: { id: 'L-101' } }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Offer…', duration_ms: 10, total_cost_usd: 0.01, usage: {}, modelUsage: {} },
  ]);
  const out = parseClaudeOutput(stdout);
  assert.deepEqual(out.skillsUsed, ['agency-offer']);
  assert.deepEqual(out.loaded, { tools: ['Skill', 'mcp__crm__search_leads'], skills: ['agency-offer'], mcpServers: ['crm:connected'] });
  assert.ok(!JSON.stringify(out).includes('example.com'), 'nothing else from the init event is kept');
});

test('an offer request: the agent loads the skill, reads the CRM, and everyone sees it', async (t) => {
  process.env.FAKE_RUNNER_DELAY_MS = '20';
  const { post, watch, worker } = await setup(t);
  const alex = await watch('alex');
  worker(createRunner('fake'));
  await alex.next('presence', (p) => p.online.includes('alex-claude'));

  await post('sales', { memberId: 'ayse', body: '@alex-claude can you draft an offer for Northwind Bakery?' });
  const searched = await alex.next('job', (j) => j.activity.length === 1);
  assert.equal(searched.activity[0].summary, 'listed CRM leads (6)');
  const opened = await alex.next('job', (j) => j.activity.length === 2);
  assert.equal(opened.activity[1].summary, 'opened L-101 Northwind Bakery (demo)');

  const answer = await alex.next('message', (m) => m.memberId === 'alex-claude');
  assert.match(answer.body, /budget \$900\/month/);
  assert.deepEqual(answer.meta.skills, ['agency-offer']);
  assert.deepEqual(answer.meta.lookups, ['listed CRM leads (6)', 'opened L-101 Northwind Bakery (demo)']);
});

test('the claim carries skills, connections and a prompt that says to use them', async (t) => {
  const { post, worker, watch } = await setup(t);
  const alex = await watch('alex');
  const runner = testRunner(async () => reply());
  worker(runner);
  await alex.next('presence', (p) => p.online.includes('scout'));
  await post('sales', { memberId: 'ayse', body: '@scout offer for Harbor Dental?' });
  await alex.next('job', (j) => j.status === 'done');

  const call = runner.calls[0];
  assert.deepEqual(call.skills.map((s) => s.id), ['agency-offer', 'ai-visibility-check']);
  assert.deepEqual(call.connections.map((c) => c.id), ['demo-crm']);
  assert.match(call.systemPrompt, /load it with the Skill tool/);
  assert.match(call.systemPrompt, /agency-offer: How our AI growth agency writes offers/);
  assert.match(call.systemPrompt, /look it up in the CRM before answering/);
  assert.equal(call.toolAccess.jobId, 1);
});

test('the MCP server speaks MCP and only reaches the CRM through the room', async (t) => {
  const { post, worker, watch } = await setup(t);
  const alex = await watch('alex');
  let seen;
  worker(testRunner(async ({ toolAccess }) => {
    const mcp = mcpClient({
      TEAMROOM_URL: toolAccess.url, TEAMROOM_WORKER: toolAccess.workerId, TEAMROOM_JOB: String(toolAccess.jobId), TEAMROOM_CONNECTION: 'demo-crm',
    });
    try {
      const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      mcp.notify('notifications/initialized');
      const list = await mcp.request('tools/list', {});
      const lead = await mcp.request('tools/call', { name: 'get_lead', arguments: { id: 'L-103' } });
      const missing = await mcp.request('tools/call', { name: 'get_lead', arguments: { id: 'L-999' } });
      const write = await mcp.request('tools/call', { name: 'delete_lead', arguments: { id: 'L-103' } });
      const unknown = await mcp.request('resources/list', {});
      seen = { init, list, lead, missing, write, unknown };
    } finally {
      mcp.close();
    }
    return reply();
  }));
  await alex.next('presence', (p) => p.online.includes('scout'));
  await post('sales', { memberId: 'ayse', body: '@scout check Harbor Dental' });
  await alex.next('job', (j) => j.status === 'done');

  assert.equal(seen.init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(seen.init.result.capabilities, { tools: {} });
  assert.deepEqual(seen.list.result.tools.map((x) => [x.name, x.annotations.readOnlyHint]), [['search_leads', true], ['get_lead', true]]);
  const lead = JSON.parse(seen.lead.result.content[0].text);
  assert.equal(lead.company, 'Harbor Dental Studio (demo)');
  assert.equal(lead.budgetPerMonth, 600);
  assert.equal(seen.missing.result.isError, true);
  assert.match(seen.missing.result.content[0].text, /No lead with id L-999/);
  assert.equal(seen.write.result.isError, true, 'there is no write tool');
  assert.equal(seen.unknown.error.code, -32601);
});

test('only the owner switches a connection; when it is off agents lose it at once', async (t) => {
  const { base, post, worker, watch } = await setup(t);
  const ayse = await watch('ayse');
  const toggle = async (memberId, enabled) => {
    const res = await fetch(`${base}/api/connections/demo-crm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memberId, enabled }),
    });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await toggle('ayse', false)).status, 403);

  // Switched off while a job is already running: its next lookup is refused.
  let lateCall;
  const runner = testRunner(async ({ toolAccess, question }) => {
    if (question.includes('first')) {
      await toggle('alex', false);
      lateCall = await callTool({ ...toolAccess, connection: 'demo-crm', tool: 'search_leads', input: {} }).catch((err) => err.message);
    }
    return reply();
  });
  worker(runner);
  await ayse.next('presence', (p) => p.online.includes('scout'));

  await post('sales', { memberId: 'alex', body: '@scout first question' });
  const off = await ayse.next('connection', (c) => c.id === 'demo-crm');
  assert.equal(off.enabled, false);
  assert.equal(off.updatedBy, 'alex');
  await ayse.next('job', (j) => j.status === 'done');
  assert.equal(lateCall, 'Demo CRM is switched off');

  // New jobs don't get the connection at all.
  await post('sales', { memberId: 'alex', body: '@scout second question' });
  await ayse.next('job', (j) => j.status === 'done' && j.id === 2);
  assert.deepEqual(runner.calls[1].connections, []);
  assert.doesNotMatch(runner.calls[1].systemPrompt, /CRM/);
});

test('tool calls are checked: right worker, real tool, sane input', async (t) => {
  const { post, worker, watch } = await setup(t);
  const alex = await watch('alex');
  const outcomes = [];
  worker(testRunner(async ({ toolAccess }) => {
    const attempt = (over) => callTool({ ...toolAccess, connection: 'demo-crm', tool: 'get_lead', input: { id: 'L-101' }, ...over })
      .then(() => 'ok', (err) => err.message);
    outcomes.push(
      await attempt({}),
      await attempt({ workerId: 'someone-else' }),
      await attempt({ tool: 'update_lead' }),
      await attempt({ connection: 'real-crm' }),
      await attempt({ input: { id: '1 OR 1=1' } }),
      await attempt({ tool: 'search_leads', input: { stage: 'deleted' } }),
    );
    return reply();
  }));
  await alex.next('presence', (p) => p.online.includes('scout'));
  await post('general', { memberId: 'alex', body: '@scout hi' });
  await alex.next('job', (j) => j.status === 'done');

  assert.deepEqual(outcomes, [
    'ok',
    'unknown worker; reconnect first',
    'Demo CRM has no tool "update_lead"',
    'no such connection',
    'id looks like L-101',
    'stage must be one of: new, qualified, proposal, won, lost',
  ]);
});
