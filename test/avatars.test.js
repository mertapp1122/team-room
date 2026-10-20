import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, createStore } from '../src/db.js';
import { PLACEHOLDER_PHOTO, seed } from '../src/seed.js';
import { WORK_DIR, downgrade, setup } from './helpers.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

test('people have photos or the placeholder, only the fictional ones are marked AI, agents use the Claude mark', async (t) => {
  const { base } = await setup(t);
  const { members } = await (await fetch(`${base}/api/state`)).json();
  for (const m of members) {
    assert.ok(m.avatar, `${m.id} has an avatar`);
    assert.ok(existsSync(join(PUBLIC, m.avatar)), `${m.avatar} exists`);
    if (m.kind === 'agent') {
      assert.equal(m.avatar, '/img/agents/claude.svg');
      assert.equal(m.avatarAi, false);
    } else {
      const photo = existsSync(join(PUBLIC, 'img/people', `${m.id}.jpg`)) ? `/img/people/${m.id}.jpg` : PLACEHOLDER_PHOTO;
      assert.equal(m.avatar, photo);
      assert.equal(m.avatarAi, m.isDemo, `${m.id}: AI portrait exactly when demo`);
    }
  }
  const owner = members.find((m) => m.id === 'alex');
  assert.deepEqual([owner.avatar, owner.avatarAi], [PLACEHOLDER_PHOTO, false], 'the owner gets the placeholder until they add a photo');

  const photo = await fetch(`${base}/img/people/ayse.jpg`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  const icon = await fetch(`${base}/img/agents/claude.svg`);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
});

test('upgrading a step 5 room gives everyone their photo', (t) => {
  const dir = join(WORK_DIR, 'upgrade-5');
  const file = join(dir, 'room.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(dir, { recursive: true, force: true });
  const db = openDb(file);
  seed(db);
  downgrade(db, 4);
  db.close();

  const upgraded = openDb(file);
  t.after(() => upgraded.close());
  const store = createStore(upgraded);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual([store.member('ayse').avatar, store.member('ayse').avatarAi], ['/img/people/ayse.jpg', true]);
  assert.deepEqual([store.member('alex').avatarAi, store.member('pipeline').avatar], [false, '/img/agents/claude.svg']);
});
