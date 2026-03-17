# data/ — Persistent Storage

## Purpose

Flat-file JSON storage for the dashboard. Currently only holds kanban board state.

## Key Files

- **`tasks.json`** — Kanban board data. Three arrays: `todo`, `inprogress`, `done`. Each task has `id`, `title`, and `created` (date string). Written by the server on every task create/move/delete.

## Data Flow

```
Client action → Express route → readTasks() → modify → writeTasks() → tasks.json
```

- `readTasks()` parses JSON and casts through TypeBox `TaskBoardSchema`
- `writeTasks()` serializes with `JSON.stringify(data, null, 2)` (pretty-printed)
- If the file is missing or corrupt, `readTasks()` returns empty board (graceful fallback)

## Conventions

- **No migrations** — schema is simple enough that changes are manual
- **Pretty-printed JSON** — for human readability and clean git diffs
- **IDs** — generated as `Date.now().toString(36) + random` (collision-safe for single-user)

## Notes

- This file is the only writable state in the entire dashboard
- Safe to edit manually — just keep the `{ todo: [], inprogress: [], done: [] }` structure
- No backup/rotation — it's a task board, not critical data
