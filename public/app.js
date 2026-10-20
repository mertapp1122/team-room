const ME_KEY = 'teamroom.me';
const GROUP_WINDOW_MS = 5 * 60_000;
// Same rule as the server: @handle, but not inside an e-mail address.
const MENTION = /(?<![\w.@-])@([a-z0-9][a-z0-9-]*)/gi;
const MODEL_NAMES = { haiku: 'Claude Haiku', sonnet: 'Claude Sonnet', opus: 'Claude Opus' };
// The New agent form's choices, with the daily limit each starts with (same as the server).
const MODEL_CHOICES = [
  ['haiku', 'Haiku', 'Quick and cheap', 'Short answers, lookups and check-ins.', '50 runs or $1 a day'],
  ['sonnet', 'Sonnet', 'Everyday work', 'Drafts, plans and most questions.', '30 runs or $3 a day'],
  ['opus', 'Opus', 'Hard problems', 'Tricky strategy and long reasoning. Slower, costs the most.', '10 runs or $5 a day'],
];
const PERSONA_PARTS = [
  ['who', 'Who you are', 'Who it is', 'A veteran copywriter who has written for bakeries, dentists and outdoor brands.'],
  ['think', 'How you think', 'How it thinks', 'Find the one benefit the reader cares about, then cut everything else.'],
  ['sound', 'How you sound', 'How it sounds', 'Dry and short. Never uses exclamation marks.'],
];
const STAGES = [['new', 'New'], ['qualified', 'Qualified'], ['proposal', 'Proposal'], ['won', 'Won'], ['lost', 'Lost']];
const stageLabel = (id) => STAGES.find(([s]) => s === id)?.[1] ?? id;
// Channel apps, in the server's order. A channel has the ones listed in its features.
const APP_IDS = ['pipeline', 'commitments'];
const PAGES = {
  members: { title: 'Members', topic: 'Everyone in Team Room: the people, and the agents that work alongside them.' },
  skills: { title: 'Skills', topic: 'Shared know-how that every agent loads. Edit the files in the repo; agents use the new version on their next job.' },
  connections: { title: 'Connections', topic: 'Tools the agents can use. Read-only: agents can look things up, never change them.' },
  usage: { title: 'Usage', topic: 'Every agent run, priced at the API-equivalent cost Claude reports. We pay through the subscription.' },
};

const $ = (sel) => document.querySelector(sel);
const els = {
  app: $('#app'),
  channelList: $('#channel-list'),
  workspaceNav: $('#workspace-nav'),
  page: $('#page'),
  me: $('#me'),
  channelName: $('#channel-name'),
  channelTopic: $('#channel-topic'),
  channelTabs: $('#channel-tabs'),
  membersToggle: $('#members-toggle'),
  messages: $('#messages'),
  composer: $('#composer'),
  sideMembers: $('#side-members'),
  sideThread: $('#side-thread'),
  threadChannel: $('#thread-channel'),
  threadMessages: $('#thread-messages'),
  threadComposer: $('#thread-composer'),
  threadClose: $('#thread-close'),
  picker: $('#picker'),
  pickerList: $('#picker-list'),
  pickerError: $('#picker-error'),
};

const state = {
  me: null,
  members: new Map(),
  channels: [],
  channelId: null,
  messages: new Map(), // channelId -> top-level messages, sorted (only channels we have loaded)
  loading: new Set(),
  unread: new Map(),
  online: new Set(), // people with a window open, and agents whose worker is connected
  jobs: new Map(), // jobId -> agent job
  side: { open: false, view: 'members', profileId: null },
  thread: null, // { rootId, channelId, root, replies, loading }
  page: null, // 'skills' | 'connections' while one of those pages is open
  pageSub: null, // on the Members page: 'new' (the New agent form) or an agent id (its profile page)
  skills: [], // shared team skills (summaries)
  connections: [], // connectors with their on/off state
  today: {}, // agentId -> { runs, costUsd } since midnight
  usageRange: '7d',
  usage: null, // the last /api/usage report
  channelView: 'messages', // or 'apps': the channel's app cards, or one app (state.app)
  app: null, // 'pipeline' | 'commitments' while an app is open
  apps: new Map(), // channelId -> app cards with their previews
  pipeline: null, // { channelId, leads } for the board on screen
  boardError: null,
  justMoved: null, // lead id to flash after someone moved it
  tracker: null, // { week, currentWeek, commitments, leads } for the week on screen
  trackerWeek: null,
  automations: [],
  overviews: new Map(), // personId -> this week's commitments and leads, for profiles
  mentions: new Map(), // channelId -> unread messages that @mention me
  editingProfile: false,
  memberFilter: 'all', // members panel: all, people or agents
  membersPageFilter: 'all', // the Members page has its own tabs
};

let mainComposer;
let threadComposer;

const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  remove: (k) => { try { localStorage.removeItem(k); } catch {} },
};

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Small DOM helper: el('div', { class: 'x' }, 'text', childNode)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const isHuman = (id) => state.members.get(id)?.kind === 'human';
const channel = (id) => state.channels.find((c) => c.id === id);
const memberOrGhost = (id) => state.members.get(id) ?? { id, name: id, kind: 'human', color: '#888' };
const isWide = () => window.matchMedia('(min-width: 1100px)').matches;

function initials(name) {
  return name.replace(/'s\b/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/* ---------- agents ---------- */

const runningJob = (agentId) => [...state.jobs.values()].find((j) => j.agentId === agentId && j.status === 'running');

function agentStatus(agent) {
  const job = runningJob(agent.id);
  if (job) return { cls: 'working', text: `Working in #${channel(job.channelId)?.name ?? job.channelId}` };
  if (state.online.has(agent.id)) return { cls: 'on', text: 'Online' };
  return { cls: '', text: 'Offline: worker not running' };
}

function presenceClass(member) {
  if (member.kind === 'agent') return agentStatus(member).cls;
  return state.online.has(member.id) ? 'on' : '';
}

const modelName = (alias) => MODEL_NAMES[alias] ?? alias;
// claude-haiku-4-5-20251001 -> haiku-4-5
const shortModel = (model) => (model ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

/* ---------- small pieces ---------- */

// A person's photo (or the Claude mark for agents), falling back to initials.
// AI-generated portraits carry a small "AI" mark wherever they are big enough to read it.
function avatar(member, { size = 32, presence = false } = {}) {
  const node = el('span', {
    class: `avatar ${member.kind === 'agent' ? 'agent' : ''} ${member.avatar ? 'has-photo' : ''}`,
    style: `--c:${member.color};--s:${size}px`,
    'aria-hidden': 'true',
  });
  if (member.avatar) {
    const img = el('img', { src: member.avatar, alt: '', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => {
      img.remove();
      node.classList.remove('has-photo');
      node.prepend(initials(member.name));
    }, { once: true });
    node.append(img);
  } else {
    node.append(initials(member.name));
  }
  if (member.avatarAi && size >= 28) node.append(el('span', { class: 'ai-mark' }, 'AI'));
  if (presence) node.append(el('span', { class: `presence ${presenceClass(member)}` }));
  return node;
}

const PORTRAIT_NOTE = 'Fictional demo teammate. The photo is an AI-generated portrait.';

// `full` adds the "AI portrait" tag where a person is introduced (members list, profile, picker).
function tags(member, { full = false } = {}) {
  return [
    member.id === state.me && el('span', { class: 'tag you' }, 'you'),
    member.isOwner && el('span', { class: 'tag owner' }, 'owner'),
    member.isDemo && el('span', { class: 'tag demo', title: member.avatarAi ? PORTRAIT_NOTE : 'Fictional demo teammate' }, 'demo'),
    full && member.avatarAi && el('span', { class: 'tag portrait', title: PORTRAIT_NOTE }, 'AI portrait'),
    member.kind === 'agent' && el('span', { class: 'tag agent', title: 'An AI agent running on Claude' }, 'Agent'),
  ];
}

const mentionsMe = (msg) => msg.memberId !== state.me && new RegExp(`(?<![\\w.@-])@${state.me}(?![\\w-])`, 'i').test(msg.body);

// Message text with known @mentions shown as chips.
function richText(body) {
  const out = [];
  let last = 0;
  for (const m of body.matchAll(MENTION)) {
    const member = state.members.get(m[1].toLowerCase());
    if (!member) continue;
    out.push(body.slice(last, m.index), el('span', { class: `mention ${member.kind}` }, `@${member.id}`));
    last = m.index + m[0].length;
  }
  out.push(body.slice(last));
  return out;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const dayKey = (ts) => new Date(ts).toDateString();

function dayLabel(ts) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(ts) === today.toDateString()) return 'Today';
  if (dayKey(ts) === yesterday.toDateString()) return 'Yesterday';
  return dayFmt.format(ts);
}

/* ---------- picker ---------- */

function showPicker(error = '') {
  els.app.hidden = true;
  els.picker.hidden = false;
  els.pickerError.hidden = !error;
  els.pickerError.textContent = error;
  const humans = [...state.members.values()].filter((m) => m.kind === 'human');
  els.pickerList.replaceChildren(...humans.map((m) =>
    el('button', { type: 'button', class: 'picker-item', onclick: () => choose(m.id) },
      avatar(m, { size: 36 }),
      el('span', { class: 'picker-text' },
        el('span', { class: 'picker-name' }, m.name, ...tags(m, { full: true })),
        el('span', { class: 'muted small' }, m.title)))));
}

function choose(id) {
  const url = new URL(location.href);
  url.searchParams.set('as', id);
  history.replaceState(null, '', url);
  storage.set(ME_KEY, id);
  start(id);
}

function switchPerson() {
  storage.remove(ME_KEY);
  location.href = location.pathname;
}

/* ---------- sidebar ---------- */

function renderMe() {
  const me = state.members.get(state.me);
  els.me.replaceChildren(
    avatar(me, { size: 30, presence: true }),
    el('span', { class: 'me-text' },
      el('span', { class: 'me-name' }, me.name),
      el('span', { class: 'muted small' }, me.title)),
    el('button', { type: 'button', class: 'link-button', onclick: switchPerson }, 'Switch'));
}

function renderChannels() {
  els.channelList.replaceChildren(...state.channels.map((c) => {
    const unread = state.unread.get(c.id) || 0;
    const active = c.id === state.channelId && !state.page;
    return el('a', {
      href: `#${c.id}`,
      class: `channel ${active ? 'active' : ''} ${unread ? 'unread' : ''}`,
      'aria-current': active ? 'page' : null,
    },
    el('span', { class: 'hash' }, '#'),
    el('span', { class: 'channel-name' }, c.name),
    unread ? el('span', {
      class: `badge ${state.mentions.get(c.id) ? 'mention' : ''}`,
      'aria-label': `${unread} unread${state.mentions.get(c.id) ? ', mentions you' : ''}`,
    }, state.mentions.get(c.id) ? `@ ${unread}` : String(unread)) : null);
  }));
  els.workspaceNav.replaceChildren(...Object.entries(PAGES).map(([id, p]) => {
    const active = state.page === id;
    return el('a', { href: `#${id}`, class: `channel ${active ? 'active' : ''}`, 'aria-current': active ? 'page' : null },
      el('span', { class: 'hash' }, { members: '◎', skills: '✦', connections: '⇄', usage: '∑' }[id]),
      el('span', { class: 'channel-name' }, p.title),
      id === 'connections' ? el('span', { class: 'muted small nav-count' }, String(state.connections.filter((c) => c.enabled).length)) : null);
  }));
}

/* ---------- side panel: members, agent profile, thread ---------- */

function setSide(open, view = state.side.view, profileId = state.side.profileId) {
  state.side = { open, view, profileId };
  document.body.classList.toggle('side-open', open);
  document.body.dataset.side = view;
  els.membersToggle.setAttribute('aria-expanded', String(open && view !== 'thread'));
  els.sideMembers.hidden = view === 'thread';
  els.sideThread.hidden = view !== 'thread';
  renderSide();
}

function renderSide() {
  const all = [...state.members.values()];
  els.membersToggle.textContent = `Members · ${all.length}`;
  if (state.me) renderMe();
  if (state.side.view === 'profile') renderProfile(state.members.get(state.side.profileId));
  else if (state.side.view === 'members') renderMembers();
  // Presence, profiles and agent work change what the Members page shows too (but leave a half-filled form alone).
  if (state.page === 'members' && state.pageSub !== 'new') renderMembersPage();
}

function memberRow(m) {
  const agent = m.kind === 'agent';
  const status = agent ? agentStatus(m) : { cls: state.online.has(m.id) ? 'on' : '', text: state.online.has(m.id) ? 'Online' : 'Offline' };
  const content = [
    avatar(m, { size: 30, presence: true }),
    el('span', { class: 'member-text' },
      el('span', { class: 'member-name' }, el('span', { class: 'truncate' }, m.name), ...tags(m, { full: true })),
      el('span', { class: 'muted small' }, m.title),
      el('span', { class: `status small ${status.cls}` }, status.text)),
  ];
  return el('li', { class: `member ${m.kind}`, 'data-member': m.id },
    el('button', { type: 'button', class: 'member-button', 'aria-label': `${m.name}: open profile`, onclick: () => openProfile(m.id) }, ...content));
}

const MEMBER_TABS = [['all', 'All'], ['people', 'People'], ['agents', 'Agents']];

function renderMembers() {
  const all = [...state.members.values()];
  const people = all.filter((m) => m.kind === 'human');
  const agents = all.filter((m) => m.kind === 'agent');
  const count = (list) => list.filter((m) => state.online.has(m.id)).length;
  const filter = state.memberFilter ?? 'all';
  const sizes = { all: all.length, people: people.length, agents: agents.length };

  els.sideMembers.replaceChildren(...[
    el('div', { class: 'side-head' },
      el('h2', {}, 'Members'),
      el('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close members', onclick: () => setSide(false) }, '×')),
    el('div', { class: 'member-tabs', role: 'group', 'aria-label': 'Show' },
      MEMBER_TABS.map(([id, label]) => el('button', {
        type: 'button',
        class: `member-tab ${filter === id ? 'active' : ''}`,
        'aria-pressed': String(filter === id),
        onclick: () => {
          state.memberFilter = id;
          renderMembers();
        },
      }, label, el('span', { class: 'member-tab-count' }, String(sizes[id]))))),
    filter !== 'agents' && el('h3', { class: 'section-label' }, `People · ${count(people)} of ${people.length} online`),
    filter !== 'agents' && el('ul', { class: 'member-list' }, people.map(memberRow)),
    filter !== 'people' && el('div', { class: 'section-row' },
      el('h3', { class: 'section-label' }, `Agents · ${count(agents)} of ${agents.length} online`),
      el('a', { class: 'link-button new-agent-link', href: '#members/new', 'aria-label': 'New agent' }, '+ New')),
    filter !== 'people' && el('ul', { class: 'member-list' }, agents.map(memberRow)),
    el('p', { class: 'muted small side-note' },
      filter === 'agents'
        ? 'Every agent runs on Claude, on the computer that runs the worker. Mention one with @ and it answers in a thread.'
        : 'The owner stands in for you. The other people are fictional demo teammates with AI-generated portraits. Click anyone for their profile.'),
  ].filter(Boolean));
}

function openProfile(id) {
  state.editingProfile = false;
  setSide(true, 'profile', id);
  if (state.members.get(id)?.kind === 'human') loadOverview(id);
}

function renderProfile(member) {
  if (member.kind === 'human') return renderPersonProfile(member);
  const agent = member;
  const status = agentStatus(agent);
  els.sideMembers.replaceChildren(
    el('div', { class: 'side-head' },
      el('button', { type: 'button', class: 'link-button back', onclick: () => setSide(true, 'members') }, '← Members'),
      el('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close profile', onclick: () => setSide(false) }, '×')),
    el('div', { class: 'profile' },
      el('div', { class: 'profile-top' },
        avatar(agent, { size: 56, presence: true }),
        el('div', {},
          el('h2', { class: 'profile-name' }, agent.name, ...tags(agent)),
          el('p', { class: 'muted small' }, `Runs on Claude · ${modelName(agent.model)}`),
          el('p', { class: `status small ${status.cls}` }, status.text))),
      el('p', { class: 'profile-title' }, agent.title),
      el('a', { class: 'link-button profile-page-link', href: `#members/${agent.id}` }, 'Open profile page →'),
      el('dl', {}, agentRows(agent, { persona: true })),
      askButton(agent)));
}

const profileRow = (label, ...value) => el('div', { class: 'profile-row' }, el('dt', {}, label), el('dd', {}, ...value));

function madeBy(agent) {
  const maker = state.members.get(agent.ownerId);
  if (!maker) return el('span', { class: 'muted' }, 'Unknown');
  return el('span', { class: 'made-by' },
    avatar(maker, { size: 22 }), el('span', {}, maker.name), ...tags(maker),
    agent.createdAt ? el('span', { class: 'muted' }, ` · ${dayFmt.format(agent.createdAt)}`) : null);
}

function personaBlocks(persona) {
  if (!persona) return el('span', { class: 'muted' }, 'No persona yet');
  return el('div', { class: 'persona' }, PERSONA_PARTS.map(([key, , label]) =>
    el('div', { class: 'persona-part' }, el('span', { class: 'persona-label' }, label), el('p', {}, persona[key]))));
}

// What both agent profiles (side panel and page) list. The page shows the persona on its own card.
function agentRows(agent, { persona = false } = {}) {
  return [
    persona && profileRow('Persona', personaBlocks(agent.persona)),
    profileRow('Model', modelName(agent.model), el('span', { class: 'muted' }, ` (${agent.model})`)),
    profileRow('Made by', madeBy(agent)),
    profileRow('Today', todayLine(agent)),
    profileRow('Good at', el('span', { class: 'chips' }, (agent.skills ?? []).map((s) => el('span', { class: 'chip' }, s)))),
    profileRow('Team skills', state.skills.length
      ? el('span', { class: 'chips' }, state.skills.map((s) => el('a', { class: 'chip skill', href: '#skills', title: s.description }, s.name)))
      : 'None yet'),
    profileRow('Connections', enabledConnections().length
      ? el('span', { class: 'chips' }, enabledConnections().map((c) => el('a', { class: 'chip', href: '#connections' }, `${c.name} · read-only`)))
      : 'None switched on'),
    profileRow('Runs on', "The computer that runs the worker, through the Claude Code CLI on your own subscription. It can load team skills and read connected tools; it can't browse, change anything or run code."),
    profileRow('Answered', `${agent.jobsDone ?? 0} ${agent.jobsDone === 1 ? 'question' : 'questions'}`),
  ].filter(Boolean);
}

function askButton(agent, { inline = false } = {}) {
  const c = channel(state.channelId) ?? state.channels[0];
  return el('button', {
    type: 'button',
    class: `primary-button ${inline ? 'inline' : ''}`,
    onclick: () => {
      if (state.page) location.hash = `#${c.id}`;
      else if (!isWide()) setSide(false);
      mainComposer.insert(`@${agent.id} `);
    },
  }, `Ask @${agent.id} in #${c.name}`);
}

const enabledConnections = () => state.connections.filter((c) => c.enabled);

function todayLine(agent) {
  const today = state.today[agent.id] ?? { runs: 0, costUsd: 0 };
  const { runs = null, usd = null } = agent.limits ?? {};
  const limit = [runs !== null && `${runs} runs`, usd !== null && `${money(usd)}`].filter(Boolean).join(' or ');
  return el('span', {},
    `${today.runs} ${today.runs === 1 ? 'run' : 'runs'} · ${money(today.costUsd)} API-equivalent`,
    el('br'),
    el('a', { class: 'muted small', href: '#usage' }, limit ? `Daily limit: ${limit}` : 'No daily limit'));
}

// Small API-equivalent prices need more digits than a bill would.
function money(v) {
  if (!v) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 10) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(0)}`;
}

/* ---------- messages ---------- */

function jobLine(job) {
  const agent = memberOrGhost(job.agentId);
  const who = el('strong', {}, agent.name);
  const checkin = Boolean(job.automationId);
  if (job.status === 'running') {
    return el('div', { class: 'job running', 'data-job': job.id },
      el('span', { class: 'spinner', 'aria-hidden': 'true' }), who, checkin ? ' is writing the daily check-in… ' : ' is working… ',
      el('span', { class: 'muted', 'data-since': job.startedAt }, elapsed(Date.now() - job.startedAt)),
      job.activity?.length ? el('span', { class: 'job-activity' }, ` · ${job.activity.at(-1).summary}`) : null);
  }
  if (job.status === 'failed' && job.blocked) {
    return el('div', { class: 'job blocked', 'data-job': job.id },
      el('span', { 'aria-hidden': 'true' }, '⏸'), job.error ?? `${agent.name} reached its daily limit.`);
  }
  if (job.status === 'failed') {
    return el('div', { class: 'job failed', 'data-job': job.id }, who, checkin ? ` couldn't post the check-in: ${job.error ?? 'unknown error'}` : ` couldn't answer: ${job.error ?? 'unknown error'}`);
  }
  return el('div', { class: 'job queued', 'data-job': job.id },
    state.online.has(job.agentId)
      ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), who, checkin ? ' is starting the check-in…' : ' got the question…']
      : [who, checkin ? ' is offline. The check-in runs when the agent worker starts.' : ' is offline. It will answer when the agent worker starts.']);
}

// Automation runs (the daily check-in) are not answers to a message: they show at the bottom of the channel.
const channelJobs = (channelId) => [...state.jobs.values()]
  .filter((j) => j.channelId === channelId && j.threadId === null && j.status !== 'done')
  .sort((a, b) => a.id - b.id)
  .slice(-3);

function refreshChannelJobs() {
  const box = els.messages.querySelector('.channel-jobs');
  if (!box || !state.channelId) return;
  const stick = nearBottom(els.messages);
  box.replaceChildren(...channelJobs(state.channelId).map(jobLine));
  if (stick) scrollToBottom(els.messages);
}

function appendMessageNodes(nodes) {
  const box = els.messages.querySelector('.channel-jobs');
  if (box) box.before(...nodes);
  else els.messages.append(...nodes);
}

const openJobs = (rootId) => [...state.jobs.values()].filter((j) => j.threadId === rootId && j.status !== 'done').sort((a, b) => a.id - b.id);

function threadLink(root) {
  const t = root.thread;
  const last = memberOrGhost(t.last.memberId);
  return el('button', { type: 'button', class: 'thread-link', onclick: () => openThread(root.id) },
    el('span', { class: 'thread-avatars' }, t.participants.map((id) => avatar(memberOrGhost(id), { size: 22 }))),
    el('span', { class: 'thread-count' }, `${t.count} ${t.count === 1 ? 'reply' : 'replies'}`),
    el('span', { class: 'thread-preview' }, el('strong', {}, `${last.name}: `), t.last.body));
}

function extras(root) {
  return [...openJobs(root.id).map(jobLine), root.thread ? threadLink(root) : null];
}

function replyMeta(meta) {
  const bits = [shortModel(meta.model), meta.durationMs != null ? elapsed(meta.durationMs) : null].filter(Boolean);
  const title = meta.costUsd != null
    ? `About $${meta.costUsd.toFixed(4)} at API list price. Paid through the Claude subscription, not per call.`
    : null;
  const skills = meta.skills ?? [];
  const lookups = meta.lookups ?? [];
  return el('div', { class: 'msg-meta' },
    el('span', { title }, bits.join(' · ')),
    skills.map((id) => el('a', { class: 'used skill', href: '#skills', title: 'Team skill the agent loaded' }, `skill: ${id}`)),
    lookups.length
      ? el('details', { class: 'used lookups' },
        el('summary', {}, `${lookups.length} CRM ${lookups.length === 1 ? 'lookup' : 'lookups'}`),
        el('ul', {}, lookups.map((l) => el('li', {}, l))))
      : null);
}

function messageNodes(msg, prev, { inThread = false } = {}) {
  const nodes = [];
  const newDay = !prev || dayKey(prev.createdAt) !== dayKey(msg.createdAt);
  if (newDay && !inThread) nodes.push(el('div', { class: 'day-divider' }, el('span', {}, dayLabel(msg.createdAt))));

  const grouped = !newDay && prev.memberId === msg.memberId && msg.createdAt - prev.createdAt < GROUP_WINDOW_MS && !prev.thread;
  const author = memberOrGhost(msg.memberId);
  const time = el('time', { datetime: new Date(msg.createdAt).toISOString(), title: new Date(msg.createdAt).toLocaleString() }, timeFmt.format(msg.createdAt));
  const isRoot = !inThread && !msg.threadId;

  nodes.push(el('article', { class: `msg ${grouped ? 'grouped' : ''} ${author.kind === 'agent' ? 'from-agent' : ''} ${mentionsMe(msg) ? 'mentions-me' : ''}`, 'data-id': msg.id },
    el('div', { class: 'msg-gutter' }, grouped ? time : avatar(author, { size: inThread ? 32 : 36 })),
    el('div', { class: 'msg-main' },
      grouped ? null : el('div', { class: 'msg-head' }, el('span', { class: 'msg-author' }, author.name), ...tags(author), time),
      msg.meta?.app === 'pipeline' ? appEventBody(msg) : el('div', { class: 'msg-body' }, richText(msg.body)),
      msg.meta && !msg.meta.app ? replyMeta(msg.meta) : null,
      isRoot ? el('div', { class: 'msg-extras', 'data-extras': msg.id }, extras(msg)) : null),
    isRoot ? el('button', { type: 'button', class: 'msg-action', onclick: () => openThread(msg.id) }, 'Reply') : null));
  return nodes;
}

function renderMessages() {
  const c = channel(state.channelId);
  const list = state.messages.get(c.id) ?? [];
  const intro = el('div', { class: 'channel-intro' },
    el('h2', {}, `#${c.name}`),
    el('p', { class: 'muted' }, `This is the start of #${c.name}. ${c.topic}`));
  const loading = state.loading.has(c.id) && list.length === 0 ? el('p', { class: 'muted center' }, 'Loading…') : null;
  els.messages.replaceChildren(intro, loading ?? '', ...list.flatMap((m, i) => messageNodes(m, list[i - 1])),
    el('div', { class: 'channel-jobs' }, channelJobs(c.id).map(jobLine)));
  scrollToBottom(els.messages);
}

const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
const scrollToBottom = (box) => { box.scrollTop = box.scrollHeight; };

// Re-draws the job lines and thread link under one top-level message.
function refreshExtras(rootId) {
  const root = state.messages.get(state.channelId)?.find((m) => m.id === rootId);
  const box = els.messages.querySelector(`[data-extras="${rootId}"]`);
  if (!root || !box) return;
  const stick = nearBottom(els.messages);
  box.replaceChildren(...extras(root).filter(Boolean));
  if (stick) scrollToBottom(els.messages);
}

/* ---------- workspace pages ---------- */

function showPage(id, sub = null) {
  state.page = id;
  state.pageSub = id === 'members' && (sub === 'new' || state.members.get(sub)?.kind === 'agent') ? sub : null;
  if (id === 'members' && sub && !state.pageSub) history.replaceState(null, '', '#members');
  els.page.classList.remove('tracker-page', 'board-page', 'apps-page');
  document.body.dataset.page = id;
  els.messages.hidden = true;
  els.composer.hidden = true;
  els.page.hidden = false;
  setPageTitle();
  renderChannels();
  renderChannelTabs();
  renderPage();
  loadPage(id);
}

function setPageTitle() {
  const { title, topic } = pageHeading();
  els.channelName.textContent = title;
  els.channelTopic.textContent = topic;
  document.title = `${title} · Team Room`;
}

function pageHeading() {
  const sub = state.page === 'members' ? state.pageSub : null;
  if (sub === 'new') return { title: 'New agent', topic: 'Make an agent for the team. It joins every channel, and anyone can @mention it.' };
  const agent = sub && state.members.get(sub);
  if (agent) return { title: agent.name, topic: `Agent profile · @${agent.id}` };
  return PAGES[state.page];
}

function leavePage() {
  state.page = null;
  state.pageSub = null;
  delete document.body.dataset.page;
  els.messages.hidden = false;
  els.composer.hidden = false;
  els.page.hidden = true;
}

async function loadPage(id) {
  if (id === 'members') return; // everything it shows is already in state
  try {
    if (id === 'skills') {
      state.skillsFull = (await api('/api/skills')).skills;
    } else if (id === 'usage') {
      els.page.classList.add('refreshing');
      state.usage = await api(`/api/usage?range=${state.usageRange}`);
      els.page.classList.remove('refreshing');
    } else {
      const [{ connections }, { records }] = await Promise.all([api('/api/connections'), api('/api/connections/demo-crm/records')]);
      state.connections = connections;
      state.crmRecords = records;
    }
  } catch (err) {
    state.pageError = err.message;
  }
  if (state.page === id) renderPage();
}

function renderPage() {
  if (state.page === 'members') renderMembersPage();
  if (state.page === 'skills') renderSkillsPage();
  if (state.page === 'connections') renderConnectionsPage();
  if (state.page === 'usage') renderUsagePage();
}

/* ---------- members page ---------- */

// The roomy version of the members panel: big photos, name and role on two lines.
// Agents open their profile page; people open their profile in the side panel.
function memberPageRow(m) {
  const agent = m.kind === 'agent';
  const status = agent ? agentStatus(m) : { cls: state.online.has(m.id) ? 'on' : '', text: state.online.has(m.id) ? 'Online' : 'Offline' };
  return el('li', { 'data-member-row': m.id },
    el('button', {
      type: 'button',
      class: `member-row ${m.kind}`,
      'aria-label': `${m.name}, ${m.title}: open profile`,
      onclick: () => (agent ? (location.hash = `#members/${m.id}`) : openProfile(m.id)),
    },
      avatar(m, { size: isWide() ? 56 : 48, presence: true }),
      el('span', { class: 'member-row-text' },
        el('span', { class: 'member-row-name' }, el('strong', {}, m.name), ...tags(m, { full: true })),
        el('span', { class: 'member-row-role', title: m.title }, m.title)),
      el('span', { class: `member-row-status status small ${status.cls}` }, status.text)));
}

function renderMembersPage() {
  if (state.pageSub === 'new') return renderNewAgentForm();
  if (state.pageSub) return renderAgentPage(state.members.get(state.pageSub));
  const all = [...state.members.values()];
  const people = all.filter((m) => m.kind === 'human');
  const agents = all.filter((m) => m.kind === 'agent');
  const filter = state.membersPageFilter;
  const sizes = { all: all.length, people: people.length, agents: agents.length };
  const section = (title, list, action = null) => el('section', { class: 'card member-section' },
    el('div', { class: 'member-section-head' },
      el('h2', {}, title, el('span', { class: 'muted' }, ` · ${list.filter((m) => state.online.has(m.id)).length} of ${list.length} online`)),
      action),
    el('ul', { class: 'member-rows' }, list.map(memberPageRow)));

  els.page.replaceChildren(...[
    el('div', { class: 'member-tabs page-tabs', role: 'group', 'aria-label': 'Show' },
      MEMBER_TABS.map(([id, label]) => el('button', {
        type: 'button',
        class: `member-tab ${filter === id ? 'active' : ''}`,
        'aria-pressed': String(filter === id),
        onclick: () => {
          state.membersPageFilter = id;
          renderMembersPage();
        },
      }, label, el('span', { class: 'member-tab-count' }, String(sizes[id]))))),
    filter !== 'agents' && section('People', people),
    filter !== 'people' && section('Agents', agents, el('a', { class: 'small-button', href: '#members/new' }, '+ New agent')),
    el('p', { class: 'muted small page-note' },
      filter === 'agents'
        ? 'Every agent runs on Claude, on the computer that runs the worker. Mention one with @ in any channel and it answers in a thread.'
        : 'The owner stands in for you. The other people are fictional demo teammates with AI-generated portraits. Click anyone for their profile.'),
  ].filter(Boolean));
}

/* ---------- agents: the New agent form and the profile page ---------- */

// Same rule as the server: "Ayşe's Copy Coach" -> @ayses-copy-coach.
function handleFor(name) {
  return name.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
}

function renderNewAgentForm() {
  const name = el('input', { type: 'text', name: 'name', maxlength: '40', required: true, placeholder: 'Copy Coach', autocomplete: 'off' });
  const handle = el('span', { class: 'field-hint' });
  const goodAt = el('input', { type: 'text', name: 'goodAt', required: true, placeholder: 'Cold emails, Subject lines, Landing page copy', autocomplete: 'off' });
  const persona = Object.fromEntries(PERSONA_PARTS.map(([key, , , example]) =>
    [key, el('textarea', { name: key, rows: '2', maxlength: '400', required: true, placeholder: example })]));
  const error = el('p', { class: 'composer-error', role: 'alert', hidden: true });
  const submit = el('button', { type: 'submit', class: 'primary-button inline' }, 'Create agent');

  const showHandle = () => {
    const id = handleFor(name.value.trim());
    const taken = id && state.members.has(id);
    handle.className = `field-hint ${taken ? 'bad' : ''}`;
    handle.textContent = !id ? 'People mention it with its @handle, made from the name.'
      : taken ? `@${id} is taken. Pick another name.` : `People mention it as @${id}`;
  };
  name.addEventListener('input', showHandle);
  showHandle();

  const field = (label, control, ...hint) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control, ...hint);
  const form = el('form', {
    class: 'card agent-form',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        const agent = await api('/api/agents', {
          method: 'POST',
          body: JSON.stringify({
            memberId: state.me,
            name: name.value,
            goodAt: goodAt.value.split(',').map((x) => x.trim()).filter(Boolean),
            model: form.elements.model.value,
            persona: Object.fromEntries(Object.entries(persona).map(([k, v]) => [k, v.value])),
          }),
        });
        receiveMember({ member: agent, today: { runs: 0, costUsd: 0 } });
        location.hash = `#members/${agent.id}`;
      } catch (err) {
        error.textContent = `Not created: ${err.message}`;
        error.hidden = false;
        submit.disabled = false;
      }
    },
  },
  el('a', { class: 'link-button back', href: '#members' }, '← Members'),
  field('Name', name, handle),
  field("What it's good at", goodAt, el('span', { class: 'field-hint' }, 'Comma separated, up to 6. Shown on its profile, and the agent is told.')),
  el('fieldset', { class: 'field model-choices' },
    el('legend', { class: 'field-label' }, 'How smart it should be'),
    el('div', { class: 'model-options' }, MODEL_CHOICES.map(([id, label, short, long, limit]) =>
      el('label', { class: 'model-option' },
        el('input', { type: 'radio', name: 'model', value: id, checked: id === 'sonnet' }),
        el('span', { class: 'model-option-text' },
          el('strong', {}, label, el('span', { class: 'muted' }, ` · ${short}`)),
          el('span', { class: 'small' }, long),
          el('span', { class: 'muted small' }, `Starts at ${limit}`)))))),
  el('fieldset', { class: 'field persona-fields' },
    el('legend', { class: 'field-label' }, 'Persona'),
    el('p', { class: 'muted small' }, 'Write it to the agent, in a sentence or two each. It answers in this voice; the company facts (like never quoting below $799/month) still apply.'),
    PERSONA_PARTS.map(([key, label]) => field(label, persona[key]))),
  error,
  el('div', { class: 'form-actions' },
    submit,
    el('a', { class: 'link-button', href: '#members' }, 'Cancel'),
    el('span', { class: 'muted small' }, "Runs on Claude on the computer that runs the worker, through your subscription. The owner can change its daily limit on Usage.")));

  els.page.replaceChildren(form);
  if (isWide()) name.focus();
}

function renderAgentPage(agent) {
  const status = agentStatus(agent);
  els.page.replaceChildren(
    el('section', { class: 'card agent-hero' },
      el('a', { class: 'link-button back', href: '#members' }, '← Members'),
      el('div', { class: 'agent-hero-top' },
        avatar(agent, { size: 72, presence: true }),
        el('div', { class: 'agent-hero-text' },
          el('h2', { class: 'profile-name' }, agent.name, ...tags(agent)),
          el('p', {}, agent.title),
          el('p', { class: 'muted small' }, `@${agent.id} · Runs on Claude · ${modelName(agent.model)}`),
          el('p', { class: `status small ${status.cls}` }, status.text)),
        el('div', { class: 'agent-hero-action' }, askButton(agent, { inline: true })))),
    el('section', { class: 'card' },
      el('h2', { class: 'card-title' }, 'Persona'),
      el('p', { class: 'muted small' }, 'Claude gets this with every question, so the agent answers in this voice.'),
      personaBlocks(agent.persona)),
    el('section', { class: 'card profile agent-facts' }, el('dl', {}, agentRows(agent))));
}

// Someone made an agent: it shows up everywhere right away.
function receiveMember({ member, today }) {
  state.members.set(member.id, { jobsDone: 0, ...state.members.get(member.id), ...member });
  state.today[member.id] = today;
  renderSide();
  if (state.page === 'members' && state.pageSub === member.id) setPageTitle();
}

/* ---------- usage page ---------- */

const RANGES = [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']];
const shortDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const dayOf = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const seconds = (ms) => (ms == null ? '–' : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : elapsed(ms));
const compact = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

let usageRefresh = null;
// Live updates: refetch at most twice a second while the page is open.
function refreshUsageSoon() {
  if (state.page !== 'usage' || usageRefresh) return;
  usageRefresh = setTimeout(() => {
    usageRefresh = null;
    if (state.page === 'usage') loadPage('usage');
  }, 500);
}

// Picks a clean tick step (1, 2 or 5 × 10^n) for about four gridlines, and the top it implies.
function niceScale(max) {
  if (max <= 0) return { top: 0, step: 0 };
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((m) => m >= raw);
  return { top: Math.ceil(max / step - 1e-9) * step, step };
}

function statTile(label, value, note, hero = false) {
  return el('div', { class: `stat ${hero ? 'hero' : ''}` },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value' }, value),
    note ? el('span', { class: 'stat-note' }, note) : null);
}

function dailyChart(daily) {
  const max = Math.max(0, ...daily.map((d) => d.costUsd));
  const { top, step } = niceScale(max);
  const peak = daily.reduce((best, d) => (d.costUsd > (best?.costUsd ?? 0) ? d : best), null);
  const tooltip = el('div', { class: 'chart-tooltip', role: 'status', hidden: true });
  const table = el('table', { class: 'data-table chart-table', hidden: true },
    el('thead', {}, el('tr', {}, el('th', {}, 'Day'), el('th', { class: 'num' }, 'Runs'), el('th', { class: 'num' }, 'API-equivalent'))),
    el('tbody', {}, daily.map((d) => el('tr', {}, el('td', {}, shortDay.format(dayOf(d.day))), el('td', { class: 'num' }, String(d.runs)), el('td', { class: 'num' }, money(d.costUsd))))));
  const plot = el('div', { class: 'chart-plot' });
  const showTip = (slot, d) => {
    tooltip.replaceChildren(el('strong', {}, money(d.costUsd)), el('span', {}, `${d.runs} ${d.runs === 1 ? 'run' : 'runs'} · ${shortDay.format(dayOf(d.day))}`));
    tooltip.hidden = false;
    const box = plot.getBoundingClientRect();
    const r = slot.getBoundingClientRect();
    tooltip.style.left = `${Math.min(Math.max(r.left - box.left + r.width / 2, 60), box.width - 60)}px`;
  };
  const labelEvery = Math.ceil(daily.length / 8);
  const ticks = top ? Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) : [0];

  plot.append(
    el('div', { class: 'chart-grid', 'aria-hidden': 'true' },
      ticks.map((v) => el('div', { class: 'tick', style: `bottom:${top ? (v / top) * 100 : 0}%` }, el('span', {}, money(v))))),
    el('div', { class: 'chart-bars', style: `--n:${daily.length}` },
      daily.map((d) => {
        const slot = el('div', {
          class: 'bar-slot',
          tabindex: '0',
          'aria-label': `${shortDay.format(dayOf(d.day))}: ${money(d.costUsd)}, ${d.runs} runs`,
          onpointerenter: () => showTip(slot, d),
          onfocus: () => showTip(slot, d),
          onpointerleave: () => { tooltip.hidden = true; },
          onblur: () => { tooltip.hidden = true; },
        },
        d.costUsd > 0 ? el('div', { class: 'bar', style: `height:${(d.costUsd / top) * 100}%` }) : null,
        d === peak && d.costUsd > 0 ? el('span', { class: 'bar-label', style: `bottom:${(d.costUsd / top) * 100}%` }, money(d.costUsd)) : null);
        return slot;
      })),
    tooltip);

  const toggle = el('button', {
    type: 'button',
    class: 'link-button',
    onclick: () => {
      table.hidden = !table.hidden;
      plot.hidden = !table.hidden;
      axis.hidden = !table.hidden;
      toggle.textContent = table.hidden ? 'Show as table' : 'Show as chart';
    },
  }, 'Show as table');
  const axis = el('div', { class: 'chart-x', style: `--n:${daily.length}`, 'aria-hidden': 'true' },
    daily.map((d, i) => el('span', {}, i % labelEvery === 0 || i === daily.length - 1 ? shortDay.format(dayOf(d.day)).replace(/,.*/, '') : '')));
  return el('figure', { class: 'card chart' },
    el('figcaption', { class: 'chart-head' }, el('h2', {}, 'API-equivalent cost per day'), toggle),
    max === 0 ? el('p', { class: 'muted small' }, 'No agent runs in this period yet.') : null,
    plot, axis, table);
}

function breakdown(title, rows, nameOf, totals) {
  const byCost = totals.costUsd > 0;
  const top = Math.max(...rows.map((r) => (byCost ? r.costUsd : r.runs)), 0);
  return el('section', { class: 'card breakdown' },
    el('h2', {}, title),
    rows.length === 0
      ? el('p', { class: 'muted small' }, 'Nothing yet.')
      : el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, title.replace('By ', '').replace(/^./, (c) => c.toUpperCase())),
          el('th', { class: 'num' }, 'Runs'),
          el('th', { class: 'num' }, 'Cost'),
          el('th', { class: 'num hide-narrow' }, 'Avg time'))),
        el('tbody', {}, rows.map((r) => {
          const share = top ? ((byCost ? r.costUsd : r.runs) / top) * 100 : 0;
          return el('tr', {},
            el('td', {},
              el('div', { class: 'name-cell' }, nameOf(r.key)),
              el('div', { class: 'share', 'aria-hidden': 'true' }, el('span', { style: `width:${share}%` }))),
            el('td', { class: 'num' }, String(r.runs), r.blocked ? el('div', { class: 'muted small' }, `${r.blocked} blocked`) : null),
            el('td', { class: 'num' }, money(r.costUsd)),
            el('td', { class: 'num hide-narrow' }, seconds(r.avgWallMs)));
        }))));
}

// Name with its demo/owner tag; "you" and "agent" add nothing in these tables.
function memberName(id) {
  if (!id) return el('span', { class: 'muted' }, 'Scheduled automations');
  const m = memberOrGhost(id);
  return [m.name, ...tags(m).filter((x) => x && !x.classList.contains('you') && !x.classList.contains('agent'))];
}

function meter(used, limit, label) {
  if (limit === null) return el('div', { class: 'meter-row' }, el('span', { class: 'meter-label' }, label), el('span', { class: 'muted small' }, 'no limit'));
  const ratio = used / limit;
  const level = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';
  return el('div', { class: `meter-row ${level}` },
    el('span', { class: 'meter-label' }, label),
    el('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(used), 'aria-label': label },
      el('span', { style: `width:${Math.min(ratio, 1) * 100}%` })),
    el('span', { class: 'meter-value' }, label === 'Runs' ? `${used} of ${limit}` : `${money(used)} of ${money(limit)}`),
    level === 'near' ? el('span', { class: 'meter-status' }, '⚠ close to limit') : null,
    level === 'over' ? el('span', { class: 'meter-status' }, '⛔ limit reached') : null);
}

function limitsCard(agents) {
  const isOwner = state.members.get(state.me)?.isOwner;
  return el('section', { class: 'card limits' },
    el('h2', {}, 'Daily limits'),
    el('p', { class: 'muted small' },
      'An agent stops taking jobs for the day once it hits either limit; it resets at midnight. ',
      'Blocked requests show in the thread and in the log below.'),
    agents.map((a) => {
      const agent = memberOrGhost(a.id);
      const runsInput = el('input', { type: 'number', min: '1', max: '10000', step: '1', value: a.limits.runs ?? '', placeholder: 'none', 'aria-label': `${agent.name} runs per day` });
      const usdInput = el('input', { type: 'number', min: '0.01', max: '1000', step: '0.01', value: a.limits.usd ?? '', placeholder: 'none', 'aria-label': `${agent.name} dollars per day` });
      const status = el('span', { class: 'muted small', role: 'status' });
      const save = async (e) => {
        e.preventDefault();
        status.textContent = 'Saving…';
        try {
          const limits = {
            runs: runsInput.value === '' ? null : Number(runsInput.value),
            usd: usdInput.value === '' ? null : Number(usdInput.value),
          };
          await api(`/api/agents/${a.id}/limits`, { method: 'POST', body: JSON.stringify({ memberId: state.me, ...limits }) });
          status.textContent = 'Saved';
        } catch (err) {
          status.textContent = `Not saved: ${err.message}`;
        }
      };
      return el('div', { class: 'limit-row' },
        el('div', { class: 'limit-who' }, avatar(agent, { size: 28 }), el('div', {}, el('strong', {}, agent.name), el('span', { class: 'muted small' }, ` ${a.model}`))),
        el('div', { class: 'limit-meters' }, meter(a.today.runs, a.limits.runs, 'Runs'), meter(a.today.costUsd, a.limits.usd, 'Cost')),
        isOwner
          ? el('form', { class: 'limit-form', onsubmit: save },
            el('label', {}, 'Runs/day ', runsInput),
            el('label', {}, '$/day ', usdInput),
            el('button', { type: 'submit', class: 'small-button' }, 'Save'),
            status)
          : null);
    }),
    isOwner ? null : el('p', { class: 'muted small' }, 'Only the owner can change limits.'));
}

function runsTable(runs) {
  const statusLabel = { done: 'answered', failed: 'failed', blocked: 'blocked', running: 'running' };
  return el('section', { class: 'card runs' },
    el('h2', {}, `Run log${runs.length === 50 ? ' · latest 50' : ''}`),
    runs.length === 0 ? el('p', { class: 'muted small' }, 'No runs in this period.') : el('div', { class: 'table-scroll' },
      el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'When'), el('th', {}, 'Agent'), el('th', {}, 'Asked by'), el('th', {}, 'Room'),
          el('th', {}, 'Model'), el('th', { class: 'num' }, 'Time'), el('th', { class: 'num' }, 'Cost'), el('th', {}, 'Result'))),
        el('tbody', {}, runs.map((r) => el('tr', { class: `run ${r.status}` },
          el('td', { class: 'nowrap' }, dayKey(r.startedAt) === dayKey(Date.now())
            ? timeFmt.format(r.startedAt)
            : `${shortDay.format(r.startedAt).replace(/,.*/, '')} ${timeFmt.format(r.startedAt)}`),
          el('td', {}, memberOrGhost(r.agentId).name),
          el('td', {}, r.requestedBy ? memberOrGhost(r.requestedBy).name : el('span', { class: 'muted' }, 'schedule')),
          el('td', {}, r.channelId ? el('a', { href: `#${r.channelId}` }, `#${channel(r.channelId)?.name ?? r.channelId}`) : '–'),
          el('td', { class: 'nowrap' }, shortModel(r.model ?? r.modelAlias) || '–', r.runner === 'fake' ? el('span', { class: 'tag readonly' }, 'fake') : null),
          el('td', { class: 'num', title: r.durationMs != null ? `Claude reported ${seconds(r.durationMs)}` : null }, r.status === 'blocked' ? '–' : seconds(r.wallMs)),
          el('td', { class: 'num' }, r.costUsd == null ? '–' : money(r.costUsd)),
          el('td', { title: r.error ?? '' }, el('span', { class: `result ${r.status}` }, statusLabel[r.status] ?? r.status))))))));
}

function renderUsagePage() {
  const u = state.usage;
  const filters = el('div', { class: 'filters', role: 'group', 'aria-label': 'Period' },
    RANGES.map(([id, label]) => el('button', {
      type: 'button',
      class: `filter ${state.usageRange === id ? 'active' : ''}`,
      'aria-pressed': String(state.usageRange === id),
      onclick: () => { state.usageRange = id; renderUsagePage(); loadPage('usage'); },
    }, label)));
  if (!u) return els.page.replaceChildren(filters, el('p', { class: 'muted' }, state.pageError ?? 'Loading…'));

  const t = u.totals;
  const tokens = t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite;
  els.page.replaceChildren(
    filters,
    el('p', { class: 'muted small usage-note' },
      'Prices are the API-equivalent cost Claude reports for each run. We pay a flat subscription, so read them as a measure of usage, not a bill.'),
    el('div', { class: 'stats' },
      statTile('API-equivalent cost', money(t.costUsd), `${compact(tokens)} tokens`, true),
      statTile('Agent runs', String(t.runs), t.runs ? `${money(t.costUsd / t.runs)} per run` : null),
      statTile('Average wait for an answer', seconds(t.avgWallMs), t.avgDurationMs != null ? `${seconds(t.avgDurationMs)} of it inside Claude` : null),
      statTile('Failed / blocked', `${t.failed} / ${t.blocked}`, t.blocked ? 'blocked by daily limits' : null)),
    dailyChart(u.daily),
    el('div', { class: 'breakdowns' },
      breakdown('By person', u.byPerson, memberName, t),
      breakdown('By room', u.byChannel, (id) => (id ? `#${channel(id)?.name ?? id}` : 'unknown'), t),
      breakdown('By agent', u.byAgent, memberName, t)),
    limitsCard(u.agents),
    runsTable(u.recent));
}

function renderSkillsPage() {
  const skills = state.skillsFull;
  if (!skills) return els.page.replaceChildren(el('p', { class: 'muted' }, state.pageError ?? 'Loading…'));
  els.page.replaceChildren(
    ...skills.map((s) => el('article', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', {}, s.name),
        el('span', { class: 'tag shared' }, 'every agent')),
      el('p', {}, s.description),
      el('p', { class: 'muted small' }, el('code', {}, s.path)),
      el('details', { class: 'skill-details' },
        el('summary', {}, 'Read the skill'),
        el('pre', { class: 'skill-body' }, s.body)))),
    el('p', { class: 'muted small page-note' },
      'These are Claude Code skill files. Before each job the worker copies them into the agent\'s workspace, and the agent loads the one that fits the request. ',
      'To add one, create skills/<name>/SKILL.md in the repo.'));
}

function connectionCard(c) {
  const isOwner = state.members.get(state.me)?.isOwner;
  const updatedBy = c.updatedBy ? memberOrGhost(c.updatedBy).name : null;
  const records = c.id === 'demo-crm' ? state.crmRecords ?? [] : [];
  const toggle = el('input', {
    type: 'checkbox',
    role: 'switch',
    checked: c.enabled,
    disabled: !isOwner,
    'aria-label': `${c.name} on or off`,
    onchange: async (e) => {
      const input = e.target;
      input.disabled = true;
      try {
        receiveConnection(await api(`/api/connections/${c.id}`, { method: 'POST', body: JSON.stringify({ memberId: state.me, enabled: input.checked }) }));
      } catch (err) {
        input.checked = !input.checked;
        alertLine.textContent = `Not changed: ${err.message}`;
        alertLine.hidden = false;
      } finally {
        input.disabled = !isOwner;
      }
    },
  });
  const alertLine = el('p', { class: 'composer-error', role: 'alert', hidden: true });
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, c.name),
      c.isDemo ? el('span', { class: 'tag demo' }, 'demo') : null,
      c.readOnly ? el('span', { class: 'tag readonly' }, 'read-only') : null),
    el('p', {}, c.description),
    el('label', { class: `switch-row ${c.enabled ? 'on' : ''}` },
      toggle,
      el('span', { class: 'switch', 'aria-hidden': 'true' }),
      el('span', {},
        el('strong', {}, c.enabled ? 'On' : 'Off'),
        c.enabled ? ': every agent can search and read these records.' : ': agents can\'t reach it.',
        updatedBy ? el('span', { class: 'muted small' }, ` Switched ${c.enabled ? 'on' : 'off'} by ${updatedBy}.`) : null)),
    isOwner ? null : el('p', { class: 'muted small' }, 'Only the owner can switch connections on or off.'),
    alertLine,
    el('h3', { class: 'card-label' }, 'Tools the agents get'),
    el('ul', { class: 'tool-list' }, c.tools.map((t) => el('li', {}, el('code', {}, t.name), ` ${t.description}`))),
    el('p', { class: 'muted small' }, 'Agents reach it through a small MCP server the worker starts for each job. Every lookup goes through Team Room and shows up under the agent\'s reply.'),
    records.length ? [
      el('h3', { class: 'card-label' }, `What the agents can read · ${records.length} fictional leads`),
      el('ul', { class: 'records' }, records.map((r) => el('li', { class: 'record' },
        el('div', { class: 'record-head' },
          el('strong', {}, r.company),
          el('span', { class: `stage ${r.stage}` }, r.stage),
          el('span', { class: 'muted small' }, `${r.id} · $${r.budgetPerMonth}/month · ${memberOrGhost(r.owner).name}`)),
        el('p', { class: 'small' }, r.goal)))),
    ] : null);
}

function renderConnectionsPage() {
  if (!state.crmRecords && !state.pageError) return els.page.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  els.page.replaceChildren(
    ...state.connections.map(connectionCard),
    el('p', { class: 'muted small page-note' }, 'More connections (a real CRM, analytics) come later. Each one starts read-only.'));
}

function receiveConnection(connection) {
  state.connections = state.connections.map((c) => (c.id === connection.id ? { ...c, ...connection } : c));
  renderChannels();
  renderSide();
  if (state.page === 'connections') renderPage();
}

/* ---------- #sales: weekly commitments, the daily check-in, people ---------- */

const HOUR_MS = 60 * 60 * 1000;
const isOwnerMe = () => Boolean(state.members.get(state.me)?.isOwner);
const canEditFor = (memberId) => memberId === state.me || isOwnerMe();
const weekShift = (week, days) => { const d = dayOf(week); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const idleText = (ms) => (ms < 48 * HOUR_MS ? 'a day' : `${Math.floor(ms / (24 * HOUR_MS))} days`);
const leadById = (id) => state.tracker?.leads.find((l) => l.id === id);

function whenText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? 'today' : d.toDateString() === tomorrow.toDateString() ? 'tomorrow' : shortDay.format(d).replace(/,.*/, '');
  return `${day} ${timeFmt.format(d)}`;
}

async function loadTracker(week = state.trackerWeek) {
  const query = week ? `?week=${week}` : '';
  try {
    const [tracker, { automations }] = await Promise.all([
      api(`/api/channels/${state.channelId}/commitments${query}`),
      api('/api/automations'),
    ]);
    state.tracker = tracker;
    state.trackerWeek = tracker.week;
    state.automations = automations;
    state.trackerError = null;
  } catch (err) {
    state.trackerError = err.message;
  }
  if (appOpen('commitments')) renderTracker();
  renderChannelTabs();
}

async function loadOverview(id) {
  try {
    state.overviews.set(id, await api(`/api/members/${id}/overview`));
  } catch {
    state.overviews.delete(id);
  }
  if (state.side.view === 'profile' && state.side.profileId === id) renderSide();
}

function receiveCommitment(c) {
  const t = state.tracker;
  if (t && c.channelId === state.channelId && c.week === t.week) {
    const i = t.commitments.findIndex((x) => x.id === c.id);
    if (i >= 0) t.commitments[i] = c;
    else t.commitments.push(c);
    if (appOpen('commitments')) renderTracker();
  }
  // Finishing a commitment on a lead moves that lead, so its card stops looking stalled.
  if (c.leadId && appOpen('pipeline')) loadBoard();
  refreshAppsSoon();
  if (state.side.view === 'profile' && state.side.profileId === c.ownerId) loadOverview(c.ownerId);
}

function receiveAutomation(a) {
  const i = state.automations.findIndex((x) => x.id === a.id);
  if (i >= 0) state.automations[i] = a;
  else state.automations.push(a);
  if (appOpen('commitments')) {
    renderTracker();
    loadTracker(); // a finished commitment may have moved a lead
  }
  refreshAppsSoon();
}

async function setCommitmentStatus(c, status, control) {
  if (control) control.disabled = true;
  try {
    receiveCommitment(await api(`/api/commitments/${c.id}`, { method: 'POST', body: JSON.stringify({ memberId: state.me, status }) }));
  } catch (err) {
    state.trackerError = `Not changed: ${err.message}`;
    renderTracker();
  }
}

function leadChip(id) {
  const lead = leadById(id);
  if (!lead) return el('span', { class: 'chip lead' }, id);
  const idle = lead.movedAt ? Date.now() - lead.movedAt : 0;
  return el('span', { class: `chip lead ${lead.stale ? 'stale' : ''}`, title: lead.stale ? `Not moved for ${idleText(idle)}` : `Moved ${whenText(lead.movedAt)}` },
    `${lead.id} ${lead.company.replace(' (demo)', '')}`, lead.stale ? el('span', { class: 'stale-mark' }, ` · ⚠ ${idleText(idle)}`) : null);
}

function commitmentItem(c) {
  const editable = canEditFor(c.ownerId);
  const box = el('input', {
    type: 'checkbox',
    checked: c.status === 'done',
    disabled: !editable || c.status === 'dropped',
    'aria-label': `${c.text}: ${c.status === 'done' ? 'done' : 'not done'}`,
    onchange: (e) => setCommitmentStatus(c, e.target.checked ? 'done' : 'open', e.target),
  });
  return el('li', { class: `commitment ${c.status}` },
    box,
    el('div', { class: 'commitment-main' },
      el('span', { class: 'commitment-text' }, c.text),
      el('span', { class: 'commitment-meta' },
        c.leadId ? leadChip(c.leadId) : null,
        c.status === 'done' ? el('span', { class: 'muted small' }, `done ${whenText(c.doneAt)}`) : null,
        c.status === 'dropped' ? el('span', { class: 'muted small' }, 'dropped') : null)),
    editable && c.status === 'open' ? el('button', { type: 'button', class: 'link-button quiet', onclick: (e) => setCommitmentStatus(c, 'dropped', e.target) }, 'Drop') : null,
    editable && c.status === 'dropped' ? el('button', { type: 'button', class: 'link-button quiet', onclick: (e) => setCommitmentStatus(c, 'open', e.target) }, 'Restore') : null);
}

function personCard(person, commitments, leads) {
  const live = commitments.filter((c) => c.status !== 'dropped');
  const done = live.filter((c) => c.status === 'done').length;
  const loose = leads.filter((l) => l.open && l.ownerId === person.id && !commitments.some((c) => c.leadId === l.id && c.status !== 'dropped'));
  return el('section', { class: 'card person-card', 'data-person': person.id },
    el('div', { class: 'person-head' },
      el('button', { type: 'button', class: 'person-link', onclick: () => openProfile(person.id) },
        avatar(person, { size: 30, presence: true }),
        el('span', {}, el('strong', {}, person.name), ...tags(person).filter((x) => x && !x.classList.contains('you')),
          el('span', { class: 'muted small block' }, person.title))),
      el('span', { class: 'person-count' }, live.length ? `${done} of ${live.length} done` : 'no commitments yet')),
    live.length ? el('div', { class: 'meter', 'aria-hidden': 'true' }, el('span', { style: `width:${(done / live.length) * 100}%` })) : null,
    commitments.length ? el('ul', { class: 'commitment-list' }, commitments.map(commitmentItem)) : null,
    loose.length ? el('p', { class: 'small loose-leads' }, 'Also owns: ', loose.map((l) => leadChip(l.id))) : null);
}

function checkinCard(a) {
  const agent = memberOrGhost(a.agentId);
  const status = agent.kind === 'agent' ? agentStatus(agent) : { cls: '', text: '' };
  const owner = isOwnerMe();
  const last = a.lastJob;
  const lastText = !last ? 'never run yet'
    : last.status === 'done' ? `posted ${whenText(last.finishedAt)}`
      : last.status === 'failed' ? (last.blocked ? 'blocked by the daily limit' : `failed: ${last.error ?? 'unknown error'}`)
        : last.status === 'running' ? 'writing now…' : 'waiting for the worker';
  const nudges = new Map();
  for (const l of a.wouldNudge) nudges.set(l.ownerId, [...(nudges.get(l.ownerId) ?? []), l]);
  const message = el('p', { class: 'muted small', role: 'status' });
  const timeInput = el('input', { type: 'time', value: a.time, 'aria-label': 'Check-in time', disabled: !owner });
  const save = (changes) => api(`/api/automations/${a.id}`, { method: 'POST', body: JSON.stringify({ memberId: state.me, ...changes }) })
    .then(receiveAutomation, (err) => { message.textContent = `Not saved: ${err.message}`; });
  const running = last && (last.status === 'running' || last.status === 'queued');

  return el('section', { class: 'card checkin' },
    el('div', { class: 'checkin-head' },
      el('div', {},
        el('h2', {}, 'Daily check-in'),
        el('p', { class: 'muted small' },
          `At ${a.time}${a.weekdaysOnly ? ' on weekdays' : ' every day'}, `, el('strong', {}, agent.name),
          ' posts how the week is going and nudges whoever owns a lead that has not moved for a day.')),
      el('span', { class: `checkin-agent status small ${status.cls}` }, avatar(agent, { size: 22, presence: true }), ` ${status.text}`)),
    el('dl', { class: 'checkin-facts' },
      el('div', {}, el('dt', {}, 'Next run'), el('dd', {}, a.enabled ? whenText(a.nextRunAt) || '–' : 'paused')),
      el('div', {}, el('dt', {}, 'Last run'), el('dd', {}, lastText, last?.status === 'done' ? [' · ', el('a', { href: `#${a.channelId}` }, 'see post')] : null))),
    el('div', { class: 'would-nudge' },
      el('span', { class: 'muted small' }, nudges.size ? 'Would nudge now:' : 'Would nudge now: nobody. Every open lead moved in the last day.'),
      [...nudges].map(([ownerId, leads]) => el('div', { class: 'nudge-row' },
        avatar(memberOrGhost(ownerId), { size: 20 }),
        el('strong', {}, memberOrGhost(ownerId).name),
        leads.map((l) => leadChip(l.id))))),
    owner
      ? el('div', { class: 'checkin-actions' },
        el('button', {
          type: 'button',
          class: 'primary-button inline',
          disabled: running,
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const { automation, job } = await api(`/api/automations/${a.id}/run`, { method: 'POST', body: JSON.stringify({ memberId: state.me }) });
              receiveJob(job);
              receiveAutomation(automation);
            } catch (err) {
              message.textContent = `Could not start: ${err.message}`;
              e.target.disabled = false;
            }
          },
        }, running ? 'Running…' : 'Run now'),
        el('label', { class: 'small muted' }, 'Time ', timeInput),
        el('button', { type: 'button', class: 'small-button', onclick: () => save({ time: timeInput.value }) }, 'Save time'),
        el('button', { type: 'button', class: 'link-button', onclick: () => save({ enabled: !a.enabled }) }, a.enabled ? 'Pause' : 'Resume'))
      : el('p', { class: 'muted small' }, 'Only the owner can run or change the check-in.'),
    message);
}

function addCommitmentForm(t) {
  const people = [...state.members.values()].filter((m) => m.kind === 'human');
  const text = el('input', { type: 'text', maxlength: '300', placeholder: 'What will you get done this week?', 'aria-label': 'Commitment', required: true });
  const lead = el('select', { 'aria-label': 'Lead (optional)' },
    el('option', { value: '' }, 'No lead'),
    t.leads.filter((l) => l.open).map((l) => el('option', { value: l.id }, `${l.id} ${l.company}`)));
  const owner = isOwnerMe()
    ? el('select', { 'aria-label': 'Whose commitment' }, people.map((p) => el('option', { value: p.id, selected: p.id === state.me }, p.id === state.me ? `${p.name} (me)` : p.name)))
    : null;
  const error = el('p', { class: 'composer-error', role: 'alert', hidden: true });
  return el('form', {
    class: 'card add-commitment',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        receiveCommitment(await api(`/api/channels/${state.channelId}/commitments`, {
          method: 'POST',
          body: JSON.stringify({ memberId: state.me, ownerId: owner?.value ?? state.me, text: text.value, leadId: lead.value || null, week: t.week }),
        }));
        text.value = '';
        lead.value = '';
        text.focus();
      } catch (err) {
        error.textContent = `Not added: ${err.message}`;
        error.hidden = false;
      }
    },
  },
  el('div', { class: 'add-row' }, text, lead, owner, el('button', { type: 'submit', class: 'small-button' }, 'Add')),
  error);
}

function renderTracker() {
  const t = state.tracker;
  if (!t || t.week !== (state.trackerWeek ?? t.week)) {
    return els.page.replaceChildren(appCrumb('Weekly commitments'), el('p', { class: 'muted' }, state.trackerError ?? 'Loading…'));
  }
  const start = dayOf(t.week);
  const end = dayOf(weekShift(t.week, 6));
  const isCurrent = t.week === t.currentWeek;
  const humans = [...state.members.values()].filter((m) => m.kind === 'human');
  const people = humans.filter((p) => p.id === state.me || t.commitments.some((c) => c.ownerId === p.id)
    || (isCurrent && t.leads.some((l) => l.open && l.ownerId === p.id)));
  const live = t.commitments.filter((c) => c.status !== 'dropped');
  const checkin = state.automations.find((a) => a.channelId === state.channelId);

  els.page.replaceChildren(...[
    appCrumb('Weekly commitments'),
    el('div', { class: 'week-nav' },
      el('button', { type: 'button', class: 'filter', 'aria-label': 'Previous week', onclick: () => { state.trackerWeek = weekShift(t.week, -7); renderTracker(); loadTracker(); } }, '‹'),
      el('h2', {}, isCurrent ? 'This week' : 'Week', el('span', { class: 'muted' }, ` · ${shortDay.format(start).replace(/^\w+,? /, '')} – ${shortDay.format(end).replace(/^\w+,? /, '')}`)),
      el('button', { type: 'button', class: 'filter', 'aria-label': 'Next week', onclick: () => { state.trackerWeek = weekShift(t.week, 7); renderTracker(); loadTracker(); } }, '›'),
      isCurrent ? null : el('button', { type: 'button', class: 'link-button', onclick: () => { state.trackerWeek = t.currentWeek; renderTracker(); loadTracker(); } }, 'Back to this week'),
      el('span', { class: 'week-total muted small' }, `${live.filter((c) => c.status === 'done').length} of ${live.length} done`)),
    state.trackerError ? el('p', { class: 'composer-error' }, state.trackerError) : null,
    isCurrent && checkin ? checkinCard(checkin) : null,
    addCommitmentForm(t),
    el('div', { class: 'people-grid' }, people.map((p) => personCard(p, t.commitments.filter((c) => c.ownerId === p.id), isCurrent ? t.leads : []))),
    el('p', { class: 'muted small page-note' },
      'A lead counts as moved when the CRM records an update or someone finishes a commitment linked to it. Leads that have not moved for a day get a nudge at check-in time.'),
  ].filter(Boolean)); // replaceChildren would print a null as text
}

function renderPersonProfile(person) {
  const row = (label, ...value) => el('div', { class: 'profile-row' }, el('dt', {}, label), el('dd', {}, ...value));
  const overview = state.overviews.get(person.id);
  const editable = canEditFor(person.id);
  const online = state.online.has(person.id);
  const head = el('div', { class: 'side-head' },
    el('button', { type: 'button', class: 'link-button back', onclick: () => setSide(true, 'members') }, '← Members'),
    el('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close profile', onclick: () => setSide(false) }, '×'));
  const top = el('div', { class: 'profile-top' },
    avatar(person, { size: 72, presence: true }),
    el('div', {},
      el('h2', { class: 'profile-name' }, person.name, ...tags(person, { full: true })),
      person.avatarAi ? el('p', { class: 'muted small' }, 'AI-generated portrait of a fictional teammate') : null,
      el('p', { class: `status small ${online ? 'on' : ''}` }, online ? 'Online' : 'Offline')));

  if (state.editingProfile && editable) {
    const title = el('input', { type: 'text', value: person.title, maxlength: '80', required: true, 'aria-label': 'Role' });
    const focus = el('textarea', { rows: '2', maxlength: '200', 'aria-label': 'Working on' }, person.focus ?? '');
    const ask = el('input', { type: 'text', value: (person.askAbout ?? []).join(', '), 'aria-label': 'Ask me about, comma separated' });
    const error = el('p', { class: 'composer-error', role: 'alert', hidden: true });
    return els.sideMembers.replaceChildren(head, el('div', { class: 'profile' }, top,
      el('form', {
        class: 'profile-form',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const saved = await api(`/api/members/${person.id}/profile`, {
              method: 'POST',
              body: JSON.stringify({ memberId: state.me, title: title.value, focus: focus.value, askAbout: ask.value.split(',').map((x) => x.trim()).filter(Boolean) }),
            });
            state.members.set(saved.id, { ...state.members.get(saved.id), ...saved });
            state.editingProfile = false;
            renderSide();
          } catch (err) {
            error.textContent = `Not saved: ${err.message}`;
            error.hidden = false;
          }
        },
      },
      el('label', {}, 'Role', title),
      el('label', {}, 'Working on', focus),
      el('label', {}, 'Ask me about', el('span', { class: 'muted small' }, ' (comma separated, up to 6)'), ask),
      error,
      el('div', { class: 'form-actions' },
        el('button', { type: 'submit', class: 'small-button' }, 'Save'),
        el('button', { type: 'button', class: 'link-button', onclick: () => { state.editingProfile = false; renderSide(); } }, 'Cancel')))));
  }

  const commitments = overview?.commitments ?? [];
  const done = commitments.filter((c) => c.status === 'done').length;
  els.sideMembers.replaceChildren(head, el('div', { class: 'profile' },
    top,
    el('p', { class: 'profile-title' }, person.title),
    el('dl', {},
      row('Working on', person.focus || el('span', { class: 'muted' }, 'Not filled in yet')),
      row('Ask me about', person.askAbout?.length
        ? el('span', { class: 'chips' }, person.askAbout.map((x) => el('span', { class: 'chip' }, x)))
        : el('span', { class: 'muted' }, 'Not filled in yet')),
      row('This week in #sales', !overview ? 'Loading…' : commitments.length
        ? [el('span', {}, `${done} of ${commitments.length} done`), el('ul', { class: 'profile-list' }, commitments.map((c) => el('li', { class: c.status }, c.status === 'done' ? '✓ ' : '○ ', c.text)))]
        : el('span', { class: 'muted' }, 'No commitments yet')),
      row('Leads', !overview ? 'Loading…' : overview.leads.length
        ? el('ul', { class: 'profile-list' }, overview.leads.map((l) => el('li', {}, `${l.id} ${l.company}`,
          l.stale ? el('span', { class: 'stale-mark' }, ` · ⚠ not moved for ${idleText(Date.now() - l.movedAt)}`) : el('span', { class: 'muted' }, ` · ${l.stage}`))))
        : el('span', { class: 'muted' }, 'No open leads'))),
    el('p', { class: 'muted small' }, 'Agents read this profile to know who to ask.'),
    editable ? el('button', { type: 'button', class: 'small-button', onclick: () => { state.editingProfile = true; renderSide(); } }, person.id === state.me ? 'Edit my profile' : 'Edit profile') : null));
}

/* ---------- channel apps: the Apps tab and the pipeline board ---------- */

const usd = (n) => `$${n.toLocaleString('en-US')}`;
const plainCompany = (name) => name.replace(/\s*\(demo\)$/, '');

// "← Apps in #sales / Pipeline" above every app.
function appCrumb(name, ...extra) {
  const c = channel(state.channelId);
  return el('div', { class: 'app-crumb' },
    el('a', { href: `#${c.id}/apps`, class: 'link-button back' }, `← Apps in #${c.name}`),
    el('span', { class: 'muted', 'aria-hidden': 'true' }, '/'),
    el('h2', {}, name),
    ...extra);
}

async function loadApps(channelId = state.channelId) {
  try {
    state.apps.set(channelId, (await api(`/api/channels/${encodeURIComponent(channelId)}/apps`)).apps);
    state.appsError = null;
  } catch (err) {
    state.appsError = err.message;
  }
  if (state.channelId === channelId && state.channelView === 'apps' && !state.app) renderApps();
}

let appsRefresh = null;
// Previews follow the live data: refetch at most every few hundred ms while the Apps tab is open.
function refreshAppsSoon() {
  state.apps.clear();
  if (state.channelView !== 'apps' || state.app || appsRefresh) return;
  appsRefresh = setTimeout(() => {
    appsRefresh = null;
    if (state.channelView === 'apps' && !state.app) loadApps();
  }, 300);
}

function pipelinePreview(p) {
  const top = Math.max(1, ...p.stages.map((s) => s.count));
  return el('div', { class: 'mini-board', 'aria-hidden': 'true' },
    p.stages.map((s) => el('div', { class: `mini-col stage-${s.id}` },
      el('div', { class: 'mini-stack', style: `--rows:${top}` },
        Array.from({ length: s.count }, (_, i) => el('span', { class: `mini-card ${i < s.stale ? 'stale' : ''}` }))),
      el('span', { class: 'mini-label' }, stageLabel(s.id), el('b', {}, ` ${s.count}`)))));
}

function commitmentsPreview(p) {
  const share = p.total ? p.done / p.total : 0;
  return el('div', { class: 'mini-commitments', 'aria-hidden': 'true' },
    el('div', { class: 'mini-ring', style: `--p:${share * 100}` }, el('span', {}, `${p.done}/${p.total}`)),
    el('div', { class: 'mini-side' },
      el('span', { class: 'mini-faces' }, p.people.slice(0, 5).map((id) => avatar(memberOrGhost(id), { size: 26 }))),
      el('span', { class: 'mini-note' }, p.checkin ? `Check-in ${p.checkin.enabled ? `at ${p.checkin.time}` : 'paused'}` : 'This week')));
}

function appCard(app) {
  const c = channel(state.channelId);
  const p = app.preview;
  const facts = app.id === 'pipeline'
    ? [`${p.open} open`, `${usd(p.openValuePerMonth)}/month in play`, p.stale ? `${p.stale} not moved for a day` : 'all moving']
    : [`${p.done} of ${p.total} done this week`, `${p.people.length} ${p.people.length === 1 ? 'person' : 'people'}`];
  return el('a', { href: `#${c.id}/apps/${app.id}`, class: `app-card app-${app.id}`, 'data-app': app.id },
    el('div', { class: 'app-preview' }, app.id === 'pipeline' ? pipelinePreview(p) : commitmentsPreview(p)),
    el('div', { class: 'app-body' },
      el('div', { class: 'app-title' }, el('h3', {}, app.name), app.id === 'pipeline' ? el('span', { class: 'tag demo' }, 'demo leads') : null),
      el('p', { class: 'muted small' }, app.description),
      el('p', { class: 'app-facts small' }, facts.flatMap((f, i) => [i ? el('span', { class: 'dot', 'aria-hidden': 'true' }, '·') : null, el('span', {}, f)]))));
}

function renderApps() {
  const c = channel(state.channelId);
  const apps = state.apps.get(c.id);
  if (!apps) return els.page.replaceChildren(el('p', { class: 'muted' }, state.appsError ?? 'Loading…'));
  if (apps.length === 0) {
    return els.page.replaceChildren(el('section', { class: 'card apps-empty' },
      el('h2', {}, `No apps in #${c.name} yet`),
      el('p', { class: 'muted' }, 'Apps live inside a channel, next to its messages. ',
        channelApps('sales').length && c.id !== 'sales' ? ['See the ', el('a', { href: '#sales/apps' }, 'pipeline board in #sales'), '.'] : null)));
  }
  els.page.replaceChildren(
    el('div', { class: 'app-grid' }, apps.map(appCard)),
    el('p', { class: 'muted small page-note' }, `Apps belong to #${c.name}: everyone here sees the same thing, live.`));
}

/* pipeline board */

async function loadBoard(channelId = state.channelId) {
  try {
    const { leads } = await api(`/api/channels/${encodeURIComponent(channelId)}/pipeline`);
    state.pipeline = { channelId, leads };
    state.boardError = null;
  } catch (err) {
    state.boardError = err.message;
  }
  if (state.channelId === channelId && appOpen('pipeline')) renderBoard();
}

// A drag in progress holds re-renders until the drop, so the card under the pointer stays put.
let drag = null;
let boardDirty = false;

function renderBoard() {
  if (drag) {
    boardDirty = true;
    return;
  }
  const b = state.pipeline;
  if (!b || b.channelId !== state.channelId) {
    return els.page.replaceChildren(appCrumb('Pipeline'), el('p', { class: 'muted' }, state.boardError ?? 'Loading…'));
  }
  const open = b.leads.filter((l) => l.open);
  const stale = open.filter((l) => l.stale).length;
  const sum = (list) => list.reduce((n, l) => n + (l.budgetPerMonth ?? 0), 0);
  els.page.replaceChildren(...[
    appCrumb('Pipeline', el('span', { class: 'board-total muted small' },
      `${open.length} open · ${usd(sum(open))}/month in play`, stale ? el('span', { class: 'stale-mark' }, ` · ⚠ ${stale} not moved for a day`) : null)),
    state.boardError ? el('p', { class: 'composer-error', role: 'alert' }, state.boardError) : null,
    el('div', { class: 'board' },
      el('div', { class: 'board-columns' }, STAGES.map(([id, label]) => {
        const leads = b.leads.filter((l) => l.stage === id);
        return el('section', { class: `column stage-${id} ${['won', 'lost'].includes(id) ? 'closed' : ''}`, 'data-stage': id, 'aria-label': `${label}: ${leads.length} leads` },
          el('header', { class: 'column-head' },
            el('span', { class: 'column-dot', 'aria-hidden': 'true' }),
            el('h3', {}, label),
            el('span', { class: 'column-count' }, String(leads.length)),
            el('span', { class: 'column-value' }, leads.length ? `${usd(sum(leads))}/mo` : '')),
          el('ul', { class: 'column-cards' },
            leads.length ? leads.map(leadCard) : el('li', { class: 'column-empty' }, 'Drop a lead here')));
      }))),
    el('p', { class: 'muted small page-note' },
      'Every lead here is fictional demo data from the demo CRM. Drag a card to another column (or use its menu) and #sales gets a short line about it, so the agents know. Agents can read the board\'s leads but never move them.'),
  ].filter(Boolean));
  state.justMoved = null;
}

function leadCard(lead) {
  const owner = memberOrGhost(lead.ownerId);
  const idle = lead.movedAt ? Date.now() - lead.movedAt : 0;
  const select = el('select', {
    class: 'card-move',
    'aria-label': `Move ${plainCompany(lead.company)} to another stage`,
    onchange: (e) => moveLead(lead.id, e.target.value),
  },
  el('option', { value: '', selected: true, disabled: true, hidden: true }, 'Move to…'),
  STAGES.filter(([id]) => id !== lead.stage).map(([id, label]) => el('option', { value: id }, `→ ${label}`)));
  const card = el('li', {
    class: `lead-card ${lead.stale ? 'stale' : ''} ${state.justMoved === lead.id ? 'just-moved' : ''}`,
    'data-lead': lead.id,
    title: `${lead.goal}\n\n${lead.notes}`,
    onpointerdown: (e) => startDrag(e, lead, card),
  },
  el('div', { class: 'lead-top' },
    el('strong', { class: 'lead-name' }, plainCompany(lead.company)),
    el('span', { class: 'tag demo' }, 'demo')),
  el('p', { class: 'lead-what muted small' }, `${lead.industry} · ${lead.city}`),
  lead.stale ? el('p', { class: 'stale-mark small' }, `⚠ not moved for ${idleText(idle)}`) : null,
  el('div', { class: 'lead-foot' },
    el('span', { class: 'lead-budget' }, `${usd(lead.budgetPerMonth)}/mo`),
    el('span', { class: 'lead-owner', title: `Owner: ${owner.name}` }, avatar(owner, { size: 22 })),
    // The native menu sits invisibly on a small icon: compact, and still keyboard and screen-reader friendly.
    el('span', { class: 'card-move-wrap', title: 'Move to another stage' }, el('span', { 'aria-hidden': 'true' }, '⇄'), select)));
  return card;
}

function startDrag(e, lead, card) {
  if (e.button !== 0 || e.target.closest('select, button, a')) return;
  const start = { x: e.clientX, y: e.clientY };
  const box = card.getBoundingClientRect();
  const offset = { x: e.clientX - box.left, y: e.clientY - box.top };
  let ghost = null;
  let over = null;
  card.setPointerCapture(e.pointerId);

  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return; // a click, not a drag
      drag = { leadId: lead.id };
      ghost = card.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${box.width}px`;
      document.body.append(ghost);
      card.classList.add('dragging');
      document.body.classList.add('board-dragging');
    }
    ghost.style.transform = `translate(${ev.clientX - offset.x}px, ${ev.clientY - offset.y}px) rotate(1.5deg)`;
    const column = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.column');
    if (column !== over) {
      over?.classList.remove('drop-target');
      over = column?.dataset.stage === lead.stage ? null : column;
      over?.classList.add('drop-target');
    }
  };
  const end = (ev) => {
    card.removeEventListener('pointermove', move);
    card.removeEventListener('pointerup', end);
    card.removeEventListener('pointercancel', end);
    if (!ghost) return;
    ghost.remove();
    card.classList.remove('dragging');
    document.body.classList.remove('board-dragging');
    over?.classList.remove('drop-target');
    drag = null;
    if (ev.type === 'pointerup' && over) moveLead(lead.id, over.dataset.stage);
    else if (boardDirty) renderBoard();
    boardDirty = false;
  };
  card.addEventListener('pointermove', move);
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

// Moves the card right away, then tells the room; if the room says no, the board reloads.
async function moveLead(leadId, stage) {
  const lead = state.pipeline?.leads.find((l) => l.id === leadId);
  if (!lead || lead.stage === stage) return renderBoard();
  const from = lead.stage;
  lead.stage = stage;
  state.boardError = null;
  renderBoard();
  try {
    const { lead: moved, message } = await api(`/api/channels/${encodeURIComponent(state.pipeline.channelId)}/pipeline/${leadId}`, {
      method: 'POST',
      body: JSON.stringify({ memberId: state.me, stage, from }),
    });
    receiveLead(moved, { flash: false });
    if (message) receive(message);
  } catch (err) {
    state.boardError = `Not moved: ${err.message}`;
    await loadBoard();
  }
}

function receiveLead(lead, { flash = true } = {}) {
  const b = state.pipeline;
  const i = b?.leads.findIndex((l) => l.id === lead.id) ?? -1;
  if (i >= 0) {
    if (flash && b.leads[i].stage !== lead.stage) state.justMoved = lead.id;
    b.leads[i] = lead;
    if (appOpen('pipeline')) renderBoard();
  }
  const t = state.tracker;
  const j = t?.leads.findIndex((l) => l.id === lead.id) ?? -1;
  if (j >= 0) {
    t.leads[j] = lead;
    if (appOpen('commitments')) renderTracker();
  }
  refreshAppsSoon();
  if (state.side.view === 'profile' && state.side.profileId === lead.ownerId) loadOverview(lead.ownerId);
  if (state.page === 'connections') loadPage('connections');
}

// A board move in the chat: "moved Northwind Bakery from Qualified to Proposal", with a way to the board.
function appEventBody(msg) {
  const m = msg.meta;
  return el('div', { class: 'msg-body app-event' },
    'moved ', el('strong', {}, m.company), ' from ',
    el('span', { class: `stage ${m.from}` }, stageLabel(m.from)), ' to ',
    el('span', { class: `stage ${m.to}` }, stageLabel(m.to)), ' ',
    el('a', { class: 'app-link', href: `#${msg.channelId}/apps/pipeline` }, 'Pipeline board'));
}

/* ---------- thread panel ---------- */

async function openThread(rootId) {
  const root = [...state.messages.values()].flat().find((m) => m.id === rootId);
  state.thread = { rootId, channelId: root?.channelId ?? state.channelId, root: root ?? null, replies: [], loading: true };
  setSide(true, 'thread');
  renderThread();
  threadComposer.input.focus();
  try {
    const data = await api(`/api/threads/${rootId}`);
    if (state.thread?.rootId !== rootId) return;
    for (const job of data.jobs) state.jobs.set(job.id, job);
    for (const r of data.replies) seenReplies.add(r.id);
    const known = new Set(data.replies.map((r) => r.id));
    // Keep replies that arrived over the live stream while we were loading.
    state.thread = { ...state.thread, root: data.root, channelId: data.root.channelId, loading: false,
      replies: [...data.replies, ...state.thread.replies.filter((r) => !known.has(r.id))].sort((a, b) => a.id - b.id) };
  } catch (err) {
    state.thread.loading = false;
    state.thread.error = err.message;
  }
  renderThread();
}

function closeThread() {
  state.thread = null;
  setSide(isWide(), 'members');
}

function renderThread() {
  const t = state.thread;
  if (!t) return;
  els.threadChannel.textContent = `#${channel(t.channelId)?.name ?? ''}`;
  if (!t.root) {
    els.threadMessages.replaceChildren(el('p', { class: 'muted center' }, t.error ?? 'Loading…'));
    return;
  }
  const replies = t.replies;
  els.threadMessages.replaceChildren(
    ...messageNodes(t.root, null, { inThread: true }),
    el('div', { class: 'day-divider thread-divider' }, el('span', {}, replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : 'No replies yet')),
    ...replies.flatMap((m, i) => messageNodes(m, replies[i - 1] ?? null, { inThread: true })),
    el('div', { class: 'thread-jobs' }, openJobs(t.rootId).map(jobLine)));
  scrollToBottom(els.threadMessages);
}

/* ---------- data flow ---------- */

function mergeMessages(channelId, incoming) {
  const byId = new Map((state.messages.get(channelId) ?? []).map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  state.messages.set(channelId, [...byId.values()].sort((a, b) => a.id - b.id));
}

async function loadChannel(id) {
  state.loading.add(id);
  if (!state.messages.has(id)) state.messages.set(id, []);
  try {
    const { messages, jobs } = await api(`/api/channels/${encodeURIComponent(id)}/messages`);
    mergeMessages(id, messages);
    for (const job of jobs) state.jobs.set(job.id, job);
  } finally {
    state.loading.delete(id);
  }
  if (id === state.channelId) renderMessages();
}

function route() {
  const [id, view, app] = location.hash.slice(1).split('/');
  if (PAGES[id]) showPage(id, view);
  else selectChannel(id, view, app);
}

const channelApps = (id) => APP_IDS.filter((a) => channel(id)?.features?.includes(a));
const appOpen = (id) => state.channelView === 'apps' && state.app === id;

function selectChannel(id, view = 'messages', app = null) {
  if (!channel(id)) id = state.channels[0].id;
  if (view === 'commitments') [view, app] = ['apps', 'commitments']; // links from before the Apps tab
  if (view !== 'apps') [view, app] = ['messages', null];
  if (app && !channelApps(id).includes(app)) app = null;
  const hash = view === 'messages' ? `#${id}` : `#${id}/apps${app ? `/${app}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  const fromPage = state.page !== null;
  if (fromPage) leavePage();
  if (id === state.channelId) {
    const c = channel(id);
    els.channelName.textContent = `# ${c.name}`;
    els.channelTopic.textContent = c.topic;
    document.title = `#${c.name} · Team Room`;
    setChannelView(view, app);
    renderChannels();
    return;
  }
  state.channelId = id;
  state.unread.delete(id);
  state.mentions.delete(id);
  const c = channel(id);
  els.channelName.textContent = `# ${c.name}`;
  els.channelTopic.textContent = c.topic;
  mainComposer.input.placeholder = `Message #${c.name}`;
  document.title = `#${c.name} · Team Room`;
  renderMessages();
  setChannelView(view, app);
  renderChannels();
  if (state.side.view === 'profile') renderSide();
  if (!state.messages.has(id) || state.messages.get(id).length === 0) loadChannel(id);
  if (isWide() && view === 'messages') mainComposer.input.focus();
}

// Messages, the channel's app cards, or one app, inside the same channel.
function setChannelView(view, app = null) {
  state.channelView = view;
  state.app = view === 'apps' ? app : null;
  const onApps = view === 'apps';
  els.messages.hidden = onApps;
  els.composer.hidden = onApps;
  els.page.hidden = !onApps;
  els.page.classList.toggle('apps-page', onApps && !state.app);
  els.page.classList.toggle('tracker-page', state.app === 'commitments');
  els.page.classList.toggle('board-page', state.app === 'pipeline');
  if (state.app === 'commitments') {
    renderTracker();
    loadTracker();
  } else if (state.app === 'pipeline') {
    renderBoard();
    loadBoard();
  } else if (onApps) {
    renderApps();
    loadApps();
  } else {
    state.unread.delete(state.channelId);
    state.mentions.delete(state.channelId);
    scrollToBottom(els.messages);
  }
  renderChannelTabs();
}

function renderChannelTabs() {
  const id = state.channelId;
  els.channelTabs.hidden = state.page !== null || !id;
  if (els.channelTabs.hidden) return;
  const unread = state.unread.get(id) || 0;
  const apps = channelApps(id).length;
  const onMessages = state.channelView === 'messages';
  els.channelTabs.replaceChildren(
    el('a', { href: `#${id}`, class: `tab ${onMessages ? 'active' : ''}`, 'aria-current': onMessages ? 'page' : null },
      'Messages', unread && !onMessages ? el('span', { class: 'badge' }, String(unread)) : null),
    el('a', { href: `#${id}/apps`, class: `tab ${onMessages ? '' : 'active'}`, 'aria-current': onMessages ? null : 'page' },
      'Apps', el('span', { class: 'tab-count' }, String(apps))));
}

// Thread replies can reach us twice (our own POST response and the live stream).
const seenReplies = new Set();

function receiveReply(msg) {
  if (seenReplies.has(msg.id)) return false;
  seenReplies.add(msg.id);
  const root = state.messages.get(msg.channelId)?.find((m) => m.id === msg.threadId);
  if (root) {
    const t = root.thread ?? { count: 0, participants: [] };
    root.thread = {
      count: t.count + 1,
      participants: t.participants.includes(msg.memberId) ? t.participants : [...t.participants, msg.memberId].slice(0, 5),
      last: { memberId: msg.memberId, body: msg.body, createdAt: msg.createdAt },
    };
    if (msg.channelId === state.channelId) refreshExtras(root.id);
  }
  const t = state.thread;
  if (t?.rootId === msg.threadId && !t.replies.some((r) => r.id === msg.id)) {
    t.replies.push(msg);
    if (t.root) {
      t.root.thread = root?.thread ?? t.root.thread;
      renderThread();
    }
  }
  return true;
}

function receive(msg) {
  if (msg.threadId) {
    if (!receiveReply(msg)) return;
  } else {
    const list = state.messages.get(msg.channelId);
    if (list?.some((m) => m.id === msg.id)) return;
    if (list) {
      const prev = list.at(-1);
      list.push(msg);
      if (msg.channelId === state.channelId && !state.loading.has(msg.channelId)) {
        const stick = nearBottom(els.messages) || msg.memberId === state.me;
        appendMessageNodes(messageNodes(msg, prev));
        if (stick) scrollToBottom(els.messages);
      }
    }
  }
  const unseen = msg.channelId !== state.channelId || state.page || state.channelView !== 'messages';
  if (unseen && msg.memberId !== state.me) {
    state.unread.set(msg.channelId, (state.unread.get(msg.channelId) || 0) + 1);
    if (mentionsMe(msg)) state.mentions.set(msg.channelId, (state.mentions.get(msg.channelId) || 0) + 1);
    renderChannels();
    renderChannelTabs();
  }
}

function receiveJob(job) {
  const before = state.jobs.get(job.id);
  state.jobs.set(job.id, job);
  if (job.status === 'done' && before?.status !== 'done') {
    const agent = state.members.get(job.agentId);
    if (agent) agent.jobsDone = (agent.jobsDone ?? 0) + 1;
  }
  if (job.channelId === state.channelId) {
    if (job.threadId === null) refreshChannelJobs();
    else refreshExtras(job.threadId);
  }
  if (job.automationId && appOpen('commitments')) renderTracker();
  if (state.thread?.rootId === job.threadId) renderThread();
  renderSide();
}

function connect() {
  const source = new EventSource(`/api/events?as=${encodeURIComponent(state.me)}`);
  let connectedBefore = false;
  source.addEventListener('hello', (e) => {
    const { online, jobs } = JSON.parse(e.data);
    state.online = new Set(online);
    document.body.classList.remove('offline');
    if (connectedBefore) {
      // Refetch what we may have missed while disconnected.
      for (const [id, job] of state.jobs) if (job.status === 'queued' || job.status === 'running') state.jobs.delete(id);
      for (const job of jobs) state.jobs.set(job.id, job);
      for (const id of state.messages.keys()) if (id !== state.channelId) state.messages.delete(id);
      loadChannel(state.channelId);
      if (state.thread) openThread(state.thread.rootId);
    }
    connectedBefore = true;
    renderSide();
  });
  source.addEventListener('presence', (e) => {
    state.online = new Set(JSON.parse(e.data).online);
    renderSide();
    // Waiting jobs read differently when their agent comes online or goes offline.
    if (state.channelId) for (const m of state.messages.get(state.channelId) ?? []) if (openJobs(m.id).length) refreshExtras(m.id);
    renderThread();
  });
  source.addEventListener('message', (e) => receive(JSON.parse(e.data)));
  source.addEventListener('job', (e) => receiveJob(JSON.parse(e.data)));
  source.addEventListener('connection', (e) => receiveConnection(JSON.parse(e.data)));
  source.addEventListener('commitment', (e) => receiveCommitment(JSON.parse(e.data)));
  source.addEventListener('lead', (e) => receiveLead(JSON.parse(e.data)));
  source.addEventListener('automation', (e) => receiveAutomation(JSON.parse(e.data)));
  source.addEventListener('member', (e) => receiveMember(JSON.parse(e.data)));
  source.addEventListener('profile', (e) => {
    const profile = JSON.parse(e.data);
    state.members.set(profile.id, { ...state.members.get(profile.id), ...profile });
    renderSide();
    if (appOpen('commitments')) renderTracker();
  });
  source.addEventListener('usage', (e) => {
    const { agentId, today } = JSON.parse(e.data);
    state.today[agentId] = today;
    if (state.side.view === 'profile' || state.pageSub) renderSide();
    refreshUsageSoon();
  });
  source.addEventListener('limits', (e) => {
    const { agentId, limits } = JSON.parse(e.data);
    const agent = state.members.get(agentId);
    if (agent) agent.limits = limits;
    if (state.side.view === 'profile' || state.pageSub) renderSide();
    refreshUsageSoon();
  });
  source.addEventListener('error', () => document.body.classList.add('offline'));
}

/* ---------- composers ---------- */

// The @ menu under a textarea: arrows to move, Enter or Tab to pick, Esc to close.
function attachMentionMenu(input) {
  const menu = el('ul', { class: 'mention-menu', role: 'listbox', hidden: true });
  input.parentElement.append(menu);
  let items = [];
  let index = 0;
  let range = null;

  const close = () => { menu.hidden = true; items = []; };
  function render() {
    menu.replaceChildren(...items.map((m, i) => el('li', {
      role: 'option',
      class: i === index ? 'active' : '',
      'aria-selected': String(i === index),
      onmousedown: (e) => { e.preventDefault(); pick(i); },
    },
    avatar(m, { size: 22, presence: true }),
    el('span', { class: 'mention-name' }, m.name),
    el('span', { class: 'muted small' }, `@${m.id}`),
    m.kind === 'agent' ? el('span', { class: 'tag agent' }, 'agent') : null)));
    menu.hidden = false;
  }
  function update() {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(?:^|\s)@([\w-]*)$/);
    if (!match) return close();
    const q = match[1].toLowerCase();
    items = [...state.members.values()]
      .filter((m) => m.id !== state.me && (m.id.startsWith(q) || m.name.toLowerCase().startsWith(q)))
      .sort((a, b) => (a.kind === 'agent' ? 0 : 1) - (b.kind === 'agent' ? 0 : 1))
      .slice(0, 6);
    if (!items.length) return close();
    range = [input.selectionStart - match[1].length - 1, input.selectionStart];
    index = 0;
    render();
  }
  function pick(i) {
    const handle = `@${items[i].id} `;
    input.value = input.value.slice(0, range[0]) + handle + input.value.slice(range[1]);
    const caret = range[0] + handle.length;
    input.setSelectionRange(caret, caret);
    close();
    input.dispatchEvent(new Event('input'));
  }

  input.addEventListener('input', update);
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      pick(index);
    } else if (e.key === 'Escape') {
      close();
    } else {
      return;
    }
    e.preventDefault();
  });
}

function createComposer(form, target) {
  const input = form.querySelector('textarea');
  const button = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.composer-error');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };

  attachMentionMenu(input); // before the Enter handler, so picking a mention doesn't send
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
    if (e.key === 'Escape' && form === els.threadComposer) closeThread();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    const { channelId, threadId } = target();
    if (!body || !channelId) return;
    button.disabled = true;
    error.hidden = true;
    try {
      const msg = await api(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ memberId: state.me, body, threadId }),
      });
      input.value = '';
      autosize();
      receive(msg);
    } catch (err) {
      error.textContent = `Not sent: ${err.message}`;
      error.hidden = false;
    } finally {
      button.disabled = false;
      input.focus();
    }
  });

  return {
    input,
    insert(text) {
      const sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
      input.value += sep + text;
      autosize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
  };
}

/* ---------- start ---------- */

function start(id) {
  state.me = id;
  els.picker.hidden = true;
  els.app.hidden = false;
  mainComposer = createComposer(els.composer, () => ({ channelId: state.channelId, threadId: null }));
  threadComposer = createComposer(els.threadComposer, () => ({ channelId: state.thread?.channelId, threadId: state.thread?.rootId }));
  setSide(isWide(), 'members');
  connect();
  if (!location.hash) history.replaceState(null, '', '#general');
  route();

  window.addEventListener('hashchange', route);
  els.membersToggle.addEventListener('click', () => {
    const showingMembers = state.side.open && state.side.view !== 'thread';
    setSide(!showingMembers, 'members');
  });
  els.threadClose.addEventListener('click', closeThread);
  // Running timers on "… is working" lines.
  setInterval(() => {
    for (const node of document.querySelectorAll('[data-since]')) node.textContent = elapsed(Date.now() - Number(node.dataset.since));
  }, 1000);
}

async function main() {
  const data = await api('/api/state');
  state.channels = data.channels;
  for (const m of data.members) state.members.set(m.id, m);
  state.online = new Set(data.online);
  for (const job of data.jobs) state.jobs.set(job.id, job);
  state.skills = data.skills;
  state.connections = data.connections;
  state.today = data.today;

  const requested = new URLSearchParams(location.search).get('as');
  if (requested) {
    if (isHuman(requested)) return start(requested);
    return showPicker(`There is no person with the id "${requested}". Pick one below.`);
  }
  const remembered = storage.get(ME_KEY);
  if (isHuman(remembered)) {
    choose(remembered);
  } else {
    showPicker();
  }
}

main().catch((err) => {
  document.body.replaceChildren(el('p', { class: 'fatal' }, `Team Room could not load: ${err.message}`));
});
