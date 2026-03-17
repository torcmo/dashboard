# public/ — Frontend

## Purpose

Single-page dashboard UI. No framework, no build step — just HTML, CSS, and vanilla JS served as static files by Express.

## Key Files

- **`index.html`** — Page shell with empty card containers. All content is injected by JS. Four panels: System Health, API Usage, Cron Jobs, Kanban Board.
- **`app.js`** — All client-side logic. Fetches from `/api/*`, renders HTML via `innerHTML`, handles drag-and-drop for kanban, model switching for usage panel.
- **`style.css`** — Complete styling. Dark theme using CSS custom properties (`:root` vars). Responsive grid layout. No external fonts or icons.

## Data Flow

```
Page load → init()
  ├── loadSystem()  → GET /api/system  → render stat-grid with progress bars
  ├── loadUsage()   → GET /api/usage   → render bar chart + model selector
  ├── loadCron()    → GET /api/cron    → render job table
  └── loadTasks()   → GET /api/tasks   → render kanban columns with drag-and-drop

User interactions:
  ├── Model dropdown change → loadUsage(model)
  ├── Drag card between columns → PUT /api/tasks/:id/move → loadTasks()
  ├── Add task → POST /api/tasks → loadTasks()
  └── Delete task → DELETE /api/tasks/:id → loadTasks()
```

## Conventions

- **No DOM framework** — use `innerHTML` for rendering, `$()` / `$$()` helpers for selection
- **Fetch pattern:** `await fetch(url).then(r => r.json())` — no error UI currently
- **Naming:** `load*()` = fetch + render, `setup*()` = event binding, `render*()` = DOM only
- **Auto-refresh:** System stats every 5s, usage every 60s (set in `init()`)

## Notes

- The bar chart in the usage panel is pure CSS (no chart library)
- Drag-and-drop uses native HTML5 DnD API — no library
- All colors come from CSS custom properties — to theme, just change `:root` vars
- Responsive: on mobile (<900px), grid collapses to single column
