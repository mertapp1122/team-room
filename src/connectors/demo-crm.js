// The demo CRM: fictional leads that agents can search and read, never change.
// People move leads between stages on the #sales pipeline board.

export class ToolError extends Error {}

export const STAGES = ['new', 'qualified', 'proposal', 'won', 'lost'];
export const STAGE_LABELS = { new: 'New', qualified: 'Qualified', proposal: 'Proposal', won: 'Won', lost: 'Lost' };
const MAX_RESULTS = 10;

// Every company and contact here is made up. updatedHoursAgo becomes updatedAt
// when the demo data is loaded, so some leads are always a few days stale.
export const DEMO_LEADS = [
  {
    id: 'L-101', updatedHoursAgo: 50, company: 'Northwind Bakery (demo)', contact: 'Lena Ward', contactRole: 'Owner',
    website: 'northwind-bakery.example', city: 'Izmir', industry: 'Local bakery, 2 locations',
    stage: 'qualified', source: 'Inbound form', owner: 'ayse', budgetPerMonth: 900,
    goal: 'Show up in ChatGPT and Google AI Overviews for "best sourdough near me" and "bakery with vegan options".',
    currentVisibility: 'Mentioned in 1 of 10 tracked AI answers (demo check last month).',
    notes: 'Strong Google reviews (4.8). No FAQ page and the menu is a PDF. Wants results before the holiday season. Lena decides alone.',
  },
  {
    id: 'L-102', updatedHoursAgo: 120, company: 'Bluefin Outdoor (demo)', contact: 'Marco Lind', contactRole: 'Head of e-commerce',
    website: 'bluefin-outdoor.example', city: 'Online (EU)', industry: 'Outdoor gear e-commerce',
    stage: 'won', source: 'Referral', owner: 'selin', budgetPerMonth: 1500,
    goal: 'More product mentions in AI shopping answers for hiking gear.',
    currentVisibility: 'Mentioned in 4 of 20 tracked AI answers.',
    notes: 'Client since last quarter. Content calendar lives in #delivery.',
  },
  {
    id: 'L-103', updatedHoursAgo: 30, company: 'Harbor Dental Studio (demo)', contact: 'Dr. Mira Holt', contactRole: 'Clinic owner',
    website: 'harbor-dental.example', city: 'Antalya', industry: 'Dental clinic',
    stage: 'new', source: 'Google Ads form', owner: 'ayse', budgetPerMonth: 600,
    goal: 'Patients who ask AI for "emergency dentist near me" should find the clinic.',
    currentVisibility: 'Not measured yet.',
    notes: 'Budget is below our $799/month minimum. Asked whether there is a cheaper option.',
  },
  {
    id: 'L-104', updatedHoursAgo: 3, company: 'Quartz Analytics (demo)', contact: 'Jonas Berg', contactRole: 'VP Marketing',
    website: 'quartz-analytics.example', city: 'Berlin', industry: 'B2B SaaS (product analytics)',
    stage: 'proposal', source: 'Webinar', owner: 'deniz', budgetPerMonth: 2500,
    goal: 'Be named in AI answers for "best product analytics tool for startups".',
    currentVisibility: 'Mentioned in 2 of 15 tracked AI answers; their two main competitors appear in 9.',
    notes: 'Wants an AEO-heavy plan plus comparison pages. Proposal due Friday.',
  },
  {
    id: 'L-105', updatedHoursAgo: 96, company: 'Maple & Thread (demo)', contact: 'Ada Kim', contactRole: 'Founder',
    website: 'maple-thread.example', city: 'Istanbul', industry: 'Direct-to-consumer apparel',
    stage: 'new', source: 'Website chat', owner: 'burak', budgetPerMonth: 1200,
    goal: 'Get ready for AI shopping agents buying on behalf of customers.',
    currentVisibility: 'Not measured yet.',
    notes: 'Wants product pages that AI shopping assistants can read and cite.',
  },
  {
    id: 'L-106', updatedHoursAgo: 400, company: 'Copperline Coffee (demo)', contact: 'Theo Grant', contactRole: 'Marketing lead',
    website: 'copperline-coffee.example', city: 'Ankara', industry: 'Coffee roaster',
    stage: 'lost', source: 'Outbound', owner: 'ayse', budgetPerMonth: 800,
    goal: 'Local AI visibility for "specialty coffee beans".',
    currentVisibility: 'Mentioned in 0 of 8 tracked AI answers.',
    notes: 'Chose to do it in-house this year. Check back in six months.',
  },
];

const summary = (l) => ({
  id: l.id, company: l.company, stage: l.stage, city: l.city, industry: l.industry, budgetPerMonth: l.budgetPerMonth, owner: l.owner,
});

function searchLeads(store, input) {
  const query = input.query ?? '';
  if (typeof query !== 'string' || query.length > 100) throw new ToolError('query must be a short string');
  if (input.stage !== undefined && !STAGES.includes(input.stage)) throw new ToolError(`stage must be one of: ${STAGES.join(', ')}`);
  const words = query.toLowerCase().replace(/\(demo\)/g, '').split(/[\s,]+/).filter(Boolean);
  const found = store.crmLeads().filter((l) => {
    if (input.stage && l.stage !== input.stage) return false;
    const haystack = [l.id, l.company, l.contact, l.industry, l.city, l.goal, l.notes].join(' ').toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
  return {
    result: { count: found.length, leads: found.slice(0, MAX_RESULTS).map(summary), note: 'Demo CRM: all leads are fictional.' },
    summary: query ? `searched the CRM for "${query}" (${found.length} found)` : `listed CRM leads (${found.length})`,
  };
}

function getLead(store, input) {
  if (typeof input.id !== 'string' || !/^L-\d{3}$/i.test(input.id)) throw new ToolError('id looks like L-101');
  const lead = store.crmLead(input.id.toUpperCase());
  if (!lead) throw new ToolError(`No lead with id ${input.id}`);
  return { result: { ...lead, note: 'Demo CRM: this lead is fictional.' }, summary: `opened ${lead.id} ${lead.company}` };
}

export const DEMO_CRM = {
  id: 'demo-crm',
  name: 'Demo CRM',
  mcpName: 'crm',
  isDemo: true,
  readOnly: true,
  description: 'Fictional leads for practice. Agents can search and read them, never change them; people move leads on the #sales pipeline board.',
  tools: [
    {
      name: 'search_leads',
      description: 'Search the demo CRM by company, contact, industry, city or notes. Returns short summaries with ids. Leave query empty to list every lead.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for, for example "Northwind" or "dental".' },
          stage: { type: 'string', enum: STAGES, description: 'Only leads in this stage.' },
        },
        additionalProperties: false,
      },
      run: searchLeads,
    },
    {
      name: 'get_lead',
      description: 'Read one lead in full by id (for example L-101): goal, budget per month, current AI visibility, notes and owner.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Lead id, for example L-101.' } },
        required: ['id'],
        additionalProperties: false,
      },
      run: getLead,
    },
  ],
  preview: (store) => store.crmLeads(),
};
