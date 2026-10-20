import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, createStore } from './db.js';
import { seed } from './seed.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 5500;
// Local only: agents run on this computer, so the room is not exposed to the network.
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.TEAMROOM_DB || fileURLToPath(new URL('../data/teamroom.db', import.meta.url));
const WITH_WORKER = !process.argv.includes('--no-worker');

const db = openDb(DB_FILE);
const store = createStore(db);
if (store.channels().length === 0) {
  seed(db);
  console.log('Empty database: loaded demo data.');
}

let worker = null;
const server = createApp({ store });
server.listen(PORT, HOST, () => {
  console.log(`Team Room running at http://localhost:${PORT}`);
  console.log(`Two windows: http://localhost:${PORT}/?as=alex and http://localhost:${PORT}/?as=ayse`);
  if (WITH_WORKER) {
    worker = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), {
      env: { ...process.env, TEAMROOM_URL: `http://127.0.0.1:${PORT}` },
    });
    worker.on('exit', (code) => {
      worker = null;
      if (code) console.log(`Agent worker exited with code ${code}; agents are offline. Restart it with: npm run worker`);
    });
  } else {
    console.log('Started without the agent worker: agents show as offline until you run: npm run worker');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    worker?.kill('SIGTERM');
    server.closeAllConnections();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
