// The agent worker: a process on the owner's computer that keeps a live connection to
// Team Room, claims jobs for its agents and runs them with `claude -p`.
// While this connection is open, its agents show as online in the room.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentError } from './agents/claude.js';
import { createRunner } from './agents/runner.js';
import { readEvents } from './sse.js';

const RECONNECT_MS = 2000;

export function startWorker({ url, runner, workDir, agents = null, concurrency = 2, model = null, log = () => {} }) {
  let stopped = false;
  let workerId = null;
  let stream = null;
  const queue = [];
  const active = new Map(); // jobId -> AbortController

  async function post(path, body) {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId, ...body }),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  async function handle(jobId, abort) {
    const claim = await post(`/api/worker/jobs/${jobId}/claim`, { runner: runner.kind, ...(model && { model }) });
    if (!claim.ok) return; // another worker took it, or it is no longer queued
    const { job, systemPrompt, prompt, question, skills, connections } = claim.data;
    const agent = { ...claim.data.agent, model: model ?? claim.data.agent.model };
    log(`job ${jobId}: ${agent.name} is working (${runner.kind}, ${agent.model}, ${skills.length} skills, connections: ${connections.map((c) => c.name).join(', ') || 'none'})`);
    try {
      const { loaded, ...reply } = await runner.run({
        agent, systemPrompt, prompt, question, skills, connections,
        cwd: join(workDir, agent.id),
        toolAccess: { url, workerId, jobId: job.id },
        signal: abort.signal,
      });
      if (loaded) {
        const team = loaded.skills.filter((id) => skills.some((sk) => sk.id === id));
        const others = loaded.skills.length - team.length;
        log(`job ${jobId}: claude saw tools [${loaded.tools.join(', ')}], team skills [${team.join(', ')}]${others ? ` (+${others} built-in, not approved)` : ''}, MCP [${loaded.mcpServers.join(', ')}]`);
      }
      await post(`/api/worker/jobs/${jobId}/complete`, reply);
      log(`job ${jobId}: ${agent.name} replied in ${(reply.durationMs / 1000).toFixed(1)} s`);
    } catch (err) {
      const error = err instanceof AgentError ? err.message : 'The agent run failed';
      if (!abort.signal.aborted) await post(`/api/worker/jobs/${jobId}/fail`, { error, usage: err.usage ?? null });
      log(`job ${jobId}: ${agent.name} failed: ${error}`);
    }
  }

  function pump() {
    while (!stopped && active.size < concurrency && queue.length) {
      const jobId = queue.shift();
      const abort = new AbortController();
      active.set(jobId, abort);
      handle(jobId, abort)
        .catch((err) => log(`job ${jobId}: ${err.message}`))
        .finally(() => {
          active.delete(jobId);
          pump();
        });
    }
  }

  async function connect() {
    const query = agents ? `?agents=${agents.map(encodeURIComponent).join(',')}` : '';
    while (!stopped) {
      stream = new AbortController();
      try {
        const res = await fetch(`${url}/api/worker/stream${query}`, { signal: stream.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for await (const { event, data } of readEvents(res.body)) {
          if (event === 'hello') {
            workerId = data.workerId;
            log(`connected to ${url} for: ${data.agents.join(', ')} (runner: ${runner.kind})`);
          } else if (event === 'job' && !queue.includes(data.id) && !active.has(data.id)) {
            queue.push(data.id);
            pump();
          }
        }
      } catch {
        // server not up yet, or it went away: retry below
      }
      // The server requeues our running jobs when we disconnect, so stop them here.
      if (workerId) log('disconnected; reconnecting…');
      workerId = null;
      queue.length = 0;
      for (const abort of active.values()) abort.abort();
      if (!stopped) await sleep(RECONNECT_MS);
    }
  }

  const done = connect();
  return {
    async stop() {
      stopped = true;
      stream?.abort();
      for (const abort of active.values()) abort.abort();
      await done;
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 5500;
  const runner = createRunner();
  const worker = startWorker({
    url: process.env.TEAMROOM_URL || `http://127.0.0.1:${port}`,
    runner,
    workDir: fileURLToPath(new URL('../data/agents/', import.meta.url)),
    agents: process.env.AGENTS ? process.env.AGENTS.split(',') : null,
    concurrency: Number(process.env.WORKER_CONCURRENCY) || 2,
    // e.g. AGENT_MODEL=haiku: run every agent on one model (cheap demos and smoke tests).
    model: process.env.AGENT_MODEL || null,
    log: (line) => console.log(`[worker] ${line}`),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => worker.stop().then(() => process.exit(0)));
  }
}
