// Runs one agent turn through the local Claude Code CLI (`claude -p`), on the
// subscription that is logged in on this computer. Never with an API key.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSkillId } from '../skills.js';

const REPO_CLAUDE_MD = fileURLToPath(new URL('../../CLAUDE.md', import.meta.url));
const MCP_SERVER = fileURLToPath(new URL('../connectors/mcp-server.js', import.meta.url));
const TIMEOUT_MS = 180_000;

// An error whose message is safe to show in the room. Raw CLI output never
// reaches the room: it can carry rate-limit, plan or account details.
// `usage` holds whatever claude reported about the run (cost, tokens), if anything.
export class AgentError extends Error {
  constructor(message, usage = null) {
    super(message);
    this.usage = usage;
  }
}

const num = (v) => (Number.isFinite(v) ? v : null);

function usageOf(result) {
  const models = Object.entries(result.modelUsage ?? {}).sort(([, a], [, b]) => (b?.costUSD ?? 0) - (a?.costUSD ?? 0));
  return {
    model: models[0]?.[0] ?? null,
    durationMs: num(result.duration_ms),
    costUsd: num(result.total_cost_usd),
    inputTokens: num(result.usage?.input_tokens),
    outputTokens: num(result.usage?.output_tokens),
    cacheReadTokens: num(result.usage?.cache_read_input_tokens),
    cacheWriteTokens: num(result.usage?.cache_creation_input_tokens),
  };
}

export function claudeEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT' || key.startsWith('CLAUDE_CODE_')) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

// One MCP server per connection, each started by claude for this job only.
export function mcpServersFor(connections, { url, workerId, jobId }) {
  if (!connections.length) return null;
  return Object.fromEntries(connections.map((c) => [c.mcpName, {
    type: 'stdio',
    command: process.execPath,
    args: [MCP_SERVER],
    env: { TEAMROOM_URL: url, TEAMROOM_WORKER: workerId, TEAMROOM_JOB: String(jobId), TEAMROOM_CONNECTION: c.id },
  }]));
}

export function claudeArgs({ model, systemPrompt, skills = [], connections = [], mcpServers = null, home = homedir() }) {
  // The prompt is written by whoever is in the room, so the agent only gets:
  // the Skill tool, approved for our team skills by name (Claude Code's built-in
  // skills stay unapproved), and the read-only tools of enabled connections.
  // dontAsk refuses anything that is not on that list.
  const allowed = [
    ...skills.filter((s) => isSkillId(s.id)).map((s) => `Skill(${s.id})`),
    ...connections.flatMap((c) => c.tools.map((t) => `mcp__${c.mcpName}__${t.name}`)),
  ];
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    // The agent's folder sits inside this repo, so also skip the repo's own dev rules.
    '--settings', JSON.stringify({ claudeMdExcludes: [join(home, '.claude', 'CLAUDE.md'), REPO_CLAUDE_MD] }),
    '--tools', skills.length ? 'Skill' : '',
    '--permission-mode', 'dontAsk',
  ];
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  if (mcpServers) args.push('--mcp-config', JSON.stringify({ mcpServers }));
  args.push('--system-prompt', systemPrompt);
  return args;
}

// Puts the team skills where Claude Code finds project skills: <cwd>/.claude/skills.
export function prepareWorkspace(cwd, skills = []) {
  const dir = join(cwd, '.claude', 'skills');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const skill of skills) {
    if (!isSkillId(skill.id)) continue;
    mkdirSync(join(dir, skill.id), { recursive: true });
    writeFileSync(join(dir, skill.id, 'SKILL.md'), skill.content);
  }
}

const skillName = (input) => {
  const raw = input?.skill ?? input?.name ?? input?.command;
  return typeof raw === 'string' ? raw.replace(/^\//, '').split(':').pop().trim() : null;
};

// `claude -p --output-format json` prints an array of events; the last one is the result.
// Only the fields below are kept. Everything else (rate-limit events, account info) is dropped.
export function parseClaudeOutput(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new AgentError('Claude returned output the worker could not read');
  }
  const events = Array.isArray(data) ? data : [data];
  const result = events.findLast((e) => e?.type === 'result');
  if (!result) throw new AgentError('Claude finished without a result');
  if (result.is_error || (result.subtype && result.subtype !== 'success')) throw new AgentError('Claude reported an error for this request', usageOf(result));
  const text = typeof result.result === 'string' ? result.result.trim() : '';
  if (!text) throw new AgentError('Claude returned an empty reply', usageOf(result));

  const toolUses = events
    .filter((e) => e?.type === 'assistant')
    .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((c) => c?.type === 'tool_use');
  const skillsUsed = [...new Set(toolUses.filter((t) => t.name === 'Skill').map((t) => skillName(t.input)).filter(Boolean))];

  // What claude says it loaded, by name only. For the worker's log.
  const init = events.find((e) => e?.type === 'system' && e.subtype === 'init');
  const names = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.name)).filter((x) => typeof x === 'string') : []);
  const loaded = init ? {
    tools: names(init.tools),
    skills: names(init.skills),
    mcpServers: Array.isArray(init.mcp_servers) ? init.mcp_servers.map((m) => `${m?.name}:${m?.status}`) : [],
  } : null;

  return {
    text,
    ...usageOf(result),
    skillsUsed,
    loaded,
  };
}

export function runClaude({ agent, systemPrompt, prompt, cwd, signal, skills = [], connections = [], toolAccess, timeoutMs = TIMEOUT_MS, bin = process.env.CLAUDE_BIN || 'claude' }) {
  mkdirSync(cwd, { recursive: true });
  prepareWorkspace(cwd, skills);
  const mcpServers = toolAccess ? mcpServersFor(connections, toolAccess) : null;
  const args = claudeArgs({ model: agent.model, systemPrompt, skills, connections: mcpServers ? connections : [], mcpServers });

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: claudeEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let failure = null;
    const stop = (reason) => {
      failure ??= reason;
      child.kill('SIGTERM');
    };
    const timer = setTimeout(() => stop(new AgentError(`Timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    const onAbort = () => stop(new AgentError('The worker stopped before the agent finished'));
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', (err) => {
      failure ??= new AgentError(err.code === 'ENOENT' ? 'The claude CLI is not installed on this computer' : 'Could not start claude');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure);
      try {
        resolve(parseClaudeOutput(stdout));
      } catch (err) {
        reject(code === 0 ? err : new AgentError(`claude exited with code ${code}`));
      }
    });
    child.stdin.on('error', () => {}); // the child may exit before reading stdin
    child.stdin.end(prompt);
  });
}
