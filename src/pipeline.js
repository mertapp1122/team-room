// The #sales work stream: which leads stopped moving, and what the daily check-in says.
import { HOUR, addDays, weekKey, weekStart } from './time.js';

export const STALE_AFTER_MS = 24 * HOUR;
const CLOSED_STAGES = ['won', 'lost'];
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// A lead moves when the CRM records a change or someone finishes a commitment on it.
export function leadMovedAt(store, lead) {
  const moved = Math.max(lead.updatedAt ?? 0, store.leadLastDone(lead.id) ?? 0);
  return moved || null;
}

export function pipelineLeads(store, now) {
  return store.crmLeads().map((lead) => {
    const movedAt = leadMovedAt(store, lead);
    const open = !CLOSED_STAGES.includes(lead.stage);
    return {
      id: lead.id,
      company: lead.company,
      stage: lead.stage,
      ownerId: lead.owner,
      goal: lead.goal,
      notes: lead.notes,
      industry: lead.industry,
      city: lead.city,
      budgetPerMonth: lead.budgetPerMonth,
      movedAt,
      open,
      stale: open && movedAt !== null && now - movedAt >= STALE_AFTER_MS,
    };
  });
}

export const staleLeads = (store, now) => pipelineLeads(store, now).filter((l) => l.stale).sort((a, b) => a.movedAt - b.movedAt);

export function idleLabel(ms) {
  const days = Math.floor(ms / (24 * HOUR));
  return days <= 1 ? 'a day' : `${days} days`;
}

// Everything the check-in needs, worked out here rather than by the model.
export function checkinFacts(store, channelId, now) {
  const week = weekKey(now);
  const commitments = store.commitments(channelId, week).filter((c) => c.status !== 'dropped');
  const leads = pipelineLeads(store, now);
  const humans = store.members().filter((m) => m.kind === 'human');
  const people = humans
    .map((m) => ({
      member: m,
      done: commitments.filter((c) => c.ownerId === m.id && c.status === 'done'),
      open: commitments.filter((c) => c.ownerId === m.id && c.status === 'open'),
    }))
    .filter((p) => p.done.length || p.open.length || leads.some((l) => l.open && l.ownerId === p.member.id));
  return {
    week,
    weekLabel: `${dayFmt.format(weekStart(now))} – ${dayFmt.format(addDays(weekStart(now), 6))}`,
    people,
    stale: leads.filter((l) => l.stale).sort((a, b) => a.movedAt - b.movedAt),
    leads,
    now,
  };
}

export function buildCheckinPrompt({ channel, facts }) {
  const leadName = (id) => facts.leads.find((l) => l.id === id)?.company ?? id;
  const item = (c) => `"${c.text}"${c.leadId ? ` (lead ${c.leadId} ${leadName(c.leadId)})` : ''}`;
  const doneCount = facts.people.reduce((n, p) => n + p.done.length, 0);
  const openCount = facts.people.reduce((n, p) => n + p.open.length, 0);
  const lines = [
    `It is time for the daily check-in in #${channel.name}. Week: ${facts.weekLabel}. Commitments this week: ${doneCount} done, ${openCount} open.`,
    '',
    'Each person this week:',
  ];
  for (const p of facts.people) {
    const who = `${p.member.name} (@${p.member.id})`;
    lines.push(`- ${who}: done ${p.done.length ? p.done.map(item).join('; ') : 'nothing yet'}. Open: ${p.open.length ? p.open.map(item).join('; ') : 'none'}.`);
  }
  lines.push('', 'Open leads that have not moved for a day or more (no CRM update and no finished commitment):');
  if (facts.stale.length === 0) lines.push('- None. Every open lead moved in the last day.');
  for (const l of facts.stale) {
    lines.push(`- ${l.id} ${l.company}, stage ${l.stage}, owner @${l.ownerId}, not moved for ${idleLabel(facts.now - l.movedAt)}. Goal: ${l.goal} Notes: ${l.notes}`);
  }
  lines.push(
    '',
    'Write the check-in to post in the channel:',
    '- One opening line on how the week is going.',
    '- One short line per person: what they finished, what is still open.',
    '- Then nudge the owner of every lead listed above: write their handle exactly as given (for example @ayse), name the lead, and suggest one concrete next step from its notes.',
    '- Under 150 words. Plain text; "-" bullets are fine. Warm, never blaming.',
  );
  return lines.join('\n');
}

const mentions = (text, id) => new RegExp(`(?<![\\w.@-])@${id}(?![\\w-])`, 'i').test(text);

// The model writes the check-in, but nobody with a stalled lead may be left out:
// any owner it did not @mention gets a plain nudge line added.
export function ensureNudges(text, stale, now) {
  const missing = [...new Set(stale.map((l) => l.ownerId))].filter((id) => id && !mentions(text, id));
  if (missing.length === 0) return text;
  const lines = missing.map((id) => {
    const leads = stale.filter((l) => l.ownerId === id);
    return `- @${id}: ${leads.map((l) => `${l.company} (${l.id}) has not moved for ${idleLabel(now - l.movedAt)}`).join('; ')}. What is the next step?`;
  });
  return `${text}\n\nNudges:\n${lines.join('\n')}`;
}
