# Dashboard TODO Plans

---

## 1. Upgrade Dashboard

**Goal:** Modernize the UI/UX — better layout, navigation, visual polish, and responsiveness.

### What Changes
- **Navigation sidebar** — replace the flat grid with a sidebar nav + main content area. Pages: Overview (current), Usage, Cron, Tasks. Keeps it organized as features grow.
- **Header bar upgrade** — show OpenClaw version, uptime badge, connection status indicator (green dot → pulsing when live-refreshing)
- **Dark theme polish** — subtle gradients, better card shadows, micro-animations on data load (fade-in instead of flash)
- **Responsive overhaul** — sidebar collapses to bottom nav on mobile, cards stack properly
- **Favicon + page title** — dynamic title showing "OpenClaw Dashboard • hostname"
- **Toast notifications** — lightweight toast system for task actions (created, moved, deleted) instead of silent reloads

### Implementation
- All changes in `public/` (HTML, CSS, JS) — no new dependencies
- Add sidebar HTML structure to `index.html`, CSS transitions in `style.css`
- Add simple client-side router in `app.js` (hash-based: `#overview`, `#usage`, `#cron`, `#tasks`) so panels can be full-page views
- Toast system: ~30 lines of JS + CSS, no library needed

### Files Touched
- `public/index.html` — restructure layout (sidebar + content area)
- `public/style.css` — sidebar styles, animations, responsive breakpoints
- `public/app.js` — hash router, toast system, init logic per page

### Effort: Medium (~200-300 lines changed)

---

## 2. Wire API Usage to Real OpenClaw Logs

**Goal:** Replace the fake seeded token data with actual usage from OpenClaw's session tracking.

### Current State
The `/api/usage` endpoint generates **fake data** using a deterministic seed from the model name. No real token counts are shown.

### How OpenClaw Tracks Usage
- `/status` returns per-session tokens (in/out), cache stats, context size
- `session_status` tool provides the same data programmatically
- OpenClaw stores session logs internally but doesn't expose a bulk usage API
- The `commands.log` file tracks session resets but not token usage
- `/usage cost` in chat shows local cost summary from session logs

### Approach
1. **Read OpenClaw session data** — parse session files from `~/.openclaw/agents/main/` to extract token usage per session
2. **Aggregate by day** — group sessions by date, sum tokens in/out
3. **Calculate real costs** — use the pricing table already in `server.js` (which is accurate)
4. **Cache the aggregation** — recompute every 60s max, not on every request
5. **Fallback** — if no session data is found, show "No usage data available" instead of fake numbers

### Discovery Needed
- Inspect `~/.openclaw/agents/main/` directory structure to find where session token counts are stored
- Check if OpenClaw has an internal API or CLI command (`openclaw status --usage --json`) that outputs structured usage data
- May need to parse session JSON files directly

### Files Touched
- `server.js` — rewrite `/api/usage` route to read real data
- `public/app.js` — minor: handle "no data" state gracefully

### Effort: Medium (depends on OpenClaw's internal data format)

---

## 3. Add Cron Job Management Controls

**Goal:** View, create, edit, enable/disable, and trigger cron jobs from the dashboard — not just list them.

### Current State
The cron panel is **read-only** — it shows OpenClaw jobs from `jobs.json` and system crontab entries in a table. No interaction possible.

### Approach
1. **Cron detail view** — click a job to see full details (payload text, schedule details, creation date, last/next run times)
2. **Create job** — form to create new OpenClaw cron jobs:
   - Name, schedule type (at/every/cron), schedule value
   - Payload type (systemEvent text or agentTurn message)
   - Session target (main/isolated)
   - Enable/disable toggle
3. **Edit/toggle jobs** — inline edit name, enable/disable toggle, delete button
4. **Trigger now** — "Run Now" button to fire a job immediately
5. **Job history** — show recent runs for each job (using cron `runs` action)

### Backend API Design
```
GET    /api/cron              — list all jobs (existing, enhanced)
POST   /api/cron              — create a new job
PUT    /api/cron/:id          — update a job (name, schedule, enabled)
DELETE /api/cron/:id          — remove a job
POST   /api/cron/:id/run      — trigger a job immediately
GET    /api/cron/:id/runs     — get run history
```

### How It Works Internally
- The server will shell out to `openclaw` CLI or directly read/write `~/.openclaw/cron/jobs.json`
- For create/update/delete: write to `jobs.json` and signal OpenClaw to reload (or use the cron tool's API if available from the gateway)
- For "Run Now": use gateway API or write a trigger file

### Discovery Needed
- Check if OpenClaw gateway exposes a REST API for cron management (likely on the gateway port)
- Determine if modifying `jobs.json` directly is safe or if we need to go through the gateway

### Files Touched
- `server.js` — new CRUD routes for cron, TypeBox schemas for job creation/update
- `public/index.html` — cron panel becomes interactive (or full page with sidebar nav)
- `public/app.js` — cron CRUD UI, forms, modals
- `public/style.css` — form styles, modal, toggle switches

### Effort: Large (~400-500 lines)

---

## 4. Setup Claude Code to Do Marketing Work

**Goal:** Create a workflow where Claude Code (via ACP/sessions_spawn) can execute marketing tasks — content writing, social media drafts, blog posts, email campaigns — using Tor.ai's knowledge base.

### What This Means
This isn't a dashboard feature — it's an **agent workflow**. The dashboard can be the trigger/monitor surface.

### Approach
1. **Marketing prompt templates** — create a set of reusable prompts in `workspace/marketing/templates/`:
   - Blog post generator (product-focused, industry-focused)
   - Social media post drafts (LinkedIn, Twitter)
   - Email campaign drafts
   - Case study outlines
   - Product one-pagers
2. **Knowledge-grounded generation** — every marketing task queries the Tor.ai RAG first (`query.py`) to ground content in real product data, customer names, specs
3. **Dashboard integration** — add a "Marketing" panel/page to the dashboard:
   - Select template type
   - Input: product, audience, tone, key points
   - "Generate" button spawns a Claude Code session
   - Output saved to `workspace/marketing/output/YYYY-MM-DD-{slug}.md`
   - History of generated content
4. **Review workflow** — generated content goes to a "Review" column in the kanban, or a dedicated review queue

### Backend API Design
```
GET    /api/marketing/templates    — list available templates
POST   /api/marketing/generate     — trigger generation (spawns agent)
GET    /api/marketing/output       — list generated content
GET    /api/marketing/output/:id   — read a specific output
```

### Files Touched
- `server.js` — marketing API routes
- `public/` — marketing page UI
- `workspace/marketing/templates/` — prompt templates (new directory)
- `workspace/marketing/output/` — generated content (new directory)

### Effort: Large (~500+ lines across files)

---

## 5. Setup Coding Pipeline of Agents

**Goal:** Create a multi-agent coding pipeline — intake a task, break it down, assign to coding agents, review output, iterate.

### Architecture
```
Task Intake → Planner Agent → Coder Agent(s) → Reviewer Agent → Output
```

### Approach
1. **Task intake** — accept coding tasks via:
   - Dashboard form (title + description + repo/path)
   - Telegram command (forward to pipeline)
   - GitHub issue trigger (via gh-issues skill)
2. **Planner agent** — isolated session that:
   - Reads the task
   - Breaks it into sub-tasks
   - Determines which files need changes
   - Creates a plan (saved as markdown)
3. **Coder agent(s)** — one or more Claude Code sessions (via ACP) that:
   - Receive a sub-task + plan
   - Implement the changes
   - Run tests if available
   - Commit with descriptive messages
4. **Reviewer agent** — isolated session that:
   - Reviews the diff
   - Checks for issues (security, style, correctness)
   - Either approves or sends back with feedback
5. **Pipeline state** — tracked in `workspace/pipelines/` as JSON:
   - Task ID, status, sub-tasks, agent sessions, outputs
6. **Dashboard view** — pipeline status page showing active/completed pipelines

### Backend API Design
```
POST   /api/pipeline/create    — create a new pipeline task
GET    /api/pipeline            — list pipelines
GET    /api/pipeline/:id       — pipeline detail + status
POST   /api/pipeline/:id/retry — retry a failed step
```

### Key Decisions Needed
- Single repo or multi-repo support?
- Auto-commit or stage for review?
- Which ACP agent: Claude Code, Codex, or configurable?
- Max concurrent agents?

### Files Touched
- `server.js` — pipeline API routes
- `public/` — pipeline status page
- `workspace/pipelines/` — pipeline state files (new directory)
- Potentially a `workspace/pipeline-runner.js` — orchestration logic

### Effort: Very Large (multi-session, ~800+ lines) — **delegate to Claude Code**

---

## 6. Setup Marketing Team of Agents

**Goal:** Multiple specialized agents working together on marketing — not just one agent generating content, but a team with roles.

### Agent Roles
1. **Strategist** — analyzes market, competitors, decides content calendar and themes
2. **Writer** — generates content (blogs, social, emails) grounded in Tor.ai knowledge base
3. **Editor** — reviews, refines, ensures brand voice consistency (uses brand guidelines from knowledge base)
4. **Analyst** — tracks what was produced, suggests improvements, identifies gaps

### Approach
1. **Agent definitions** — each agent has a persona prompt + specific instructions:
   - Saved in `workspace/marketing/agents/{role}.md`
   - References Tor.ai brand guidelines, tone, audience
2. **Workflow orchestration**:
   - Strategist produces a brief → Writer generates draft → Editor reviews → output
   - All grounded in RAG knowledge base
   - Pipeline tracked in JSON state files
3. **Content calendar** — Strategist maintains a calendar in `workspace/marketing/calendar.json`:
   - Upcoming content pieces, deadlines, themes
   - Dashboard shows calendar view
4. **Dashboard integration**:
   - "Marketing Team" page showing agent activity
   - Content pipeline: brief → draft → review → published
   - Calendar view of planned content
5. **Cron-driven** — scheduled runs (e.g., weekly strategy review, daily content generation)

### Relationship to TODO #4
TODO #4 is the **foundation** — single agent doing marketing work. TODO #6 is the **evolution** — multiple agents in roles. Implement #4 first, then layer #6 on top.

### Backend API Design
```
GET    /api/marketing/team          — team status (agents, last activity)
POST   /api/marketing/brief         — strategist creates a brief
POST   /api/marketing/draft         — writer generates from brief
POST   /api/marketing/review        — editor reviews a draft
GET    /api/marketing/calendar      — content calendar
```

### Files Touched
- `server.js` — team/calendar API routes
- `public/` — team dashboard page, calendar UI
- `workspace/marketing/agents/` — agent persona files
- `workspace/marketing/calendar.json` — content calendar state

### Effort: Very Large (~1000+ lines) — **delegate to Claude Code**, builds on TODO #4

---

## Recommended Order of Implementation

```
1. Upgrade Dashboard          ← foundation for everything else
2. Wire API Usage             ← quick win, real data
3. Add Cron Management        ← interactive controls
4. Marketing (single agent)   ← first agent workflow
5. Coding Pipeline            ← multi-agent orchestration
6. Marketing Team             ← builds on #4, most complex
```

Items 1-3 are **dashboard infrastructure**. Items 4-6 are **agent orchestration** that use the dashboard as a control surface.

Items 5 and 6 will be delegated to Claude Code (>50 line rule) and broken into smaller PRs.
