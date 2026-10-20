# Team Room: project rules

Team Room is our team's own multiplayer workspace: humans and AI agents in the same channels. We build it one prompt at a time. Build only what the current prompt asks; list anything else as a next step.

## Ground rules
- Only write inside this folder. Don't touch global settings (~/.claude, ~/.codex, global npm or pip).
- Go to the web only if I ask.
- Aim for about 20 minutes per step. Keep the scope tight.
- When you finish a step, leave no servers or background processes running (stop them by port: `lsof -tiTCP:5500 -sTCP:LISTEN | xargs kill`).
- Commit at the end of every step (`git add -A && git commit -m "step N: ..."`).
- End your last message with a short "How I verified it" section.
- Only stop processes you started yourself, by the port or PID you got when you started them. Never kill other programs on this computer (no `pkill`, `killall`).
- Use relative paths in shell commands.

## Stack
- Plain Node (22.18 or newer), no framework. Vanilla HTML/CSS/JS in the browser. Prefer zero npm dependencies: `node:http`, `node:sqlite`, `node:test` and server-sent events are enough.
- One command starts everything: `npm start`. App port 5500 (read it from PORT, default 5500); use 5501-5509 for anything else.
- Data lives in `./data` (gitignored). `npm run seed` resets it to the demo data.
- Tests: `npm test` (node --test). Keep them fast.
- No real login. A "who are you?" picker is enough, and `?as=<member-id>` in the URL must work so we can demo two people in two browser windows.
- It must look clean and readable at 1600x900 and at 800x900 (two windows side by side). Calm, light interface; no purple gradients.
- For UI checks use headless Chrome from the shell (on macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new ...`). Don't use my own Chrome window or the Chrome extension.

## People and data
- <YOUR NAME> is the owner and the only real person. Every other human teammate is fictional demo data, and the UI labels them "demo".
- No real client names. Leads and companies are fictional and labeled demo.
- Our business: <ONE OR TWO LINES ABOUT YOUR COMPANY. Example: an AI growth agency; packages start at $799/month with GEO, AEO and SEO together; never quote lower.>

## Agents run on our own subscription
- An agent is a local worker that runs the Claude Code CLI on this computer (`claude -p`). Never use an API key.
- When spawning claude: remove ANTHROPIC_API_KEY, CLAUDECODE and every CLAUDE_CODE_*, CLAUDE_PID and CLAUDE_EFFORT variable from the environment; set CLAUDE_CODE_DISABLE_AUTO_MEMORY=1; pass `--setting-sources project --strict-mcp-config --no-session-persistence` and `--settings '{"claudeMdExcludes":["<home>/.claude/CLAUDE.md"]}'` (compute `<home>` with `os.homedir()`).
- `claude -p --output-format json` prints a JSON array of events. The last item (type "result") has `result`, `total_cost_usd`, `usage`, `duration_ms` and `modelUsage`. `total_cost_usd` is the API list-price equivalent; we actually pay through the subscription.
- Never store or show rate-limit events, plan, account or e-mail details.
- Tests use a fake runner (`AGENT_RUNNER=fake`). At most two real smoke calls per step, with the cheapest model (haiku) and a short prompt.
