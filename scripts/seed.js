import { fileURLToPath } from 'node:url';
import { openDb, createStore } from '../src/db.js';
import { seed } from '../src/seed.js';

const DB_FILE = process.env.TEAMROOM_DB || fileURLToPath(new URL('../data/teamroom.db', import.meta.url));

const db = openDb(DB_FILE);
seed(db);
const store = createStore(db);
const messages = store.channels().reduce((n, c) => n + store.messages(c.id).length, 0);
console.log(`Reset ${DB_FILE}: ${store.members().length} members, ${store.channels().length} channels, ${messages} messages.`);
db.close();
