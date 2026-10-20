import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createStore } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createRunner } from '../src/agents/runner.js';
import { AgentError, claudeArgs, claudeEnv, parseClaudeOutput } from '../src/agents/claude.js';
import { buildSystemPrompt } from '../src/agents/prompt.js';
import { setup, testRunner } from './helpers.js';

test('claude is spawned without API keys or nested-session variables, and with no tools', () => {
  const env = claudeEnv({
    PATH: '/usr/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_PID: '9', CLAUDE_EFFORT: 'high',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/x', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });

  const args = claudeArgs({ model: 'haiku', systemPrompt: 'SYS', home: '/home/x' });
  for (const flag of ['-p', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--output-format'), 'json');
  assert.equal(value('--model'), 'haiku');
  assert.equal(value('--setting-sources'), 'project');
  assert.equal(value('--tools'), '');
  assert.equal(value('--system-prompt'), 'SYS');
  assert.ok(JSON.parse(value('--settings')).claudeMdExcludes.includes('/home/x/.claude/CLAUDE.md'));
});

test('only the result fields are kept from claude output', () => {
  const stdout = JSON.stringify([
    { type: 'system', subtype: 'init', model: 'claude-haiku', apiKeySource: 'none' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
    {
      type: 'result', subtype: 'success', is_error: false, result: ' Hello there \n', duration_ms: 1234,
      total_cost_usd: 0.0021, usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { 'claude-small': { costUSD: 0.0001 }, 'claude-haiku-x': { costUSD: 0.002 } },
    },
  ]);
  assert.deepEqual(parseClaudeOutput(stdout), {
    text: 'Hello there', model: 'claude-haiku-x', durationMs: 1234, costUsd: 0.0021, inputTokens: 10, outputTokens: 5,
    cacheReadTokens: null, cacheWriteTokens: null, skillsUsed: [], loaded: { tools: [], skills: [], mcpServers: [] },
  });
  const failed = JSON.stringify([{ type: 'result', subtype: 'success', is_error: true, result: 'usage limit reached, resets 5pm' }]);
  assert.throws(() => parseClaudeOutput(failed), (err) => err instanceof AgentError && !/limit|5pm/.test(err.message) && !/limit|5pm/.test(JSON.stringify(err.usage)));
  assert.throws(() => parseClaudeOutput('not json'), AgentError);
});

test('agent system prompt carries the profile and the pricing rule', () => {
  const store = createStore((() => { const db = openDb(':memory:'); seed(db); return db; })());
  const prompt = buildSystemPrompt(store.member('scout'));
  assert.match(prompt, /You are Scout/);
  assert.match(prompt, /Survey and study design/);
  assert.match(prompt, /\$799\/month/);
  assert.match(prompt, /no tools/);
});

test('a mention becomes a job; the worker runs it and the reply lands in a thread', async (t) => {
  const { base, post, watch, worker } = await setup(t);
  const ayse = await watch('ayse');
  const runner = testRunner();
  worker(runner);
  await ayse.next('presence', (p) => p.online.includes('scout'));

  const sent = await post('sales', { memberId: 'alex', body: '@scout which audience should Northwind (demo) test first?' });
  assert.equal(sent.status, 201);

  const queued = await ayse.next('job', (j) => j.status === 'queued');
  assert.equal(queued.agentId, 'scout');
  assert.equal(queued.threadId, sent.body.id);
  await ayse.next('job', (j) => j.id === queued.id && j.status === 'running');
  const reply = await ayse.next('message', (m) => m.memberId === 'scout');
  const done = await ayse.next('job', (j) => j.id === queued.id && j.status === 'done');

  assert.equal(reply.threadId, sent.body.id);
  assert.equal(reply.body, 'Scout says hi to: @scout which audience should Northwind (demo) test first?');
  assert.deepEqual(reply.meta, {
    jobId: queued.id, model: 'test-model', durationMs: 5, costUsd: 0.001, inputTokens: null, outputTokens: null, skills: [], lookups: [],
  });
  assert.equal(done.replyId, reply.id);

  const call = runner.calls[0];
  assert.equal(call.agent.model, 'haiku');
  assert.match(call.prompt, /Channel: #sales/);
  assert.match(call.prompt, /Alex \(founder\)/);
  assert.match(call.systemPrompt, /You are Scout/);

  const thread = await (await fetch(`${base}/api/threads/${sent.body.id}`)).json();
  assert.equal(thread.replies.length, 1);
  assert.equal(thread.root.thread.count, 1);
  const channel = await (await fetch(`${base}/api/channels/sales/messages`)).json();
  assert.ok(!channel.messages.some((m) => m.id === reply.id), 'thread replies stay out of the channel list');
  assert.equal(channel.messages.find((m) => m.id === sent.body.id).thread.last.memberId, 'scout');
});

test('a mention inside a thread answers in that thread with the thread as context', async (t) => {
  const { post, watch, worker } = await setup(t);
  const ayse = await watch('ayse');
  const runner = testRunner();
  worker(runner);
  await ayse.next('presence', (p) => p.online.includes('geo-auditor'));

  const root = (await post('visibility', { memberId: 'deniz', body: 'Brand shows up in 3 of 10 answers.' })).body;
  await post('visibility', { memberId: 'ayse', body: 'Which prompts are missing?', threadId: root.id });
  await post('visibility', { memberId: 'ayse', body: '@geo-auditor what would you fix first?', threadId: root.id });
  const reply = await ayse.next('message', (m) => m.memberId === 'geo-auditor');

  assert.equal(reply.threadId, root.id);
  const { prompt } = runner.calls[0];
  assert.match(prompt, /The thread so far/);
  assert.match(prompt, /Brand shows up in 3 of 10 answers/);
  assert.match(prompt, /Which prompts are missing/);
});

test('mentions: only agents, once each, never inside e-mail addresses', async (t) => {
  const { store, post } = await setup(t);
  await post('general', { memberId: 'alex', body: '@scout @Scout and @geo-auditor, cc @ayse and mail@scout.com' });
  assert.deepEqual(store.queuedJobs().map((j) => j.agentId), ['scout', 'geo-auditor']);
});

test('with no worker, agents are offline and jobs wait; a worker that starts later picks them up', async (t) => {
  const { base, post, watch, worker } = await setup(t);
  const alex = await watch('alex');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(!state.online.includes('scout'), 'scout offline without a worker');

  await post('research', { memberId: 'alex', body: '@scout draft three screener questions' });
  const job = await alex.next('job', (j) => j.status === 'queued');

  worker(testRunner());
  await alex.next('presence', (p) => p.online.includes('scout') && p.online.includes('alex-claude'));
  await alex.next('job', (j) => j.id === job.id && j.status === 'done');
});

test('when the worker stops, its agents go offline and the running job goes back in the queue', async (t) => {
  const { watch, post, worker } = await setup(t);
  const alex = await watch('alex');
  const hanging = testRunner(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new AgentError('stopped')))));
  const w = worker(hanging);
  await alex.next('presence', (p) => p.online.includes('scout'));

  await post('general', { memberId: 'alex', body: '@scout this takes a while' });
  const running = await alex.next('job', (j) => j.status === 'running');
  await w.stop();

  await alex.next('presence', (p) => !p.online.includes('scout'));
  const requeued = await alex.next('job', (j) => j.id === running.id && j.status === 'queued' && j.startedAt === null && j.attempts === 1);
  assert.equal(requeued.error, null);
});

test('a failed run shows a safe error in the room', async (t) => {
  const { watch, post, worker } = await setup(t);
  const alex = await watch('alex');
  worker(testRunner(async ({ question }) => {
    if (question.includes('known')) throw new AgentError('Timed out after 180 s');
    throw new Error('raw CLI text with account details');
  }));
  await alex.next('presence', (p) => p.online.includes('scout'));

  await post('general', { memberId: 'alex', body: '@scout known problem' });
  assert.equal((await alex.next('job', (j) => j.status === 'failed')).error, 'Timed out after 180 s');
  await post('general', { memberId: 'alex', body: '@scout surprise' });
  assert.equal((await alex.next('job', (j) => j.status === 'failed')).error, 'The agent run failed');
});

test('worker endpoints refuse strangers', async (t) => {
  const { base, store, post } = await setup(t);
  await post('general', { memberId: 'alex', body: '@scout hi' });
  const [job] = store.queuedJobs();
  for (const action of ['claim', 'complete', 'fail']) {
    const res = await fetch(`${base}/api/worker/jobs/${job.id}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'made-up', text: 'x' }),
    });
    assert.equal(res.status, 409, action);
  }
  assert.equal(store.job(job.id).status, 'queued');
});

test('the fake runner answers without calling Claude', async () => {
  process.env.FAKE_RUNNER_DELAY_MS = '1';
  const runner = createRunner('fake');
  const out = await runner.run({ agent: { name: 'Scout', model: 'haiku' }, question: 'hi' });
  assert.equal(out.model, 'fake-haiku');
  assert.match(out.text, /Fake reply from Scout/);
});
