// Builds what an agent sees: a system prompt from its profile, and the
// conversation around the message that mentioned it.
import { COMPANY } from '../seed.js';

const MAX_LINE = 1500;

function toolsSection(skills, connections) {
  const lines = ['', 'Team skills and tools:'];
  if (skills.length) {
    lines.push('- Shared team skills. When a request matches a skill, load it with the Skill tool before you answer, and follow it:');
    for (const s of skills) lines.push(`  - ${s.name}: ${s.description}`);
  }
  if (connections.length) {
    lines.push('- Connected tools, read-only:');
    for (const c of connections) lines.push(`  - ${c.name}: ${c.description} Tools: ${c.tools.map((t) => t.name).join(', ')}.`);
    lines.push('- Whenever a lead or company comes up, look it up in the CRM before answering. Never guess lead details; if a lead is not in the CRM, say so.');
  }
  lines.push("- That is all you have: you cannot browse the web, change anything, read files or run code. Don't claim you did.");
  return lines;
}

function directory(people) {
  const lines = ['', "Who's who. When something needs a person, point to the right teammate by their @handle:"];
  for (const p of people) {
    const tag = p.isOwner ? 'founder' : p.isDemo ? 'demo teammate' : 'teammate';
    lines.push(`- ${p.name} (@${p.id}), ${p.title}, ${tag}.${p.focus ? ` Working on: ${p.focus}.` : ''}${p.askAbout?.length ? ` Ask about: ${p.askAbout.join(', ')}.` : ''}`);
  }
  return lines;
}

// The persona a teammate wrote for the agent. It sets the voice; the facts and rules below still hold.
function personaSection(persona) {
  if (!persona) return [];
  return [
    '',
    'Your persona. Stay in it in every reply:',
    `- Who you are: ${persona.who}`,
    `- How you think: ${persona.think}`,
    `- How you sound: ${persona.sound}`,
    'Your persona sets your voice and your angle. The company facts and the answer rules below still apply.',
  ];
}

export function buildSystemPrompt(agent, { skills = [], connections = [], people = [] } = {}) {
  const hasTools = skills.length > 0 || connections.length > 0;
  return [
    `You are ${agent.name}, an AI agent and member of Team Room, the internal chat of ${COMPANY.name}. People and agents share the same channels.`,
    `Your role: ${agent.title}.`,
    agent.skills?.length ? `You are good at: ${agent.skills.join('; ')}.` : '',
    agent.instructions,
    ...personaSection(agent.persona),
    '',
    'Facts about the company:',
    ...COMPANY.facts.map((fact) => `- ${fact}`),
    '',
    'How to answer:',
    '- You are replying in a chat thread. Be concise and practical: usually 2 to 6 short sentences, or a short list with "-" bullets, unless a skill asks for a longer format (an offer draft, for example).',
    '- Plain text only: no headings, no bold, no tables.',
    hasTools ? '- If you need information you cannot get, ask for it.' : "- You have no tools here: you cannot browse, read files or run code. Don't claim you did. If you need information, ask for it.",
    '- Reply in the language of the person who mentioned you.',
    ...(hasTools ? toolsSection(skills, connections) : []),
    ...(people.length ? directory(people) : []),
  ].join('\n');
}

function describe(member) {
  if (!member) return 'Unknown';
  if (member.kind === 'agent') return `${member.name} (agent)`;
  if (member.isOwner) return `${member.name} (founder)`;
  return `${member.name} (${member.title}, demo teammate)`;
}

const clip = (text) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text);

export function buildPrompt({ channel, history, trigger, members }) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const lines = [`Channel: #${channel.name} (${channel.topic})`, ''];
  if (history.length) {
    lines.push(trigger.threadId ? 'The thread so far, oldest first:' : 'Recent messages in the channel, oldest first:');
    for (const m of history) lines.push(`${describe(byId.get(m.memberId))}: ${clip(m.body)}`);
    lines.push('');
  }
  lines.push(`New message that mentions you, from ${describe(byId.get(trigger.memberId))}:`);
  lines.push(clip(trigger.body));
  lines.push('', 'Write your reply. It will be posted in the thread under that message.');
  return lines.join('\n');
}
