import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, createStore } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/app.js';

let server;
let base;

before(async () => {
  const db = openDb(':memory:');
  seed(db);
  server = createApp({ store: createStore(db) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const getJson = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

const post = async (channel, payload) => {
  const res = await fetch(`${base}/api/channels/${channel}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

// Opens /api/events and lets a test wait for the next event of a given type (and shape).
async function openStream(as) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events?as=${as}`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  let buffer = '';

  async function next(type, match = () => true) {
    for (;;) {
      const i = queue.findIndex((e) => e.event === type && match(e.data));
      if (i >= 0) return queue.splice(i, 1)[0].data;
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before "${type}"`);
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (event && data) queue.push({ event, data: JSON.parse(data) });
      }
    }
  }
  return { next, close: () => controller.abort() };
}

test('state lists channels, people and agents with demo labels', async () => {
  const { status, body } = await getJson('/api/state');
  assert.equal(status, 200);
  assert.deepEqual(body.channels.map((c) => c.id), ['general', 'sales', 'delivery', 'visibility', 'research', 'ecommerce']);

  const humans = body.members.filter((m) => m.kind === 'human');
  const agents = body.members.filter((m) => m.kind === 'agent');
  assert.ok(agents.length >= 2, 'has agent members');
  const alex = humans.find((m) => m.id === 'alex');
  assert.equal(alex.isOwner, true);
  assert.equal(alex.isDemo, false);
  for (const m of humans.filter((h) => h.id !== 'alex')) assert.equal(m.isDemo, true, `${m.id} is labeled demo`);
});

test('seeded prices never go below $799/month', async () => {
  const { body } = await getJson('/api/state');
  const texts = body.channels.map((c) => c.topic);
  for (const c of body.channels) texts.push(...(await getJson(`/api/channels/${c.id}/messages`)).body.messages.map((m) => m.body));
  for (const price of texts.join('\n').matchAll(/\$(\d[\d,]*)/g)) {
    assert.ok(Number(price[1].replace(/,/g, '')) >= 799, `found ${price[0]}`);
  }
});

test('a posted message is stored and returned in order', async () => {
  const sent = await post('delivery', { memberId: 'selin', body: '  Draft two is up.  ' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.body, 'Draft two is up.');
  assert.equal(sent.body.memberId, 'selin');

  const { body } = await getJson('/api/channels/delivery/messages');
  assert.deepEqual(body.messages.at(-1), sent.body);
  const ids = body.messages.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test('another person sees the message live, and presence shows both', async () => {
  const alex = await openStream('alex');
  const ayse = await openStream('ayse');
  try {
    const hello = await ayse.next('hello');
    assert.ok(hello.online.includes('alex') && hello.online.includes('ayse'));

    const sent = await post('general', { memberId: 'alex', body: 'Can you see this, Ayşe?' });
    const received = await ayse.next('message');
    assert.deepEqual(received, sent.body);
    assert.deepEqual(await alex.next('message'), sent.body, 'sender gets it too');
  } finally {
    alex.close();
    ayse.close();
  }
});

test('presence drops a person when their last window closes', async () => {
  const watcher = await openStream('alex');
  await watcher.next('hello');
  const deniz = await openStream('deniz');
  await watcher.next('presence', (p) => p.online.includes('deniz'));
  deniz.close();
  const left = await watcher.next('presence', (p) => !p.online.includes('deniz'));
  assert.ok(left.online.includes('alex'));
  watcher.close();
});

test('rejects bad posts', async () => {
  assert.equal((await post('general', { memberId: 'alex', body: '   ' })).status, 400);
  assert.equal((await post('general', { memberId: 'nobody', body: 'hi' })).status, 400);
  assert.equal((await post('general', { memberId: 'scout', body: 'hi' })).status, 403, 'agents only post through the worker');
  assert.equal((await post('general', { memberId: 'alex', body: 'hi', threadId: 999999 })).status, 400, 'unknown thread');
  assert.equal((await post('nope', { memberId: 'alex', body: 'hi' })).status, 404);
  assert.equal((await post('general', { memberId: 'alex', body: 'x'.repeat(4001) })).status, 400);

  const bad = await fetch(`${base}/api/channels/general/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);

  // A form post from another site (no JSON content-type) is refused, so it can't trigger agents.
  const form = await fetch(`${base}/api/channels/general/messages`, { method: 'POST', body: JSON.stringify({ memberId: 'alex', body: '@scout hi' }) });
  assert.equal(form.status, 415);
});

test('serves the app and refuses paths outside public/', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Team Room<\/title>/);

  for (const path of ['/%2e%2e/package.json', '/..%2fsrc%2fapp.js', '/%E0%A4%A']) {
    const status = await new Promise((resolve, reject) => {
      http.get(base + path, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.ok(status === 404 || status === 400, `${path} -> ${status}`);
  }
});
