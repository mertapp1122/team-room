import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, createStore } from '../src/db.js';
import { seed } from '../src/seed.js';
import { buildSystemPrompt } from '../src/agents/prompt.js';
import { staleLeads } from '../src/pipeline.js';
import { weekKey } from '../src/time.js';
import { WORK_DIR, downgrade, setup, testRunner } from './helpers.js';

const json = async (res) => ({ status: res.status, body: await res.json() });
const send = (base, path, payload) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
}).then(json);

function freshStore(now = Date.now()) {
  const db = openDb(':memory:');
  seed(db, now);
  return createStore(db);
}

test('a lead is stale after a day without a CRM update or a finished commitment on it', async (t) => {
  const store = freshStore();
  const stale = (s) => staleLeads(s, Date.now()).map((l) => `${l.id}:${l.ownerId}`);
  // Seeded: Northwind 50 h, Harbor Dental 30 h, Maple & Thread 96 h idle; Quartz 3 h; won/lost leads never count.
  assert.deepEqual(stale(store), ['L-105:burak', 'L-101:ayse', 'L-103:ayse']);

  const room = await setup(t);
  const { body: list } = await fetch(`${room.base}/api/channels/sales/commitments`).then(json);
  const offer = list.commitments.find((c) => c.leadId === 'L-101');
  assert.equal((await send(room.base, `/api/commitments/${offer.id}`, { memberId: 'ayse', status: 'done' })).status, 200);
  assert.deepEqual(stale(room.store), ['L-105:burak', 'L-103:ayse'], 'finishing a commitment on a lead moves it');
});

test('commitments: people add their own, Alex can assign, everyone sees changes live', async (t) => {
  const room = await setup(t);
  const deniz = await room.watch('deniz');
  const add = (payload) => send(room.base, '/api/channels/sales/commitments', payload);

  const mine = await add({ memberId: 'ayse', text: '  Follow up with Lena at Northwind  ', leadId: 'L-101' });
  assert.equal(mine.status, 201);
  assert.deepEqual([mine.body.ownerId, mine.body.text, mine.body.status, mine.body.week], ['ayse', 'Follow up with Lena at Northwind', 'open', weekKey(Date.now())]);
  assert.equal((await deniz.next('commitment', (c) => c.id === mine.body.id)).text, 'Follow up with Lena at Northwind');

  assert.equal((await add({ memberId: 'ayse', ownerId: 'deniz', text: 'Do my homework' })).status, 403);
  assert.equal((await add({ memberId: 'alex', ownerId: 'deniz', text: 'Send Quartz the AEO outline' })).status, 201);
  assert.equal((await add({ memberId: 'alex', ownerId: 'pipeline', text: 'x' })).status, 400, 'agents do not take commitments');
  assert.equal((await add({ memberId: 'ayse', text: '' })).status, 400);
  assert.equal((await add({ memberId: 'ayse', text: 'x', leadId: 'L-999' })).status, 400);
  assert.equal((await add({ memberId: 'ayse', text: 'x', week: '2026-10-14' })).status, 400, 'weeks start on Monday');
  assert.equal((await send(room.base, '/api/channels/general/commitments', { memberId: 'ayse', text: 'x' })).status, 404, 'only #sales has a tracker');

  const id = mine.body.id;
  assert.equal((await send(room.base, `/api/commitments/${id}`, { memberId: 'deniz', status: 'done' })).status, 403);
  assert.equal((await send(room.base, `/api/commitments/${id}`, { memberId: 'ayse', status: 'finished' })).status, 400);
  const done = await send(room.base, `/api/commitments/${id}`, { memberId: 'ayse', status: 'done' });
  assert.equal(done.body.status, 'done');
  assert.ok(done.body.doneAt);
  const reopened = await send(room.base, `/api/commitments/${id}`, { memberId: 'alex', status: 'open' });
  assert.equal(reopened.body.doneAt, null);

  const { body } = await fetch(`${room.base}/api/channels/sales/commitments`).then(json);
  assert.ok(body.commitments.some((c) => c.id === id));
  assert.equal(body.leads.length, 6);
});

test('people have profiles the person or Alex can edit, and agents read them', async (t) => {
  const room = await setup(t);
  const alex = await room.watch('alex');
  const { body: state } = await fetch(`${room.base}/api/state`).then(json);
  const ayse = state.members.find((m) => m.id === 'ayse');
  assert.equal(ayse.title, 'Account lead');
  assert.match(ayse.focus, /Northwind/);
  assert.ok(ayse.askAbout.includes('Proposals and offers'));

  const edit = (memberId, target, profile) => send(room.base, `/api/members/${target}/profile`, { memberId, ...profile });
  assert.equal((await edit('ayse', 'deniz', { title: 'Boss' })).status, 403);
  assert.equal((await edit('ayse', 'scout', { title: 'x' })).status, 404, 'agents have their own profiles');
  assert.equal((await edit('ayse', 'ayse', { title: '' })).status, 400);
  assert.equal((await edit('ayse', 'ayse', { title: 'Account lead', askAbout: Array(7).fill('x') })).status, 400);
  const saved = await edit('ayse', 'ayse', { title: 'Senior account lead', focus: 'Northwind offer', askAbout: ['Offers', 'Client calls'] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await alex.next('profile', (p) => p.id === 'ayse')).askAbout, ['Offers', 'Client calls']);
  assert.equal((await edit('alex', 'deniz', { title: 'Head of GEO' })).status, 200);

  const { body: overview } = await fetch(`${room.base}/api/members/ayse/overview`).then(json);
  assert.deepEqual(overview.commitments.map((c) => c.leadId), ['L-101', 'L-103', null]);
  assert.deepEqual(overview.leads.map((l) => [l.id, l.stale]), [['L-101', true], ['L-103', true]]);

  const prompt = buildSystemPrompt(room.store.member('scout'), { people: room.store.members().filter((m) => m.kind === 'human') });
  assert.match(prompt, /Ayşe Kaya \(@ayse\), Senior account lead, demo teammate\. Working on: Northwind offer\. Ask about: Offers, Client calls\./);
  assert.match(prompt, /Alex \(@alex\), Founder, founder\./);
});

test('"Run now": Pipeline posts the check-in in #sales and nudges every owner of a stalled lead', async (t) => {
  const room = await setup(t);
  const ayse = await room.watch('ayse');
  const runner = testRunner(async () => ({ text: 'Good afternoon, team! Solid week so far.', model: 'claude-haiku-5-5', durationMs: 900, costUsd: 0.001 }));
  room.worker(runner);
  await ayse.next('presence', (p) => p.online.includes('pipeline'));

  assert.equal((await send(room.base, '/api/automations/sales-checkin/run', { memberId: 'ayse' })).status, 403);
  const started = await send(room.base, '/api/automations/sales-checkin/run', { memberId: 'alex' });
  assert.equal(started.status, 202);
  assert.deepEqual([started.body.job.automationId, started.body.job.threadId, started.body.job.agentId], ['sales-checkin', null, 'pipeline']);

  const post = await ayse.next('message', (m) => m.memberId === 'pipeline');
  assert.equal(post.channelId, 'sales');
  assert.equal(post.threadId, null, 'the check-in is its own message, not a thread reply');
  assert.match(post.body, /^Good afternoon, team!/);
  // Stalest first.
  assert.match(post.body, /\n\nNudges:\n- @burak: Maple & Thread \(demo\) \(L-105\) has not moved for 4 days\. What is the next step\?\n/);
  assert.match(post.body, /\n- @ayse: Northwind Bakery \(demo\) \(L-101\) has not moved for 2 days; Harbor Dental Studio \(demo\) \(L-103\) has not moved for a day\. What is the next step\?$/);
  assert.doesNotMatch(post.body, /@deniz/, 'Quartz moved recently');

  const { prompt, question } = runner.calls[0];
  assert.equal(question, 'Daily check-in for #sales');
  assert.match(prompt, /Commitments this week: 3 done, 4 open\./);
  assert.match(prompt, /Ayşe Kaya \(@ayse\): done "Add visibility screenshots to the sales deck"/);
  assert.match(prompt, /L-105 Maple & Thread \(demo\), stage new, owner @burak, not moved for 4 days/);
  assert.match(runner.calls[0].systemPrompt, /Who's who/);

  const { body: usage } = await fetch(`${room.base}/api/usage?range=today`).then(json);
  assert.deepEqual([usage.recent[0].agentId, usage.recent[0].requestedBy, usage.recent[0].threadId], ['pipeline', 'alex', null]);
  const { body: list } = await fetch(`${room.base}/api/automations`).then(json);
  assert.equal(list.automations[0].lastJob.status, 'done');
});

test('no extra nudge lines when the agent already mentioned everyone', async (t) => {
  const room = await setup(t);
  const alex = await room.watch('alex');
  room.worker(testRunner(async () => ({ text: 'Check-in. @ayse Northwind and Harbor need a next step. @burak Maple & Thread too.', model: 'm', durationMs: 1, costUsd: 0 })));
  await alex.next('presence', (p) => p.online.includes('pipeline'));
  await send(room.base, '/api/automations/sales-checkin/run', { memberId: 'alex' });
  const post = await alex.next('message', (m) => m.memberId === 'pipeline');
  assert.doesNotMatch(post.body, /Nudges:/);
});

test('the check-in runs once at 17:00 on weekdays, and Alex can change or pause it', async (t) => {
  let clock = new Date(2026, 9, 19, 16, 59).getTime(); // Monday
  const room = await setup(t, { now: () => clock });
  const due = () => room.server.runDueAutomations().map((j) => j.automationId);

  assert.deepEqual(due(), [], 'not before 17:00');
  clock = new Date(2026, 9, 19, 17, 0, 30).getTime();
  assert.deepEqual(due(), ['sales-checkin']);
  clock = new Date(2026, 9, 19, 17, 30).getTime();
  assert.deepEqual(due(), [], 'once a day');
  clock = new Date(2026, 9, 20, 19, 30).getTime();
  assert.deepEqual(due(), [], 'a missed run is skipped after two hours');
  clock = new Date(2026, 9, 24, 17, 5).getTime(); // Saturday
  assert.deepEqual(due(), [], 'not on weekends');

  const update = (payload) => send(room.base, '/api/automations/sales-checkin', { memberId: 'alex', ...payload });
  assert.equal((await send(room.base, '/api/automations/sales-checkin', { memberId: 'ayse', enabled: false })).status, 403);
  assert.equal((await update({ time: '25:00' })).status, 400);
  const changed = await update({ time: '09:30' });
  assert.equal(changed.body.time, '09:30');
  assert.equal(changed.body.nextRunAt, new Date(2026, 9, 26, 9, 30).getTime(), 'next weekday at the new time');
  clock = new Date(2026, 9, 26, 9, 31).getTime();
  await update({ enabled: false });
  assert.deepEqual(due(), [], 'paused');
  await update({ enabled: true });
  assert.deepEqual(due(), ['sales-checkin']);
});

test('the check-in respects Pipeline\'s daily limit', async (t) => {
  const room = await setup(t);
  const alex = await room.watch('alex');
  await send(room.base, '/api/agents/pipeline/limits', { memberId: 'alex', runs: 1, usd: null });
  room.worker(testRunner(async () => ({ text: 'ok', model: 'm', durationMs: 1, costUsd: 0 })));
  await alex.next('presence', (p) => p.online.includes('pipeline'));
  await send(room.base, '/api/automations/sales-checkin/run', { memberId: 'alex' });
  await alex.next('job', (j) => j.automationId && j.status === 'done');
  const second = await send(room.base, '/api/automations/sales-checkin/run', { memberId: 'alex' });
  assert.equal(second.body.job.blocked, true);
  assert.equal(second.body.job.error, 'Pipeline reached its daily limit of 1 run. It resets at midnight.');
});

test('upgrading a step 4 room adds the #sales work stream and keeps its history', (t) => {
  const dir = join(WORK_DIR, 'upgrade-4');
  const file = join(dir, 'room.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(dir, { recursive: true, force: true });

  const db = openDb(file);
  seed(db);
  const old = createStore(db);
  const ask = old.addMessage({ channelId: 'sales', memberId: 'ayse', body: '@scout hi' });
  old.addJob({ agentId: 'scout', channelId: 'sales', messageId: ask.id, threadId: ask.id, requestedBy: 'ayse' });
  downgrade(db, 3);
  db.close();

  const upgraded = openDb(file);
  t.after(() => upgraded.close());
  const store = createStore(upgraded);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(store.queuedJobs()[0].messageId, ask.id, 'existing jobs survive the jobs table rebuild');
  assert.equal(store.member('pipeline').model, 'haiku');
  assert.match(store.member('ayse').focus, /Northwind/);
  assert.deepEqual(store.channel('sales').features, ['pipeline', 'commitments', 'checkin']);
  assert.equal(store.automation('sales-checkin').time, '17:00');
  assert.equal(store.commitments('sales', weekKey(Date.now())).length, 7);
  assert.ok(store.crmLeads().every((l) => Number.isFinite(l.updatedAt)));
});
