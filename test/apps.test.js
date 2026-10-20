import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, createStore } from '../src/db.js';
import { seed } from '../src/seed.js';
import { staleLeads } from '../src/pipeline.js';
import { WORK_DIR, downgrade, setup, testRunner } from './helpers.js';

const json = async (res) => ({ status: res.status, body: await res.json() });
const get = (base, path) => fetch(base + path).then(json);
const send = (base, path, payload) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
}).then(json);

test('every channel has an Apps tab; #sales has the pipeline board and the commitments tracker', async (t) => {
  const { base } = await setup(t);
  const { body } = await get(base, '/api/channels/sales/apps');
  assert.deepEqual(body.apps.map((a) => a.id), ['pipeline', 'commitments']);

  const pipeline = body.apps[0].preview;
  assert.deepEqual(pipeline.stages.map((s) => [s.id, s.count]), [['new', 2], ['qualified', 1], ['proposal', 1], ['won', 1], ['lost', 1]]);
  assert.equal(pipeline.open, 4);
  assert.equal(pipeline.openValuePerMonth, 900 + 600 + 2500 + 1200);
  assert.equal(pipeline.stale, 3);

  const commitments = body.apps[1].preview;
  assert.deepEqual([commitments.done, commitments.total], [3, 7]);
  assert.deepEqual(commitments.checkin, { time: '17:00', enabled: true, weekdaysOnly: true });

  assert.deepEqual((await get(base, '/api/channels/general/apps')).body.apps, [], 'other channels have an empty Apps tab');
  assert.equal((await get(base, '/api/channels/nope/apps')).status, 404);
  assert.equal((await get(base, '/api/channels/general/pipeline')).status, 404);
});

test('moving a lead on the board moves it for everyone and posts a line in #sales', async (t) => {
  const room = await setup(t);
  const alex = await room.watch('alex');
  const board = await get(room.base, '/api/channels/sales/pipeline');
  assert.deepEqual(board.body.stages, ['new', 'qualified', 'proposal', 'won', 'lost']);
  const northwind = board.body.leads.find((l) => l.id === 'L-101');
  assert.deepEqual([northwind.stage, northwind.stale, northwind.budgetPerMonth], ['qualified', true, 900]);

  const moved = await send(room.base, '/api/channels/sales/pipeline/L-101', { memberId: 'ayse', stage: 'proposal', from: 'qualified' });
  assert.equal(moved.status, 200);
  assert.deepEqual([moved.body.lead.stage, moved.body.lead.stale], ['proposal', false], 'a move counts as the lead moving');

  const lead = await alex.next('lead', (l) => l.id === 'L-101');
  assert.equal(lead.stage, 'proposal');
  const line = await alex.next('message', (m) => m.meta?.app === 'pipeline');
  assert.deepEqual([line.channelId, line.memberId, line.threadId], ['sales', 'ayse', null]);
  assert.equal(line.body, 'Moved Northwind Bakery (demo) (L-101) from Qualified to Proposal on the pipeline board.');
  assert.deepEqual(line.meta, { app: 'pipeline', leadId: 'L-101', company: 'Northwind Bakery (demo)', from: 'qualified', to: 'proposal' });
  const checkin = await alex.next('automation');
  assert.ok(!checkin.wouldNudge.some((l) => l.id === 'L-101'), 'the check-in stops nudging a lead that just moved');

  // The CRM the agents read has the new stage too.
  assert.equal(room.store.crmLead('L-101').stage, 'proposal');
  assert.equal(room.store.crmLead('L-101').updatedBy, 'ayse');
  assert.ok(!staleLeads(room.store, Date.now()).some((l) => l.id === 'L-101'));
  const { body: chat } = await get(room.base, '/api/channels/sales/messages');
  assert.equal(chat.messages.at(-1).id, line.id);
});

test('the board refuses agents, unknown stages and out-of-date moves', async (t) => {
  const { base, store } = await setup(t);
  const move = (payload, lead = 'L-103', channel = 'sales') => send(base, `/api/channels/${channel}/pipeline/${lead}`, payload);
  assert.equal((await move({ memberId: 'pipeline', stage: 'qualified' })).status, 403, 'agents read the CRM, never change it');
  assert.equal((await move({ memberId: 'nobody', stage: 'qualified' })).status, 400);
  assert.equal((await move({ memberId: 'ayse', stage: 'signed' })).status, 400);
  assert.equal((await move({ memberId: 'ayse', stage: 'qualified' }, 'L-999')).status, 404);
  assert.equal((await move({ memberId: 'ayse', stage: 'qualified' }, 'L-103', 'general')).status, 404);

  // Deniz's board still showed Harbor Dental as "qualified" when Ayşe had it in "new".
  const late = await move({ memberId: 'deniz', stage: 'proposal', from: 'qualified' });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /already in New/);

  const before = store.messages('sales').length;
  const same = await move({ memberId: 'ayse', stage: 'new' });
  assert.deepEqual([same.status, same.body.message], [200, null], 'dropping a card where it was posts nothing');
  assert.equal(store.messages('sales').length, before);
});

test('agents see board moves in the channel history', async (t) => {
  const room = await setup(t);
  const ayse = await room.watch('ayse');
  const runner = testRunner();
  room.worker(runner);
  await ayse.next('presence', (p) => p.online.includes('pipeline'));

  await send(room.base, '/api/channels/sales/pipeline/L-105', { memberId: 'burak', stage: 'qualified' });
  await room.post('sales', { memberId: 'alex', body: '@pipeline what moved today?' });
  await ayse.next('message', (m) => m.memberId === 'pipeline');
  assert.match(runner.calls[0].prompt, /Burak Tan \(E-commerce lead, demo teammate\): Moved Maple & Thread \(demo\) \(L-105\) from New to Qualified on the pipeline board\./);
  assert.match(runner.calls[0].systemPrompt, /people move leads on the #sales pipeline board/);
});

test('upgrading a step 7 room adds the pipeline board to #sales', (t) => {
  const dir = join(WORK_DIR, 'upgrade-6');
  const file = join(dir, 'room.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(dir, { recursive: true, force: true });
  const db = openDb(file);
  seed(db);
  downgrade(db, 5);
  assert.deepEqual(JSON.parse(db.prepare("SELECT features FROM channels WHERE id = 'sales'").get().features), ['commitments', 'checkin']);
  db.close();

  const upgraded = openDb(file);
  t.after(() => upgraded.close());
  const store = createStore(upgraded);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(store.channel('sales').features, ['commitments', 'checkin', 'pipeline']);
  assert.deepEqual(store.channel('general').features, []);
});
