# CLAUDE.md — OpenClaw Dashboard

> This file is read automatically by Claude Code. It provides the context needed to write high-quality, secure, consistent code in this project.

## Project Overview

Local monitoring dashboard for OpenClaw — displays system health (CPU, memory, disk), API token usage with cost estimation, cron job status, and a kanban task board. Runs on `localhost:3333`. Single-user, no auth required (local only).

## Architecture

```
server.js (Express API + static file server)
├── /api/system    → reads /proc/stat, os module → system metrics
├── /api/usage     → reads openclaw.json config → token usage (currently seeded, not real)
├── /api/cron      → reads OpenClaw cron jobs.json + system crontab → job list
├── /api/tasks     → CRUD against data/tasks.json → kanban board
└── static files   → public/ (SPA, no framework)

public/
├── index.html     → Shell with empty panels, loaded by JS
├── app.js         → All client logic: fetch, render, drag-and-drop
└── style.css      → Dark theme, responsive grid, all styling
```

**Data flows one direction:** server reads system/config files → serves JSON → client renders.
The only write path is the kanban board (tasks CRUD → `data/tasks.json`).

## Tech Stack

- **Runtime:** Node.js (no build step, no transpilation)
- **Server:** Express 4.x
- **Validation:** TypeBox (`@sinclair/typebox`) — runtime type checking + casting
- **Frontend:** Vanilla JS, no framework, no bundler
- **Storage:** JSON file (`data/tasks.json`) — no database
- **Styling:** CSS custom properties, dark theme, responsive grid

## Coding Standards

### Style
- Use consistent naming: `camelCase` for variables/functions, `PascalCase` for schemas/types
- Prefer `const` over `let`; never use `var`
- Use descriptive names — code is read more than written
- Keep functions under 40 lines; extract helpers when they grow
- Section separators in server.js: `// === Section Name ===` or `// --- Section Name ---`

### TypeBox Schemas
- **Every API response** has a corresponding TypeBox schema at the top of `server.js`
- **Every POST/PUT body** has a schema + uses the `validate()` middleware
- **All responses** pass through `Value.Cast(Schema, data)` before `res.json()`
- When adding a new endpoint: define the schema first, then write the route

### Error Handling
- API errors return `{ error: string, details?: any }` with appropriate HTTP status
- File read failures (config, tasks) silently fall back to defaults — the dashboard is a viewer, not critical infra
- Validation errors return 400 with path-level detail

### Security
- **Local only** — no auth, no HTTPS, no public exposure
- No user-provided data is rendered unescaped (innerHTML is built from server-validated data)
- execSync is used for `df` and `crontab -l` — these are hardcoded commands, never interpolating user input
- tasks.json is the only writable file — input is validated via TypeBox before write

### Comments
- Comment the *why*, not the *what*
- Every file should have a 1-2 line header comment explaining its purpose
- Use section separators for logical blocks

## File Structure

Every folder contains a `README.md` explaining its purpose, key files, and data flow.

**Rule: When you modify code in a folder, update its README.md if the change affects structure, purpose, or data flow.**

## Testing

No test framework currently. To verify:
1. `npm start` → check `http://localhost:3333`
2. `curl localhost:3333/api/system` → should return system metrics
3. `curl localhost:3333/api/tasks` → should return kanban board state
4. POST/PUT with invalid body → should return 400 with validation errors

## Common Patterns

- **Adding a new dashboard panel:**
  1. Define TypeBox schema in `server.js`
  2. Add `GET /api/<name>` route, cast response through schema
  3. Add a `<div class="card">` in `index.html`
  4. Add `loadNewPanel()` function in `app.js`, call from `init()`
  5. Style in `style.css` following existing patterns

- **Adding a new kanban feature:**
  1. Update `TaskSchema` or add new schema
  2. Add/modify route in server.js with `validate()` middleware
  3. Update `renderKanban()` in app.js

## Things to Avoid

- **No build steps** — this is intentionally a zero-config project. No webpack, no TypeScript, no JSX.
- **No external CDN dependencies** — everything is local
- **No database** — tasks.json is the store. Don't add SQLite/Postgres unless explicitly asked.
- **Don't expose to network** — it binds to all interfaces but is designed for local use only
- **Don't interpolate user input into shell commands** — the execSync calls must stay hardcoded
- **Don't remove TypeBox validation** — it's the primary safety net for data integrity
