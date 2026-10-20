import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentError } from '../src/agents/claude.js';
import { openDb, createStore } from '../src/db.js';
import { seed } from '../src/seed.js';
import { WORK_DIR, downgrade, setup, testRunner } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

const answer = (over = {}) => async () => ({
  text: 'ok', model: 'claude-haiku-5-5', durationMs: 2000, costUsd: 0.25,
  inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 500, skillsUsed: ['agency-offer'], ...over,
});

async function json(res) {
  return { status: res.status, body: await res.json() };
}

function limitsApi(base) {
  return (agentId, memberId, limits) => fetch(`${base}/api/agents/${agentId}/limits`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memberId, ...limits }),
  }).then(json);
}

// Mentions an agent and waits until that job is finished (done or failed).
async function ask(room, stream, { channel = 'sales', from = 'ayse', agent = 'scout', text = 'hi' } = {}) {
  const sent = await room.post(channel, { memberId: from, body: `@${agent} ${text}` });
  return stream.next('job', (j) => j.messageId === sent.body.id && (j.status === 'done' || j.status === 'failed'));
}

test('every run is logged with who asked, where, which agent and model, time and price', async (t) => {
  const room = await setup(t);
  const alex = await room.watch('alex');
  room.worker(testRunner(answer()));
  await alex.next('presence', (p) => p.online.includes('scout'));

  await ask(room, alex, { channel: 'sales', from: 'ayse', agent: 'scout' });
  await ask(room, alex, { channel: 'visibility', from: 'deniz', agent: 'scout' });
  await ask(room, alex, { channel: 'sales', from: 'ayse', agent: 'geo-auditor' });

  const { body: usage } = await fetch(`${room.base}/api/usage?range=today`).then(json);
  const [last] = usage.recent;
  assert.deepEqual(
    { ...last, id: undefined, jobId: undefined, threadId: undefined, startedAt: undefined, finishedAt: undefined, wallMs: undefined },
    {
      id: undefined, jobId: undefined, threadId: undefined, startedAt: undefined, finishedAt: undefined,
      wallMs: undefined,
      agentId: 'geo-auditor', requestedBy: 'ayse', channelId: 'sales', runner: 'test', modelAlias: 'haiku', model: 'claude-haiku-5-5',
      status: 'done', durationMs: 2000, costUsd: 0.25, inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 500,
      skills: ['agency-offer'], lookups: 0, error: null,
    },
  );

  assert.equal(usage.totals.runs, 3);
  assert.equal(usage.totals.costUsd, 0.75);
  assert.equal(usage.totals.avgDurationMs, 2000, 'what claude reported');
  assert.ok(Number.isInteger(last.wallMs) && last.wallMs >= 0 && last.wallMs === last.finishedAt - last.startedAt, 'how long the person waited');
  assert.ok(Number.isInteger(usage.totals.avgWallMs));
  assert.deepEqual(usage.totals.tokens, { input: 30, output: 600, cacheRead: 9000, cacheWrite: 1500 });
  const pick = (rows) => Object.fromEntries(rows.map((r) => [r.key, [r.runs, r.costUsd]]));
  assert.deepEqual(pick(usage.byPerson), { ayse: [2, 0.5], deniz: [1, 0.25] });
  assert.deepEqual(pick(usage.byChannel), { sales: [2, 0.5], visibility: [1, 0.25] });
  assert.deepEqual(pick(usage.byAgent), { scout: [2, 0.5], 'geo-auditor': [1, 0.25] });
  assert.deepEqual(pick(usage.byModel), { 'claude-haiku-5-5': [3, 0.75] });
  assert.deepEqual(usage.daily.map((d) => [d.runs, d.costUsd]), [[3, 0.75]]);
  assert.deepEqual(usage.agents.find((a) => a.id === 'scout').today, { runs: 2, costUsd: 0.5 });

  const week = (await fetch(`${room.base}/api/usage?range=7d`).then(json)).body;
  assert.equal(week.daily.length, 7);
  assert.equal((await fetch(`${room.base}/api/usage?range=year`)).status, 400);
});

test('failed runs are logged too, with the cost claude reported', async (t) => {
  const room = await setup(t);
  const alex = await room.watch('alex');
  room.worker(testRunner(async () => {
    throw new AgentError('Claude reported an error for this request', { model: 'claude-haiku-5-5', durationMs: 900, costUsd: 0.01 });
  }));
  await alex.next('presence', (p) => p.online.includes('scout'));
  const job = await ask(room, alex);
  assert.equal(job.status, 'failed');

  const { body } = await fetch(`${room.base}/api/usage?range=today`).then(json);
  assert.deepEqual([body.recent[0].status, body.recent[0].costUsd, body.recent[0].model, body.recent[0].error],
    ['failed', 0.01, 'claude-haiku-5-5', 'Claude reported an error for this request']);
  assert.equal(body.totals.failed, 1);
  assert.equal(body.totals.costUsd, 0.01);
});

test('a daily run limit stops the agent, and everyone sees why', async (t) => {
  const room = await setup(t);
  const setLimits = limitsApi(room.base);
  const ayse = await room.watch('ayse');
  const runner = testRunner(answer({ costUsd: 0.01 }));
  room.worker(runner);
  await ayse.next('presence', (p) => p.online.includes('scout'));

  assert.equal((await setLimits('scout', 'ayse', { runs: 2, usd: null })).status, 403, 'only the owner sets limits');
  assert.equal((await setLimits('scout', 'alex', { runs: 0, usd: null })).status, 400);
  assert.equal((await setLimits('scout', 'alex', { runs: 2, usd: 'lots' })).status, 400);
  assert.equal((await setLimits('ayse', 'alex', { runs: 2, usd: null })).status, 404, 'people have no limits');
  const set = await setLimits('scout', 'alex', { runs: 2, usd: null });
  assert.deepEqual(set.body.limits, { runs: 2, usd: null });
  assert.deepEqual(await ayse.next('limits'), { agentId: 'scout', limits: { runs: 2, usd: null } });

  assert.equal((await ask(room, ayse)).status, 'done');
  assert.equal((await ask(room, ayse)).status, 'done');
  const third = await ask(room, ayse);
  assert.equal(third.status, 'failed');
  assert.equal(third.blocked, true);
  assert.equal(third.error, 'Scout reached its daily limit of 2 runs. It resets at midnight.');
  assert.equal(runner.calls.length, 2, 'the blocked job never reached the worker');

  // Other agents are not affected.
  assert.equal((await ask(room, ayse, { agent: 'geo-auditor' })).status, 'done');

  const { body } = await fetch(`${room.base}/api/usage?range=today`).then(json);
  assert.equal(body.totals.blocked, 1);
  assert.equal(body.totals.runs, 3);
  assert.equal(body.recent.find((r) => r.status === 'blocked').agentId, 'scout');
});

test('a daily price limit counts API-equivalent dollars, and resets at midnight', async (t) => {
  let clock = new Date(2026, 9, 17, 22, 0).getTime();
  const room = await setup(t, { now: () => clock });
  const ayse = await room.watch('ayse');
  room.worker(testRunner(answer({ costUsd: 0.6 })));
  await ayse.next('presence', (p) => p.online.includes('alex-claude'));
  await limitsApi(room.base)('alex-claude', 'alex', { runs: null, usd: 1 });

  assert.equal((await ask(room, ayse, { agent: 'alex-claude' })).status, 'done');
  assert.equal((await ask(room, ayse, { agent: 'alex-claude' })).status, 'done');
  const blocked = await ask(room, ayse, { agent: 'alex-claude' });
  assert.equal(blocked.error, "Alex's Claude reached its daily limit of $1.00 in API-equivalent usage. It resets at midnight.");

  clock += 3 * 60 * 60 * 1000; // 01:00 the next day
  assert.equal((await ask(room, ayse, { agent: 'alex-claude' })).status, 'done');
  const { body } = await fetch(`${room.base}/api/usage?range=7d`).then(json);
  assert.deepEqual(body.daily.slice(-2).map((d) => [d.day, d.runs, Math.round(d.costUsd * 100) / 100]), [['2026-10-17', 2, 1.2], ['2026-10-18', 1, 0.6]]);
});

test('jobs that queued up while the worker was away are checked again when claimed', async (t) => {
  const room = await setup(t);
  const alex = await room.watch('alex');
  await limitsApi(room.base)('scout', 'alex', { runs: 2, usd: null });
  const sent = [];
  for (const n of [1, 2, 3]) sent.push((await room.post('general', { memberId: 'alex', body: `@scout question ${n}` })).body.id);

  const runner = testRunner(answer());
  room.worker(runner, { concurrency: 1 });
  const results = [];
  for (const id of sent) results.push(await alex.next('job', (j) => j.messageId === id && (j.status === 'done' || j.status === 'failed')));
  assert.deepEqual(results.map((j) => [j.status, j.blocked]), [['done', false], ['done', false], ['failed', true]]);
  assert.equal(runner.calls.length, 2);
});

test('a run the worker drops is logged as failed, and the retry gets its own row', async (t) => {
  const room = await setup(t);
  const alex = await room.watch('alex');
  const first = room.worker(testRunner(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new AgentError('stopped'))))));
  await alex.next('presence', (p) => p.online.includes('scout'));
  await room.post('general', { memberId: 'alex', body: '@scout slow one' });
  await alex.next('job', (j) => j.status === 'running');
  await first.stop();
  await alex.next('job', (j) => j.status === 'queued' && j.attempts === 1);

  room.worker(testRunner(answer()));
  await alex.next('job', (j) => j.status === 'done');
  const { body } = await fetch(`${room.base}/api/usage?range=today`).then(json);
  assert.deepEqual(body.recent.map((r) => [r.status, r.error]).reverse(),
    [['failed', 'The worker stopped before finishing'], ['done', null]]);
});

test('upgrading a step 3 room rebuilds the log from past jobs', (t) => {
  const dir = join(WORK_DIR, 'upgrade');
  const file = join(dir, 'room.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(dir, { recursive: true, force: true });

  // Build a room as it was before the usage log existed.
  const db = openDb(file);
  seed(db);
  const store = createStore(db);
  const ask = store.addMessage({ channelId: 'sales', memberId: 'ayse', body: '@scout hi' });
  const job = store.addJob({ agentId: 'scout', channelId: 'sales', messageId: ask.id, threadId: ask.id });
  store.claimJob(job.id, 1000);
  const meta = { jobId: job.id, model: 'claude-haiku-5-5', durationMs: 1500, costUsd: 0.002, inputTokens: 5, outputTokens: 50, skills: ['agency-offer'], lookups: [] };
  const reply = store.addMessage({ channelId: 'sales', memberId: 'scout', body: 'ok', threadId: ask.id, meta });
  store.finishJob(job.id, reply.id, 2600);
  downgrade(db, 2);
  db.close();

  const upgraded = openDb(file);
  t.after(() => upgraded.close());
  assert.equal(new DatabaseSync(file).prepare('PRAGMA user_version').get().user_version, 7);
  const runs = createStore(upgraded).usage({ from: 0, to: Date.now() + DAY }).recent;
  assert.equal(runs.length, 1);
  assert.deepEqual(
    [runs[0].agentId, runs[0].requestedBy, runs[0].channelId, runs[0].model, runs[0].costUsd, runs[0].durationMs, runs[0].runner, runs[0].skills],
    ['scout', 'ayse', 'sales', 'claude-haiku-5-5', 0.002, 1500, 'claude', ['agency-offer']],
  );
  assert.deepEqual(createStore(upgraded).member('scout').limits, { runs: 50, usd: 1 });
});
