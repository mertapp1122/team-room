import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, buildSystemPrompt } from './agents/prompt.js';
import { channelApps } from './apps.js';
import { CONNECTORS, ToolError, describeConnector } from './connectors/index.js';
import { STAGES, STAGE_LABELS } from './connectors/demo-crm.js';
import { SKILLS_DIR, loadSkills } from './skills.js';
import { buildCheckinPrompt, checkinFacts, ensureNudges, pipelineLeads, staleLeads } from './pipeline.js';
import { HOUR, addDays, atTime, dayKey, isClockTime, isDayKey, isWeekday, startOfDay, weekKey, weekStart } from './time.js';
import { sseHeaders, writeEvent } from './sse.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_MESSAGE = 4000;
const MAX_AGENT_REPLY = 12_000;
const MAX_ERROR = 200;
const MAX_ACTIVITY = 30;
const MAX_COMMITMENT = 300;
const MAX_PERSONA_PART = 400;
// How smart a new agent is, and the daily limit it starts with (the owner can change it on Usage).
const AGENT_MODELS = {
  haiku: { runs: 50, usd: 1 },
  sonnet: { runs: 30, usd: 3 },
  opus: { runs: 10, usd: 5 },
};
const SCHEDULE_TICK_MS = 30_000;
const SCHEDULE_WINDOW_MS = 2 * HOUR; // a missed 17:00 still runs until 19:00, never later
const MAX_REQUEST = 64 * 1024;
const HEARTBEAT_MS = 25_000;
// @handle, but not the middle of an e-mail address.
const MENTION = /(?<![\w.@-])@([a-z0-9][a-z0-9-]*)/gi;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  // Requiring JSON means a page on another site can't post here without a CORS preflight we never answer.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'send JSON (content-type: application/json)');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST) throw new HttpError(413, 'request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const finite = (v) => (Number.isFinite(v) ? v : null);
const DAY_RANGES = { today: 1, '7d': 7, '30d': 30 };
const MAX_CHART_DAYS = 90;

// What claude reported about one run. Everything is optional.
function runMetrics(p = {}) {
  return {
    model: typeof p.model === 'string' ? p.model.slice(0, 80) : null,
    durationMs: finite(p.durationMs),
    costUsd: finite(p.costUsd),
    inputTokens: finite(p.inputTokens),
    outputTokens: finite(p.outputTokens),
    cacheReadTokens: finite(p.cacheReadTokens),
    cacheWriteTokens: finite(p.cacheWriteTokens),
  };
}
const publicMember = ({ instructions, ...m }) => m;

// "Ayşe's Copy Coach" -> "ayses-copy-coach": the @handle people mention.
export function handleFor(name) {
  return name.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
}

export function createApp({ store, now = Date.now, skillsDir = SKILLS_DIR }) {
  const clients = new Set(); // browser windows: { res, memberId }
  const workers = new Map(); // workerId -> { res, agents: Set }
  const running = new Map(); // jobId -> workerId that claimed it

  // Jobs that were running when the server stopped get another go; their old runs are closed.
  store.requeueAllRunning();
  store.closeStaleRuns(now());

  const onlineAgents = () => new Set([...workers.values()].flatMap((w) => [...w.agents]));
  const online = () => [...new Set([...[...clients].map((c) => c.memberId).filter(Boolean), ...onlineAgents()])].sort();

  function broadcast(event, data) {
    for (const c of clients) writeEvent(c.res, event, data);
  }

  // Runs a change to who is connected and tells everyone if the online list changed.
  function presenceChange(fn) {
    const before = online().join();
    fn();
    if (online().join() !== before) broadcast('presence', { online: online() });
  }

  function dispatch(job) {
    for (const w of workers.values()) if (w.agents.has(job.agentId)) writeEvent(w.res, 'job', { id: job.id, agentId: job.agentId });
  }

  const skillSummaries = () => loadSkills(skillsDir).map(({ id, name, description, path }) => ({ id, name, description, path }));
  const connectionList = () => [...CONNECTORS.values()].map((c) => ({ ...describeConnector(c), ...store.connection(c.id) }));
  const enabledConnectors = () => [...CONNECTORS.values()].filter((c) => store.connection(c.id).enabled);

  /* ---------- usage and daily limits ---------- */

  const agentToday = (agentId) => store.agentToday(agentId, startOfDay(now()));

  // Why this agent may not start another run today, or null.
  function limitProblem(agent) {
    const { runs = null, usd = null } = agent.limits ?? {};
    if (runs === null && usd === null) return null;
    const today = agentToday(agent.id);
    if (runs !== null && today.runs >= runs) {
      return `${agent.name} reached its daily limit of ${runs} ${runs === 1 ? 'run' : 'runs'}. It resets at midnight.`;
    }
    if (usd !== null && today.costUsd >= usd) {
      return `${agent.name} reached its daily limit of $${usd.toFixed(2)} in API-equivalent usage. It resets at midnight.`;
    }
    return null;
  }

  function usageChanged(agentId) {
    broadcast('usage', { agentId, today: agentToday(agentId) });
  }

  function block(job, agent, reason) {
    const blocked = store.blockJob(job.id, reason, now());
    if (!blocked) return null;
    store.logBlocked({ job, modelAlias: agent.model, error: reason, at: now() });
    broadcast('job', blocked);
    usageChanged(agent.id);
    return blocked;
  }

  function usageReport(range) {
    const at = now();
    const today = startOfDay(at);
    const to = addDays(today, 1);
    const from = DAY_RANGES[range] ? addDays(today, 1 - DAY_RANGES[range]) : startOfDay(store.firstRunAt() ?? at);
    const report = store.usage({ from, to });

    // One bar per local day; a long "all" range shows its last 90 days.
    const chartFrom = Math.max(from, addDays(today, 1 - MAX_CHART_DAYS));
    const daily = [];
    const byDay = new Map();
    for (let d = chartFrom; d < to; d = addDays(d, 1)) {
      const bucket = { day: dayKey(d), runs: 0, costUsd: 0 };
      daily.push(bucket);
      byDay.set(bucket.day, bucket);
    }
    for (const run of store.runsBetween(chartFrom, to)) {
      const bucket = byDay.get(dayKey(run.startedAt));
      if (!bucket || run.status === 'blocked') continue;
      bucket.runs += 1;
      bucket.costUsd += run.costUsd ?? 0;
    }

    const agents = store.members().filter((m) => m.kind === 'agent')
      .map((a) => ({ id: a.id, model: a.model, limits: a.limits, today: agentToday(a.id) }));
    return { range, from, to, resetsAt: to, ...report, daily, agents };
  }

  async function setLimits(req, res, agentId) {
    const agent = store.member(agentId);
    if (agent?.kind !== 'agent') throw new HttpError(404, 'no such agent');
    const { memberId, runs = null, usd = null } = await readJson(req);
    if (!store.member(memberId)?.isOwner) throw new HttpError(403, 'only the owner can change limits');
    if (runs !== null && !(Number.isInteger(runs) && runs >= 1 && runs <= 10_000)) throw new HttpError(400, 'runs must be a whole number from 1 to 10000, or empty');
    if (usd !== null && !(Number.isFinite(usd) && usd >= 0.01 && usd <= 1000)) throw new HttpError(400, 'usd must be between 0.01 and 1000, or empty');
    const limits = { runs, usd: usd === null ? null : Math.round(usd * 100) / 100 };
    store.setAgentLimits(agent.id, limits);
    broadcast('limits', { agentId: agent.id, limits });
    sendJson(res, 200, { agentId: agent.id, limits, today: agentToday(agent.id) });
  }

  /* ---------- agents the team makes ---------- */

  // Any person can make an agent: a name, what it's good at, a model and a three-part persona.
  async function createAgent(req, res) {
    const { memberId, name, goodAt, model, persona } = await readJson(req);
    const member = typeof memberId === 'string' ? store.member(memberId) : null;
    if (member?.kind !== 'human') throw new HttpError(403, 'only people make agents');
    const title = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (title.length < 2 || title.length > 40) throw new HttpError(400, 'the name is 2 to 40 characters');
    const id = handleFor(title);
    if (id.length < 2) throw new HttpError(400, 'the name needs at least two letters or digits');
    const skills = Array.isArray(goodAt) ? goodAt.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
    if (!skills.length || skills.length > 6 || skills.some((x) => x.length > 60)) throw new HttpError(400, "what it's good at is 1 to 6 short items");
    if (!Object.hasOwn(AGENT_MODELS, model)) throw new HttpError(400, 'model is haiku, sonnet or opus');
    const parts = {};
    for (const [key, label] of [['who', 'who you are'], ['think', 'how you think'], ['sound', 'how you sound']]) {
      const text = typeof persona?.[key] === 'string' ? persona[key].trim() : '';
      if (!text || text.length > MAX_PERSONA_PART) throw new HttpError(400, `persona: "${label}" is 1 to ${MAX_PERSONA_PART} characters`);
      parts[key] = text;
    }
    const role = `${member.name.split(' ')[0]}'s agent: ${skills.join(', ')}`;
    const agent = store.addAgent({
      id, name: title, title: role.length > 100 ? `${role.slice(0, 99)}…` : role, ownerId: member.id, model, skills, persona: parts,
      limits: AGENT_MODELS[model], at: now(),
    });
    if (!agent) throw new HttpError(409, `@${id} is taken. Pick another name.`);
    // Workers that serve every agent serve this one too, from now on.
    presenceChange(() => {
      for (const w of workers.values()) if (w.all) w.agents.add(agent.id);
    });
    const view = publicMemberOf(agent.id);
    broadcast('member', { member: view, today: agentToday(agent.id) });
    sendJson(res, 201, view);
  }

  /* ---------- the #sales work stream: commitments, profiles, the daily check-in ---------- */

  const hasFeature = (channelId, feature) => store.channel(channelId)?.features.includes(feature);
  const publicMemberOf = (id) => publicMember(store.members().find((m) => m.id === id));

  function nextRunAt(a, at) {
    for (let i = 0; i < 8; i += 1) {
      const due = atTime(addDays(at, i), a.time);
      if (a.weekdaysOnly && !isWeekday(due)) continue;
      if (due > at || (i === 0 && a.lastScheduledDay !== dayKey(at) && at < due + SCHEDULE_WINDOW_MS)) return due;
    }
    return null;
  }

  function automationView(a) {
    const at = now();
    return {
      ...a,
      nextRunAt: a.enabled ? nextRunAt(a, at) : null,
      lastJob: a.lastJobId ? store.job(a.lastJobId) : null,
      wouldNudge: staleLeads(store, at).map(({ id, company, ownerId, movedAt }) => ({ id, company, ownerId, movedAt })),
    };
  }

  function triggerAutomation(a, requestedBy) {
    const agent = store.member(a.agentId);
    const job = store.addJob({ agentId: a.agentId, channelId: a.channelId, automationId: a.id, requestedBy, createdAt: now() });
    store.setAutomationJob(a.id, job.id);
    broadcast('job', job);
    const problem = limitProblem(agent);
    if (problem) block(job, agent, problem);
    else dispatch(job);
    broadcast('automation', automationView(store.automation(a.id)));
    return store.job(job.id);
  }

  // Fires each enabled automation once a day, at its time (weekdays only if set).
  function runDueAutomations() {
    const at = now();
    const fired = [];
    for (const a of store.automations()) {
      if (!a.enabled || (a.weekdaysOnly && !isWeekday(at))) continue;
      const due = atTime(at, a.time);
      if (at < due || at > due + SCHEDULE_WINDOW_MS) continue;
      if (!store.markScheduled(a.id, dayKey(at))) continue;
      fired.push(triggerAutomation(a, null));
    }
    return fired;
  }

  async function addCommitment(req, res, channelId) {
    if (!hasFeature(channelId, 'commitments')) throw new HttpError(404, 'this channel has no commitments tracker');
    const { memberId, ownerId = memberId, text, leadId = null, week = weekKey(now()) } = await readJson(req);
    const member = store.member(memberId);
    if (member?.kind !== 'human') throw new HttpError(400, 'unknown member');
    if (store.member(ownerId)?.kind !== 'human') throw new HttpError(400, 'commitments belong to people');
    if (ownerId !== member.id && !member.isOwner) throw new HttpError(403, 'only the owner can add commitments for someone else');
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body || body.length > MAX_COMMITMENT) throw new HttpError(400, `write the commitment in 1 to ${MAX_COMMITMENT} characters`);
    if (leadId !== null && !store.crmLead(leadId)) throw new HttpError(400, 'no such lead');
    if (!isDayKey(week) || weekKey(new Date(`${week}T12:00`).getTime()) !== week) throw new HttpError(400, 'week is the Monday it starts on, as YYYY-MM-DD');
    const commitment = store.addCommitment({ channelId, week, ownerId, text: body, leadId, createdBy: member.id, at: now() });
    broadcast('commitment', commitment);
    sendJson(res, 201, commitment);
  }

  async function updateCommitment(req, res, id) {
    const existing = store.commitment(id);
    if (!existing) throw new HttpError(404, 'no such commitment');
    const { memberId, status } = await readJson(req);
    const member = store.member(memberId);
    if (!member || (member.id !== existing.ownerId && !member.isOwner)) throw new HttpError(403, 'only its owner or the room owner can change a commitment');
    if (!['open', 'done', 'dropped'].includes(status)) throw new HttpError(400, 'status is open, done or dropped');
    const commitment = store.setCommitmentStatus(id, status, now());
    broadcast('commitment', commitment);
    // Finishing a commitment on a lead moves that lead, so the check-in preview changes.
    if (commitment.leadId) for (const a of store.automations()) broadcast('automation', automationView(a));
    sendJson(res, 200, commitment);
  }

  async function updateProfile(req, res, id) {
    const target = store.member(id);
    if (target?.kind !== 'human') throw new HttpError(404, 'no such person');
    const { memberId, title, focus = '', askAbout = [] } = await readJson(req);
    const member = store.member(memberId);
    if (!member || (member.id !== target.id && !member.isOwner)) throw new HttpError(403, 'only the person or the room owner can edit a profile');
    const role = typeof title === 'string' ? title.trim() : '';
    if (!role || role.length > 80) throw new HttpError(400, 'role is 1 to 80 characters');
    if (typeof focus !== 'string' || focus.trim().length > 200) throw new HttpError(400, 'working on is at most 200 characters');
    if (!Array.isArray(askAbout) || askAbout.length > 6 || askAbout.some((x) => typeof x !== 'string' || !x.trim() || x.trim().length > 40)) {
      throw new HttpError(400, 'ask me about is up to 6 short topics');
    }
    store.updateProfile(target.id, { title: role, focus: focus.trim(), askAbout: askAbout.map((x) => x.trim()) });
    const profile = publicMemberOf(target.id);
    broadcast('profile', profile);
    sendJson(res, 200, profile);
  }

  // What a person is on this week, for their profile.
  function personOverview(id) {
    const at = now();
    return {
      week: weekKey(at),
      commitments: store.commitmentsOf(id, weekKey(at)),
      leads: pipelineLeads(store, at).filter((l) => l.ownerId === id && l.open),
    };
  }

  async function automationAction(req, res, id, action) {
    const a = store.automation(id);
    if (!a) throw new HttpError(404, 'no such automation');
    const payload = await readJson(req);
    if (!store.member(payload.memberId)?.isOwner) throw new HttpError(403, 'only the room owner can run or change automations');
    if (action === 'run') return sendJson(res, 202, { job: triggerAutomation(a, payload.memberId), automation: automationView(store.automation(id)) });
    const enabled = payload.enabled ?? a.enabled;
    const time = payload.time ?? a.time;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    if (!isClockTime(time)) throw new HttpError(400, 'time is HH:MM, 24-hour');
    const view = automationView(store.setAutomation(id, { enabled, time, by: payload.memberId, at: now() }));
    broadcast('automation', view);
    sendJson(res, 200, view);
  }

  /* ---------- channel apps: previews, and the #sales pipeline board ---------- */

  function appsOf(channelId) {
    const c = store.channel(channelId);
    if (!c) throw new HttpError(404, 'no such channel');
    const at = now();
    return channelApps(c).map(({ id, name, description, preview }) => ({ id, name, description, preview: preview(store, c.id, at) }));
  }

  // A person drags a lead to another stage. Everyone's board follows, and the channel
  // gets a short line about it, which is how agents (and the history) learn of the move.
  async function moveLead(req, res, channelId, leadId) {
    if (!hasFeature(channelId, 'pipeline')) throw new HttpError(404, 'this channel has no pipeline board');
    const { memberId, stage, from = null } = await readJson(req);
    const member = typeof memberId === 'string' ? store.member(memberId) : null;
    if (!member) throw new HttpError(400, 'unknown member');
    if (member.kind !== 'human') throw new HttpError(403, 'only people move leads; agents read the CRM');
    if (!STAGES.includes(stage)) throw new HttpError(400, `stage is one of: ${STAGES.join(', ')}`);
    const lead = store.crmLead(leadId);
    if (!lead) throw new HttpError(404, 'no such lead');
    // The board was out of date: someone else moved this lead first.
    if (from !== null && from !== lead.stage) throw new HttpError(409, `${lead.company} is already in ${STAGE_LABELS[lead.stage]}`);
    const view = () => pipelineLeads(store, now()).find((l) => l.id === lead.id);
    if (lead.stage === stage) return sendJson(res, 200, { lead: view(), message: null });

    store.setLeadStage(lead.id, stage, member.id, now());
    const message = store.addMessage({
      channelId,
      memberId: member.id,
      body: `Moved ${lead.company} (${lead.id}) from ${STAGE_LABELS[lead.stage]} to ${STAGE_LABELS[stage]} on the pipeline board.`,
      meta: { app: 'pipeline', leadId: lead.id, company: lead.company, from: lead.stage, to: stage },
      createdAt: now(),
    });
    const moved = view();
    broadcast('lead', moved);
    broadcast('message', message);
    // A moved lead is no longer stalled, so the check-in preview changes.
    for (const a of store.automations()) broadcast('automation', automationView(a));
    sendJson(res, 200, { lead: moved, message });
  }

  function mentionedAgents(text) {
    const ids = new Set([...text.matchAll(MENTION)].map((m) => m[1].toLowerCase()));
    return [...ids].filter((id) => store.member(id)?.kind === 'agent');
  }

  /* ---------- browsers ---------- */

  function events(req, res, url) {
    const as = url.searchParams.get('as');
    const member = as ? store.member(as) : null;
    const client = { res, memberId: member?.kind === 'human' ? member.id : null };

    res.writeHead(200, sseHeaders);
    res.write('retry: 2000\n\n');
    presenceChange(() => clients.add(client));
    writeEvent(res, 'hello', { online: online(), jobs: store.activeJobs() });

    req.on('close', () => presenceChange(() => clients.delete(client)));
  }

  async function postMessage(req, res, channelId) {
    if (!store.channel(channelId)) throw new HttpError(404, 'no such channel');
    const { memberId, body, threadId = null } = await readJson(req);
    const member = typeof memberId === 'string' ? store.member(memberId) : null;
    if (!member) throw new HttpError(400, 'unknown member');
    if (member.kind !== 'human') throw new HttpError(403, 'agents post through the worker');
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) throw new HttpError(400, 'message is empty');
    if (text.length > MAX_MESSAGE) throw new HttpError(400, `message is longer than ${MAX_MESSAGE} characters`);
    if (threadId !== null) {
      const root = Number.isInteger(threadId) ? store.message(threadId) : null;
      if (!root || root.channelId !== channelId || root.threadId) throw new HttpError(400, 'no such thread in this channel');
    }

    const message = store.addMessage({ channelId, memberId: member.id, body: text, threadId, createdAt: now() });
    broadcast('message', message);

    for (const agentId of mentionedAgents(text)) {
      const job = store.addJob({ agentId, channelId, messageId: message.id, threadId: threadId ?? message.id, requestedBy: member.id, createdAt: now() });
      broadcast('job', job);
      const agent = store.member(agentId);
      const problem = limitProblem(agent);
      if (problem) block(job, agent, problem);
      else dispatch(job);
    }
    sendJson(res, 201, message);
  }

  /* ---------- the agent worker ---------- */

  function workerStream(req, res, url) {
    const agents = store.members().filter((m) => m.kind === 'agent').map((m) => m.id);
    const wanted = url.searchParams.get('agents')?.split(',').filter(Boolean) ?? agents;
    const unknown = wanted.filter((id) => !agents.includes(id));
    if (unknown.length) throw new HttpError(400, `not agents: ${unknown.join(', ')}`);

    const workerId = randomUUID();
    res.writeHead(200, sseHeaders);
    // A worker started without an agent list serves every agent, including ones made later.
    presenceChange(() => workers.set(workerId, { res, agents: new Set(wanted), all: !url.searchParams.has('agents') }));
    writeEvent(res, 'hello', { workerId, agents: wanted });
    for (const job of store.queuedJobs()) if (wanted.includes(job.agentId)) writeEvent(res, 'job', { id: job.id, agentId: job.agentId });

    req.on('close', () => {
      presenceChange(() => workers.delete(workerId));
      for (const [jobId, owner] of running) {
        if (owner !== workerId) continue;
        running.delete(jobId);
        const job = store.requeueJob(jobId, 'The worker stopped twice while running this', now());
        if (!job) continue;
        store.finishRun(jobId, { status: 'failed', at: now(), error: 'The worker stopped before finishing' });
        usageChanged(job.agentId);
        broadcast('job', job);
        if (job.status === 'queued') dispatch(job);
      }
    });
  }

  async function workerJob(req, res, jobId, action) {
    const payload = await readJson(req);
    if (!workers.has(payload.workerId)) throw new HttpError(409, 'unknown worker; reconnect first');

    if (action === 'claim') {
      const waiting = store.job(jobId);
      if (waiting?.status === 'queued') {
        const problem = limitProblem(store.member(waiting.agentId));
        if (problem && block(waiting, store.member(waiting.agentId), problem)) throw new HttpError(409, 'daily limit reached');
      }
      const job = store.claimJob(jobId, now());
      if (!job) throw new HttpError(409, 'job is not waiting');
      running.set(job.id, payload.workerId);
      const agent = store.member(job.agentId);
      store.startRun({
        job,
        runner: typeof payload.runner === 'string' ? payload.runner.slice(0, 20) : null,
        modelAlias: typeof payload.model === 'string' ? payload.model.slice(0, 40) : agent.model,
        at: now(),
      });
      broadcast('job', job);
      usageChanged(agent.id);
      const channel = store.channel(job.channelId);
      const skills = loadSkills(skillsDir);
      const connections = enabledConnectors().map(describeConnector);
      const people = store.members().filter((m) => m.kind === 'human');
      let prompt;
      let question;
      if (job.automationId) {
        // An automation has no message to answer: the server works out the facts and the agent writes them up.
        prompt = buildCheckinPrompt({ channel, facts: checkinFacts(store, job.channelId, now()) });
        question = `Daily check-in for #${channel.name}`;
      } else {
        const trigger = store.message(job.messageId);
        const history = store.context({ channelId: job.channelId, threadId: job.threadId, beforeId: job.messageId });
        prompt = buildPrompt({ channel, history, trigger, members: store.members() });
        question = trigger.body;
      }
      return sendJson(res, 200, {
        job,
        agent: { id: agent.id, name: agent.name, model: agent.model, persona: agent.persona },
        skills: skills.map(({ id, name, description, content }) => ({ id, name, description, content })),
        connections,
        systemPrompt: buildSystemPrompt(agent, { skills, connections, people }),
        prompt,
        question,
      });
    }

    const job = store.job(jobId);
    if (!job || job.status !== 'running' || running.get(jobId) !== payload.workerId) throw new HttpError(409, 'job is not running on this worker');

    if (action === 'tools') {
      const connector = CONNECTORS.get(payload.connection);
      if (!connector) throw new HttpError(404, 'no such connection');
      if (!store.connection(connector.id).enabled) throw new HttpError(403, `${connector.name} is switched off`);
      const tool = connector.tools.find((t) => t.name === payload.tool);
      if (!tool) throw new HttpError(404, `${connector.name} has no tool "${payload.tool}"`);
      const input = payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input) ? payload.input : {};
      let out;
      try {
        out = tool.run(store, input);
      } catch (err) {
        if (err instanceof ToolError) throw new HttpError(400, err.message);
        throw err;
      }
      if (job.activity.length < MAX_ACTIVITY) {
        const updated = store.addJobActivity(jobId, { kind: 'tool', connection: connector.id, tool: tool.name, summary: out.summary, at: now() });
        if (updated) broadcast('job', updated);
      }
      return sendJson(res, 200, { result: out.result });
    }

    running.delete(jobId);

    if (action === 'complete') {
      let text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (text.length > MAX_AGENT_REPLY) text = `${text.slice(0, MAX_AGENT_REPLY)}…`;
      const metrics = runMetrics(payload);
      if (!text) {
        const failed = store.failJob(jobId, 'The agent returned an empty reply', now());
        store.finishRun(jobId, { status: 'failed', at: now(), ...metrics, lookups: job.activity.length, error: failed.error });
        broadcast('job', failed);
        usageChanged(job.agentId);
        throw new HttpError(400, 'empty reply');
      }
      const meta = {
        jobId,
        model: metrics.model,
        durationMs: metrics.durationMs,
        costUsd: metrics.costUsd,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        skills: Array.isArray(payload.skillsUsed)
          ? [...new Set(payload.skillsUsed)].filter((id) => loadSkills(skillsDir).some((s) => s.id === id))
          : [],
        lookups: job.activity.filter((a) => a.kind === 'tool').map((a) => a.summary),
      };
      // A check-in is a new top-level message, and it must nudge every owner of a stalled lead.
      if (job.automationId) text = ensureNudges(text, staleLeads(store, now()), now());
      const reply = store.addMessage({ channelId: job.channelId, memberId: job.agentId, body: text, threadId: job.threadId, meta, createdAt: now() });
      const done = store.finishJob(jobId, reply.id, now());
      store.finishRun(jobId, { status: 'done', at: now(), ...metrics, skills: meta.skills, lookups: meta.lookups.length });
      broadcast('message', reply);
      broadcast('job', done);
      if (job.automationId) broadcast('automation', automationView(store.automation(job.automationId)));
      usageChanged(job.agentId);
      return sendJson(res, 200, { job: done, message: reply });
    }

    const error = typeof payload.error === 'string' && payload.error.trim() ? payload.error.trim().slice(0, MAX_ERROR) : 'The agent run failed';
    const failed = store.failJob(jobId, error, now());
    // A failed run can still have used tokens; claude reports them when it can.
    store.finishRun(jobId, { status: 'failed', at: now(), ...runMetrics(payload.usage ?? {}), lookups: job.activity.length, error });
    broadcast('job', failed);
    usageChanged(job.agentId);
    return sendJson(res, 200, { job: failed });
  }

  /* ---------- connections ---------- */

  // Only the owner switches connections on or off; everyone sees the change live.
  async function setConnection(req, res, connector) {
    const { memberId, enabled } = await readJson(req);
    const member = typeof memberId === 'string' ? store.member(memberId) : null;
    if (!member?.isOwner) throw new HttpError(403, 'only the owner can change connections');
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    store.setConnection(connector.id, enabled, member.id, now());
    const connection = connectionList().find((c) => c.id === connector.id);
    broadcast('connection', connection);
    sendJson(res, 200, connection);
  }

  /* ---------- routing ---------- */

  async function serveStatic(res, pathname) {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      throw new HttpError(400, 'bad path');
    }
    const file = resolve(join(PUBLIC_DIR, rel));
    if (!file.startsWith(resolve(PUBLIC_DIR) + sep)) throw new HttpError(404, 'not found');
    let content;
    try {
      content = await readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(content);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;
    let m;

    if (method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, {
        members: store.members().map(publicMember),
        channels: store.channels(),
        online: online(),
        jobs: store.activeJobs(),
        today: Object.fromEntries(store.members().filter((x) => x.kind === 'agent').map((a) => [a.id, agentToday(a.id)])),
        skills: skillSummaries(),
        connections: connectionList(),
      });
    }
    if ((m = pathname.match(/^\/api\/channels\/([\w-]+)\/commitments$/))) {
      if (method === 'POST') return addCommitment(req, res, m[1]);
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      if (!hasFeature(m[1], 'commitments')) throw new HttpError(404, 'this channel has no commitments tracker');
      const week = url.searchParams.get('week') ?? weekKey(now());
      if (!isDayKey(week)) throw new HttpError(400, 'week is YYYY-MM-DD');
      const start = weekStart(new Date(`${week}T12:00`).getTime());
      return sendJson(res, 200, {
        week: dayKey(start),
        currentWeek: weekKey(now()),
        commitments: store.commitments(m[1], dayKey(start)),
        leads: pipelineLeads(store, now()),
      });
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/channels\/([\w-]+)\/apps$/))) return sendJson(res, 200, { apps: appsOf(m[1]) });
    if ((m = pathname.match(/^\/api\/channels\/([\w-]+)\/pipeline(?:\/(L-\d{3}))?$/))) {
      if (method === 'POST' && m[2]) return moveLead(req, res, m[1], m[2]);
      if (method !== 'GET' || m[2]) throw new HttpError(405, 'method not allowed');
      if (!hasFeature(m[1], 'pipeline')) throw new HttpError(404, 'this channel has no pipeline board');
      return sendJson(res, 200, { stages: STAGES, leads: pipelineLeads(store, now()) });
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/commitments\/(\d+)$/))) return updateCommitment(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/api/automations') {
      return sendJson(res, 200, { automations: store.automations().map(automationView) });
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/automations\/([\w-]+)(\/run)?$/))) return automationAction(req, res, m[1], m[2] ? 'run' : 'update');
    if ((m = pathname.match(/^\/api\/members\/([\w-]+)\/(profile|overview)$/))) {
      if (method === 'POST' && m[2] === 'profile') return updateProfile(req, res, m[1]);
      if (method === 'GET' && m[2] === 'overview') {
        if (store.member(m[1])?.kind !== 'human') throw new HttpError(404, 'no such person');
        return sendJson(res, 200, personOverview(m[1]));
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (method === 'GET' && pathname === '/api/usage') {
      const range = url.searchParams.get('range') ?? '7d';
      if (!DAY_RANGES[range] && range !== 'all') throw new HttpError(400, 'range is today, 7d, 30d or all');
      return sendJson(res, 200, usageReport(range));
    }
    if (method === 'POST' && pathname === '/api/agents') return createAgent(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/api\/agents\/([\w-]+)\/limits$/))) return setLimits(req, res, m[1]);
    if (method === 'GET' && pathname === '/api/skills') return sendJson(res, 200, { skills: loadSkills(skillsDir) });
    if (method === 'GET' && pathname === '/api/connections') return sendJson(res, 200, { connections: connectionList() });
    if ((m = pathname.match(/^\/api\/connections\/([\w-]+)(\/records)?$/))) {
      const connector = CONNECTORS.get(m[1]);
      if (!connector) throw new HttpError(404, 'no such connection');
      if (method === 'GET' && m[2]) return sendJson(res, 200, { records: connector.preview(store) });
      if (method === 'POST' && !m[2]) return setConnection(req, res, connector);
      throw new HttpError(405, 'method not allowed');
    }
    if (method === 'GET' && pathname === '/api/events') return events(req, res, url);

    if ((m = pathname.match(/^\/api\/channels\/([\w-]+)\/messages$/))) {
      if (method === 'GET') {
        if (!store.channel(m[1])) throw new HttpError(404, 'no such channel');
        return sendJson(res, 200, { messages: store.messages(m[1]), jobs: store.openChannelJobs(m[1]) });
      }
      if (method === 'POST') return postMessage(req, res, m[1]);
      throw new HttpError(405, 'method not allowed');
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/threads\/(\d+)$/))) {
      const thread = store.thread(Number(m[1]));
      if (!thread) throw new HttpError(404, 'no such thread');
      return sendJson(res, 200, { ...thread, jobs: store.openThreadJobs(thread.root.id) });
    }

    if (method === 'GET' && pathname === '/api/worker/stream') return workerStream(req, res, url);
    if (method === 'POST' && (m = pathname.match(/^\/api\/worker\/jobs\/(\d+)\/(claim|complete|fail|tools)$/))) {
      return workerJob(req, res, Number(m[1]), m[2]);
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    return serveStatic(res, pathname);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) return res.end();
      sendJson(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'internal error' });
    }
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(': ping\n\n');
    for (const w of workers.values()) w.res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const scheduler = setInterval(runDueAutomations, SCHEDULE_TICK_MS);
  scheduler.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(scheduler);
  });
  // For tests and the "is anything due?" check right after start.
  server.runDueAutomations = runDueAutomations;

  return server;
}
