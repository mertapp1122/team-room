// Demo data. The owner (Alex) stands in for you; every other human is fictional
// and flagged is_demo. Leads and companies in messages are fictional and say "(demo)".
// To make the room yours, edit COMPANY, MEMBERS and CHANNELS here, then run `npm run seed`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO_LEADS } from './connectors/demo-crm.js';
import { HOUR, addDays, weekKey } from './time.js';

// What every agent knows about the company. Agents follow these as hard rules.
export const COMPANY = {
  name: 'an AI growth agency',
  facts: [
    'Alex is the founder and owner. The other people in this room are fictional demo teammates, and leads or companies mentioned here are fictional demo data. Never invent real client names.',
    'The agency helps brands show up in AI answers (ChatGPT, Perplexity, Gemini, Google AI Overviews) and in search.',
    'Packages start at $799/month and include GEO, AEO and SEO together. Never quote a price below $799/month.',
  ],
};

export const MEMBERS = [
  {
    id: 'alex', name: 'Alex', kind: 'human', title: 'Founder', isOwner: true, color: '#2f6f68',
    focus: 'Pricing, partnerships and rolling Team Room out to the team',
    askAbout: ['Pricing exceptions', 'Partnerships', 'Anything about the agents'],
  },
  {
    id: 'ayse', name: 'Ayşe Kaya', kind: 'human', title: 'Account lead', isDemo: true, color: '#b5603a',
    focus: 'Offers for Northwind Bakery (demo) and Harbor Dental Studio (demo)',
    askAbout: ['Proposals and offers', 'Client calls', 'Lead status'],
  },
  {
    id: 'deniz', name: 'Deniz Aras', kind: 'human', title: 'GEO / SEO strategist', isDemo: true, color: '#3b6ea5',
    focus: 'The Quartz Analytics (demo) proposal and its AEO plan',
    askAbout: ['GEO and AEO audits', 'AI visibility data', 'Technical SEO'],
  },
  {
    id: 'selin', name: 'Selin Okur', kind: 'human', title: 'Content lead', isDemo: true, color: '#8a6d1f',
    focus: 'Bluefin Outdoor (demo) content calendar',
    askAbout: ['Content plans', 'FAQ and answer pages', 'Writing samples for offers'],
  },
  {
    id: 'burak', name: 'Burak Tan', kind: 'human', title: 'E-commerce lead', isDemo: true, color: '#5b7a3a',
    focus: 'Online store clients and the Maple & Thread (demo) lead',
    askAbout: ['Online store clients', 'AI shopping answers', 'E-commerce leads'],
  },
  {
    id: 'alex-claude', name: "Alex's Claude", kind: 'agent', ownerId: 'alex', color: '#2f6f68',
    title: "Alex's personal agent: proposals, strategy and client comms",
    model: 'sonnet',
    dailyRunsLimit: 30, dailyUsdLimit: 3,
    skills: ['Proposals and client emails', 'GEO, AEO and SEO strategy', 'Pricing and packaging', 'Summing up a thread'],
    instructions: 'You work for Alex, the founder. Write like a sharp, friendly agency operator: concrete next steps, no fluff.',
    persona: {
      who: "Alex's right hand at the agency: you have seen hundreds of proposals and know what makes a client say yes.",
      think: 'Start from what the client wants to win, then the smallest package that gets them there. Never below $799/month.',
      sound: 'Sharp and friendly. Short sentences, concrete next steps, no fluff or hype.',
    },
  },
  {
    id: 'scout', name: 'Scout', kind: 'agent', ownerId: 'alex', color: '#55606e',
    title: 'Research agent: customer and market studies',
    model: 'haiku',
    dailyRunsLimit: 50, dailyUsdLimit: 1,
    skills: ['Survey and study design', 'Audience and persona questions', 'Quick market sizing', 'Findings as short bullets'],
    instructions: 'You design quick customer and market research for the agency and its clients. Suggest study questions and audiences; label any numbers as rough estimates.',
    persona: {
      who: 'A curious research designer who has run hundreds of customer studies.',
      think: 'Pick the one question that would change a decision, then the audience that can answer it. Numbers are rough until a study says otherwise.',
      sound: 'Calm and curious. Asks one good question back when the brief is fuzzy.',
    },
  },
  {
    id: 'geo-auditor', name: 'GEO Auditor', kind: 'agent', ownerId: 'alex', color: '#55606e',
    title: 'AI search visibility checks for clients',
    model: 'haiku',
    dailyRunsLimit: 50, dailyUsdLimit: 1,
    skills: ['GEO and AEO recommendations', 'Content and schema gaps', 'Prioritized fix lists', 'Reading pasted AI answers'],
    instructions: 'You audit how brands show up in AI answers (ChatGPT, Perplexity, Gemini, AI Overviews). You cannot browse, so work from what people paste and say what you would check.',
    persona: {
      who: 'A meticulous GEO and AEO auditor.',
      think: 'Evidence first: what the AI answer says today, what is missing, and which fix moves visibility most.',
      sound: 'Precise and plain. Numbered fixes, most important first.',
    },
  },
  {
    id: 'pipeline', name: 'Pipeline', kind: 'agent', ownerId: 'alex', color: '#55606e',
    title: 'Runs the daily #sales check-in and nudges leads that stopped moving',
    model: 'haiku',
    dailyRunsLimit: 10, dailyUsdLimit: 0.5,
    skills: ['Daily check-ins', 'Spotting stalled leads', 'Short, friendly nudges'],
    instructions: 'You keep the #sales pipeline moving. Be warm and brief, never blame anyone, and give each nudge one concrete next step.',
    persona: {
      who: 'The friendly coach of the #sales pipeline.',
      think: 'A lead that sits still is a lead that cools. Find the one next step that gets it moving today.',
      sound: 'Warm and brief, never blaming. One nudge, one next step.',
    },
  },
];

export const CHANNELS = [
  { id: 'general', name: 'general', topic: 'Agency-wide news and chatter' },
  { id: 'sales', name: 'sales', topic: 'Leads and proposals. Packages start at $799/month: GEO, AEO and SEO together.', features: ['pipeline', 'commitments', 'checkin'] },
  { id: 'delivery', name: 'delivery', topic: 'Client work in progress' },
  { id: 'visibility', name: 'visibility', topic: 'AI search visibility checks (GEO/AEO) for clients' },
  { id: 'research', name: 'research', topic: 'Customer and market research' },
  { id: 'ecommerce', name: 'ecommerce', topic: 'Online store clients and AI shopping answers' },
];

// [channel, member, body, minutes ago]
const MESSAGES = [
  ['general', 'alex', 'Welcome to Team Room. People and agents share the same channels here. Mention an agent with @ (try @scout) and it answers in a thread.', 180],
  ['general', 'ayse', 'Nice. So leads go to #sales now?', 176],
  ['general', 'alex', 'Yes: #sales for leads, #delivery for client work, and one channel for each kind of work.', 175],
  ['sales', 'ayse', 'New lead: Northwind Bakery (demo) wants to show up in ChatGPT answers for "best sourdough near me".', 120],
  ['sales', 'deniz', 'Good fit for the base package: GEO, AEO and SEO together from $799/month.', 115],
  ['delivery', 'selin', 'Content calendar for Bluefin Outdoor (demo) is drafted. Reviews by Thursday please.', 90],
  ['visibility', 'deniz', 'Visibility check for Bluefin Outdoor (demo): the brand shows up in 4 of 20 tracked AI answers.', 60],
  ['research', 'alex', 'Next study idea: find out how people pick a local bakery, so the Northwind Bakery (demo) offer speaks their language.', 45],
  ['ecommerce', 'burak', 'Product page checklist for AI shopping answers is ready for feedback.', 30],
];

// The demo CRM connection (on) and its fictional leads.
export function seedConnections(db, now = Date.now()) {
  db.exec('DELETE FROM connections;');
  db.prepare(`
    INSERT INTO connections (id, enabled, updated_by, updated_at)
    VALUES ('demo-crm', 1, (SELECT id FROM members WHERE is_owner = 1 ORDER BY sort LIMIT 1), ?)`).run(now);
  seedLeads(db, now);
}

export function seedLeads(db, now = Date.now()) {
  db.exec('DELETE FROM crm_leads;');
  const addLead = db.prepare('INSERT INTO crm_leads (id, data, sort) VALUES (?, ?, ?)');
  DEMO_LEADS.forEach(({ updatedHoursAgo, ...lead }, i) =>
    addLead.run(lead.id, JSON.stringify({ ...lead, updatedAt: now - updatedHoursAgo * HOUR }), i));
}

// [owner, text, lead, done how many days ago (null = open)]
const COMMITMENTS = [
  ['ayse', 'Send the Northwind Bakery (demo) offer', 'L-101', null],
  ['ayse', 'Call Harbor Dental Studio (demo) about the $799/month minimum', 'L-103', null],
  ['ayse', 'Add visibility screenshots to the sales deck', null, 1],
  ['deniz', 'Finish the Quartz Analytics (demo) proposal', 'L-104', null],
  ['deniz', 'Outline the AEO comparison pages for Quartz', 'L-104', 0],
  ['burak', 'Book an intro call with Maple & Thread (demo)', 'L-105', null],
  ['alex', 'Walk the team through the offer skill', null, 1],
];

// The #sales work stream: this week's commitments and the 17:00 check-in.
export function seedPipeline(db, now = Date.now()) {
  db.exec("DELETE FROM commitments; DELETE FROM automations; DELETE FROM sqlite_sequence WHERE name = 'commitments';");
  const week = weekKey(now);
  const add = db.prepare(`
    INSERT INTO commitments (channel_id, week, owner_id, text, lead_id, status, created_by, created_at, done_at, updated_at)
    VALUES ('sales', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [owner, text, lead, doneDaysAgo] of COMMITMENTS) {
    // Done items never predate this week's Monday.
    const doneAt = doneDaysAgo === null ? null : Math.min(now, Math.max(addDays(now, -doneDaysAgo), new Date(`${week}T09:00`).getTime()));
    add.run(week, owner, text, lead, doneAt ? 'done' : 'open', owner, now - 2 * 24 * HOUR, doneAt, doneAt ?? now - 2 * 24 * HOUR);
  }
  db.prepare(`
    INSERT INTO automations (id, channel_id, agent_id, kind, time, weekdays_only, enabled, updated_by, updated_at)
    VALUES ('sales-checkin', 'sales', 'pipeline', 'sales-checkin', '17:00', 1, 1, (SELECT id FROM members WHERE is_owner = 1 ORDER BY sort LIMIT 1), ?)`).run(now);
}

// Photos: public/img/people/<id>.jpg when it exists (AI-generated portraits for the
// fictional teammates; drop your own photo in for the owner), otherwise a plain
// placeholder. The Claude mark for every agent, since they all run on Claude.
const CLAUDE_ICON = '/img/agents/claude.svg';
export const PLACEHOLDER_PHOTO = '/img/people/placeholder.svg';
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const photoOf = (id) => (existsSync(`${PUBLIC_DIR}/img/people/${id}.jpg`) ? `/img/people/${id}.jpg` : PLACEHOLDER_PHOTO);
export const avatarOf = (m) => (m.kind === 'agent'
  ? { avatar: CLAUDE_ICON, avatarAi: false }
  : { avatar: photoOf(m.id), avatarAi: Boolean(m.isDemo) });

export function seedAvatars(db) {
  const update = db.prepare('UPDATE members SET avatar = ?, avatar_ai = ? WHERE id = ?');
  for (const m of MEMBERS) {
    const { avatar, avatarAi } = avatarOf(m);
    update.run(avatar, avatarAi ? 1 : 0, m.id);
  }
}

// The three-part persona of the demo agents: who it is, how it thinks, how it sounds.
export function seedPersonas(db) {
  const update = db.prepare("UPDATE members SET persona = ? WHERE id = ? AND kind = 'agent'");
  for (const m of MEMBERS.filter((m) => m.persona)) update.run(JSON.stringify(m.persona), m.id);
}

export function insertMember(db, m, sort) {
  db.prepare(`
    INSERT INTO members (id, name, kind, title, is_demo, is_owner, owner_id, color, sort, model, skills, instructions,
                         daily_runs_limit, daily_usd_limit, focus, ask_about)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    m.id, m.name, m.kind, m.title, m.isDemo ? 1 : 0, m.isOwner ? 1 : 0, m.ownerId ?? null, m.color, sort,
    m.model ?? null, JSON.stringify(m.skills ?? []), m.instructions ?? '', m.dailyRunsLimit ?? null, m.dailyUsdLimit ?? null,
    m.focus ?? '', JSON.stringify(m.askAbout ?? []));
}

export function seed(db, now = Date.now()) {
  db.exec('BEGIN');
  try {
    db.exec(`
      DELETE FROM commitments; DELETE FROM automations; DELETE FROM agent_runs; DELETE FROM connections;
      DELETE FROM jobs; DELETE FROM messages; DELETE FROM channels; DELETE FROM members;
      DELETE FROM sqlite_sequence WHERE name IN ('messages', 'jobs', 'agent_runs', 'commitments');`);
    MEMBERS.forEach((m, i) => insertMember(db, m, i));
    seedAvatars(db);
    seedPersonas(db);

    const addChannel = db.prepare('INSERT INTO channels (id, name, topic, sort, features) VALUES (?, ?, ?, ?, ?)');
    CHANNELS.forEach((c, i) => addChannel.run(c.id, c.name, c.topic, i, JSON.stringify(c.features ?? [])));

    const addMessage = db.prepare('INSERT INTO messages (channel_id, member_id, body, created_at) VALUES (?, ?, ?, ?)');
    for (const [channel, member, body, minutesAgo] of MESSAGES) {
      addMessage.run(channel, member, body, now - minutesAgo * 60_000);
    }
    seedConnections(db, now);
    seedPipeline(db, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
