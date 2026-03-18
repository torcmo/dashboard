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
  if (route === 'pipeline') { loadPipeline(); loadKnownRepos(); loadRepoConfigs(); loadWebhookConfigs(); loadNotificationConfig(); setupRepoConfigBindings(); setupWebhookBindings(); setupNotificationBindings(); return; }
  // Stop pipeline auto-refresh when navigating away
  stopPlAutoRefresh();
  disconnectPipelineLogs();
  plCurrentDetailRunId = null;
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
let archiveView = false;

async function loadTasks() {
  const qs = archiveView ? '?archived=true' : '';
  tasksData = await fetch('/api/tasks' + qs).then(r => r.json());
  renderKanban();
}

async function autoArchiveDeployed() {
  try { await fetch('/api/tasks/archive-deployed?days=30', { method: 'POST' }); } catch {}
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
  if (col === 'deployed' && !archiveView) p.push('<button class="archive-btn" data-id="' + escAttr(t.id) + '" title="Archive">\uD83D\uDCE6</button>');
  if (archiveView) p.push('<button class="unarchive-btn" data-id="' + escAttr(t.id) + '" title="Unarchive">\u21A9</button>');
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
  const parts = [renderPipelineSummary()];
  // Archive controls bar
  parts.push('<div class="archive-controls">');
  parts.push('<button class="archive-toggle-btn" id="archive-toggle-btn">' + (archiveView ? '\uD83D\uDCE6 Hide Archive' : '\uD83D\uDCE6 Show Archive') + '</button>');
  if (!archiveView) parts.push('<button class="archive-all-btn" id="archive-all-deployed-btn">Archive All Deployed</button>');
  parts.push('</div>');
  if (archiveView) parts.push('<div class="archive-banner">Showing archived cards</div>');
  parts.push(renderAddTaskForm());
  parts.push('<div class="kanban">');
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
  setupCardClick(ctx);
  setupArchiveButtons(ctx);
}

function setupArchiveButtons(ctx) {
  // Archive toggle
  const toggleBtn = $('#archive-toggle-btn', ctx);
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      archiveView = !archiveView;
      await loadTasks();
    });
  }
  // Archive All Deployed
  const archiveAllBtn = $('#archive-all-deployed-btn', ctx);
  if (archiveAllBtn) {
    archiveAllBtn.addEventListener('click', async () => {
      await fetch('/api/tasks/archive-deployed?days=0', { method: 'POST' });
      showToast('Archived all deployed cards');
      await loadTasks();
    });
  }
  // Per-card archive buttons
  $$('.archive-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await fetch('/api/tasks/' + btn.dataset.id + '/archive', { method: 'PUT' });
      showToast('Card archived');
      await loadTasks();
    });
  });
  // Per-card unarchive buttons
  $$('.unarchive-btn', ctx).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await fetch('/api/tasks/' + btn.dataset.id + '/unarchive', { method: 'PUT' });
      showToast('Card restored');
      await loadTasks();
    });
  });
}

function setupCardClick(ctx) {
  $$('.kanban-card', ctx).forEach(card => {
    card.addEventListener('click', function(e) {
      // Don't trigger on button/link clicks
      if (e.target.closest('button, a, .delete-btn, .card-action-btn')) return;
      const id = card.dataset.id;
      const col = card.dataset.col;
      // Find the task data
      const task = (tasksData[col] || []).find(t => t.id === id);
      if (!task) return;
      showTaskDetailModal(task, col);
    });
    card.style.cursor = 'pointer';
  });
}

function showTaskDetailModal(task, col) {
  const overlay = document.createElement('div');
  overlay.className = 'task-modal-overlay';
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });

  const isBuilding = col === 'building';
  const prHtml = task.pr && task.pr.number
    ? '<a href="' + escAttr(task.pr.url) + '" target="_blank" class="card-pr-badge pr-' + (task.pr.status || 'open') + '">PR #' + task.pr.number + ' ↗</a>'
    : '<span style="color:var(--text-muted)">No PR</span>';

  const labelsHtml = (task.labels || []).map(function(l) {
    return '<span class="card-label">' + escHtml(l) + '</span>';
  }).join(' ') || '<span style="color:var(--text-muted)">None</span>';

  const metaRows = [
    ['Status', '<span style="color:' + (COL_COLORS[col] || '#888') + ';font-weight:700">' + escHtml(COL_LABELS[col] || col) + '</span>'],
    ['Priority', task.priority ? '<span class="card-priority">' + (PRIORITY_BADGE[task.priority] || '') + ' ' + escHtml(task.priority) + '</span>' : 'None'],
    ['Assignee', task.assignee === 'claude-code' ? '🤖 Claude Code' : task.assignee === 'human' ? '👤 Human' : escHtml(task.assignee || 'Unassigned')],
    ['Repository', task.repo ? escHtml(task.repo) : 'None'],
    ['Branch', task.branch ? '<code>' + escHtml(task.branch) + '</code>' : 'None'],
    ['PR', prHtml],
    ['Labels', labelsHtml],
    ['Created', task.created || 'Unknown']
  ];

  if (task.startedAt) metaRows.push(['Started', new Date(task.startedAt).toLocaleString()]);
  if (task.mergedAt) metaRows.push(['Merged', new Date(task.mergedAt).toLocaleString()]);
  if (task.deployedAt) metaRows.push(['Deployed', new Date(task.deployedAt).toLocaleString()]);

  const metaTable = metaRows.map(function(r) {
    return '<tr><td style="color:var(--text-muted);padding:6px 16px 6px 0;white-space:nowrap">' + r[0] + '</td><td style="padding:6px 0">' + r[1] + '</td></tr>';
  }).join('');

  let buildingTerminal = '';
  if (isBuilding) {
    buildingTerminal = '<div class="modal-terminal-wrap">' +
      '<div class="modal-terminal-header">' +
        '<span class="modal-terminal-title">Claude Code Output</span>' +
        '<span class="modal-live-dot" id="modal-live-dot"><span class="modal-live-pulse"></span> Live</span>' +
      '</div>' +
      '<pre class="modal-terminal-output" id="modal-terminal-output">Connecting to build stream...</pre>' +
    '</div>';
  }

  const modal = document.createElement('div');
  modal.className = 'task-modal';
  modal.innerHTML = '<div class="task-modal-header">' +
    '<h2 style="margin:0;font-size:18px">' + escHtml(task.title) + '</h2>' +
    '<button class="task-modal-close" onclick="this.closest(\'.task-modal-overlay\').remove()">&times;</button>' +
    '</div>' +
    '<div class="task-modal-body">' +
    '<table style="width:100%;border-collapse:collapse">' + metaTable + '</table>' +
    buildingTerminal +
    '</div>' +
    '<div class="task-modal-footer">' +
    '<button class="btn btn-small" onclick="this.closest(\'.task-modal-overlay\').remove()">Close</button>' +
    '</div>';

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // If building, connect live SSE stream
  if (isBuilding) {
    connectModalStream(overlay);
  }
}

// --- Modal Live SSE Stream ---
let modalSSE = null;
const MODAL_MAX_LINES = 200;

const TOOL_ICONS = {
  'Read': '📖', 'Write': '✏️', 'Edit': '🔧', 'Bash': '⚡',
  'Grep': '🔍', 'Glob': '📂', 'Agent': '🤖', 'TodoWrite': '📋'
};
const TOOL_PATTERN = /\b(Read|Write|Edit|Bash|Grep|Glob|Agent|TodoWrite)\s*\(/;

function connectModalStream(overlay) {
  const output = document.getElementById('modal-terminal-output');
  const liveDot = document.getElementById('modal-live-dot');
  if (!output) return;

  let lineCount = 0;

  if (modalSSE) modalSSE.close();
  modalSSE = new EventSource('/api/claude/stream');

  modalSSE.onmessage = function(event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === 'connected') {
      output.textContent = '';
    }

    if (data.type === 'history' && data.content) {
      const lines = data.content.split('\n');
      const trimmed = lines.slice(-MODAL_MAX_LINES);
      lineCount = trimmed.length;
      output.textContent = trimmed.join('\n');
      output.scrollTop = output.scrollHeight;
    }

    if (data.type === 'output') {
      const text = data.content;
      const newLines = text.split('\n');
      lineCount += newLines.length - 1;

      // Trim excess lines from top
      if (lineCount > MODAL_MAX_LINES) {
        const allText = output.textContent + text;
        const allLines = allText.split('\n');
        while (output.firstChild) output.removeChild(output.firstChild);
        const keep = allLines.slice(-MODAL_MAX_LINES);
        lineCount = keep.length;
        appendColoredLines(output, keep.join('\n'), data.stream);
      } else {
        appendColoredLines(output, text, data.stream);
      }
      output.scrollTop = output.scrollHeight;
    }

    if (data.type === 'status') {
      if (data.status === 'idle' || data.status === 'exited') {
        if (liveDot) {
          liveDot.textContent = '';
          const checkSpan = document.createElement('span');
          checkSpan.className = 'modal-done-icon';
          checkSpan.textContent = '✓';
          liveDot.appendChild(checkSpan);
          liveDot.appendChild(document.createTextNode(' Build complete'));
          liveDot.classList.add('done');
          liveDot.classList.remove('live');
        }
        const marker = document.createElement('span');
        marker.className = 'modal-term-success';
        marker.textContent = '\n\n── Build complete ──\n';
        output.appendChild(marker);
        output.scrollTop = output.scrollHeight;
        if (modalSSE) { modalSSE.close(); modalSSE = null; }
      } else if (data.status === 'error') {
        if (liveDot) {
          liveDot.textContent = '● Error';
          liveDot.classList.add('error');
        }
      } else if (data.status === 'running') {
        if (liveDot) {
          liveDot.classList.add('live');
          liveDot.classList.remove('done', 'error');
        }
      }
    }
  };

  modalSSE.onerror = function() {
    if (liveDot) {
      liveDot.textContent = '● Disconnected';
      liveDot.classList.add('error');
      liveDot.classList.remove('live');
    }
  };

  // Clean up SSE when modal closes
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay || e.target.closest('.task-modal-close') || e.target.closest('.task-modal-footer button')) {
      if (modalSSE) { modalSSE.close(); modalSSE = null; }
    }
  });

  // Also clean up if overlay is removed from DOM
  const obs = new MutationObserver(function() {
    if (!document.body.contains(overlay)) {
      if (modalSSE) { modalSSE.close(); modalSSE = null; }
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
}

function appendColoredLines(container, text, stream) {
  if (stream === 'stderr') {
    const span = document.createElement('span');
    span.className = 'modal-term-error';
    span.textContent = text;
    container.appendChild(span);
    return;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) container.appendChild(document.createTextNode('\n'));
    const line = lines[i];
    const match = line.match(TOOL_PATTERN);
    if (match) {
      const icon = TOOL_ICONS[match[1]] || '⚡';
      const span = document.createElement('span');
      span.className = 'modal-term-tool';
      span.textContent = icon + ' ' + line;
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(line));
    }
  }
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
// --- Pipeline Runs UI ---
const PL_STAGES = ['build', 'pr', 'review', 'qa', 'staging', 'merge', 'deploy'];
const PL_STAGE_LABELS = { build: 'Build', pr: 'PR', review: 'Review', qa: 'QA', staging: 'Staging', merge: 'Merge', deploy: 'Deploy' };
const PL_STATUS_CLASS = { queued: 'pl-status-queued', running: 'pl-status-running', completed: 'pl-status-completed', failed: 'pl-status-failed', cancelled: 'pl-status-cancelled' };
const PL_STAGE_STATUS_ICON = {
  pending: '<span class="pl-stage-icon pl-si-pending">\u2014</span>',
  running: '<span class="pl-stage-icon pl-si-running"></span>',
  passed: '<span class="pl-stage-icon pl-si-passed">\u2713</span>',
  failed: '<span class="pl-stage-icon pl-si-failed">\u2715</span>',
  skipped: '<span class="pl-stage-icon pl-si-skipped">\u2014</span>'
};

let plExpandedStage = null;
let plNewRunVisible = false;
let plLogEventSource = null;
let plCurrentDetailRunId = null;
let plAutoRefreshList = null;
let plAutoRefreshDetail = null;
let plKnownRepos = [];

function fmtDuration(secs) {
  if (secs == null) return '--';
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
  return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
}

function fmtDurationMs(ms) {
  if (ms == null) return '--';
  return fmtDuration(Math.round(ms / 1000));
}

function fmtCost(usd) {
  if (usd == null || usd === 0) return '$0.00';
  return '$' + parseFloat(usd).toFixed(4);
}

function escHtml(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

async function loadPipeline() {
  const statusFilter = ($('#pl-filter-status') || {}).value || '';
  const repoFilter = ($('#pl-filter-repo') || {}).value || '';
  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);
  if (repoFilter) params.set('repo', repoFilter);

  try {
    const runs = await fetch('/api/pipeline/runs?' + params).then(r => r.json());
    renderPipelineRunList(runs);
  } catch {
    const panel = $('#pipeline-runs-panel');
    if (panel) panel.textContent = 'Failed to load pipeline runs.';
  }
}

function renderPipelineRunList(runs) {
  const panel = $('#pipeline-runs-panel');
  if (!panel) return;

  // Populate repo filter dropdown with unique repos
  const repoSelect = $('#pl-filter-repo');
  if (repoSelect && repoSelect.options.length <= 1) {
    const repos = [...new Set(runs.map(r => r.repo).filter(Boolean))];
    repos.forEach(repo => {
      const opt = document.createElement('option');
      opt.value = repo;
      opt.textContent = repo;
      repoSelect.appendChild(opt);
    });
  }

  // Build the panel using DOM methods for safety, with innerHTML only for server-validated data
  panel.textContent = '';

  // New Run form
  if (plNewRunVisible) {
    const formDiv = document.createElement('div');
    formDiv.className = 'pl-new-run-form';
    formDiv.innerHTML = [
      '<div class="pl-form-fields">',
      '  <label class="pl-form-label">Task ID (optional)<input type="text" id="pl-run-taskid" placeholder="e.g. pg-03"></label>',
      '  <label class="pl-form-label">Repo<input type="text" id="pl-run-repo" placeholder="e.g. torcmo/marketing-command-center"></label>',
      '  <label class="pl-form-label pl-form-wide">Prompt<textarea id="pl-run-prompt" rows="3" placeholder="Describe the coding task..."></textarea></label>',
      '  <label class="pl-form-label">Provider<select id="pl-run-provider"><option value="github">GitHub</option><option value="azure_devops">Azure DevOps</option></select></label>',
      '  <label class="pl-form-label">Triggered By<input type="text" id="pl-run-trigger" placeholder="e.g. nihal@tor.ai"></label>',
      '</div>',
      '<div class="pl-form-options">',
      '  <label class="pl-check"><input type="checkbox" id="pl-run-automerge" checked> Auto-merge</label>',
      '  <label class="pl-check"><input type="checkbox" id="pl-run-skipreview"> Skip review</label>',
      '  <label class="pl-check"><input type="checkbox" id="pl-run-skipqa"> Skip QA</label>',
      '</div>',
      '<button class="pl-submit-btn" id="pl-submit-run">Create Run</button>'
    ].join('\n');
    panel.appendChild(formDiv);
  }

  // Runs table
  const wrap = document.createElement('div');
  wrap.className = 'pl-table-wrap';
  const table = document.createElement('table');
  table.className = 'pl-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Task', 'Repo', 'Provider', 'Status', 'Stage', 'Duration', 'Cost', 'Triggered By', 'Created'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  if (runs.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.className = 'pl-empty';
    td.textContent = 'No pipeline runs found.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    runs.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'pl-run-row';
      tr.dataset.id = r.id;

      const tdTask = document.createElement('td');
      tdTask.className = 'pl-cell-taskid';
      tdTask.textContent = r.taskId || '--';

      const tdRepo = document.createElement('td');
      tdRepo.className = 'pl-cell-repo';
      tdRepo.textContent = r.repo;

      const tdProvider = document.createElement('td');
      const provBadge = document.createElement('span');
      provBadge.className = 'pl-provider-badge pl-provider-' + (r.provider || 'github');
      provBadge.textContent = r.provider === 'azure_devops' ? 'Azure DevOps' : 'GitHub';
      tdProvider.appendChild(provBadge);

      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'pl-status-badge ' + (PL_STATUS_CLASS[r.status] || '');
      badge.textContent = r.status;
      tdStatus.appendChild(badge);

      const tdStage = document.createElement('td');
      tdStage.textContent = r.currentStage ? (PL_STAGE_LABELS[r.currentStage] || r.currentStage) : '--';

      const tdDur = document.createElement('td');
      tdDur.textContent = fmtDuration(r.durationSecs);

      const tdCost = document.createElement('td');
      tdCost.textContent = fmtCost(r.costUsd);

      const tdBy = document.createElement('td');
      tdBy.textContent = r.triggeredBy || '--';

      const tdDate = document.createElement('td');
      tdDate.className = 'pl-cell-date';
      tdDate.textContent = new Date(r.createdAt).toLocaleString();

      tr.append(tdTask, tdRepo, tdProvider, tdStatus, tdStage, tdDur, tdCost, tdBy, tdDate);
      tr.addEventListener('click', () => showPipelineDetail(r.id));
      tbody.appendChild(tr);
    });
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);

  // Bind new run form submit
  const submitBtn = $('#pl-submit-run');
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const repo = ($('#pl-run-repo') || {}).value?.trim();
      const prompt = ($('#pl-run-prompt') || {}).value?.trim();
      if (!repo || !prompt) { showToast('Repo and prompt are required'); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';
      try {
        const body = {
          repo, prompt,
          taskId: ($('#pl-run-taskid') || {}).value?.trim() || undefined,
          provider: ($('#pl-run-provider') || {}).value || 'github',
          triggeredBy: ($('#pl-run-trigger') || {}).value?.trim() || undefined,
          config: {
            autoMerge: $('#pl-run-automerge')?.checked !== false,
            skipReview: $('#pl-run-skipreview')?.checked || false,
            skipQA: $('#pl-run-skipqa')?.checked || false
          }
        };
        const resp = await fetch('/api/pipeline/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) { const err = await resp.json(); showToast('Error: ' + (err.error || 'Failed')); return; }
        showToast('Pipeline run created');
        plNewRunVisible = false;
        await loadPipeline();
      } catch { showToast('Error creating run'); }
    });
  }

  // Bind filter changes
  const statusSel = $('#pl-filter-status');
  const repoSel = $('#pl-filter-repo');
  if (statusSel) statusSel.onchange = () => loadPipeline();
  if (repoSel) repoSel.onchange = () => loadPipeline();

  // Bind new run button to modal
  const newBtn = $('#pl-new-run-btn');
  if (newBtn) newBtn.onclick = () => openNewRunModal();

  // Start auto-refresh when on pipeline list
  startPlListAutoRefresh();
}

async function showPipelineDetail(runId) {
  $('#pipeline-list-view').classList.add('hidden');
  $('#pipeline-detail-view').classList.remove('hidden');
  plExpandedStage = null;
  plCurrentDetailRunId = runId;

  // Stop list auto-refresh, start detail auto-refresh
  stopPlAutoRefresh();
  plAutoRefreshDetail = setInterval(() => refreshPipelineDetail(), 10000);

  try {
    const run = await fetch('/api/pipeline/runs/' + encodeURIComponent(runId)).then(r => r.json());
    renderPipelineDetail(run);
    connectPipelineLogs(runId);
  } catch {
    const p = $('#pipeline-detail-panel');
    if (p) p.textContent = 'Failed to load run details.';
  }
}

async function refreshPipelineDetail() {
  if (!plCurrentDetailRunId) return;
  try {
    const run = await fetch('/api/pipeline/runs/' + encodeURIComponent(plCurrentDetailRunId)).then(r => r.json());
    renderPipelineDetail(run);
  } catch { /* silent */ }
}

// --- Pipeline Live Logs (SSE) ---

const PL_STAGE_LABELS_UPPER = { build: 'BUILD', pr: 'PR', review: 'REVIEW', qa: 'QA', staging: 'STAGING', merge: 'MERGE', deploy: 'DEPLOY' };

function connectPipelineLogs(runId) {
  disconnectPipelineLogs();

  const output = $('#pl-log-output');
  const statusEl = $('#pl-log-status');
  if (!output) return;

  output.textContent = '';
  if (statusEl) { statusEl.textContent = '● Connecting'; statusEl.className = 'pl-log-status'; }

  plLogEventSource = new EventSource('/api/pipeline/runs/' + encodeURIComponent(runId) + '/logs');

  plLogEventSource.onopen = () => {
    if (statusEl) { statusEl.textContent = '● Live'; statusEl.className = 'pl-log-status connected'; }
  };

  plLogEventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'stage') {
        const header = document.createElement('span');
        header.className = 'pl-log-stage-header' + (data.status === 'passed' ? ' passed' : data.status === 'failed' ? ' failed' : '');
        const icon = data.status === 'passed' ? '\u2713' : data.status === 'failed' ? '\u2715' : '\u25b6';
        header.textContent = `${icon} ${PL_STAGE_LABELS_UPPER[data.stage] || data.stage} — ${data.status}`;
        if (data.durationMs) header.textContent += ` (${fmtDurationMs(data.durationMs)})`;
        if (data.costUsd > 0) header.textContent += ` $${data.costUsd.toFixed(4)}`;
        output.appendChild(header);
        output.appendChild(document.createTextNode('\n'));
      }

      if (data.type === 'output' && data.content) {
        const lines = data.content.split('\n');
        for (const line of lines) {
          if (line.startsWith('[ERROR]')) {
            const errSpan = document.createElement('span');
            errSpan.className = 'pl-log-error';
            errSpan.textContent = line;
            output.appendChild(errSpan);
          } else {
            output.appendChild(document.createTextNode(line));
          }
          output.appendChild(document.createTextNode('\n'));
        }
      }

      if (data.type === 'done') {
        if (statusEl) { statusEl.textContent = '● Done'; statusEl.className = 'pl-log-status done'; }
        disconnectPipelineLogs();
      }

      if (data.type === 'error') {
        const errSpan = document.createElement('span');
        errSpan.className = 'pl-log-error';
        errSpan.textContent = '[ERROR] ' + data.message + '\n';
        output.appendChild(errSpan);
      }

      // Auto-scroll to bottom
      output.scrollTop = output.scrollHeight;
    } catch { /* malformed event */ }
  };

  plLogEventSource.onerror = () => {
    if (statusEl) { statusEl.textContent = '● Disconnected'; statusEl.className = 'pl-log-status'; }
  };

  // Clear button
  const clearBtn = $('#pl-log-clear');
  if (clearBtn) clearBtn.onclick = () => { output.textContent = ''; };
}

function disconnectPipelineLogs() {
  if (plLogEventSource) {
    plLogEventSource.close();
    plLogEventSource = null;
  }
}

function renderPipelineDetail(run) {
  // Title — uses textContent for dynamic values
  const titleEl = $('#pl-detail-title');
  if (titleEl) {
    titleEl.textContent = '';
    const icon = document.createElement('span');
    icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
    titleEl.appendChild(icon);
    titleEl.appendChild(document.createTextNode(' ' + (run.taskId || run.id.slice(0, 8)) + ' \u2014 ' + run.repo + ' '));
    const providerBadge = document.createElement('span');
    providerBadge.className = 'pl-provider-badge pl-provider-' + (run.provider || 'github');
    providerBadge.textContent = run.provider === 'azure_devops' ? 'Azure DevOps' : 'GitHub';
    titleEl.appendChild(providerBadge);
    titleEl.appendChild(document.createTextNode(' '));
    const badge = document.createElement('span');
    badge.className = 'pl-status-badge ' + (PL_STATUS_CLASS[run.status] || '');
    badge.textContent = run.status;
    titleEl.appendChild(badge);
  }

  // Action buttons
  const actionsEl = $('#pl-detail-actions');
  if (actionsEl) {
    actionsEl.textContent = '';
    if (run.status === 'running' || run.status === 'queued') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'pl-action-btn pl-action-cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = async () => {
        await fetch('/api/pipeline/runs/' + encodeURIComponent(run.id) + '/cancel', { method: 'POST' });
        showToast('Run cancelled');
        showPipelineDetail(run.id);
      };
      actionsEl.appendChild(cancelBtn);
    }
    if (run.status === 'failed') {
      const failedStage = (run.stages || []).find(s => s.status === 'failed');
      if (failedStage) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'pl-action-btn pl-action-retry';
        retryBtn.textContent = 'Retry from ' + PL_STAGE_LABELS[failedStage.stage];
        retryBtn.onclick = async () => {
          await fetch('/api/pipeline/runs/' + encodeURIComponent(run.id) + '/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromStage: failedStage.stage })
          });
          showToast('Retrying from ' + PL_STAGE_LABELS[failedStage.stage]);
          showPipelineDetail(run.id);
        };
        actionsEl.appendChild(retryBtn);
      }
    }
    if (run.currentStage === 'staging' && run.status === 'running') {
      const approveBtn = document.createElement('button');
      approveBtn.className = 'pl-action-btn pl-action-approve';
      approveBtn.textContent = 'Approve';
      approveBtn.onclick = async () => {
        await fetch('/api/pipeline/runs/' + encodeURIComponent(run.id) + '/approve', { method: 'POST' });
        showToast('Staging approved');
        showPipelineDetail(run.id);
      };
      actionsEl.appendChild(approveBtn);
    }
  }

  // Stage stepper
  const stages = run.stages || [];
  const panel = $('#pipeline-detail-panel');
  if (!panel) return;
  panel.textContent = '';

  const stepperDiv = document.createElement('div');
  stepperDiv.className = 'pl-stepper';
  stages.forEach((s, i) => {
    const step = document.createElement('div');
    step.className = 'pl-stepper-step' + (plExpandedStage === s.stage ? ' pl-step-active' : '');
    step.dataset.stage = s.stage;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'pl-step-icon-wrap pl-step-' + s.status;
    iconWrap.innerHTML = PL_STAGE_STATUS_ICON[s.status] || PL_STAGE_STATUS_ICON.pending;

    const nameDiv = document.createElement('div');
    nameDiv.className = 'pl-step-name';
    nameDiv.textContent = PL_STAGE_LABELS[s.stage];

    step.append(iconWrap, nameDiv);
    if (s.durationMs != null) {
      const durDiv = document.createElement('div');
      durDiv.className = 'pl-step-dur';
      durDiv.textContent = fmtDurationMs(s.durationMs);
      step.appendChild(durDiv);
    }

    step.addEventListener('click', () => {
      plExpandedStage = plExpandedStage === s.stage ? null : s.stage;
      renderPipelineDetail(run);
    });

    stepperDiv.appendChild(step);

    if (i < stages.length - 1) {
      const line = document.createElement('div');
      line.className = 'pl-stepper-line' + (s.status === 'passed' ? ' pl-line-passed' : '');
      stepperDiv.appendChild(line);
    }
  });
  panel.appendChild(stepperDiv);

  // Expanded stage output
  if (plExpandedStage) {
    const s = stages.find(st => st.stage === plExpandedStage);
    if (s) {
      const detail = document.createElement('div');
      detail.className = 'pl-stage-detail';

      const header = document.createElement('div');
      header.className = 'pl-stage-detail-header';
      const strong = document.createElement('strong');
      strong.textContent = PL_STAGE_LABELS[s.stage];
      header.appendChild(strong);
      const sBadge = document.createElement('span');
      sBadge.className = 'pl-status-badge ' + (s.status === 'passed' ? 'pl-status-completed' : s.status === 'failed' ? 'pl-status-failed' : s.status === 'running' ? 'pl-status-running' : 'pl-status-queued');
      sBadge.textContent = s.status;
      header.appendChild(sBadge);
      if (s.costUsd) {
        const costSpan = document.createElement('span');
        costSpan.className = 'pl-stage-cost';
        costSpan.textContent = fmtCost(s.costUsd);
        header.appendChild(costSpan);
      }
      if (s.durationMs != null) {
        const durSpan = document.createElement('span');
        durSpan.className = 'pl-stage-dur-tag';
        durSpan.textContent = fmtDurationMs(s.durationMs);
        header.appendChild(durSpan);
      }
      detail.appendChild(header);

      if (s.error) {
        const errPre = document.createElement('pre');
        errPre.className = 'pl-stage-output pl-stage-error';
        errPre.textContent = s.error;
        detail.appendChild(errPre);
      }
      if (s.output) {
        const outPre = document.createElement('pre');
        outPre.className = 'pl-stage-output';
        outPre.textContent = s.output;
        detail.appendChild(outPre);
      }
      if (!s.output && !s.error) {
        const none = document.createElement('div');
        none.className = 'pl-stage-none';
        none.textContent = 'No output yet';
        detail.appendChild(none);
      }

      panel.appendChild(detail);
    }
  }

  // Right sidebar — Run Info
  const infoPanel = $('#pl-sidebar-info');
  if (infoPanel) {
    const infoRows = [
      ['ID', run.id.slice(0, 8) + '\u2026'],
      ['Task', run.taskId || '--'],
      ['Repo', run.repo],
      ['Branch', run.branch || '--'],
      ['Provider', run.provider === 'azure_devops' ? 'Azure DevOps' : 'GitHub'],
      ['Triggered By', run.triggeredBy || '--'],
      ['Created', new Date(run.createdAt).toLocaleString()],
      run.startedAt ? ['Started', new Date(run.startedAt).toLocaleString()] : null,
      run.completedAt ? ['Completed', new Date(run.completedAt).toLocaleString()] : null,
      ['Duration', fmtDuration(run.durationSecs)],
      ['Total Cost', fmtCost(run.costUsd)]
    ].filter(Boolean);

    const listDiv = document.createElement('div');
    listDiv.className = 'pl-info-list';
    infoRows.forEach(([label, val]) => {
      const row = document.createElement('div');
      row.className = 'pl-info-row';
      const lbl = document.createElement('span');
      lbl.className = 'pl-info-label';
      lbl.textContent = label;
      const v = document.createElement('span');
      v.className = 'pl-info-val';
      v.textContent = val;
      row.append(lbl, v);
      listDiv.appendChild(row);
    });

    if (run.prUrl) {
      const prRow = document.createElement('div');
      prRow.className = 'pl-info-row';
      const prLbl = document.createElement('span');
      prLbl.className = 'pl-info-label';
      prLbl.textContent = 'PR';
      const prVal = document.createElement('span');
      prVal.className = 'pl-info-val';
      const prLink = document.createElement('a');
      prLink.href = run.prUrl;
      prLink.target = '_blank';
      prLink.textContent = '#' + run.prNumber;
      prVal.appendChild(prLink);
      prRow.append(prLbl, prVal);
      listDiv.appendChild(prRow);
    }

    infoPanel.textContent = '';
    infoPanel.appendChild(listDiv);

    if (run.prompt) {
      const promptDiv = document.createElement('div');
      promptDiv.className = 'pl-info-prompt';
      const promptTitle = document.createElement('strong');
      promptTitle.textContent = 'Prompt';
      const promptPre = document.createElement('pre');
      promptPre.className = 'pl-prompt-text';
      promptPre.textContent = run.prompt;
      promptDiv.append(promptTitle, promptPre);
      infoPanel.appendChild(promptDiv);
    }
  }

  // Right sidebar — Cost Breakdown
  const costPanel = $('#pl-sidebar-cost');
  if (costPanel) {
    costPanel.textContent = '';
    const costStages = stages.filter(s => s.costUsd > 0);
    if (costStages.length === 0) {
      costPanel.textContent = 'No costs recorded';
    } else {
      costStages.forEach(s => {
        const row = document.createElement('div');
        row.className = 'pl-cost-row';
        const name = document.createElement('span');
        name.textContent = PL_STAGE_LABELS[s.stage];
        const cost = document.createElement('span');
        cost.textContent = fmtCost(s.costUsd);
        row.append(name, cost);
        costPanel.appendChild(row);
      });
    }
  }

  // Right sidebar — Audit Log
  const auditPanel = $('#pl-sidebar-audit');
  if (auditPanel) {
    auditPanel.textContent = '';
    const logs = run.auditLog || [];
    if (logs.length === 0) {
      auditPanel.textContent = 'No audit entries';
    } else {
      logs.forEach(l => {
        const entry = document.createElement('div');
        entry.className = 'pl-audit-entry';
        const action = document.createElement('span');
        action.className = 'pl-audit-action';
        action.textContent = l.action;
        const actor = document.createElement('span');
        actor.className = 'pl-audit-actor';
        actor.textContent = l.actor || '--';
        const time = document.createElement('span');
        time.className = 'pl-audit-time';
        time.textContent = new Date(l.createdAt).toLocaleString();
        entry.append(action, actor, time);
        auditPanel.appendChild(entry);
      });
    }
  }

  // Back button
  const backBtn = $('#pl-back-btn');
  if (backBtn) backBtn.onclick = () => {
    disconnectPipelineLogs();
    plCurrentDetailRunId = null;
    stopPlAutoRefresh();
    $('#pipeline-detail-view').classList.add('hidden');
    $('#pipeline-list-view').classList.remove('hidden');
    loadPipeline();
    startPlListAutoRefresh();
  };
}

// --- Pipeline Auto-Refresh ---

function startPlListAutoRefresh() {
  stopPlAutoRefresh();
  plAutoRefreshList = setInterval(loadPipeline, 10000);
}

function stopPlAutoRefresh() {
  if (plAutoRefreshList) { clearInterval(plAutoRefreshList); plAutoRefreshList = null; }
  if (plAutoRefreshDetail) { clearInterval(plAutoRefreshDetail); plAutoRefreshDetail = null; }
}

// --- New Run Modal ---

async function loadKnownRepos() {
  try {
    plKnownRepos = await fetch('/api/pipeline/repos').then(r => r.json());
  } catch {
    plKnownRepos = ['torcmo/marketing-command-center', 'torcmo/dashboard'];
  }
}

function openNewRunModal() {
  const overlay = $('#pl-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');

  // Populate repo dropdown
  const repoSelect = $('#pl-modal-repo');
  if (repoSelect) {
    repoSelect.textContent = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select a repo...';
    repoSelect.appendChild(defaultOpt);
    plKnownRepos.forEach(repo => {
      const opt = document.createElement('option');
      opt.value = repo;
      opt.textContent = repo;
      repoSelect.appendChild(opt);
    });
  }

  // Reset form
  const tid = $('#pl-modal-taskid'); if (tid) tid.value = '';
  const prompt = $('#pl-modal-prompt'); if (prompt) prompt.value = '';
  const am = $('#pl-modal-automerge'); if (am) am.checked = true;
  const sr = $('#pl-modal-skipreview'); if (sr) sr.checked = false;
  const sq = $('#pl-modal-skipqa'); if (sq) sq.checked = false;
  const slider = $('#pl-modal-timeout'); if (slider) slider.value = '600';
  const sliderVal = $('#pl-modal-timeout-val'); if (sliderVal) sliderVal.textContent = '600';

  // Reset provider to GitHub and hide Azure fields
  const providerSel = $('#pl-modal-provider');
  const azureFields = $('#pl-modal-azure-fields');
  if (providerSel) providerSel.value = 'github';
  if (azureFields) azureFields.classList.add('hidden');
  const azOrg = $('#pl-modal-azure-org'); if (azOrg) azOrg.value = '';
  const azProj = $('#pl-modal-azure-project'); if (azProj) azProj.value = '';
  const azWi = $('#pl-modal-azure-workitem'); if (azWi) azWi.value = '';

  // Provider toggle — show/hide Azure DevOps fields
  if (providerSel) providerSel.onchange = () => {
    if (azureFields) azureFields.classList.toggle('hidden', providerSel.value !== 'azure_devops');
  };

  // Timeout slider live update
  if (slider) slider.oninput = () => {
    if (sliderVal) sliderVal.textContent = slider.value;
  };

  // Close handlers
  const closeBtn = $('#pl-modal-close');
  const cancelBtn = $('#pl-modal-cancel');
  const closeModal = () => overlay.classList.add('hidden');
  if (closeBtn) closeBtn.onclick = closeModal;
  if (cancelBtn) cancelBtn.onclick = closeModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  // Submit handler
  const submitBtn = $('#pl-modal-submit');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      const repo = ($('#pl-modal-repo') || {}).value;
      const promptVal = ($('#pl-modal-prompt') || {}).value?.trim();
      if (!repo || !promptVal) { showToast('Repository and prompt are required'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';

      try {
        const selectedProvider = ($('#pl-modal-provider') || {}).value || 'github';
        const config = {
          autoMerge: $('#pl-modal-automerge')?.checked !== false,
          skipReview: $('#pl-modal-skipreview')?.checked || false,
          skipQA: $('#pl-modal-skipqa')?.checked || false,
          timeoutSeconds: parseInt($('#pl-modal-timeout')?.value || '600', 10)
        };
        if (selectedProvider === 'azure_devops') {
          const azOrgVal = ($('#pl-modal-azure-org') || {}).value?.trim();
          const azProjVal = ($('#pl-modal-azure-project') || {}).value?.trim();
          const azWiVal = ($('#pl-modal-azure-workitem') || {}).value?.trim();
          if (azOrgVal) config.organization = azOrgVal;
          if (azProjVal) config.project = azProjVal;
          if (azWiVal) config.workItemId = azWiVal;
        }
        const body = {
          repo,
          prompt: promptVal,
          provider: selectedProvider,
          taskId: ($('#pl-modal-taskid') || {}).value?.trim() || undefined,
          config
        };

        const resp = await fetch('/api/pipeline/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!resp.ok) {
          const err = await resp.json();
          showToast('Error: ' + (err.error || 'Failed'));
          return;
        }

        showToast('Pipeline run created');
        closeModal();
        await loadPipeline();
      } catch {
        showToast('Error creating pipeline run');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Run';
      }
    };
  }
}

// --- Repo Config CRUD ---

let plRepoConfigs = [];
let plRepoEditKey = null;

async function loadRepoConfigs() {
  try {
    plRepoConfigs = await fetch('/api/pipeline/repo-configs').then(r => r.json());
  } catch {
    plRepoConfigs = [];
  }
  renderRepoConfigs();
}

function renderRepoConfigs() {
  const panel = $('#pipeline-repo-config-panel');
  if (!panel) return;
  panel.textContent = '';

  const wrap = document.createElement('div');
  wrap.className = 'pl-table-wrap';
  const table = document.createElement('table');
  table.className = 'pl-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Repo', 'Provider', 'Org / Project', 'Default Branch', 'Merge Strategy', ''].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  if (plRepoConfigs.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'pl-empty';
    td.textContent = 'No repos configured. Click "+ Add Repo" to get started.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    plRepoConfigs.forEach(rc => {
      const tr = document.createElement('tr');
      tr.className = 'pl-run-row';

      const tdName = document.createElement('td');
      tdName.className = 'pl-cell-repo';
      tdName.textContent = rc.repoName || rc.repoId;

      const tdProv = document.createElement('td');
      const provBadge = document.createElement('span');
      provBadge.className = 'pl-provider-badge pl-provider-' + (rc.provider || 'github');
      provBadge.textContent = rc.provider === 'azure_devops' ? 'Azure DevOps' : 'GitHub';
      tdProv.appendChild(provBadge);

      const tdOrg = document.createElement('td');
      tdOrg.className = 'pl-cell-repo';
      if (rc.provider === 'azure_devops') {
        tdOrg.textContent = (rc.organization || '') + ' / ' + (rc.project || '');
      } else {
        tdOrg.textContent = rc.org || '';
      }

      const tdBranch = document.createElement('td');
      tdBranch.textContent = rc.defaultBranch || 'master';

      const tdMerge = document.createElement('td');
      tdMerge.textContent = rc.mergeStrategy || 'squash';

      const tdActions = document.createElement('td');
      tdActions.className = 'pl-repo-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'pl-action-btn pl-action-approve';
      editBtn.textContent = 'Edit';
      editBtn.style.cssText = 'font-size:.7rem;padding:3px 10px';
      editBtn.onclick = (e) => { e.stopPropagation(); openRepoModal(rc); };

      const delBtn = document.createElement('button');
      delBtn.className = 'pl-action-btn pl-action-cancel';
      delBtn.textContent = 'Delete';
      delBtn.style.cssText = 'font-size:.7rem;padding:3px 10px';
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        await fetch('/api/pipeline/repo-configs/' + encodeURIComponent(rc.repoId), { method: 'DELETE' });
        showToast('Repo config deleted');
        await loadRepoConfigs();
      };

      tdActions.append(editBtn, delBtn);
      tr.append(tdName, tdProv, tdOrg, tdBranch, tdMerge, tdActions);
      tbody.appendChild(tr);
    });
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
}

function openRepoModal(config) {
  const overlay = $('#pl-repo-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');

  const titleEl = $('#pl-repo-modal-title');
  const provSel = $('#pl-repo-provider');
  const ghFields = $('#pl-repo-github-fields');
  const azFields = $('#pl-repo-azure-fields');
  const orgInput = $('#pl-repo-org');
  const azOrgInput = $('#pl-repo-azure-org');
  const azProjInput = $('#pl-repo-azure-project');
  const nameInput = $('#pl-repo-name');
  const branchInput = $('#pl-repo-branch');
  const mergeSel = $('#pl-repo-merge-strategy');

  if (config) {
    plRepoEditKey = config.repoId;
    if (titleEl) titleEl.textContent = 'Edit Repo Config';
    if (provSel) provSel.value = config.provider || 'github';
    if (nameInput) nameInput.value = config.repoName || '';
    if (branchInput) branchInput.value = config.defaultBranch || 'master';
    if (mergeSel) mergeSel.value = config.mergeStrategy || 'squash';
    if (config.provider === 'azure_devops') {
      if (ghFields) ghFields.classList.add('hidden');
      if (azFields) azFields.classList.remove('hidden');
      if (azOrgInput) azOrgInput.value = config.organization || '';
      if (azProjInput) azProjInput.value = config.project || '';
    } else {
      if (ghFields) ghFields.classList.remove('hidden');
      if (azFields) azFields.classList.add('hidden');
      if (orgInput) orgInput.value = config.org || '';
    }
  } else {
    plRepoEditKey = null;
    if (titleEl) titleEl.textContent = 'Add Repo Config';
    if (provSel) provSel.value = 'github';
    if (ghFields) ghFields.classList.remove('hidden');
    if (azFields) azFields.classList.add('hidden');
    if (orgInput) orgInput.value = '';
    if (azOrgInput) azOrgInput.value = '';
    if (azProjInput) azProjInput.value = '';
    if (nameInput) nameInput.value = '';
    if (branchInput) branchInput.value = 'master';
    if (mergeSel) mergeSel.value = 'squash';
  }

  // Provider toggle
  if (provSel) provSel.onchange = () => {
    const isAzure = provSel.value === 'azure_devops';
    if (ghFields) ghFields.classList.toggle('hidden', isAzure);
    if (azFields) azFields.classList.toggle('hidden', !isAzure);
  };

  const closeModal = () => overlay.classList.add('hidden');
  const closeBtn = $('#pl-repo-modal-close');
  const cancelBtn = $('#pl-repo-modal-cancel');
  if (closeBtn) closeBtn.onclick = closeModal;
  if (cancelBtn) cancelBtn.onclick = closeModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  const submitBtn = $('#pl-repo-modal-submit');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      const repoName = (nameInput || {}).value?.trim();
      if (!repoName) { showToast('Repository name is required'); return; }

      const provider = (provSel || {}).value || 'github';
      const repoId = plRepoEditKey || repoName;
      const body = {
        provider,
        repoName,
        defaultBranch: (branchInput || {}).value?.trim() || 'master',
        mergeStrategy: (mergeSel || {}).value || 'squash'
      };
      if (provider === 'github') {
        body.organization = (orgInput || {}).value?.trim() || '';
      } else {
        body.organization = (azOrgInput || {}).value?.trim() || '';
        body.project = (azProjInput || {}).value?.trim() || '';
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
      try {
        const resp = await fetch('/api/pipeline/repo-configs/' + encodeURIComponent(repoId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) { const err = await resp.json(); showToast('Error: ' + (err.error || 'Failed')); return; }
        showToast('Repo config saved');
        closeModal();
        await loadRepoConfigs();
      } catch {
        showToast('Error saving repo config');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save';
      }
    };
  }
}

function setupRepoConfigBindings() {
  const addBtn = $('#pl-repo-add-btn');
  if (addBtn) addBtn.onclick = () => openRepoModal(null);
}

// --- Webhook Config ---

let whConfigs = [];
let whEditRepoId = null;

async function loadWebhookConfigs() {
  try {
    whConfigs = await fetch('/api/webhooks/configs').then(r => r.json());
  } catch {
    whConfigs = [];
  }
  renderWebhookConfigs();
}

function renderWebhookConfigs() {
  const panel = $('#webhook-config-panel');
  if (!panel) return;
  panel.textContent = '';

  const wrap = document.createElement('div');
  wrap.className = 'pl-table-wrap';
  const table = document.createElement('table');
  table.className = 'pl-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Repo', 'Status', 'Events', 'Branches', 'Webhook URL', ''].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  if (whConfigs.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'pl-empty';
    td.textContent = 'No webhooks configured. Click "+ Add Webhook" to get started.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    whConfigs.forEach(wh => {
      const tr = document.createElement('tr');
      tr.className = 'pl-run-row';

      const tdRepo = document.createElement('td');
      tdRepo.className = 'pl-cell-repo';
      tdRepo.textContent = wh.repoId;

      const tdStatus = document.createElement('td');
      const statusBadge = document.createElement('span');
      statusBadge.className = 'wh-status-badge ' + (wh.enabled ? 'wh-status-active' : 'wh-status-disabled');
      statusBadge.textContent = wh.enabled ? 'Active' : 'Disabled';
      tdStatus.appendChild(statusBadge);

      const tdEvents = document.createElement('td');
      tdEvents.textContent = (wh.events || []).join(', ');

      const tdBranches = document.createElement('td');
      tdBranches.textContent = (wh.branches || []).length ? wh.branches.join(', ') : 'all';

      const tdUrl = document.createElement('td');
      const repoConfig = plRepoConfigs.find(rc => rc.repoId === wh.repoId);
      const isAzure = repoConfig && repoConfig.provider === 'azure_devops';
      const webhookUrl = window.location.origin + '/api/webhooks/' + (isAzure ? 'azure-devops' : 'github');
      const urlWrap = document.createElement('div');
      urlWrap.className = 'wh-url-cell';
      const urlCode = document.createElement('code');
      urlCode.className = 'wh-url-code';
      urlCode.textContent = webhookUrl;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'wh-copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(webhookUrl);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      };
      urlWrap.append(urlCode, copyBtn);
      tdUrl.appendChild(urlWrap);

      const tdActions = document.createElement('td');
      tdActions.className = 'pl-repo-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'pl-action-btn pl-action-approve';
      editBtn.textContent = 'Edit';
      editBtn.style.cssText = 'font-size:.7rem;padding:3px 10px';
      editBtn.onclick = (e) => { e.stopPropagation(); openWebhookModal(wh); };

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'pl-action-btn ' + (wh.enabled ? 'pl-action-cancel' : 'pl-action-approve');
      toggleBtn.textContent = wh.enabled ? 'Disable' : 'Enable';
      toggleBtn.style.cssText = 'font-size:.7rem;padding:3px 10px';
      toggleBtn.onclick = async (e) => {
        e.stopPropagation();
        await fetch('/api/webhooks/configs/' + encodeURIComponent(wh.repoId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...wh, enabled: !wh.enabled })
        });
        showToast(wh.enabled ? 'Webhook disabled' : 'Webhook enabled');
        await loadWebhookConfigs();
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'pl-action-btn pl-action-cancel';
      delBtn.textContent = 'Delete';
      delBtn.style.cssText = 'font-size:.7rem;padding:3px 10px';
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        await fetch('/api/webhooks/configs/' + encodeURIComponent(wh.repoId), { method: 'DELETE' });
        showToast('Webhook config deleted');
        await loadWebhookConfigs();
      };

      tdActions.append(editBtn, toggleBtn, delBtn);
      tr.append(tdRepo, tdStatus, tdEvents, tdBranches, tdUrl, tdActions);
      tbody.appendChild(tr);
    });
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
}

function openWebhookModal(config) {
  const overlay = $('#wh-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');

  const titleEl = $('#wh-modal-title');
  const repoSel = $('#wh-modal-repo');
  const enabledCb = $('#wh-modal-enabled');
  const secretInput = $('#wh-modal-secret');
  const revealBtn = $('#wh-modal-reveal');
  const genBtn = $('#wh-modal-gen');
  const evtPush = $('#wh-evt-push');
  const evtPr = $('#wh-evt-pr');
  const branchesInput = $('#wh-modal-branches');

  // Populate repo dropdown from known repo configs using safe DOM methods
  if (repoSel) {
    while (repoSel.firstChild) repoSel.removeChild(repoSel.firstChild);
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select a repo...';
    repoSel.appendChild(defaultOpt);
    plRepoConfigs.forEach(rc => {
      const opt = document.createElement('option');
      opt.value = rc.repoId;
      opt.textContent = rc.repoName || rc.repoId;
      repoSel.appendChild(opt);
    });
  }

  if (config) {
    whEditRepoId = config.repoId;
    if (titleEl) titleEl.textContent = 'Edit Webhook';
    if (repoSel) { repoSel.value = config.repoId; repoSel.disabled = true; }
    if (enabledCb) enabledCb.checked = config.enabled !== false;
    if (secretInput) secretInput.value = config.secret || '';
    if (evtPush) evtPush.checked = (config.events || []).includes('push');
    if (evtPr) evtPr.checked = (config.events || []).includes('pull_request');
    if (branchesInput) branchesInput.value = (config.branches || []).join(', ');
  } else {
    whEditRepoId = null;
    if (titleEl) titleEl.textContent = 'Add Webhook';
    if (repoSel) { repoSel.value = ''; repoSel.disabled = false; }
    if (enabledCb) enabledCb.checked = true;
    if (secretInput) secretInput.value = '';
    if (evtPush) evtPush.checked = true;
    if (evtPr) evtPr.checked = true;
    if (branchesInput) branchesInput.value = '';
  }

  // Secret reveal toggle
  if (secretInput) secretInput.type = 'password';
  if (revealBtn) {
    revealBtn.textContent = 'Show';
    revealBtn.onclick = () => {
      const isHidden = secretInput.type === 'password';
      secretInput.type = isHidden ? 'text' : 'password';
      revealBtn.textContent = isHidden ? 'Hide' : 'Show';
    };
  }

  // Generate random secret
  if (genBtn) {
    genBtn.onclick = () => {
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
      if (secretInput) secretInput.value = hex;
      if (secretInput) secretInput.type = 'text';
      if (revealBtn) revealBtn.textContent = 'Hide';
    };
  }

  const closeModal = () => overlay.classList.add('hidden');
  const closeBtn = $('#wh-modal-close');
  const cancelBtn = $('#wh-modal-cancel');
  if (closeBtn) closeBtn.onclick = closeModal;
  if (cancelBtn) cancelBtn.onclick = closeModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  const submitBtn = $('#wh-modal-submit');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      const repoId = whEditRepoId || (repoSel ? repoSel.value : '');
      if (!repoId) { showToast('Please select a repository'); return; }

      const events = [];
      if (evtPush && evtPush.checked) events.push('push');
      if (evtPr && evtPr.checked) events.push('pull_request');

      const branchStr = branchesInput ? branchesInput.value.trim() : '';
      const branches = branchStr ? branchStr.split(',').map(b => b.trim()).filter(Boolean) : [];

      const body = {
        enabled: enabledCb ? enabledCb.checked : true,
        secret: secretInput ? secretInput.value.trim() : '',
        events,
        branches
      };

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
      try {
        const resp = await fetch('/api/webhooks/configs/' + encodeURIComponent(repoId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) { const err = await resp.json(); showToast('Error: ' + (err.error || 'Failed')); return; }
        showToast('Webhook config saved');
        closeModal();
        await loadWebhookConfigs();
      } catch {
        showToast('Error saving webhook config');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save';
      }
    };
  }
}

function setupWebhookBindings() {
  const addBtn = $('#wh-add-btn');
  if (addBtn) addBtn.onclick = () => openWebhookModal(null);
}

// --- Notification Preferences ---

const NOTIF_EVENTS = ['started', 'review_done', 'qa_done', 'completed', 'failed'];
const NOTIF_LABELS = {
  started: 'Pipeline Started',
  review_done: 'Review Done',
  qa_done: 'QA Done',
  completed: 'Pipeline Completed',
  failed: 'Pipeline Failed'
};

let notifConfig = { defaults: {}, users: {} };

async function loadNotificationConfig() {
  try {
    notifConfig = await fetch('/api/pipeline/notifications').then(r => r.json());
  } catch {
    notifConfig = { defaults: { started: true, review_done: true, qa_done: true, completed: true, failed: true }, users: {} };
  }
  renderNotificationConfig();
}

function renderNotificationConfig() {
  const panel = $('#notification-config-panel');
  if (!panel) return;
  panel.textContent = '';

  const wrap = document.createElement('div');
  wrap.className = 'pl-table-wrap';
  const table = document.createElement('table');
  table.className = 'pl-table';

  // Header row
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const thUser = document.createElement('th');
  thUser.textContent = 'User / Default';
  headRow.appendChild(thUser);
  NOTIF_EVENTS.forEach(evt => {
    const th = document.createElement('th');
    th.textContent = NOTIF_LABELS[evt];
    th.style.textAlign = 'center';
    headRow.appendChild(th);
  });
  const thActions = document.createElement('th');
  thActions.textContent = '';
  headRow.appendChild(thActions);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Defaults row
  const defRow = document.createElement('tr');
  defRow.className = 'pl-run-row';
  const defLabel = document.createElement('td');
  const defBold = document.createElement('strong');
  defBold.textContent = 'Global Defaults';
  defLabel.appendChild(defBold);
  defRow.appendChild(defLabel);
  NOTIF_EVENTS.forEach(evt => {
    const td = document.createElement('td');
    td.style.textAlign = 'center';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = notifConfig.defaults?.[evt] !== false;
    cb.dataset.scope = 'defaults';
    cb.dataset.event = evt;
    cb.onchange = () => saveNotificationConfig();
    td.appendChild(cb);
    defRow.appendChild(td);
  });
  const defActions = document.createElement('td');
  defRow.appendChild(defActions);
  tbody.appendChild(defRow);

  // Per-user rows
  const users = Object.keys(notifConfig.users || {}).sort();
  users.forEach(userId => {
    const userPrefs = notifConfig.users[userId];
    const tr = document.createElement('tr');
    tr.className = 'pl-run-row';
    const tdUser = document.createElement('td');
    tdUser.className = 'pl-cell-repo';
    tdUser.textContent = userId;
    tr.appendChild(tdUser);

    NOTIF_EVENTS.forEach(evt => {
      const td = document.createElement('td');
      td.style.textAlign = 'center';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = userPrefs[evt] !== false;
      cb.dataset.scope = userId;
      cb.dataset.event = evt;
      cb.onchange = () => saveNotificationConfig();
      td.appendChild(cb);
      tr.appendChild(td);
    });

    const tdActions = document.createElement('td');
    tdActions.className = 'pl-repo-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'pl-action-btn pl-action-cancel';
    delBtn.textContent = 'Remove';
    delBtn.style.cssText = 'font-size:.7rem;padding:3px 10px';
    delBtn.onclick = async () => {
      delete notifConfig.users[userId];
      await saveNotificationConfig();
    };
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
}

async function saveNotificationConfig() {
  // Read all checkboxes from the table
  const panel = $('#notification-config-panel');
  if (!panel) return;

  const updated = { defaults: {}, users: { ...(notifConfig.users || {}) } };

  panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const scope = cb.dataset.scope;
    const evt = cb.dataset.event;
    if (!scope || !evt) return;
    if (scope === 'defaults') {
      updated.defaults[evt] = cb.checked;
    } else {
      if (!updated.users[scope]) updated.users[scope] = {};
      updated.users[scope][evt] = cb.checked;
    }
  });

  try {
    const resp = await fetch('/api/pipeline/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    });
    if (resp.ok) {
      notifConfig = await resp.json();
      showToast('Notification preferences saved');
    } else {
      showToast('Failed to save notification preferences');
    }
  } catch {
    showToast('Error saving notification preferences');
  }
  renderNotificationConfig();
}

function setupNotificationBindings() {
  const addBtn = $('#notif-add-user-btn');
  if (addBtn) {
    addBtn.onclick = () => {
      const userId = prompt('Enter user ID (e.g. user@example.com):');
      if (!userId || !userId.trim()) return;
      const trimmed = userId.trim();
      if (!notifConfig.users) notifConfig.users = {};
      if (notifConfig.users[trimmed]) {
        showToast('User already exists');
        return;
      }
      notifConfig.users[trimmed] = {
        started: true, review_done: true, qa_done: true, completed: true, failed: true
      };
      saveNotificationConfig();
    };
  }
}

// --- Pipeline Stats Widget (Overview) ---

async function loadPipelineStats() {
  const panel = $('#pipeline-stats-panel');
  if (!panel) return;

  try {
    const stats = await fetch('/api/pipeline/stats').then(r => r.json());
    renderPipelineStats(panel, stats);
  } catch {
    panel.textContent = 'Failed to load stats';
  }
}

function renderPipelineStats(panel, stats) {
  panel.textContent = '';

  const widget = document.createElement('div');
  widget.className = 'pl-stats-widget';

  // Donut chart via SVG (CSS-only, no chart library)
  const donutWrap = document.createElement('div');
  donutWrap.className = 'pl-stats-donut-wrap';

  const donut = document.createElement('div');
  donut.className = 'pl-stats-donut';

  const pct = stats.successRate || 0;
  const circumference = 2 * Math.PI * 40;
  const filled = (pct / 100) * circumference;
  const remaining = circumference - filled;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  const bgCircle = document.createElementNS(svgNS, 'circle');
  bgCircle.setAttribute('cx', '50'); bgCircle.setAttribute('cy', '50'); bgCircle.setAttribute('r', '40');
  bgCircle.setAttribute('fill', 'none'); bgCircle.setAttribute('stroke', 'var(--border)'); bgCircle.setAttribute('stroke-width', '8');
  const fgCircle = document.createElementNS(svgNS, 'circle');
  fgCircle.setAttribute('cx', '50'); fgCircle.setAttribute('cy', '50'); fgCircle.setAttribute('r', '40');
  fgCircle.setAttribute('fill', 'none');
  fgCircle.setAttribute('stroke', pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--orange)' : 'var(--red)');
  fgCircle.setAttribute('stroke-width', '8');
  fgCircle.setAttribute('stroke-dasharray', filled + ' ' + remaining);
  fgCircle.setAttribute('stroke-linecap', 'round');
  svg.append(bgCircle, fgCircle);
  donut.appendChild(svg);

  const donutLabel = document.createElement('div');
  donutLabel.className = 'pl-stats-donut-label';
  donutLabel.textContent = pct + '%';
  donut.appendChild(donutLabel);

  const sub = document.createElement('div');
  sub.className = 'pl-stats-donut-sub';
  sub.textContent = 'Success Rate';

  donutWrap.append(donut, sub);

  // Right side: metrics + recent runs
  const right = document.createElement('div');
  right.className = 'pl-stats-right';

  const metricsDiv = document.createElement('div');
  metricsDiv.className = 'pl-stats-metrics';

  const metricData = [
    ['Cost (7d)', '$' + (stats.totalCostWeek || 0).toFixed(2)],
    ['Avg Duration', fmtDuration(stats.avgDurationSecs)],
    ['Completed', String(stats.completed || 0)],
    ['Failed', String(stats.failed || 0)]
  ];

  metricData.forEach(([lbl, val]) => {
    const m = document.createElement('div');
    m.className = 'pl-stats-metric';
    const lblDiv = document.createElement('div');
    lblDiv.className = 'label';
    lblDiv.textContent = lbl;
    const valDiv = document.createElement('div');
    valDiv.className = 'value';
    valDiv.textContent = val;
    m.append(lblDiv, valDiv);
    metricsDiv.appendChild(m);
  });

  // Recent runs
  const recent = document.createElement('div');
  recent.className = 'pl-stats-recent';
  const titleDiv = document.createElement('div');
  titleDiv.className = 'pl-stats-recent-title';
  titleDiv.textContent = 'Last 5 Runs';
  recent.appendChild(titleDiv);

  (stats.recentRuns || []).forEach(r => {
    const row = document.createElement('div');
    row.className = 'pl-stats-run-row';

    const task = document.createElement('span');
    task.className = 'pl-stats-run-task';
    task.textContent = r.taskId || r.id.slice(0, 6);

    const repo = document.createElement('span');
    repo.className = 'pl-stats-run-repo';
    repo.textContent = r.repo;

    const badge = document.createElement('span');
    badge.className = 'pl-status-badge ' + (PL_STATUS_CLASS[r.status] || '');
    badge.textContent = r.status;

    row.append(task, repo, badge);
    recent.appendChild(row);
  });

  right.append(metricsDiv, recent);
  widget.append(donutWrap, right);
  panel.appendChild(widget);
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

  // Auto-archive deployed cards older than 30 days on load
  await autoArchiveDeployed();

  // Load all data (including pipeline stats on overview)
  await Promise.all([loadSystem(), loadUsage(), loadCron(), loadTasks(), loadPipelineStats(), loadKnownRepos()]);

  // Init Claude Code terminal
  initClaudeTerminal();

  // Auto-refresh system stats every 5s, usage every 60s, tasks every 10s, pipeline stats every 30s
  setInterval(loadSystem, 5000);
  setInterval(loadUsage, 60000);
  setInterval(loadTasks, 10000);
  setInterval(loadPipelineStats, 30000);
}

init();
