# OpenClaw Dashboard

Local monitoring dashboard for OpenClaw. Displays system health, API usage, cron jobs, and a kanban task board.

## Quick Start

```bash
npm install
npm start
# → http://localhost:3333
```

## Structure

```
dashboard/
├── CLAUDE.md          # AI coding context (read this for coding standards)
├── server.js          # Express API server (all backend logic)
├── package.json       # Dependencies: express, @sinclair/typebox
├── public/            # Frontend SPA (vanilla JS, no build step)
│   ├── index.html     # Page shell
│   ├── app.js         # Client logic (fetch, render, drag-and-drop)
│   └── style.css      # Dark theme, responsive layout
└── data/
    └── tasks.json     # Kanban board persistence (JSON file)
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/system` | CPU, memory, disk, uptime |
| GET | `/api/usage?model=...` | Token usage & cost by model |
| GET | `/api/cron` | OpenClaw + system cron jobs |
| GET | `/api/tasks` | Kanban board state |
| POST | `/api/tasks` | Create task `{ title, column? }` |
| PUT | `/api/tasks/:id/move` | Move task `{ to, index? }` |
| DELETE | `/api/tasks/:id` | Delete task |

All request bodies are validated via TypeBox. Invalid input returns `400 { error, details }`.

## Key Design Decisions

- **No framework** — vanilla JS keeps it fast and dependency-light
- **TypeBox validation** — runtime type safety without TypeScript build step
- **JSON file storage** — simple, human-readable, git-friendly
- **Dark theme** — matches terminal/IDE aesthetic
- **Auto-refresh** — system stats every 5s, usage every 60s
