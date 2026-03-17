// OpenClaw Dashboard — client logic: routing, data loading, rendering, toasts

// --- Helpers ---
function fmt(bytes) {
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(1) + ' TB';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(1) + ' KB';
}
function fmtNum(n) { return n.toLocaleString(); }
function fillColor(pct) {
  if (pct < 60) return 'fill-green';
  if (pct < 85) return 'fill-orange';
  return 'fill-red';
}
function $(sel, ctx = document) { return ctx.querySelector(sel); }
function $$(sel, ctx = document) { return ctx.querySelectorAll(sel); }

// --- Toast Notifications ---
function showToast(message) {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3000);
}

// --- Router ---
const ROUTES = ['overview', 'usage', 'cron', 'tasks', 'campaigns', 'marketing', 'pipeline', 'team'];
let currentRoute = 'overview';
let systemInfo = { hostname: '', platform: '' };

function getRoute() {
  const hash = location.hash.replace('#', '') || 'overview';
  return ROUTES.includes(hash) ? hash : 'overview';
}

function navigate() {
  const route = getRoute();
  if (route === currentRoute && document.querySelector('.page:not(.hidden)')) return;
  currentRoute = route;

  // Toggle page visibility
  ROUTES.forEach(r => {
    const page = $(`#page-${r}`);
    if (page) page.classList.toggle('hidden', r !== 'overview' && r !== route);
  });
  // Overview shows when route is 'overview', hide others
  const overviewPage = $('#page-overview');
  if (route === 'overview') {
    overviewPage.classList.remove('hidden');
    // Hide single-view pages
    ['usage', 'cron', 'tasks', 'campaigns', 'marketing', 'pipeline', 'team'].forEach(r => {
      $(`#page-${r}`).classList.add('hidden');
    });
  } else {
    overviewPage.classList.add('hidden');
    ROUTES.filter(r => r !== 'overview').forEach(r => {
      $(`#page-${r}`).classList.toggle('hidden', r !== route);
    });
  }

  // Re-trigger fade animation on visible page
  const activePage = $(`#page-${route}`);
  if (activePage) {
    activePage.style.animation = 'none';
    activePage.offsetHeight; // force reflow
    activePage.style.animation = '';
  }

  // Update nav links
  $$('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.route === route);
  });
  $$('.bottom-link').forEach(link => {
    link.classList.toggle('active', link.dataset.route === route);
  });

  // Sync content into full-width panels when navigating to single view
  syncPanels(route);
}

// Copy rendered content from overview cards into full-width single panels
function syncPanels(route) {
  if (route === 'overview') return;
  if (route === 'campaigns') { loadCampaigns(); return; }
  if (route === 'marketing') { loadMarketing(); return; }
  if (route === 'pipeline') { loadPipeline(); return; }
  if (route === 'team') { loadTeam(); return; }
  const panelMap = { usage: 'usage-panel', cron: 'cron-panel', tasks: 'kanban-panel' };
  const sourceId = panelMap[route];
  const targetId = sourceId + '-full';
  if (!sourceId) return;
  const source = $(`#${sourceId}`);
  const target = $(`#${targetId}`);
  if (source && target) {
    target.innerHTML = source.innerHTML;
    // Re-bind interactive elements in the cloned panel
    if (route === 'usage') bindModelSelect(target);
    if (route === 'cron') setupCronPanel(target);
    if (route === 'tasks') {
      setupDragDrop(target);
      setupAddTask(target);
      setupDeleteButtons(target);
    }
  }
}

function bindModelSelect(ctx) {
  const sel = $('#model-select', ctx);
  if (sel) sel.addEventListener('change', e => loadUsage(e.target.value));
}

// --- Header Bar ---
async function updateHeader(data) {
  systemInfo.hostname = data.hostname;
  systemInfo.platform = data.platform;
  const info = $('#header-info');
  if (info) info.textContent = `${data.hostname} / ${data.platform}`;
  document.title = `OpenClaw Dashboard \u2014 ${data.hostname}`;
}

// --- System Health ---
async function loadSystem() {
  const data = await fetch('/api/system').then(r => r.json());
  updateHeader(data);

  const html = `
    <div class="stat-grid">
      <div class="stat">
        <div class="label">CPU Usage</div>
        <div class="value">${data.cpu.usage}%</div>
        <div class="sub">${data.cpu.cores} cores — ${data.cpu.model}</div>
        <div class="progress"><div class="fill ${fillColor(data.cpu.usage)}" style="width:${data.cpu.usage}%"></div></div>
      </div>
      <div class="stat">
        <div class="label">Memory</div>
        <div class="value">${data.memory.percent}%</div>
        <div class="sub">${fmt(data.memory.used)} / ${fmt(data.memory.total)}</div>
        <div class="progress"><div class="fill ${fillColor(data.memory.percent)}" style="width:${data.memory.percent}%"></div></div>
      </div>
      <div class="stat">
        <div class="label">Disk (root)</div>
        <div class="value">${data.disk.percent}%</div>
        <div class="sub">${fmt(data.disk.used)} / ${fmt(data.disk.total)}</div>
        <div class="progress"><div class="fill ${fillColor(data.disk.percent)}" style="width:${data.disk.percent}%"></div></div>
      </div>
      <div class="stat">
        <div class="label">Uptime</div>
        <div class="value">${data.uptime.days}d ${data.uptime.hours}h ${data.uptime.mins}m</div>
        <div class="sub">${data.hostname} — ${data.platform}</div>
      </div>
    </div>`;
  $('#system-panel').innerHTML = html;
}

// --- API Usage ---
let currentModel = null;

function renderUsageHTML(data) {
  currentModel = data.activeModel;
  const maxTokens = Math.max(...data.daily.map(d => d.tokensIn + d.tokensOut), 1);
  const isPrimary = data.activeModel === data.primaryModel;

  return `
    <div class="model-selector">
      <select id="model-select">
        ${data.models.map(m => {
          const short = m.split('/').pop();
          const label = m === data.primaryModel ? `${short} (primary)` : short;
          return `<option value="${m}" ${m === data.activeModel ? 'selected' : ''}>${label}</option>`;
        }).join('')}
      </select>
      <span class="provider-badge">${data.provider}</span>
      ${isPrimary ? '<span class="primary-badge">PRIMARY</span>' : ''}
    </div>
    <div class="usage-stats">
      <div class="usage-stat"><div class="label">Tokens In</div><div class="value">${fmtNum(data.totals.tokensIn)}</div></div>
      <div class="usage-stat"><div class="label">Tokens Out</div><div class="value">${fmtNum(data.totals.tokensOut)}</div></div>
      <div class="usage-stat"><div class="label">Requests</div><div class="value">${fmtNum(data.totals.requests)}</div></div>
      <div class="usage-stat"><div class="label">Est. Cost (7d)</div><div class="value">$${data.totals.cost.toFixed(2)}</div></div>
    </div>
    <div class="pricing-info">
      <span>$${data.pricing.input}/M in</span> · <span>$${data.pricing.output}/M out</span>
    </div>
    <div class="chart">
      ${data.daily.map(d => {
        const hIn = Math.max((d.tokensIn / maxTokens) * 100, 3);
        const hOut = Math.max((d.tokensOut / maxTokens) * 100, 3);
        const label = d.date.slice(5);
        return `<div class="chart-bar-group">
          <div class="chart-bar-pair" style="height:100%">
            <div class="chart-bar in" style="height:${hIn}%" title="${fmtNum(d.tokensIn)} in"></div>
            <div class="chart-bar out" style="height:${hOut}%" title="${fmtNum(d.tokensOut)} out"></div>
          </div>
          <div class="chart-label">${label}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="chart-legend">
      <span class="leg-in">Tokens In</span>
      <span class="leg-out">Tokens Out</span>
    </div>
    <div class="line-graph-section">
      <h3 class="line-graph-title">Token Usage Over Time</h3>
      <canvas id="usage-line-graph" class="usage-line-canvas"></canvas>
    </div>`;
}

// --- Line Graph ---
function drawUsageLineGraph(canvas, daily) {
  if (!canvas || !daily.length) return;

  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = 220;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 20, right: 20, bottom: 40, left: 60 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxVal = Math.max(...daily.map(d => Math.max(d.tokensIn, d.tokensOut)), 1);

  // Background
  ctx.fillStyle = '#161616';
  ctx.fillRect(0, 0, width, height);

  // Gridlines
  ctx.strokeStyle = 'rgba(42,42,42,0.6)';
  ctx.lineWidth = 1;
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = pad.top + (plotH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    // Y-axis labels
    const val = maxVal - (maxVal / gridLines) * i;
    ctx.fillStyle = '#8A8580';
    ctx.font = '11px Lato, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtNum(Math.round(val)), pad.left - 8, y + 4);
  }

  // X-axis labels
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8A8580';
  ctx.font = '10px Lato, sans-serif';
  const labelStep = daily.length > 14 ? Math.ceil(daily.length / 7) : 1;
  for (let i = 0; i < daily.length; i++) {
    if (i % labelStep !== 0 && i !== daily.length - 1) continue;
    const x = pad.left + (plotW / Math.max(daily.length - 1, 1)) * i;
    ctx.fillText(daily[i].date.slice(5), x, height - pad.bottom + 18);
  }

  // Draw line helper
  function drawLine(key, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < daily.length; i++) {
      const x = pad.left + (plotW / Math.max(daily.length - 1, 1)) * i;
      const y = pad.top + plotH - (daily[i][key] / maxVal) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw dots
    ctx.fillStyle = color;
    for (let i = 0; i < daily.length; i++) {
      const x = pad.left + (plotW / Math.max(daily.length - 1, 1)) * i;
      const y = pad.top + plotH - (daily[i][key] / maxVal) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawLine('tokensIn', '#F6490D');
  drawLine('tokensOut', '#bc8cff');

  // Legend
  const legY = height - 6;
  ctx.font = '11px Lato, sans-serif';
  ctx.textAlign = 'left';

  ctx.fillStyle = '#F6490D';
  ctx.fillRect(pad.left, legY - 8, 10, 10);
  ctx.fillStyle = '#8A8580';
  ctx.fillText('Tokens In', pad.left + 14, legY);

  ctx.fillStyle = '#bc8cff';
  ctx.fillRect(pad.left + 90, legY - 8, 10, 10);
  ctx.fillStyle = '#8A8580';
  ctx.fillText('Tokens Out', pad.left + 104, legY);
}

async function loadUsage(model) {
  const params = model ? `?model=${encodeURIComponent(model)}` : '';
  const data = await fetch(`/api/usage${params}`).then(r => r.json());
  const html = renderUsageHTML(data);

  // Update both overview and full panel
  $('#usage-panel').innerHTML = html;
  bindModelSelect($('#usage-panel'));
  drawUsageLineGraph($('#usage-line-graph', $('#usage-panel')), data.daily);

  const full = $('#usage-panel-full');
  if (full) {
    full.innerHTML = html;
    bindModelSelect(full);
    drawUsageLineGraph($('#usage-line-graph', full), data.daily);
  }
}

// --- Cron Jobs ---
let cronExpandedId = null;

function formatSchedule(schedule) {
  if (typeof schedule === 'string') return schedule;
  if (!schedule || !schedule.kind) return '—';
  const val = schedule[schedule.kind] || schedule.value || '';
  if (schedule.kind === 'at') return `Once @ ${val}`;
  if (schedule.kind === 'every') return `Every ${val}`;
  if (schedule.kind === 'cron') return val;
  return JSON.stringify(schedule);
}

function renderCronHTML(data) {
  const allJobs = [...data.openclaw.map(j => ({ ...j, source: 'openclaw' })), ...data.system];
  const jobRows = allJobs.length === 0
    ? '<tr><td colspan="6" class="cron-empty">No cron jobs configured.</td></tr>'
    : allJobs.map(j => {
        const isOC = j.source === 'openclaw';
        const enabled = j.enabled !== undefined ? j.enabled : true;
        const statusClass = enabled ? (j.status || 'active') : 'disabled';
        const expanded = cronExpandedId === j.id;
        return `
          <tr class="cron-row ${expanded ? 'expanded' : ''}" data-id="${j.id}">
            <td><span class="status-dot status-${statusClass}"></span>${enabled ? (j.status || 'active') : 'disabled'}</td>
            <td class="cron-name-cell" data-id="${j.id}">
              <span class="cron-chevron">${expanded ? '&#9662;' : '&#9656;'}</span>
              <span title="${j.command || ''}">${j.name}</span>
            </td>
            <td><code>${formatSchedule(j.schedule)}</code></td>
            <td>${j.lastRun ? new Date(j.lastRun).toLocaleString() : '—'}</td>
            <td>${j.source || 'openclaw'}</td>
            <td class="cron-actions">${isOC ? `
              <button class="cron-btn cron-btn-run" data-id="${j.id}" title="Run now">&#9654;</button>
              <label class="cron-toggle" title="${enabled ? 'Disable' : 'Enable'}">
                <input type="checkbox" ${enabled ? 'checked' : ''} data-id="${j.id}" class="cron-toggle-input">
                <span class="cron-toggle-slider"></span>
              </label>
              <button class="cron-btn cron-btn-delete" data-id="${j.id}" title="Delete">&times;</button>
            ` : ''}</td>
          </tr>
          ${expanded ? `<tr class="cron-detail-row"><td colspan="6">
            <div class="cron-detail">
              <div><strong>Schedule:</strong> ${formatSchedule(j.schedule)}</div>
              <div><strong>Payload:</strong> ${j.payload?.text || j.command || '—'} <span class="cron-detail-badge">${j.payload?.kind || ''}</span></div>
              <div><strong>Session:</strong> ${j.sessionTarget || '—'}</div>
              <div><strong>Next Run:</strong> ${j.nextRun ? new Date(j.nextRun).toLocaleString() : '—'}</div>
            </div>
          </td></tr>` : ''}`;
      }).join('');

  return `
    <table class="cron-table">
      <thead><tr><th>Status</th><th>Name</th><th>Schedule</th><th>Last Run</th><th>Source</th><th></th></tr></thead>
      <tbody>${jobRows}</tbody>
    </table>
    <div class="cron-add-section">
      <button class="cron-add-toggle" id="cron-add-toggle">+ Add Job</button>
      <div class="cron-add-form" id="cron-add-form">
        <div class="cron-form-grid">
          <label>Name<input type="text" id="cron-name" placeholder="My job"></label>
          <label>Schedule Type
            <select id="cron-schedule-kind">
              <option value="at">One-time</option>
              <option value="every">Interval</option>
              <option value="cron">Cron expression</option>
            </select>
          </label>
          <label>Schedule Value<input type="text" id="cron-schedule-value" placeholder="e.g. 2026-04-01T09:00, 30m, */5 * * * *"></label>
          <label>Payload Type
            <select id="cron-payload-kind">
              <option value="systemEvent">System Event</option>
              <option value="agentTurn">Agent Turn</option>
            </select>
          </label>
          <label class="cron-form-wide">Payload Text<textarea id="cron-payload-text" rows="2" placeholder="Payload content..."></textarea></label>
          <label>Session Target
            <select id="cron-session-target">
              <option value="main">Main</option>
              <option value="isolated">Isolated</option>
            </select>
          </label>
          <label class="cron-form-check"><input type="checkbox" id="cron-enabled" checked> Enabled</label>
        </div>
        <button class="cron-form-submit" id="cron-form-submit">Add Job</button>
      </div>
    </div>`;
}

function setupCronPanel(ctx) {
  // Expand/collapse detail rows
  $$('.cron-name-cell', ctx).forEach(cell => {
    cell.addEventListener('click', () => {
      const id = cell.dataset.id;
      cronExpandedId = cronExpandedId === id ? null : id;
      loadCron();
    });
  });

  // Run button
  $$('.cron-btn-run', ctx).forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/cron/${btn.dataset.id}/run`, { method: 'POST' });
      showToast('Job triggered');
      await loadCron();
    });
  });

  // Toggle enabled/disabled
  $$('.cron-toggle-input', ctx).forEach(input => {
    input.addEventListener('change', async () => {
      await fetch(`/api/cron/${input.dataset.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: input.checked })
      });
      showToast(input.checked ? 'Job enabled' : 'Job disabled');
      await loadCron();
    });
  });

  // Delete button
  $$('.cron-btn-delete', ctx).forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/cron/${btn.dataset.id}`, { method: 'DELETE' });
      showToast('Job deleted');
      await loadCron();
    });
  });

  // Add job form toggle
  const toggle = $('#cron-add-toggle', ctx);
  const form = $('#cron-add-form', ctx);
  if (toggle && form) {
    toggle.addEventListener('click', () => {
      const open = form.classList.toggle('open');
      toggle.textContent = open ? '− Cancel' : '+ Add Job';
    });
  }

  // Submit new job
  const submitBtn = $('#cron-form-submit', ctx);
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const name = ($('#cron-name', ctx) || {}).value?.trim();
      if (!name) { showToast('Name is required'); return; }
      const body = {
        name,
        scheduleKind: $('#cron-schedule-kind', ctx).value,
        scheduleValue: ($('#cron-schedule-value', ctx) || {}).value?.trim() || '',
        payloadKind: $('#cron-payload-kind', ctx).value,
        payloadText: ($('#cron-payload-text', ctx) || {}).value || '',
        sessionTarget: $('#cron-session-target', ctx).value,
        enabled: $('#cron-enabled', ctx).checked
      };
      const resp = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        const err = await resp.json();
        showToast('Error: ' + (err.error || 'Failed'));
        return;
      }
      showToast(`Job created: ${name}`);
      await loadCron();
    });
  }
}

async function loadCron() {
  const data = await fetch('/api/cron').then(r => r.json());
  const html = renderCronHTML(data);

  const panel = $('#cron-panel');
  panel.innerHTML = html;
  setupCronPanel(panel);

  const full = $('#cron-panel-full');
  if (full) {
    full.innerHTML = html;
    setupCronPanel(full);
  }
}

// --- Kanban Board (8-Stage CI/CD Pipeline) ---
const PIPELINE_COLS = ['backlog', 'building', 'pr_open', 'code_review', 'qa', 'staging', 'merged', 'deployed'];
const COL_LABELS = {
  backlog: 'Backlog', building: 'Building', pr_open: 'PR Open', code_review: 'Code Review',
  qa: 'QA', staging: 'Staging', merged: 'Merged', deployed: 'Deployed'
};
const COL_COLORS = {
  backlog: '#8A8580', building: '#F6490D', pr_open: '#58a6ff', code_review: '#bc8cff',
  qa: '#d29922', staging: '#00bcd4', merged: '#3fb950', deployed: '#3fb950'
};
const PRIORITY_BADGE = { high: '\uD83D\uDD34', medium: '\uD83D\uDFE1', low: '\u26AA' };
let tasksData = {};
PIPELINE_COLS.forEach(c => tasksData[c] = []);

async function loadTasks() {
  tasksData = await fetch('/api/tasks').then(r => r.json());
  renderKanban();
}

function taskAge(created) {
  const days = Math.floor((Date.now() - new Date(created).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return days + 'd ago';
}

function timeInStage(t, col) {
  const ts = col === 'building' ? t.startedAt : col === 'pr_open' ? t.prCreatedAt :
    col === 'merged' ? t.mergedAt : col === 'deployed' ? t.deployedAt : null;
  if (!ts) return '';
  const hrs = Math.floor((Date.now() - new Date(ts).getTime()) / 3600000);
  if (hrs < 1) return '<1h';
  if (hrs < 24) return hrs + 'h';
  return Math.floor(hrs / 24) + 'd';
}

function escAttr(s) { return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderCardHTML(t, col) {
  const p = [];
  p.push('<div class="kanban-card" draggable="true" data-id="' + escAttr(t.id) + '" data-col="' + col + '">');
  p.push('<div class="card-top-row">');
  p.push('<span class="card-drag-handle">\u2847</span>');
  p.push('<span class="card-title">' + escHtml(t.title) + '</span>');
  if (t.priority) p.push('<span class="card-priority" title="' + escAttr(t.priority) + '">' + (PRIORITY_BADGE[t.priority] || '') + '</span>');
  p.push('<button class="delete-btn" data-id="' + escAttr(t.id) + '" title="Delete">&times;</button>');
  p.push('</div>');
  if (t.labels && t.labels.length) {
    p.push('<div class="card-labels">');
    t.labels.forEach(function(l) { p.push('<span class="card-label">' + escHtml(l) + '</span>'); });
    p.push('</div>');
  }
  if (t.branch) p.push('<span class="card-branch">' + escHtml(t.branch) + '</span>');
  if (t.pr && t.pr.number) {
    const prClass = t.pr.status === 'merged' ? 'pr-merged' : t.pr.status === 'changes-requested' ? 'pr-changes' : 'pr-open';
    p.push('<a class="card-pr-badge ' + prClass + '" href="' + escAttr(t.pr.url) + '" target="_blank" rel="noopener">PR #' + t.pr.number + ' \u2197</a>');
  }
  if (t.repo) p.push('<span class="card-repo">' + escHtml(t.repo) + '</span>');
  if (col === 'qa') {
    p.push('<div class="card-qa-panel">');
    if (t.qaChecks && t.qaChecks.length) {
      t.qaChecks.forEach(function(c) {
        const icon = c.status === 'passed' ? '\u2713' : c.status === 'failed' ? '\u2717' : '\u25CB';
        p.push('<div class="qa-check qa-' + c.status + '"><span class="qa-icon">' + icon + '</span> ' + escHtml(c.name) + '</div>');
      });
    }
    p.push('<div class="qa-actions">');
    p.push('<button class="qa-run-btn" data-id="' + escAttr(t.id) + '">Run QA</button>');
    p.push('<button class="qa-approve-btn" data-id="' + escAttr(t.id) + '">Approve \u2192 Staging</button>');
    p.push('<button class="qa-fail-btn" data-id="' + escAttr(t.id) + '">Fail \u2192 Building</button>');
    p.push('</div></div>');
  }
  p.push('<div class="card-footer">');
  const assigneeIcon = t.assignee === 'claude-code' ? '\uD83E\uDD16' : t.assignee === 'human' ? '\uD83D\uDC64' : '';
  if (assigneeIcon) p.push('<span class="card-assignee">' + assigneeIcon + '</span>');
  const stageTime = timeInStage(t, col);
  if (stageTime) p.push('<span class="card-stage-time">' + stageTime + '</span>');
  p.push('<span class="card-date">' + escHtml(taskAge(t.created)) + '</span>');
  p.push('</div>');
  p.push('<div class="card-hover-actions">');
  const colIdx = PIPELINE_COLS.indexOf(col);
  if (colIdx > 0) p.push('<button class="card-action-btn card-reject-btn" data-id="' + escAttr(t.id) + '" data-to="' + PIPELINE_COLS[colIdx - 1] + '" title="Move back">\u2190</button>');
  if (colIdx < PIPELINE_COLS.length - 1) p.push('<button class="card-action-btn card-advance-btn" data-id="' + escAttr(t.id) + '" data-to="' + PIPELINE_COLS[colIdx + 1] + '" title="Advance">\u2192</button>');
  p.push('</div>');
  p.push('</div>');
  return p.join('');
}

function renderPipelineSummary() {
  const totalTasks = PIPELINE_COLS.reduce((s, c) => s + (tasksData[c] || []).length, 0);
  const buildingCount = (tasksData.building || []).length;
  const today = new Date().toISOString().slice(0, 10);
  const mergedToday = (tasksData.merged || []).filter(t => t.mergedAt && t.mergedAt.slice(0, 10) === today).length;
  const deployedToday = (tasksData.deployed || []).filter(t => t.deployedAt && t.deployedAt.slice(0, 10) === today).length;
  const parts = ['<div class="pipeline-bar">'];
  parts.push('<div class="pipeline-summary">');
  PIPELINE_COLS.forEach(function(col, i) {
    const count = (tasksData[col] || []).length;
    const isActive = col === 'building' && count > 0;
    if (i > 0) parts.push('<span class="pipe-arrow">\u2192</span>');
    parts.push('<button class="pipe-stage' + (isActive ? ' pipe-stage-active' : '') + (count > 0 ? ' has-items' : '') + '" style="--stage-color:' + COL_COLORS[col] + '" data-scroll-col="' + col + '">');
    parts.push('<span class="pipe-stage-label">' + escHtml(COL_LABELS[col]) + '</span>');
    parts.push('<span class="pipe-stage-count">' + count + '</span>');
    parts.push('</button>');
  });
  parts.push('</div>');
  parts.push('<div class="pipeline-stats">');
  parts.push('<span class="pipe-stat"><strong>' + totalTasks + '</strong> total</span>');
  parts.push('<span class="pipe-stat"><strong>' + buildingCount + '</strong> building</span>');
  parts.push('<span class="pipe-stat"><strong>' + mergedToday + '</strong> merged today</span>');
  parts.push('<span class="pipe-stat"><strong>' + deployedToday + '</strong> deployed today</span>');
  parts.push('</div></div>');
  return parts.join('');
}

function renderAddTaskForm() {
  return '<div class="add-task-form"><div class="add-task-row">' +
    '<input type="text" id="new-task-input" placeholder="Task title\u2026" class="add-task-title" />' +
    '<select id="new-task-priority" class="add-task-select"><option value="">Priority</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>' +
    '<select id="new-task-repo" class="add-task-select"><option value="">Repo</option><option value="torcmo/marketing-command-center">marketing-command-center</option><option value="torcmo/dashboard">dashboard</option></select>' +
    '<input type="text" id="new-task-labels" placeholder="Labels (comma-sep)" class="add-task-labels" />' +
    '<button id="add-task-btn" class="add-task-submit">+ Add Task</button>' +
    '</div></div>';
}

function renderKanbanHTML() {
  const parts = [renderPipelineSummary(), renderAddTaskForm(), '<div class="kanban">'];
  PIPELINE_COLS.forEach(function(col) {
    parts.push('<div class="kanban-col col-' + col + '" data-col="' + col + '" id="kanban-col-' + col + '">');
    parts.push('<div class="kanban-col-header" style="border-top:3px solid ' + COL_COLORS[col] + '">');
    parts.push('<h3>' + escHtml(COL_LABELS[col]) + (col === 'deployed' ? ' \u2713' : '') + '</h3>');
    parts.push('<span class="count">' + (tasksData[col] || []).length + '</span></div>');
    parts.push('<div class="kanban-cards" data-col="' + col + '">');
    (tasksData[col] || []).forEach(function(t) { parts.push(renderCardHTML(t, col)); });
    parts.push('</div></div>');
  });
  parts.push('</div>');
  return parts.join('');
}

function renderKanban() {
  const html = renderKanbanHTML();
  // All HTML content is sanitized through escHtml/escAttr before insertion
  const el = $('#kanban-panel');
  el.innerHTML = html;
  setupKanbanEvents(el);
  const full = $('#kanban-panel-full');
  if (full) {
    full.innerHTML = html;
    setupKanbanEvents(full);
  }
}

function setupKanbanEvents(ctx) {
  setupDragDrop(ctx);
  setupAddTask(ctx);
  setupDeleteButtons(ctx);
  setupCardActions(ctx);
  setupQAButtons(ctx);
  setupPipelineScroll(ctx);
}

function setupDragDrop(ctx = document) {
  let draggedId = null;

  $$('.kanban-card', ctx).forEach(card => {
    card.addEventListener('dragstart', e => {
      draggedId = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('.kanban-cards', ctx).forEach(c => c.classList.remove('drag-over'));
    });
  });

  $$('.kanban-cards', ctx).forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (!draggedId) return;
      const toCol = zone.dataset.col;

      const cards = [...zone.querySelectorAll('.kanban-card:not(.dragging)')];
      let insertIndex = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { insertIndex = i; break; }
      }

      await fetch(`/api/tasks/${draggedId}/move`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: toCol, index: insertIndex })
      });
      showToast(`Task moved to ${COL_LABELS[toCol]}`);
      await loadTasks();
    });
  });
}

function setupAddTask(ctx) {
  const input = $('#new-task-input', ctx);
  const btn = $('#add-task-btn', ctx);
  if (!input || !btn) return;

  async function addTask() {
    const title = input.value.trim();
    if (!title) return;
    const priority = ($('#new-task-priority', ctx) || {}).value || undefined;
    const repo = ($('#new-task-repo', ctx) || {}).value || undefined;
    const labelsRaw = ($('#new-task-labels', ctx) || {}).value || '';
    const labels = labelsRaw.split(',').map(s => s.trim()).filter(Boolean);
    const body = { title };
    if (priority) body.priority = priority;
    if (repo) body.repo = repo;
    if (labels.length) body.labels = labels;
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    input.value = '';
    if ($('#new-task-labels', ctx)) $('#new-task-labels', ctx).value = '';
    showToast('Task created: ' + title);
    await loadTasks();
  }

  btn.addEventListener('click', addTask);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });
}

function setupDeleteButtons(ctx) {
  $$('.delete-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      showToast('Task deleted');
      await loadTasks();
    });
  });
}

function setupCardActions(ctx) {
  $$('.card-action-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const to = btn.dataset.to;
      await fetch(`/api/tasks/${id}/move`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to })
      });
      showToast('Moved to ' + COL_LABELS[to]);
      await loadTasks();
    });
  });
}

function setupQAButtons(ctx) {
  $$('.qa-run-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await fetch(`/api/tasks/${btn.dataset.id}/qa`, { method: 'POST' });
      showToast('QA checks running...');
      await loadTasks();
    });
  });
  $$('.qa-approve-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await fetch(`/api/tasks/${btn.dataset.id}/move`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'staging' })
      });
      showToast('Approved \u2192 Staging');
      await loadTasks();
    });
  });
  $$('.qa-fail-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await fetch(`/api/tasks/${btn.dataset.id}/move`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'building' })
      });
      showToast('Failed QA \u2192 Back to Building');
      await loadTasks();
    });
  });
}

function setupPipelineScroll(ctx) {
  $$('.pipe-stage[data-scroll-col]', ctx).forEach(btn => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.scrollCol;
      const target = $('#kanban-col-' + col, ctx);
      if (target) target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
  });
}

// --- Marketing ---
let marketingTemplates = [];
let marketingSelectedTemplate = null;

async function loadMarketing() {
  const [templates, output] = await Promise.all([
    fetch('/api/marketing/templates').then(r => r.json()),
    fetch('/api/marketing/output').then(r => r.json())
  ]);
  marketingTemplates = templates;
  renderMarketing(templates, output);
}

function renderMarketing(templates, output) {
  const panel = $('#marketing-panel');
  if (!panel) return;

  const templateCards = templates.map(t => `
    <div class="mkt-template-card" data-id="${t.id}">
      <div class="mkt-template-name">${t.name}</div>
      <div class="mkt-template-desc">${t.description}</div>
      <div class="mkt-template-inputs">${t.inputs.map(i => `<span class="mkt-input-tag">${i}</span>`).join('')}</div>
    </div>
  `).join('');

  const outputRows = output.length === 0
    ? '<tr><td colspan="4" class="mkt-empty">No generated content yet.</td></tr>'
    : output.map(o => `
      <tr>
        <td class="mkt-filename">${o.filename}</td>
        <td>${new Date(o.created).toLocaleString()}</td>
        <td class="mkt-preview-text">${o.preview.slice(0, 80)}${o.preview.length > 80 ? '...' : ''}</td>
        <td><button class="mkt-view-btn" data-id="${o.id}">View</button></td>
      </tr>
    `).join('');

  panel.innerHTML = `
    <div class="mkt-section">
      <h3 class="mkt-section-title">Generate Content</h3>
      <div class="mkt-template-grid">${templateCards}</div>
      <div class="mkt-form-area" id="mkt-form-area"></div>
    </div>
    <div class="mkt-section">
      <h3 class="mkt-section-title">Recent Output</h3>
      <table class="mkt-output-table">
        <thead><tr><th>File</th><th>Created</th><th>Preview</th><th></th></tr></thead>
        <tbody>${outputRows}</tbody>
      </table>
      <div class="mkt-viewer" id="mkt-viewer"></div>
    </div>
  `;

  // Bind template card clicks
  $$('.mkt-template-card', panel).forEach(card => {
    card.addEventListener('click', () => {
      $$('.mkt-template-card', panel).forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const tpl = templates.find(t => t.id === card.dataset.id);
      marketingSelectedTemplate = tpl;
      renderMarketingForm(tpl);
    });
  });

  // Bind view buttons
  $$('.mkt-view-btn', panel).forEach(btn => {
    btn.addEventListener('click', async () => {
      const data = await fetch(`/api/marketing/output/${btn.dataset.id}`).then(r => r.json());
      const viewer = $('#mkt-viewer');
      if (viewer) {
        viewer.innerHTML = `
          <div class="mkt-viewer-header">
            <strong>${data.filename}</strong>
            <button class="mkt-viewer-close" id="mkt-viewer-close">&times;</button>
          </div>
          <pre class="mkt-viewer-content">${data.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        `;
        $('#mkt-viewer-close').addEventListener('click', () => { viewer.innerHTML = ''; });
      }
    });
  });
}

function renderMarketingForm(tpl) {
  const area = $('#mkt-form-area');
  if (!area || !tpl) return;

  const fields = tpl.inputs.map(input => `
    <label class="mkt-form-label">
      ${input}
      <input type="text" class="mkt-form-input" data-key="${input}" placeholder="Enter ${input}...">
    </label>
  `).join('');

  area.innerHTML = `
    <div class="mkt-form">
      <div class="mkt-form-title">Generate: ${tpl.name}</div>
      <div class="mkt-form-fields">${fields}</div>
      <button class="mkt-generate-btn" id="mkt-generate-btn">Generate</button>
    </div>
  `;

  $('#mkt-generate-btn').addEventListener('click', async () => {
    const inputs = {};
    $$('.mkt-form-input', area).forEach(el => {
      inputs[el.dataset.key] = el.value.trim();
    });
    const btn = $('#mkt-generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
      const resp = await fetch('/api/marketing/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: tpl.id, inputs, product: inputs.product || '' })
      });
      if (!resp.ok) {
        const err = await resp.json();
        showToast('Error: ' + (err.error || 'Failed'));
        return;
      }
      const result = await resp.json();
      showToast(`Content generated: ${result.filename}`);
      await loadMarketing();
    } catch (e) {
      showToast('Error generating content');
    }
  });
}

// --- Pipeline ---
let pipelineExpanded = {};

async function loadPipeline() {
  const pipelines = await fetch('/api/pipeline').then(r => r.json());
  renderPipeline(pipelines);
}

function renderPipeline(pipelines) {
  const panel = $('#pipeline-panel');
  if (!panel) return;

  const STAGE_LABELS = { plan: 'Plan', code: 'Code', review: 'Review' };
  const STATUS_COLORS = {
    pending: 'pipe-pending', planning: 'pipe-running', coding: 'pipe-running',
    reviewing: 'pipe-running', done: 'pipe-done', failed: 'pipe-failed'
  };
  const STAGE_COLORS = {
    pending: 'pipe-stage-pending', running: 'pipe-stage-running',
    done: 'pipe-stage-done', failed: 'pipe-stage-failed'
  };

  const cards = pipelines.length === 0
    ? '<div class="pipe-empty">No pipelines yet. Create one above.</div>'
    : pipelines.map(p => {
        const expanded = pipelineExpanded[p.id];
        const stageSteps = p.stages.map((s, i) => `
          <div class="pipe-step">
            <div class="pipe-step-dot ${STAGE_COLORS[s.status] || 'pipe-stage-pending'}"></div>
            <div class="pipe-step-label">${STAGE_LABELS[s.name]}</div>
          </div>
          ${i < p.stages.length - 1 ? `<div class="pipe-step-line ${s.status === 'done' ? 'pipe-line-done' : ''}"></div>` : ''}
        `).join('');

        const stageOutputs = expanded ? `<div class="pipe-outputs">
          ${p.stages.map(s => `
            <div class="pipe-output-block">
              <div class="pipe-output-header">${STAGE_LABELS[s.name]} <span class="pipe-output-status ${STAGE_COLORS[s.status]}">${s.status}</span></div>
              ${s.startedAt ? `<div class="pipe-output-time">Started: ${new Date(s.startedAt).toLocaleString()}</div>` : ''}
              ${s.completedAt ? `<div class="pipe-output-time">Completed: ${new Date(s.completedAt).toLocaleString()}</div>` : ''}
              ${s.output ? `<pre class="pipe-output-text">${s.output.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>` : '<div class="pipe-output-none">No output yet</div>'}
            </div>
          `).join('')}
        </div>` : '';

        return `
          <div class="pipe-card" data-id="${p.id}">
            <div class="pipe-card-header">
              <div class="pipe-card-info" data-id="${p.id}">
                <span class="pipe-chevron">${expanded ? '&#9662;' : '&#9656;'}</span>
                <span class="pipe-card-title">${p.title}</span>
                <span class="pipe-status-badge ${STATUS_COLORS[p.status] || 'pipe-pending'}">${p.status}</span>
              </div>
              <button class="pipe-delete-btn" data-id="${p.id}" title="Delete">&times;</button>
            </div>
            ${p.description ? `<div class="pipe-card-desc">${p.description}</div>` : ''}
            ${p.repo ? `<div class="pipe-card-repo">${p.repo}</div>` : ''}
            <div class="pipe-card-date">${new Date(p.createdAt).toLocaleString()}</div>
            <div class="pipe-stepper">${stageSteps}</div>
            ${stageOutputs}
          </div>`;
      }).join('');

  panel.innerHTML = `
    <div class="pipe-section">
      <h3 class="pipe-section-title">New Pipeline</h3>
      <div class="pipe-form">
        <div class="pipe-form-fields">
          <label class="pipe-form-label">Task Title<input type="text" id="pipe-title" placeholder="e.g. Add user authentication"></label>
          <label class="pipe-form-label">Repo Path (optional)<input type="text" id="pipe-repo" placeholder="/path/to/repo"></label>
          <label class="pipe-form-label pipe-form-wide">Description<textarea id="pipe-desc" rows="3" placeholder="Describe the coding task..."></textarea></label>
        </div>
        <button class="pipe-create-btn" id="pipe-create-btn">Create Pipeline</button>
      </div>
    </div>
    <div class="pipe-section">
      <h3 class="pipe-section-title">Active Pipelines</h3>
      ${cards}
    </div>
  `;

  // Bind create
  $('#pipe-create-btn').addEventListener('click', async () => {
    const title = ($('#pipe-title') || {}).value?.trim();
    const description = ($('#pipe-desc') || {}).value?.trim();
    const repo = ($('#pipe-repo') || {}).value?.trim();
    if (!title || !description) { showToast('Title and description are required'); return; }
    const btn = $('#pipe-create-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    try {
      const resp = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, repo: repo || undefined })
      });
      if (!resp.ok) { const err = await resp.json(); showToast('Error: ' + (err.error || 'Failed')); return; }
      showToast(`Pipeline created: ${title}`);
      await loadPipeline();
    } catch { showToast('Error creating pipeline'); }
  });

  // Bind expand/collapse
  $$('.pipe-card-info', panel).forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      pipelineExpanded[id] = !pipelineExpanded[id];
      loadPipeline();
    });
  });

  // Bind delete
  $$('.pipe-delete-btn', panel).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/pipeline/${btn.dataset.id}`, { method: 'DELETE' });
      showToast('Pipeline deleted');
      await loadPipeline();
    });
  });
}

// --- Marketing Team ---
const AGENT_COLORS = { strategist: 'team-blue', writer: 'team-purple', editor: 'team-green', analyst: 'team-orange' };
const STATUS_BADGE_CLASS = { planned: 'cal-planned', 'in-progress': 'cal-inprogress', draft: 'cal-draft', published: 'cal-published' };

let teamAgents = [];
let teamCalendar = { items: [] };

async function loadTeam() {
  const [agents, calendar, output] = await Promise.all([
    fetch('/api/marketing/team').then(r => r.json()),
    fetch('/api/marketing/calendar').then(r => r.json()),
    fetch('/api/marketing/output').then(r => r.json())
  ]);
  teamAgents = agents;
  teamCalendar = calendar;
  renderTeam(agents, calendar, output);
}

function renderTeam(agents, calendar, output) {
  const panel = $('#team-panel');
  if (!panel) return;

  // Agent Roster
  const agentCards = agents.map(a => {
    const colorClass = AGENT_COLORS[a.id] || 'team-blue';
    return `
      <div class="team-agent-card ${colorClass}" data-id="${a.id}">
        <div class="team-agent-name">${a.name}</div>
        <div class="team-agent-role">${a.role}</div>
        <div class="team-agent-desc">${a.description}</div>
        <button class="team-run-btn" data-agent="${a.id}">Run Task</button>
        <div class="team-run-form hidden" data-agent="${a.id}">
          <textarea class="team-task-input" data-agent="${a.id}" rows="3" placeholder="Describe the task..."></textarea>
          <select class="team-calendar-select" data-agent="${a.id}">
            <option value="">— No calendar item —</option>
            ${calendar.items.map(i => `<option value="${i.id}">${i.title} (${i.type})</option>`).join('')}
          </select>
          <button class="team-execute-btn" data-agent="${a.id}">Execute</button>
        </div>
      </div>`;
  }).join('');

  // Calendar table
  const calendarRows = calendar.items.length === 0
    ? '<tr><td colspan="7" class="cal-empty">No content planned yet.</td></tr>'
    : calendar.items.map(i => `
      <tr>
        <td>${i.title}</td>
        <td><span class="cal-type-badge">${i.type}</span></td>
        <td>${i.product || '—'}</td>
        <td><span class="cal-status ${STATUS_BADGE_CLASS[i.status] || 'cal-planned'}">${i.status}</span></td>
        <td>${i.assignedAgent || '—'}</td>
        <td>${i.dueDate}</td>
        <td class="cal-actions">
          <select class="cal-status-select" data-id="${i.id}">
            <option value="planned" ${i.status === 'planned' ? 'selected' : ''}>planned</option>
            <option value="in-progress" ${i.status === 'in-progress' ? 'selected' : ''}>in-progress</option>
            <option value="draft" ${i.status === 'draft' ? 'selected' : ''}>draft</option>
            <option value="published" ${i.status === 'published' ? 'selected' : ''}>published</option>
          </select>
          <button class="cal-delete-btn" data-id="${i.id}" title="Delete">&times;</button>
        </td>
      </tr>`).join('');

  // Recent output (pipeline activity)
  const outputRows = output.length === 0
    ? '<div class="team-activity-empty">No agent output yet.</div>'
    : output.slice(0, 10).map(o => `
      <div class="team-activity-item">
        <span class="team-activity-file">${o.filename}</span>
        <span class="team-activity-date">${new Date(o.created).toLocaleString()}</span>
        <span class="team-activity-preview">${o.preview.slice(0, 100)}${o.preview.length > 100 ? '...' : ''}</span>
      </div>`).join('');

  panel.innerHTML = `
    <div class="team-section">
      <h3 class="team-section-title">Agent Roster</h3>
      <div class="team-agent-grid">${agentCards}</div>
    </div>
    <div class="team-section">
      <h3 class="team-section-title">Content Calendar</h3>
      <button class="team-add-content-btn" id="team-add-content-toggle">+ Add Content</button>
      <div class="team-add-form hidden" id="team-add-form">
        <div class="team-add-fields">
          <label>Title<input type="text" id="cal-new-title" placeholder="Content title"></label>
          <label>Type
            <select id="cal-new-type">
              <option value="blog">Blog</option>
              <option value="social">Social</option>
              <option value="email">Email</option>
              <option value="case-study">Case Study</option>
            </select>
          </label>
          <label>Product<input type="text" id="cal-new-product" placeholder="Product name"></label>
          <label>Due Date<input type="date" id="cal-new-due"></label>
          <label class="team-add-wide">Brief<textarea id="cal-new-brief" rows="2" placeholder="Content brief..."></textarea></label>
        </div>
        <button class="team-add-submit" id="team-add-submit">Add to Calendar</button>
      </div>
      <table class="cal-table">
        <thead><tr><th>Title</th><th>Type</th><th>Product</th><th>Status</th><th>Agent</th><th>Due</th><th></th></tr></thead>
        <tbody>${calendarRows}</tbody>
      </table>
    </div>
    <div class="team-section">
      <h3 class="team-section-title">Pipeline Activity</h3>
      <div class="team-activity-list">${outputRows}</div>
    </div>
  `;

  setupTeamBindings(panel);
}

function setupTeamBindings(ctx) {
  // Run Task toggle
  $$('.team-run-btn', ctx).forEach(btn => {
    btn.addEventListener('click', () => {
      const form = $(`.team-run-form[data-agent="${btn.dataset.agent}"]`, ctx);
      if (form) {
        form.classList.toggle('hidden');
        btn.textContent = form.classList.contains('hidden') ? 'Run Task' : 'Cancel';
      }
    });
  });

  // Execute agent task
  $$('.team-execute-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async () => {
      const agent = btn.dataset.agent;
      const taskInput = $(`.team-task-input[data-agent="${agent}"]`, ctx);
      const calSelect = $(`.team-calendar-select[data-agent="${agent}"]`, ctx);
      const task = taskInput?.value?.trim();
      if (!task) { showToast('Task description is required'); return; }

      btn.disabled = true;
      btn.textContent = 'Running...';
      try {
        const body = { agentRole: agent, task };
        if (calSelect?.value) body.calendarItemId = calSelect.value;
        const resp = await fetch('/api/marketing/team/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) { const err = await resp.json(); showToast('Error: ' + (err.error || 'Failed')); return; }
        const result = await resp.json();
        showToast(`Agent ${agent} output: ${result.filename}`);
        await loadTeam();
      } catch { showToast('Error running agent'); }
    });
  });

  // Add content toggle
  const addToggle = $('#team-add-content-toggle', ctx);
  const addForm = $('#team-add-form', ctx);
  if (addToggle && addForm) {
    addToggle.addEventListener('click', () => {
      const open = !addForm.classList.toggle('hidden');
      addToggle.textContent = open ? '+ Add Content' : '− Cancel';
    });
  }

  // Submit new calendar item
  const submitBtn = $('#team-add-submit', ctx);
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const title = ($('#cal-new-title', ctx) || {}).value?.trim();
      if (!title) { showToast('Title is required'); return; }
      const body = {
        title,
        type: $('#cal-new-type', ctx).value,
        product: ($('#cal-new-product', ctx) || {}).value?.trim() || '',
        dueDate: ($('#cal-new-due', ctx) || {}).value || new Date().toISOString().slice(0, 10),
        brief: ($('#cal-new-brief', ctx) || {}).value || ''
      };
      const resp = await fetch('/api/marketing/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) { const err = await resp.json(); showToast('Error: ' + (err.error || 'Failed')); return; }
      showToast(`Added: ${title}`);
      await loadTeam();
    });
  }

  // Status change
  $$('.cal-status-select', ctx).forEach(sel => {
    sel.addEventListener('change', async () => {
      await fetch(`/api/marketing/calendar/${sel.dataset.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: sel.value })
      });
      showToast('Status updated');
      await loadTeam();
    });
  });

  // Delete calendar item
  $$('.cal-delete-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/marketing/calendar/${btn.dataset.id}`, { method: 'DELETE' });
      showToast('Item deleted');
      await loadTeam();
    });
  });
}

// === MCC Campaigns ===
let campaignsExpanded = {};
let campaignIcps = [];
let campaignChannels = [];
let campaignEditId = null;

async function loadCampaigns() {
  const [campaigns, icps, channels] = await Promise.all([
    fetch('/api/mcc/campaigns').then(r => r.json()),
    fetch('/api/mcc/icps').then(r => r.json()),
    fetch('/api/mcc/channels').then(r => r.json())
  ]);
  campaignIcps = icps;
  campaignChannels = channels;
  renderCampaigns(campaigns);
}

function renderCampaigns(campaigns) {
  const panel = $('#campaigns-panel');
  if (!panel) return;

  const STATUS_COLORS = { draft: 'camp-draft', active: 'camp-active', paused: 'camp-paused', completed: 'camp-completed' };

  const icpMap = {};
  campaignIcps.forEach(i => { icpMap[i.id] = i.name; });
  const channelMap = {};
  campaignChannels.forEach(c => { channelMap[c.id] = c.name; });

  const cards = campaigns.length === 0
    ? '<div class="camp-empty">No campaigns yet. Create one above.</div>'
    : campaigns.map(c => {
        const expanded = campaignsExpanded[c.id];
        const icpNames = c.targetIcps.map(id => icpMap[id] || id);
        const channelNames = c.channels.map(id => channelMap[id] || id);

        const detail = expanded ? `
          <div class="camp-detail">
            <div class="camp-detail-section">
              <strong>Goals</strong>
              <ul class="camp-goals-list">${c.goals.map(g => '<li>' + g + '</li>').join('')}</ul>
            </div>
            <div class="camp-detail-section">
              <strong>Content Items</strong>
              <ul class="camp-goals-list">${c.contentItems.map(ci => '<li>' + ci + '</li>').join('')}</ul>
            </div>
            <div class="camp-detail-section">
              <strong>Channels</strong>
              <div class="camp-tags">${channelNames.map(n => '<span class="camp-channel-tag">' + n + '</span>').join('')}</div>
            </div>
            <div class="camp-metrics-row">
              <div class="camp-metric"><div class="camp-metric-label">Reach</div><div class="camp-metric-value">${fmtNum(c.metrics.reach)}</div></div>
              <div class="camp-metric"><div class="camp-metric-label">Engagement</div><div class="camp-metric-value">${fmtNum(c.metrics.engagement)}</div></div>
              <div class="camp-metric"><div class="camp-metric-label">Leads</div><div class="camp-metric-value">${fmtNum(c.metrics.leads)}</div></div>
            </div>
            <div class="camp-detail-actions">
              <button class="camp-edit-btn" data-id="${c.id}">Edit</button>
              <button class="camp-delete-btn" data-id="${c.id}">Delete</button>
            </div>
          </div>` : '';

        return `
          <div class="camp-card" data-id="${c.id}">
            <div class="camp-card-header" data-id="${c.id}">
              <div class="camp-card-info">
                <span class="camp-chevron">${expanded ? '&#9662;' : '&#9656;'}</span>
                <span class="camp-card-name">${c.name}</span>
                <span class="camp-status-badge ${STATUS_COLORS[c.status]}">${c.status}</span>
              </div>
              <div class="camp-card-meta">
                <span class="camp-date-range">${c.startDate} — ${c.endDate}</span>
              </div>
            </div>
            <div class="camp-card-sub">
              <span class="camp-icp-list">${icpNames.map(n => '<span class="camp-icp-tag">' + n + '</span>').join('')}</span>
              <span class="camp-channel-count">${c.channels.length} channel${c.channels.length !== 1 ? 's' : ''}</span>
            </div>
            ${detail}
          </div>`;
      }).join('');

  // Build create form with ICP and channel checkboxes
  const icpCheckboxes = campaignIcps.map(i =>
    '<label class="camp-check-label"><input type="checkbox" value="' + i.id + '" class="camp-icp-check"> ' + i.name + '</label>'
  ).join('');
  const channelCheckboxes = campaignChannels.map(c =>
    '<label class="camp-check-label"><input type="checkbox" value="' + c.id + '" class="camp-channel-check"> ' + c.name + '</label>'
  ).join('');

  // Server-validated data rendered via innerHTML — follows existing codebase pattern (see CLAUDE.md)
  panel.textContent = '';
  panel.insertAdjacentHTML('beforeend', [
    '<div class="camp-section">',
    '  <div class="camp-form-toggle-row">',
    '    <h3 class="camp-section-title">Campaigns</h3>',
    '    <button class="camp-add-btn" id="camp-add-toggle">+ New Campaign</button>',
    '  </div>',
    '  <div class="camp-form hidden" id="camp-form">',
    '    <div class="camp-form-fields">',
    '      <label class="camp-form-label">Name<input type="text" id="camp-name" placeholder="Campaign name"></label>',
    '      <label class="camp-form-label">Status',
    '        <select id="camp-status">',
    '          <option value="draft">Draft</option>',
    '          <option value="active">Active</option>',
    '          <option value="paused">Paused</option>',
    '          <option value="completed">Completed</option>',
    '        </select>',
    '      </label>',
    '      <label class="camp-form-label">Start Date<input type="date" id="camp-start"></label>',
    '      <label class="camp-form-label">End Date<input type="date" id="camp-end"></label>',
    '      <label class="camp-form-label camp-form-wide">Description<textarea id="camp-desc" rows="2" placeholder="Campaign description..."></textarea></label>',
    '    </div>',
    '    <div class="camp-form-multi">',
    '      <div class="camp-multi-group"><strong>Target ICPs</strong><div class="camp-check-grid">' + icpCheckboxes + '</div></div>',
    '      <div class="camp-multi-group"><strong>Channels</strong><div class="camp-check-grid">' + channelCheckboxes + '</div></div>',
    '    </div>',
    '    <div class="camp-form-actions">',
    '      <button class="camp-submit-btn" id="camp-submit-btn">Create Campaign</button>',
    '      <button class="camp-cancel-btn" id="camp-cancel-btn">Cancel</button>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div class="camp-section">' + cards + '</div>'
  ].join('\n'));

  // Bind toggle form
  const toggleBtn = $('#camp-add-toggle');
  const form = $('#camp-form');
  toggleBtn.addEventListener('click', () => {
    campaignEditId = null;
    form.classList.toggle('hidden');
    toggleBtn.textContent = form.classList.contains('hidden') ? '+ New Campaign' : '- Cancel';
    if (!form.classList.contains('hidden')) {
      $('#camp-submit-btn').textContent = 'Create Campaign';
      clearCampaignForm();
    }
  });
  $('#camp-cancel-btn').addEventListener('click', () => {
    form.classList.add('hidden');
    toggleBtn.textContent = '+ New Campaign';
    campaignEditId = null;
  });

  // Bind submit (create or update)
  $('#camp-submit-btn').addEventListener('click', async () => {
    const name = ($('#camp-name') || {}).value?.trim();
    if (!name) { showToast('Name is required'); return; }
    const body = {
      name,
      description: ($('#camp-desc') || {}).value?.trim() || '',
      status: $('#camp-status').value,
      startDate: ($('#camp-start') || {}).value || new Date().toISOString().slice(0, 10),
      endDate: ($('#camp-end') || {}).value || new Date().toISOString().slice(0, 10),
      targetIcps: [...$$('.camp-icp-check:checked')].map(c => c.value),
      channels: [...$$('.camp-channel-check:checked')].map(c => c.value)
    };
    const btn = $('#camp-submit-btn');
    btn.disabled = true;

    try {
      if (campaignEditId) {
        const resp = await fetch('/api/mcc/campaigns/' + campaignEditId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) { const err = await resp.json(); showToast('Error: ' + (err.error || 'Failed')); return; }
        showToast('Campaign updated: ' + name);
      } else {
        const resp = await fetch('/api/mcc/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) { const err = await resp.json(); showToast('Error: ' + (err.error || 'Failed')); return; }
        showToast('Campaign created: ' + name);
      }
      campaignEditId = null;
      await loadCampaigns();
    } catch { showToast('Error saving campaign'); }
  });

  // Bind expand/collapse on card headers
  $$('.camp-card-header', panel).forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      campaignsExpanded[id] = !campaignsExpanded[id];
      loadCampaigns();
    });
  });

  // Bind edit buttons
  $$('.camp-edit-btn', panel).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const data = await fetch('/api/mcc/campaigns/' + id).then(r => r.json());
      campaignEditId = id;
      form.classList.remove('hidden');
      toggleBtn.textContent = '- Cancel';
      $('#camp-submit-btn').textContent = 'Update Campaign';
      fillCampaignForm(data);
      panel.scrollTop = 0;
    });
  });

  // Bind delete buttons
  $$('.camp-delete-btn', panel).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch('/api/mcc/campaigns/' + btn.dataset.id, { method: 'DELETE' });
      showToast('Campaign deleted');
      await loadCampaigns();
    });
  });
}

function clearCampaignForm() {
  ['#camp-name', '#camp-desc', '#camp-start', '#camp-end'].forEach(s => { const el = $(s); if (el) el.value = ''; });
  const sel = $('#camp-status'); if (sel) sel.value = 'draft';
  $$('.camp-icp-check').forEach(c => { c.checked = false; });
  $$('.camp-channel-check').forEach(c => { c.checked = false; });
}

function fillCampaignForm(data) {
  $('#camp-name').value = data.name || '';
  $('#camp-desc').value = data.description || '';
  $('#camp-status').value = data.status || 'draft';
  $('#camp-start').value = data.startDate || '';
  $('#camp-end').value = data.endDate || '';
  $$('.camp-icp-check').forEach(c => { c.checked = (data.targetIcps || []).includes(c.value); });
  $$('.camp-channel-check').forEach(c => { c.checked = (data.channels || []).includes(c.value); });
}

// === Claude Code Terminal ===
let claudeSSE = null;
let claudeTerminalCollapsed = false;

function initClaudeTerminal() {
  const output = document.getElementById('claude-terminal-output');
  const statusEl = document.getElementById('claude-status');
  const killBtn = document.getElementById('claude-kill-btn');
  const clearBtn = document.getElementById('claude-clear-btn');
  const toggleBtn = document.getElementById('claude-toggle-btn');
  const body = document.getElementById('claude-terminal-body');

  if (!output) return;

  // Connect SSE
  if (claudeSSE) claudeSSE.close();
  claudeSSE = new EventSource('/api/claude/stream');

  claudeSSE.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === 'history' && data.content) {
      output.textContent = data.content;
      output.scrollTop = output.scrollHeight;
    }

    if (data.type === 'output') {
      // Color stderr differently
      if (data.stream === 'stderr') {
        const span = document.createElement('span');
        span.className = 'stderr';
        span.textContent = data.content;
        output.appendChild(span);
      } else {
        // Detect tool use patterns and highlight
        const text = data.content;
        if (text.includes('Read(') || text.includes('Write(') || text.includes('Edit(') || text.includes('Bash(')) {
          const span = document.createElement('span');
          span.className = 'tool-use';
          span.textContent = text;
          output.appendChild(span);
        } else {
          output.appendChild(document.createTextNode(text));
        }
      }
      // Auto-scroll to bottom
      output.scrollTop = output.scrollHeight;
    }

    if (data.type === 'status') {
      if (data.status === 'running') {
        statusEl.textContent = '● Running';
        statusEl.className = 'terminal-status running';
        killBtn.classList.remove('hidden');
      } else if (data.status === 'exited') {
        const code = data.code === 0 ? '' : ` (code ${data.code})`;
        statusEl.textContent = `● Finished${code}`;
        statusEl.className = 'terminal-status' + (data.code === 0 ? ' running' : ' error');
        killBtn.classList.add('hidden');
        // Add completion marker
        const span = document.createElement('span');
        span.className = data.code === 0 ? 'success' : 'stderr';
        span.textContent = `\n\n--- Process exited with code ${data.code} ---\n`;
        output.appendChild(span);
        output.scrollTop = output.scrollHeight;
      } else if (data.status === 'error') {
        statusEl.textContent = '● Error';
        statusEl.className = 'terminal-status error';
        killBtn.classList.add('hidden');
      } else {
        statusEl.textContent = '● Idle';
        statusEl.className = 'terminal-status';
        killBtn.classList.add('hidden');
      }
    }
  };

  claudeSSE.onerror = () => {
    statusEl.textContent = '● Disconnected';
    statusEl.className = 'terminal-status error';
  };

  // Kill button
  killBtn.addEventListener('click', async () => {
    if (!confirm('Kill Claude Code process?')) return;
    await fetch('/api/claude/kill', { method: 'POST' });
    showToast('Claude Code process killed');
  });

  // Clear button
  clearBtn.addEventListener('click', () => {
    output.textContent = '';
  });

  // Toggle collapse
  toggleBtn.addEventListener('click', () => {
    claudeTerminalCollapsed = !claudeTerminalCollapsed;
    body.classList.toggle('collapsed', claudeTerminalCollapsed);
    toggleBtn.textContent = claudeTerminalCollapsed ? '▲' : '▼';
  });
}

// --- Init ---
async function init() {
  // Set up hash routing
  window.addEventListener('hashchange', navigate);
  navigate();

  // Load all data
  await Promise.all([loadSystem(), loadUsage(), loadCron(), loadTasks()]);

  // Init Claude Code terminal
  initClaudeTerminal();

  // Auto-refresh system stats every 5s, usage every 60s, tasks every 10s
  setInterval(loadSystem, 5000);
  setInterval(loadUsage, 60000);
  setInterval(loadTasks, 10000);
}

init();
