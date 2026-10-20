import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHANNELS, MEMBERS, avatarOf, insertMember, seedAvatars, seedConnections, seedLeads, seedPersonas, seedPipeline } from './seed.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  title     TEXT NOT NULL DEFAULT '',
  is_demo   INTEGER NOT NULL DEFAULT 0,
  is_owner  INTEGER NOT NULL DEFAULT 0,
  owner_id  TEXT REFERENCES members(id),
  color     TEXT NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  topic  TEXT NOT NULL DEFAULT '',
  sort   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id),
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(channel_id, id);
`;

// Each entry upgrades the schema by one version (PRAGMA user_version).
const MIGRATIONS = [
  // v1: agent profiles, threads and agent jobs.
  `
  ALTER TABLE members ADD COLUMN model TEXT;
  ALTER TABLE members ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE members ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
  ALTER TABLE messages ADD COLUMN thread_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;
  ALTER TABLE messages ADD COLUMN meta TEXT;
  CREATE INDEX messages_by_thread ON messages(thread_id, id);
  CREATE TABLE jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT NOT NULL REFERENCES members(id),
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    thread_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    reply_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    started_at   INTEGER,
    finished_at  INTEGER
  );
  CREATE INDEX jobs_by_status ON jobs(status, id);
  CREATE INDEX jobs_by_thread ON jobs(thread_id, id);
  `,
  // v2: connections (tools the team hooks up), the demo CRM, and what each job looked up.
  `
  ALTER TABLE jobs ADD COLUMN activity TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE connections (
    id          TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 0,
    updated_by  TEXT REFERENCES members(id),
    updated_at  INTEGER
  );
  CREATE TABLE crm_leads (
    id    TEXT PRIMARY KEY,
    data  TEXT NOT NULL,
    sort  INTEGER NOT NULL DEFAULT 0
  );
  `,
  // v3: a usage log of every agent run, who asked for it, and a daily limit per agent.
  `
  ALTER TABLE jobs ADD COLUMN requested_by TEXT REFERENCES members(id);
  ALTER TABLE jobs ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN daily_runs_limit INTEGER;
  ALTER TABLE members ADD COLUMN daily_usd_limit REAL;
  UPDATE jobs SET requested_by = (SELECT member_id FROM messages WHERE messages.id = jobs.message_id);
  -- Append-only: no foreign keys, so the log outlives anything it points at.
  CREATE TABLE agent_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id              INTEGER,
    agent_id            TEXT NOT NULL,
    requested_by        TEXT,
    channel_id          TEXT,
    thread_id           INTEGER,
    runner              TEXT,
    model_alias         TEXT,
    model               TEXT,
    status              TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'blocked')),
    started_at          INTEGER NOT NULL,
    finished_at         INTEGER,
    duration_ms         INTEGER,
    cost_usd            REAL,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cache_read_tokens   INTEGER,
    cache_write_tokens  INTEGER,
    skills              TEXT NOT NULL DEFAULT '[]',
    lookups             INTEGER NOT NULL DEFAULT 0,
    error               TEXT
  );
  CREATE INDEX agent_runs_by_time ON agent_runs(started_at);
  CREATE INDEX agent_runs_by_agent ON agent_runs(agent_id, started_at);
  -- Runs from before the log existed, rebuilt from jobs and their replies.
  INSERT INTO agent_runs (job_id, agent_id, requested_by, channel_id, thread_id, runner, model_alias, model, status,
                          started_at, finished_at, duration_ms, cost_usd, input_tokens, output_tokens, skills, lookups, error)
  SELECT j.id, j.agent_id, j.requested_by, j.channel_id, j.thread_id,
         CASE WHEN json_extract(r.meta, '$.model') LIKE 'fake-%' THEN 'fake' ELSE 'claude' END,
         (SELECT model FROM members WHERE members.id = j.agent_id),
         json_extract(r.meta, '$.model'), j.status, j.started_at, j.finished_at,
         COALESCE(json_extract(r.meta, '$.durationMs'), j.finished_at - j.started_at),
         json_extract(r.meta, '$.costUsd'), json_extract(r.meta, '$.inputTokens'), json_extract(r.meta, '$.outputTokens'),
         COALESCE(json_extract(r.meta, '$.skills'), '[]'), json_array_length(j.activity), j.error
  FROM jobs j LEFT JOIN messages r ON r.id = j.reply_id
  WHERE j.status IN ('done', 'failed') AND j.started_at IS NOT NULL
  ORDER BY j.id;
  `,
  // v4: the #sales work stream. Jobs can now come from an automation (no message to answer),
  // so their message and thread become optional; plus profiles, commitments and automations.
  `
  CREATE TABLE jobs_v4 (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id       TEXT NOT NULL REFERENCES members(id),
    channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id     INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    thread_id      INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    automation_id  TEXT,
    status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts       INTEGER NOT NULL DEFAULT 0,
    error          TEXT,
    reply_id       INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL,
    started_at     INTEGER,
    finished_at    INTEGER,
    activity       TEXT NOT NULL DEFAULT '[]',
    requested_by   TEXT REFERENCES members(id),
    blocked        INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO jobs_v4 (id, agent_id, channel_id, message_id, thread_id, status, attempts, error, reply_id,
                       created_at, started_at, finished_at, activity, requested_by, blocked)
  SELECT id, agent_id, channel_id, message_id, thread_id, status, attempts, error, reply_id,
         created_at, started_at, finished_at, activity, requested_by, blocked FROM jobs;
  DROP TABLE jobs;
  ALTER TABLE jobs_v4 RENAME TO jobs;
  CREATE INDEX jobs_by_status ON jobs(status, id);
  CREATE INDEX jobs_by_thread ON jobs(thread_id, id);
  CREATE INDEX jobs_by_channel ON jobs(channel_id, id);

  ALTER TABLE members ADD COLUMN focus TEXT NOT NULL DEFAULT '';
  ALTER TABLE members ADD COLUMN ask_about TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE channels ADD COLUMN features TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE commitments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    week        TEXT NOT NULL,
    owner_id    TEXT NOT NULL REFERENCES members(id),
    text        TEXT NOT NULL,
    lead_id     TEXT,
    status      TEXT NOT NULL CHECK (status IN ('open', 'done', 'dropped')),
    created_by  TEXT REFERENCES members(id),
    created_at  INTEGER NOT NULL,
    done_at     INTEGER,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX commitments_by_week ON commitments(channel_id, week, id);
  CREATE INDEX commitments_by_lead ON commitments(lead_id, done_at);

  CREATE TABLE automations (
    id                  TEXT PRIMARY KEY,
    channel_id          TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    agent_id            TEXT NOT NULL REFERENCES members(id),
    kind                TEXT NOT NULL,
    time                TEXT NOT NULL,
    weekdays_only       INTEGER NOT NULL DEFAULT 1,
    enabled             INTEGER NOT NULL DEFAULT 1,
    last_scheduled_day  TEXT,
    last_job_id         INTEGER,
    updated_by          TEXT REFERENCES members(id),
    updated_at          INTEGER
  );
  `,
  // v5: photos. avatar_ai marks an AI-generated portrait (the fictional teammates).
  `
  ALTER TABLE members ADD COLUMN avatar TEXT;
  ALTER TABLE members ADD COLUMN avatar_ai INTEGER NOT NULL DEFAULT 0;
  `,
  // v6: the pipeline board app in #sales.
  `
  UPDATE channels SET features = json_insert(features, '$[#]', 'pipeline')
  WHERE id = 'sales' AND NOT EXISTS (SELECT 1 FROM json_each(channels.features) WHERE value = 'pipeline');
  `,
  // v7: agents the team makes themselves. A persona in three parts (JSON: who, think, sound),
  // and when it was made. owner_id is who made it.
  `
  ALTER TABLE members ADD COLUMN persona TEXT;
  ALTER TABLE members ADD COLUMN created_at INTEGER;
  `,
];

function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      if (version === 0) {
        // Existing rooms get the agent profiles from the demo data.
        const update = db.prepare('UPDATE members SET title = ?, model = ?, skills = ?, instructions = ? WHERE id = ?');
        for (const m of MEMBERS.filter((m) => m.kind === 'agent')) {
          update.run(m.title, m.model, JSON.stringify(m.skills), m.instructions, m.id);
        }
      }
      // Existing rooms get the demo CRM, switched on.
      if (version === 1) seedConnections(db);
      // Existing agents get the default daily limits.
      if (version === 2) {
        const update = db.prepare('UPDATE members SET daily_runs_limit = ?, daily_usd_limit = ? WHERE id = ?');
        for (const m of MEMBERS.filter((m) => m.kind === 'agent')) update.run(m.dailyRunsLimit, m.dailyUsdLimit, m.id);
      }
      // Existing rooms get the #sales work stream: profiles, the Pipeline agent, dated leads,
      // this week's demo commitments and the 17:00 check-in. (Empty databases get it from the seed.)
      if (version === 3 && db.prepare('SELECT COUNT(*) AS n FROM members').get().n > 0) {
        const profile = db.prepare('UPDATE members SET focus = ?, ask_about = ? WHERE id = ?');
        for (const m of MEMBERS.filter((m) => m.kind === 'human')) profile.run(m.focus, JSON.stringify(m.askAbout), m.id);
        const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM members').get().n;
        for (const m of MEMBERS.filter((m) => m.kind === 'agent')) {
          if (!db.prepare('SELECT 1 FROM members WHERE id = ?').get(m.id)) insertMember(db, m, sort);
        }
        const features = db.prepare('UPDATE channels SET features = ? WHERE id = ?');
        for (const c of CHANNELS.filter((c) => c.features)) features.run(JSON.stringify(c.features), c.id);
        seedLeads(db);
        if (db.prepare("SELECT 1 FROM channels WHERE id = 'sales'").get()) seedPipeline(db);
      }
      if (version === 4) seedAvatars(db);
      if (version === 6) seedPersonas(db);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const toMember = (r) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  title: r.title,
  isDemo: r.is_demo === 1,
  isOwner: r.is_owner === 1,
  ownerId: r.owner_id,
  color: r.color,
  ...(r.kind === 'agent' && {
    model: r.model,
    skills: JSON.parse(r.skills),
    instructions: r.instructions,
    limits: { runs: r.daily_runs_limit ?? null, usd: r.daily_usd_limit ?? null },
    persona: r.persona ? JSON.parse(r.persona) : null,
    createdAt: r.created_at ?? null,
  }),
  ...(r.kind === 'human' && { focus: r.focus ?? '', askAbout: JSON.parse(r.ask_about ?? '[]') }),
  avatar: r.avatar ?? null,
  avatarAi: r.avatar_ai === 1,
});

const toChannel = (r) => ({ id: r.id, name: r.name, topic: r.topic, features: JSON.parse(r.features ?? '[]') });

const toCommitment = (r) => ({
  id: r.id,
  channelId: r.channel_id,
  week: r.week,
  ownerId: r.owner_id,
  text: r.text,
  leadId: r.lead_id,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  doneAt: r.done_at,
  updatedAt: r.updated_at,
});

const toAutomation = (r) => ({
  id: r.id,
  channelId: r.channel_id,
  agentId: r.agent_id,
  kind: r.kind,
  time: r.time,
  weekdaysOnly: r.weekdays_only === 1,
  enabled: r.enabled === 1,
  lastScheduledDay: r.last_scheduled_day,
  lastJobId: r.last_job_id,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

const toMessage = (r) => ({
  id: r.id,
  channelId: r.channel_id,
  memberId: r.member_id,
  body: r.body,
  createdAt: r.created_at,
  threadId: r.thread_id,
  ...(r.meta && { meta: JSON.parse(r.meta) }),
});

const toJob = (r) => ({
  id: r.id,
  agentId: r.agent_id,
  channelId: r.channel_id,
  messageId: r.message_id,
  threadId: r.thread_id,
  automationId: r.automation_id ?? null,
  status: r.status,
  attempts: r.attempts,
  error: r.error,
  replyId: r.reply_id,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  activity: JSON.parse(r.activity ?? '[]'),
  requestedBy: r.requested_by ?? null,
  blocked: r.blocked === 1,
});

const toRun = (r) => ({
  id: r.id,
  jobId: r.job_id,
  agentId: r.agent_id,
  requestedBy: r.requested_by,
  channelId: r.channel_id,
  threadId: r.thread_id,
  runner: r.runner,
  modelAlias: r.model_alias,
  model: r.model,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms,
  wallMs: r.finished_at && r.status !== 'blocked' ? r.finished_at - r.started_at : null,
  costUsd: r.cost_usd,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  skills: JSON.parse(r.skills),
  lookups: r.lookups,
  error: r.error,
});

// One row per group: how many runs, what they cost, how long they took.
const USAGE_COLUMNS = `
  SUM(status IN ('running', 'done', 'failed')) AS runs,
  SUM(status = 'done') AS done,
  SUM(status = 'failed') AS failed,
  SUM(status = 'blocked') AS blocked,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COALESCE(SUM(CASE WHEN status = 'done' THEN duration_ms END), 0) AS done_ms,
  COALESCE(SUM(CASE WHEN status = 'done' THEN finished_at - started_at END), 0) AS done_wall_ms,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens`;

const toUsage = (r) => ({
  runs: r.runs ?? 0,
  done: r.done ?? 0,
  failed: r.failed ?? 0,
  blocked: r.blocked ?? 0,
  costUsd: r.cost_usd ?? 0,
  // durationMs is what claude reports; wall time is how long the person waited (CLI start-up included).
  avgDurationMs: r.done ? Math.round(r.done_ms / r.done) : null,
  avgWallMs: r.done ? Math.round(r.done_wall_ms / r.done) : null,
  tokens: { input: r.input_tokens ?? 0, output: r.output_tokens ?? 0, cacheRead: r.cache_read_tokens ?? 0, cacheWrite: r.cache_write_tokens ?? 0 },
});

const PREVIEW_CHARS = 280;
const MAX_ATTEMPTS = 2;

export function createStore(db) {
  const q = {
    members: db.prepare('SELECT * FROM members ORDER BY sort, name'),
    member: db.prepare('SELECT * FROM members WHERE id = ?'),
    agentStats: db.prepare("SELECT agent_id, COUNT(*) AS done FROM jobs WHERE status = 'done' GROUP BY agent_id"),
    channels: db.prepare('SELECT * FROM channels ORDER BY sort, name'),
    channel: db.prepare('SELECT * FROM channels WHERE id = ?'),
    message: db.prepare('SELECT * FROM messages WHERE id = ?'),
    roots: db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT ?
      ) ORDER BY id`),
    rootsBefore: db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id`),
    replies: db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id'),
    repliesBefore: db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id`),
    replyCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?'),
    lastReply: db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1'),
    participants: db.prepare('SELECT member_id FROM messages WHERE thread_id = ? GROUP BY member_id ORDER BY MIN(id) LIMIT 5'),
    addMessage: db.prepare(`
      INSERT INTO messages (channel_id, member_id, body, created_at, thread_id, meta)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *`),

    job: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    addJob: db.prepare(`
      INSERT INTO jobs (agent_id, channel_id, message_id, thread_id, automation_id, requested_by, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING *`),
    blockJob: db.prepare(`
      UPDATE jobs SET status = 'failed', blocked = 1, error = ?, finished_at = ? WHERE id = ? AND status = 'queued' RETURNING *`),
    claimJob: db.prepare(`
      UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1, error = NULL
      WHERE id = ? AND status = 'queued' RETURNING *`),
    finishJob: db.prepare(`
      UPDATE jobs SET status = 'done', reply_id = ?, finished_at = ? WHERE id = ? AND status = 'running' RETURNING *`),
    failJob: db.prepare(`
      UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running' RETURNING *`),
    requeueJob: db.prepare(`
      UPDATE jobs SET status = 'queued', started_at = NULL WHERE id = ? AND status = 'running' RETURNING *`),
    requeueAllRunning: db.prepare(`
      UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`),
    queuedJobs: db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id"),
    activeJobs: db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY id"),
    openChannelJobs: db.prepare("SELECT * FROM jobs WHERE channel_id = ? AND status != 'done' ORDER BY id"),
    openThreadJobs: db.prepare("SELECT * FROM jobs WHERE thread_id = ? AND status != 'done' ORDER BY id"),
    addActivity: db.prepare(`
      UPDATE jobs SET activity = json_insert(activity, '$[#]', json(?)) WHERE id = ? AND status = 'running' RETURNING *`),

    connections: db.prepare('SELECT * FROM connections'),
    connection: db.prepare('SELECT * FROM connections WHERE id = ?'),
    setConnection: db.prepare(`
      INSERT INTO connections (id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      RETURNING *`),
    setLimits: db.prepare('UPDATE members SET daily_runs_limit = ?, daily_usd_limit = ? WHERE id = ? AND kind = \'agent\''),

    startRun: db.prepare(`
      INSERT INTO agent_runs (job_id, agent_id, requested_by, channel_id, thread_id, runner, model_alias, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?) RETURNING *`),
    blockedRun: db.prepare(`
      INSERT INTO agent_runs (job_id, agent_id, requested_by, channel_id, thread_id, model_alias, status, started_at, finished_at, error)
      VALUES (?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?) RETURNING *`),
    finishRun: db.prepare(`
      UPDATE agent_runs SET status = ?, finished_at = ?, model = COALESCE(?, model), duration_ms = ?, cost_usd = ?,
        input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, skills = ?, lookups = ?, error = ?
      WHERE id = ? AND status = 'running' RETURNING *`),
    closeStaleRuns: db.prepare(`
      UPDATE agent_runs SET status = 'failed', finished_at = ?, error = 'Team Room restarted during this run' WHERE status = 'running'`),
    runningRun: db.prepare("SELECT * FROM agent_runs WHERE job_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1"),
    agentToday: db.prepare(`
      SELECT SUM(status IN ('running', 'done', 'failed')) AS runs, COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM agent_runs WHERE agent_id = ? AND started_at >= ?`),
    usageTotal: db.prepare(`SELECT ${USAGE_COLUMNS} FROM agent_runs WHERE started_at >= ? AND started_at < ?`),
    usageByAgent: db.prepare(`SELECT agent_id AS key, ${USAGE_COLUMNS} FROM agent_runs WHERE started_at >= ? AND started_at < ? GROUP BY key`),
    usageByPerson: db.prepare(`SELECT requested_by AS key, ${USAGE_COLUMNS} FROM agent_runs WHERE started_at >= ? AND started_at < ? GROUP BY key`),
    usageByChannel: db.prepare(`SELECT channel_id AS key, ${USAGE_COLUMNS} FROM agent_runs WHERE started_at >= ? AND started_at < ? GROUP BY key`),
    usageByModel: db.prepare(`SELECT COALESCE(model, model_alias) AS key, ${USAGE_COLUMNS} FROM agent_runs WHERE started_at >= ? AND started_at < ? AND status != 'blocked' GROUP BY key`),
    usageRuns: db.prepare('SELECT * FROM agent_runs WHERE started_at >= ? AND started_at < ? ORDER BY id DESC LIMIT ?'),
    firstRun: db.prepare('SELECT MIN(started_at) AS at FROM agent_runs'),

    updateProfile: db.prepare("UPDATE members SET title = ?, focus = ?, ask_about = ? WHERE id = ? AND kind = 'human'"),
    addAgent: db.prepare(`
      INSERT INTO members (id, name, kind, title, owner_id, color, sort, model, skills, persona, daily_runs_limit, daily_usd_limit,
                           avatar, created_at)
      VALUES (?, ?, 'agent', ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM members), ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING RETURNING *`),

    commitments: db.prepare('SELECT * FROM commitments WHERE channel_id = ? AND week = ? ORDER BY id'),
    commitmentsOf: db.prepare("SELECT * FROM commitments WHERE owner_id = ? AND week = ? AND status != 'dropped' ORDER BY id"),
    commitment: db.prepare('SELECT * FROM commitments WHERE id = ?'),
    addCommitment: db.prepare(`
      INSERT INTO commitments (channel_id, week, owner_id, text, lead_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?) RETURNING *`),
    setCommitmentStatus: db.prepare(`
      UPDATE commitments SET status = ?, done_at = ?, updated_at = ? WHERE id = ? RETURNING *`),
    leadLastDone: db.prepare("SELECT MAX(done_at) AS at FROM commitments WHERE lead_id = ? AND status = 'done'"),

    automations: db.prepare('SELECT * FROM automations ORDER BY id'),
    automation: db.prepare('SELECT * FROM automations WHERE id = ?'),
    setAutomation: db.prepare('UPDATE automations SET enabled = ?, time = ?, updated_by = ?, updated_at = ? WHERE id = ? RETURNING *'),
    markScheduled: db.prepare(`
      UPDATE automations SET last_scheduled_day = ? WHERE id = ? AND COALESCE(last_scheduled_day, '') != ? RETURNING *`),
    setAutomationJob: db.prepare('UPDATE automations SET last_job_id = ? WHERE id = ?'),

    crmLeads: db.prepare('SELECT data FROM crm_leads ORDER BY sort, id'),
    crmLead: db.prepare('SELECT data FROM crm_leads WHERE id = ?'),
    setLeadStage: db.prepare(`
      UPDATE crm_leads SET data = json_set(data, '$.stage', ?, '$.updatedAt', ?, '$.updatedBy', ?) WHERE id = ? RETURNING data`),
  };

  const toConnection = (r) => ({ id: r.id, enabled: r.enabled === 1, updatedBy: r.updated_by, updatedAt: r.updated_at });

  function threadSummary(rootId) {
    const count = q.replyCount.get(rootId).n;
    if (count === 0) return null;
    const last = q.lastReply.get(rootId);
    return {
      count,
      participants: q.participants.all(rootId).map((r) => r.member_id),
      last: {
        memberId: last.member_id,
        createdAt: last.created_at,
        body: last.body.length > PREVIEW_CHARS ? `${last.body.slice(0, PREVIEW_CHARS)}…` : last.body,
      },
    };
  }

  const withThread = (m) => {
    const thread = threadSummary(m.id);
    return thread ? { ...m, thread } : m;
  };

  const store = {
    members: () => {
      const done = new Map(q.agentStats.all().map((r) => [r.agent_id, r.done]));
      return q.members.all().map(toMember).map((m) => (m.kind === 'agent' ? { ...m, jobsDone: done.get(m.id) ?? 0 } : m));
    },
    member: (id) => {
      const r = q.member.get(id);
      return r ? toMember(r) : null;
    },
    channels: () => q.channels.all().map(toChannel),
    channel: (id) => {
      const r = q.channel.get(id);
      return r ? toChannel(r) : null;
    },
    message: (id) => {
      const r = q.message.get(id);
      return r ? toMessage(r) : null;
    },
    // Top-level messages of a channel, each with a summary of its thread.
    messages: (channelId, limit = 200) => q.roots.all(channelId, limit).map(toMessage).map(withThread),
    thread: (rootId) => {
      const root = store.message(rootId);
      if (!root || root.threadId) return null;
      return { root: withThread(root), replies: q.replies.all(rootId).map(toMessage) };
    },
    addMessage: ({ channelId, memberId, body, threadId = null, meta = null, createdAt = Date.now() }) =>
      toMessage(q.addMessage.get(channelId, memberId, body, createdAt, threadId, meta ? JSON.stringify(meta) : null)),

    // What an agent sees before the message that mentioned it.
    context: ({ channelId, threadId, beforeId }) => {
      if (threadId === beforeId) return q.rootsBefore.all(channelId, beforeId, 12).map(toMessage);
      return [store.message(threadId), ...q.repliesBefore.all(threadId, beforeId, 20).map(toMessage)];
    },

    job: (id) => {
      const r = q.job.get(id);
      return r ? toJob(r) : null;
    },
    addJob: ({ agentId, channelId, messageId = null, threadId = null, automationId = null, requestedBy = null, createdAt = Date.now() }) =>
      toJob(q.addJob.get(agentId, channelId, messageId, threadId, automationId, requestedBy, createdAt)),
    // A waiting job that may not run (daily limit): it fails without ever starting.
    blockJob: (id, error, at = Date.now()) => {
      const r = q.blockJob.get(error, at, id);
      return r ? toJob(r) : null;
    },
    claimJob: (id, at = Date.now()) => {
      const r = q.claimJob.get(at, id);
      return r ? toJob(r) : null;
    },
    finishJob: (id, replyId, at = Date.now()) => toJob(q.finishJob.get(replyId, at, id)),
    failJob: (id, error, at = Date.now()) => {
      const r = q.failJob.get(error, at, id);
      return r ? toJob(r) : null;
    },
    // A worker went away mid-job: try again later, but give up after MAX_ATTEMPTS.
    requeueJob: (id, reason, at = Date.now()) => {
      const job = store.job(id);
      if (!job || job.status !== 'running') return null;
      if (job.attempts >= MAX_ATTEMPTS) return store.failJob(id, reason, at);
      return toJob(q.requeueJob.get(id));
    },
    requeueAllRunning: () => q.requeueAllRunning.run(),
    queuedJobs: () => q.queuedJobs.all().map(toJob),
    activeJobs: () => q.activeJobs.all().map(toJob),
    openChannelJobs: (channelId) => q.openChannelJobs.all(channelId).map(toJob),
    openThreadJobs: (threadId) => q.openThreadJobs.all(threadId).map(toJob),
    addJobActivity: (id, entry) => {
      const r = q.addActivity.get(JSON.stringify(entry), id);
      return r ? toJob(r) : null;
    },

    // Connection state (on/off). What each connector can do lives in src/connectors.
    connections: () => q.connections.all().map(toConnection),
    connection: (id) => {
      const r = q.connection.get(id);
      return r ? toConnection(r) : { id, enabled: false, updatedBy: null, updatedAt: null };
    },
    setConnection: (id, enabled, memberId, at = Date.now()) => toConnection(q.setConnection.get(id, enabled ? 1 : 0, memberId, at)),

    setAgentLimits: (id, { runs, usd }) => q.setLimits.run(runs, usd, id).changes === 1,

    /* ---------- usage log ---------- */
    startRun: ({ job, runner = null, modelAlias = null, at = Date.now() }) =>
      toRun(q.startRun.get(job.id, job.agentId, job.requestedBy, job.channelId, job.threadId, runner, modelAlias, at)),
    logBlocked: ({ job, modelAlias = null, error, at = Date.now() }) =>
      toRun(q.blockedRun.get(job.id, job.agentId, job.requestedBy, job.channelId, job.threadId, modelAlias, at, at, error)),
    // Closes the open run of a job with whatever claude reported (all optional).
    finishRun: (jobId, { status, at = Date.now(), model = null, durationMs = null, costUsd = null, inputTokens = null, outputTokens = null,
      cacheReadTokens = null, cacheWriteTokens = null, skills = [], lookups = 0, error = null }) => {
      const open = q.runningRun.get(jobId);
      if (!open) return null;
      const r = q.finishRun.get(status, at, model, durationMs ?? at - open.started_at, costUsd, inputTokens, outputTokens,
        cacheReadTokens, cacheWriteTokens, JSON.stringify(skills), lookups, error, open.id);
      return r ? toRun(r) : null;
    },
    closeStaleRuns: (at = Date.now()) => q.closeStaleRuns.run(at),
    agentToday: (agentId, since) => {
      const r = q.agentToday.get(agentId, since);
      return { runs: r.runs ?? 0, costUsd: r.cost_usd ?? 0 };
    },
    usage: ({ from, to, recent = 50 }) => {
      const grouped = (stmt) => stmt.all(from, to).map((r) => ({ key: r.key, ...toUsage(r) })).sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs);
      return {
        totals: toUsage(q.usageTotal.get(from, to)),
        byAgent: grouped(q.usageByAgent),
        byPerson: grouped(q.usageByPerson),
        byChannel: grouped(q.usageByChannel),
        byModel: grouped(q.usageByModel),
        recent: q.usageRuns.all(from, to, recent).map(toRun),
      };
    },
    // Runs in [from, to), for the daily series (the caller buckets them by local day).
    runsBetween: (from, to) => q.usageRuns.all(from, to, 100_000).map(toRun),
    firstRunAt: () => q.firstRun.get().at ?? null,

    updateProfile: (id, { title, focus, askAbout }) => q.updateProfile.run(title, focus, JSON.stringify(askAbout), id).changes === 1,
    // A teammate made an agent. Null if the handle is already taken.
    addAgent: ({ id, name, title, ownerId, model, skills, persona, limits, color = '#55606e', at = Date.now() }) => {
      const r = q.addAgent.get(id, name, title, ownerId, color, model, JSON.stringify(skills), JSON.stringify(persona),
        limits.runs, limits.usd, avatarOf({ kind: 'agent' }).avatar, at);
      return r ? toMember(r) : null;
    },

    /* ---------- commitments (weekly tracker) ---------- */
    commitments: (channelId, week) => q.commitments.all(channelId, week).map(toCommitment),
    commitmentsOf: (memberId, week) => q.commitmentsOf.all(memberId, week).map(toCommitment),
    commitment: (id) => {
      const r = q.commitment.get(id);
      return r ? toCommitment(r) : null;
    },
    addCommitment: ({ channelId, week, ownerId, text, leadId = null, createdBy, at = Date.now() }) =>
      toCommitment(q.addCommitment.get(channelId, week, ownerId, text, leadId, createdBy, at, at)),
    setCommitmentStatus: (id, status, at = Date.now()) =>
      toCommitment(q.setCommitmentStatus.get(status, status === 'done' ? at : null, at, id)),
    // When a lead last moved because someone finished a commitment on it.
    leadLastDone: (leadId) => q.leadLastDone.get(leadId).at ?? null,

    /* ---------- automations ---------- */
    automations: () => q.automations.all().map(toAutomation),
    automation: (id) => {
      const r = q.automation.get(id);
      return r ? toAutomation(r) : null;
    },
    setAutomation: (id, { enabled, time, by, at = Date.now() }) => toAutomation(q.setAutomation.get(enabled ? 1 : 0, time, by, at, id)),
    // Claims today's scheduled run; false if it already ran today (so it fires once a day).
    markScheduled: (id, day) => Boolean(q.markScheduled.get(day, id, day)),
    setAutomationJob: (id, jobId) => q.setAutomationJob.run(jobId, id),

    crmLeads: () => q.crmLeads.all().map((r) => JSON.parse(r.data)),
    crmLead: (id) => {
      const r = q.crmLead.get(id);
      return r ? JSON.parse(r.data) : null;
    },
    // A person moved a lead on the pipeline board; that counts as the lead moving.
    setLeadStage: (id, stage, memberId, at = Date.now()) => {
      const r = q.setLeadStage.get(stage, at, memberId, id);
      return r ? JSON.parse(r.data) : null;
    },
  };
  return store;
}
