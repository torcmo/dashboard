# Dashboard Rebrand Task: Tor.ai

## Overview
Rebrand the entire dashboard from generic "OpenClaw Dashboard" to a proper **Tor.ai branded experience**. The dashboard serves as torbot's command center for the Tor.ai senior team.

## Brand Guide (extracted from official Tor.ai brand guidelines)

### Colors (Digital Palette — RGB)
- **Primary Red-Orange:** `#F6490D` (accent, CTAs, active states, brand highlights)
- **Charcoal Black (bg):** `#111111` (main background)
- **Surface Dark:** `#1A1A1A` (cards, sidebar, elevated surfaces)
- **Border:** `#2A2A2A` (subtle borders, softer than current `#30363d`)
- **Text Primary:** `#E8E4E0` (warm off-white, not cold blue-gray)
- **Text Dim:** `#8A8580` (muted text, warm-toned)
- **Green (success):** `#3fb950` (keep functional)
- **Red (error):** `#f85149` (keep functional)
- **Orange (warning):** `#d29922` (keep functional)

### Typography
- **Font:** Lato (Google Font) — `@import url('https://fonts.googleapis.com/css2?family=Lato:wght@400;600;700;900&display=swap')`
- **Headlines/Page Titles:** Lato Black (900), letter-spacing: -0.025em
- **Section Headers/Card Titles:** Lato Bold (700)
- **Body/Labels:** Lato Regular (400)
- **Small Text:** Lato SemiBold (600) at smaller sizes

### Logo
- File: `public/tor-logo.png` (already placed — the two-color version with red square-dot and red circle-dot)
- Use in sidebar header, replacing the smiley SVG

### Brand Motifs
- **Square dot (■)** and **circle dot (●)** in red-orange are signature Tor.ai elements
- Use square bullets for lists, circular indicators for status — in brand red where appropriate
- Active nav states should use red-orange left border accent

## Changes Required

### 1. HTML (index.html)
- Change `<title>` to "torbot Dashboard — Tor.ai"
- Replace sidebar brand section: remove smiley SVG, add `<img src="tor-logo.png" height="28">` and change text to "torbot"
- Add Google Fonts link in `<head>`: Lato with weights 400,600,700,900

### 2. CSS (style.css) — Full Color & Typography Overhaul

**Root Variables — Replace entirely:**
```css
:root {
  --bg: #111111;
  --surface: #1A1A1A;
  --border: #2A2A2A;
  --border-hi: #F6490D;
  --text: #E8E4E0;
  --text-dim: #8A8580;
  --accent: #F6490D;
  --green: #3fb950;
  --red: #f85149;
  --orange: #d29922;
  --purple: #bc8cff;
  --radius: 10px;
  --shadow: 0 2px 8px rgba(0,0,0,.5);
  --sidebar-w: 240px;
}
```

**Typography:**
- Change body font-family to `'Lato', sans-serif`
- Card headers h2: font-weight 700, letter-spacing -0.015em
- Page titles (header h1): font-weight 900, letter-spacing -0.025em
- All text should feel slightly warmer than the current cold blue-gray

**Sidebar:**
- Background: `#141414` (slightly different from surface for depth)
- Active nav link: red-orange left border (3px solid var(--accent)), subtle red-tinted background `rgba(246, 73, 13, 0.08)`
- Nav link hover: warm tint, not cold white
- Add a subtle section divider between "Overview/Usage/Cron" and "Tasks/Marketing/Pipeline/Team" nav groups
- Sidebar brand padding increase to 24px, logo image height 28px

**Cards:**
- Add a subtle top-border accent: `border-top: 2px solid rgba(246, 73, 13, 0.3)` on card hover
- Card header badges: use red-orange tint instead of blue
- Softer shadows with warm tones

**Charts/Data Viz:**
- Bar chart `.chart-bar.in`: use `var(--accent)` (red-orange)
- Keep `.chart-bar.out` as purple for contrast

**Interactive Elements:**
- All blue accent references → red-orange
- Buttons, links, focus rings, selected states
- Toggle switches: green stays for enabled, but border accents go red-orange

**Mobile Bottom Nav:**
- Active state: red-orange color

### 3. JS (app.js) — Minor
- No functional changes needed, but if there are any hardcoded blue colors in JS (inline styles), change them to the new accent

### 4. Overall Feel
- Should feel like a **premium IoT command center**, not a GitHub-clone admin panel
- Warm charcoal tones, not cold blue-gray
- The red-orange accent should feel surgical — used for key interactive moments, not splashed everywhere
- Typography should feel intentional and tight (Lato Black headlines)

## DO NOT
- Break any existing functionality (API calls, kanban drag-drop, cron management, etc.)
- Remove any existing pages or features
- Change the server.js file
- Add any npm dependencies

## Files to modify
1. `public/index.html` — branding, fonts, title
2. `public/style.css` — full color/typography overhaul  
3. `public/app.js` — only if hardcoded colors exist

## Test
After changes, verify the dashboard loads at http://localhost:3333 and all 7 pages render correctly.
