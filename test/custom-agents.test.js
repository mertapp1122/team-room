import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, createStore } from '../src/db.js';
import { seed } from '../src/seed.js';
import { handleFor } from '../src/app.js';
import { buildSystemPrompt } from '../src/agents/prompt.js';
import { WORK_DIR, downgrade, setup, testRunner } from './helpers.js';

const PERSONA = {
  who: 'A veteran copywriter who has written for bakeries and dentists.',
  think: 'Find the one benefit the reader cares about, then cut everything else.',
  sound: 'Dry, short sentences. Never uses exclamation marks.',
};
const NEW_AGENT = { memberId: 'ayse', name: 'Copy Coach', goodAt: ['Cold emails', 'Subject lines'], model: 'sonnet', persona: PERSONA };

async function create(base, body) {
  const res = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('a name becomes an @handle', () => {
  assert.equal(handleFor('Copy Coach'), 'copy-coach');
  assert.equal(handleFor("Ayşe's Işık Bot"), 'ayses-isik-bot');
  assert.equal(handleFor('  Ünal  3000 '), 'unal-3000');
  assert.equal(handleFor('—'), '');
});

test('a person makes an agent; every window sees it with its persona, model and maker', async (t) => {
  const { base, watch } = await setup(t, { now: () => new Date('2026-10-14T11:00').getTime() });
  const alex = await watch('alex');

  const made = await create(base, NEW_AGENT);
  assert.equal(made.status, 201);
  assert.equal(made.body.id, 'copy-coach');
  assert.equal(made.body.kind, 'agent');
  assert.equal(made.body.model, 'sonnet');
  assert.equal(made.body.ownerId, 'ayse');
  assert.equal(made.body.title, "Ayşe's agent: Cold emails, Subject lines");
  assert.deepEqual(made.body.skills, ['Cold emails', 'Subject lines']);
  assert.deepEqual(made.body.persona, PERSONA);
  assert.deepEqual(made.body.limits, { runs: 30, usd: 3 });
  assert.equal(made.body.avatar, '/img/agents/claude.svg');
  assert.equal(made.body.createdAt, new Date('2026-10-14T11:00').getTime());
  assert.equal(made.body.instructions, undefined);

  const live = await alex.next('member', (e) => e.member.id === 'copy-coach');
  assert.deepEqual(live.member, made.body);
  assert.deepEqual(live.today, { runs: 0, costUsd: 0 });

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(state.members.find((m) => m.id === 'copy-coach'), { ...made.body, jobsDone: 0 });
  assert.deepEqual(state.today['copy-coach'], { runs: 0, costUsd: 0 });
  // The demo agents have personas too.
  assert.ok(state.members.filter((m) => m.kind === 'agent').every((a) => a.persona?.who && a.persona.think && a.persona.sound));
});

test('the form is checked on the server', async (t) => {
  const { base } = await setup(t);
  const bad = async (patch, status, pattern) => {
    const res = await create(base, { ...NEW_AGENT, ...patch });
    assert.equal(res.status, status, JSON.stringify(patch));
    assert.match(res.body.error, pattern);
  };
  await bad({ memberId: 'scout' }, 403, /only people/);
  await bad({ memberId: 'nobody' }, 403, /only people/);
  await bad({ name: 'X' }, 400, /2 to 40/);
  await bad({ name: '!!' }, 400, /two letters/);
  await bad({ goodAt: [] }, 400, /good at/);
  await bad({ goodAt: 'Cold emails' }, 400, /good at/);
  await bad({ model: 'gpt-4' }, 400, /haiku, sonnet or opus/);
  await bad({ model: 'constructor' }, 400, /haiku, sonnet or opus/);
  await bad({ persona: { ...PERSONA, sound: '  ' } }, 400, /how you sound/);
  await bad({ persona: { ...PERSONA, who: 'x'.repeat(401) } }, 400, /who you are/);
  await bad({ persona: null }, 400, /who you are/);
  // Handles are unique, people included.
  await bad({ name: 'Scout' }, 409, /@scout is taken/);
  await bad({ name: 'Alex' }, 409, /@alex is taken/);
  assert.equal((await create(base, NEW_AGENT)).status, 201);
  await bad({ name: 'copy  coach' }, 409, /@copy-coach is taken/);
  // Opus starts with a tighter daily limit.
  assert.deepEqual((await create(base, { ...NEW_AGENT, name: 'Deep Thinker', model: 'opus' })).body.limits, { runs: 10, usd: 5 });
});

test('the persona reaches claude through the system prompt', () => {
  const store = createStore((() => { const db = openDb(':memory:'); seed(db); return db; })());
  const agent = store.addAgent({ id: 'copy-coach', name: 'Copy Coach', title: 't', ownerId: 'ayse', model: 'haiku', skills: ['Cold emails'], persona: PERSONA, limits: { runs: 1, usd: 1 } });
  const prompt = buildSystemPrompt(agent);
  assert.match(prompt, /You are Copy Coach/);
  assert.match(prompt, /Who you are: A veteran copywriter/);
  assert.match(prompt, /How you think: Find the one benefit/);
  assert.match(prompt, /How you sound: Dry, short sentences/);
  // The persona sets the voice; the pricing rule still comes after it.
  assert.ok(prompt.indexOf('How you sound') < prompt.indexOf('$799/month'));
  assert.doesNotMatch(buildSystemPrompt({ ...agent, persona: null }), /Your persona/);
});

test('a worker that was already running answers for the new agent, in its voice', async (t) => {
  const { base, post, watch, worker } = await setup(t);
  const ayse = await watch('ayse');
  const runner = testRunner();
  worker(runner);
  // A worker for named agents only keeps to its list.
  const scoutOnly = testRunner();
  worker(scoutOnly, { agents: ['scout'] });
  await ayse.next('presence', (p) => p.online.includes('alex-claude'));

  await create(base, NEW_AGENT);
  await ayse.next('presence', (p) => p.online.includes('copy-coach'));

  const sent = await post('sales', { memberId: 'ayse', body: '@copy-coach a subject line for the Northwind (demo) offer?' });
  const reply = await ayse.next('message', (m) => m.memberId === 'copy-coach');
  assert.equal(reply.threadId, sent.body.id);
  assert.equal(runner.calls.length, 1);
  assert.equal(scoutOnly.calls.length, 0);
  const [call] = runner.calls;
  assert.equal(call.agent.model, 'sonnet');
  assert.deepEqual(call.agent.persona, PERSONA);
  assert.match(call.systemPrompt, /How you sound: Dry, short sentences\. Never uses exclamation marks\./);

  const usage = await (await fetch(`${base}/api/usage?range=today`)).json();
  assert.equal(usage.byAgent.find((r) => r.key === 'copy-coach').runs, 1);
});

test('upgrading a step 8 room gives the demo agents their personas', (t) => {
  const dir = join(WORK_DIR, 'upgrade-7');
  const file = join(dir, 'room.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(dir, { recursive: true, force: true });
  const db = openDb(file);
  seed(db);
  downgrade(db, 6);
  db.close();

  const upgraded = openDb(file);
  t.after(() => upgraded.close());
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7);
  const store = createStore(upgraded);
  assert.match(store.member('pipeline').persona.sound, /Warm and brief/);
  assert.equal(store.member('pipeline').ownerId, 'alex');
});
