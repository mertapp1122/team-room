import { setTimeout as sleep } from 'node:timers/promises';
import { AgentError, runClaude } from './claude.js';
import { callTool } from '../connectors/index.js';

// A runner turns one claimed job into a reply: { text, model, durationMs, costUsd, skillsUsed, ... }.
// AGENT_RUNNER=fake answers without calling Claude (tests and UI demos). It still
// goes through the real connector tools, so the CRM path is exercised end to end.
export function createRunner(kind = process.env.AGENT_RUNNER || 'claude') {
  if (kind === 'claude') return { kind, run: runClaude };
  if (kind === 'fake') {
    const delayMs = Number(process.env.FAKE_RUNNER_DELAY_MS ?? 1500);
    // The fake runner calls no model, so it reports $0 unless told otherwise (UI demos).
    const costUsd = Number(process.env.FAKE_RUNNER_COST_USD ?? 0);
    return {
      kind,
      async run({ agent, question, signal, skills = [], connections = [], toolAccess }) {
        const started = Date.now();
        const wait = async (ms) => {
          try {
            await sleep(ms, null, { signal });
          } catch {
            throw new AgentError('The worker stopped before the agent finished');
          }
        };
        await wait(delayMs / 2);
        if (/\bfail\b/i.test(question)) throw new AgentError('Fake runner was asked to fail');

        const skillsUsed = skills
          .filter((s) => (s.id === 'agency-offer' && /offer|proposal|quote/i.test(question)) || (s.id === 'ai-visibility-check' && /visib/i.test(question)))
          .map((s) => s.id);
        let found = '';
        if (toolAccess && connections.some((c) => c.id === 'demo-crm')) {
          const call = (tool, input) => callTool({ ...toolAccess, connection: 'demo-crm', tool, input });
          const { leads } = await call('search_leads', {});
          const lead = leads.find((l) => question.toLowerCase().includes(l.company.split(' ')[0].toLowerCase()));
          if (lead) {
            const full = await call('get_lead', { id: lead.id });
            found = ` CRM: ${full.company}, budget $${full.budgetPerMonth}/month.`;
          }
        }
        await wait(delayMs / 2);
        return {
          text: `Fake reply from ${agent.name}.${skillsUsed.length ? ` Skill: ${skillsUsed.join(', ')}.` : ''}${found} You asked: "${question}"`,
          model: `fake-${agent.model}`,
          durationMs: Date.now() - started,
          costUsd,
          inputTokens: 0,
          outputTokens: 0,
          skillsUsed,
        };
      },
    };
  }
  throw new Error(`Unknown AGENT_RUNNER "${kind}" (use "claude" or "fake")`);
}
