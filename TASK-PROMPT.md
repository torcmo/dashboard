# Dashboard Improvements — 3 Tasks

Read CLAUDE.md first for project conventions. The dashboard is at /home/torbot/.openclaw/workspace/dashboard/

## Task 1: Fix CPU Usage to Show Real-Time Delta

The current `/api/system` endpoint reads `/proc/stat` cumulative values since boot — this gives a misleading average, not current usage.

**Fix:** Implement a two-sample delta approach:
1. Read `/proc/stat` on server start and store the values
2. On each `/api/system` request, read `/proc/stat` again, compute the delta between current and previous sample, calculate percentage from the delta
3. Store the new sample for next request
4. This gives actual real-time CPU usage (like `top` does)

The memory and disk readings are already correct (they use `os.freemem()` and `df`). Only CPU needs fixing.

**File:** `server.js` — the `app.get('/api/system', ...)` handler around line 385.

## Task 2: Add Line Graph for API Token Usage Over Time

Currently the usage section shows a bar chart. Add a **line graph** showing token usage (input + output) over time.

**Requirements:**
- Use an HTML5 `<canvas>` element — NO external charting libraries (project rule: no external deps)
- Draw a line graph with vanilla JS Canvas API
- X axis: dates from the `daily` array returned by `/api/usage`
- Y axis: total tokens (tokensIn + tokensOut) per day
- Two lines: one for input tokens (cyan/blue), one for output tokens (purple/magenta)
- Match the existing dark theme (background #181a20, text #e0e0e0)
- Include axis labels, gridlines, and a legend
- Responsive — canvas should resize with the container
- Add this as a new section in the Usage page, below the existing bar chart (or replace it if it looks better)

**Files:** `public/app.js` (add render function), `public/style.css` (canvas styling), `public/index.html` (if needed for the canvas container in the usage section)

## Task 3: Start the Dashboard Server

After completing tasks 1 and 2:
1. Kill any existing process on port 3333: `lsof -ti :3333 | xargs kill -9 2>/dev/null`
2. Start the server: `cd /home/torbot/.openclaw/workspace/dashboard && node server.js &`
3. Verify it's running: `curl -s localhost:3333/api/system | head -c 200`

## General Rules
- Follow CLAUDE.md conventions (TypeBox schemas, section separators, etc.)
- No external dependencies — vanilla JS only
- Dark theme consistent with existing styles
- Test each change works before moving on
