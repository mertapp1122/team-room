// Shared setup for tests that need a running room: an in-memory database,
// a server on a free port, browser-like event streams and in-process workers.
import { join } from 'node:path';
import { openDb, createStore } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { startWorker } from '../src/worker.js';
import { readEvents } from '../src/sse.js';

export const WORK_DIR = join(import.meta.dirname, '..', 'data', 'test-agents');

// A runner the test controls: it records every call and answers with `answer(args)`.
export function testRunner(answer = async ({ agent, question }) => ({ text: `${agent.name} says hi to: ${question}`, model: 'test-model', durationMs: 5, costUsd: 0.001 })) {
  const calls = [];
  return { kind: 'test', calls, run: async (args) => { calls.push(args); return answer(args); } };
}

export async function setup(t, { now } = {}) {
  const db = openDb(':memory:');
  seed(db);
  const store = createStore(db);
  const server = createApp({ store, ...(now && { now }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const workers = [];
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.close();
    await Promise.all(workers.map((w) => w.stop()));
    server.closeAllConnections();
    server.close();
  });

  const post = async (channel, payload) => {
    const res = await fetch(`${base}/api/channels/${channel}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  };

  // A browser window: waits for events matching a predicate.
  async function watch(as) {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events?as=${as}`, { signal: controller.signal });
    const iterator = readEvents(res.body)[Symbol.asyncIterator]();
    const seen = [];
    const stream = {
      async next(type, match = () => true) {
        const i = seen.findIndex((e) => e.event === type && match(e.data));
        if (i >= 0) return seen.splice(i, 1)[0].data;
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) throw new Error(`stream ended before "${type}"`);
          if (value.event === type && match(value.data)) return value.data;
          seen.push(value);
        }
      },
      close: () => controller.abort(),
    };
    streams.push(stream);
    await stream.next('hello');
    return stream;
  }

  const worker = (runner, options = {}) => {
    const w = startWorker({ url: base, runner, workDir: WORK_DIR, ...options });
    workers.push(w);
    return w;
  };

  return { base, store, server, post, watch, worker };
}


// Turns a current database back into an older schema version, to test upgrades.
export function downgrade(db, version) {
  if (version < 7) db.exec('ALTER TABLE members DROP COLUMN persona; ALTER TABLE members DROP COLUMN created_at;');
  db.exec(`UPDATE channels SET features = (SELECT json_group_array(value) FROM json_each(channels.features) WHERE value != 'pipeline');`);
  if (version >= 5) return db.exec(`PRAGMA user_version = ${version}`);
  db.exec(`
    ALTER TABLE members DROP COLUMN avatar;
    ALTER TABLE members DROP COLUMN avatar_ai;`);
  if (version >= 4) return db.exec(`PRAGMA user_version = ${version}`);
  db.exec(`
    DROP TABLE commitments;
    DROP TABLE automations;
    DELETE FROM members WHERE id = 'pipeline';
    ALTER TABLE jobs DROP COLUMN automation_id;
    ALTER TABLE members DROP COLUMN focus;
    ALTER TABLE members DROP COLUMN ask_about;
    ALTER TABLE channels DROP COLUMN features;`);
  if (version <= 2) {
    db.exec(`
      DROP TABLE agent_runs;
      ALTER TABLE jobs DROP COLUMN requested_by;
      ALTER TABLE jobs DROP COLUMN blocked;
      ALTER TABLE members DROP COLUMN daily_runs_limit;
      ALTER TABLE members DROP COLUMN daily_usd_limit;`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}
