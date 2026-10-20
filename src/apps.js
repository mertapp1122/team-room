// Apps live inside a channel; the channel's features say which ones it has.
// Each app has a preview (its card on the channel's Apps tab) and a full view in the browser.
import { STAGES } from './connectors/demo-crm.js';
import { pipelineLeads } from './pipeline.js';
import { weekKey } from './time.js';

const sum = (list) => list.reduce((n, l) => n + (l.budgetPerMonth ?? 0), 0);

export const APPS = [
  {
    id: 'pipeline',
    name: 'Pipeline',
    description: 'Every demo lead by stage. Drag a card to move it; the channel gets a line so the agents know.',
    preview: (store, channelId, now) => {
      const leads = pipelineLeads(store, now);
      const open = leads.filter((l) => l.open);
      return {
        stages: STAGES.map((id) => {
          const here = leads.filter((l) => l.stage === id);
          return { id, count: here.length, valuePerMonth: sum(here), stale: here.filter((l) => l.stale).length };
        }),
        open: open.length,
        openValuePerMonth: sum(open),
        stale: open.filter((l) => l.stale).length,
      };
    },
  },
  {
    id: 'commitments',
    name: 'Weekly commitments',
    description: 'What everyone promised to get done this week, and the daily check-in that follows up.',
    preview: (store, channelId, now) => {
      const week = weekKey(now);
      const live = store.commitments(channelId, week).filter((c) => c.status !== 'dropped');
      const checkin = store.automations().find((a) => a.channelId === channelId);
      return {
        week,
        done: live.filter((c) => c.status === 'done').length,
        total: live.length,
        people: [...new Set(live.map((c) => c.ownerId))],
        checkin: checkin ? { time: checkin.time, enabled: checkin.enabled, weekdaysOnly: checkin.weekdaysOnly } : null,
      };
    },
  },
];

export const channelApps = (channel) => APPS.filter((a) => channel.features.includes(a.id));
