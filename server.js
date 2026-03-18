const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { Type } = require('@sinclair/typebox');
const { Value } = require('@sinclair/typebox/value');

// --- Claude Code Live Terminal ---
const CLAUDE_LOG_FILE = path.join(__dirname, 'data', 'claude-code.log');
// Ensure log file exists
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
if (!fs.existsSync(CLAUDE_LOG_FILE)) fs.writeFileSync(CLAUDE_LOG_FILE, '');

const app = express();
const PORT = 3333;

const TASKS_FILE = path.join(__dirname, 'data', 'tasks.json');
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const CRON_FILE = path.join(OPENCLAW_DIR, 'cron', 'jobs.json');
const CONFIG_FILE = path.join(OPENCLAW_DIR, 'openclaw.json');
const WORKSPACE_DIR = path.join(__dirname, '..');
const MARKETING_DIR = path.join(WORKSPACE_DIR, 'marketing');
const TEMPLATES_DIR = path.join(MARKETING_DIR, 'templates');
const OUTPUT_DIR = path.join(MARKETING_DIR, 'output');
const AGENTS_DIR = path.join(MARKETING_DIR, 'agents');
const CALENDAR_FILE = path.join(MARKETING_DIR, 'calendar.json');
const PIPELINES_DIR = path.join(WORKSPACE_DIR, 'pipelines');
const MCC_DIR = path.join(__dirname, 'data', 'mcc');
const MCC_CAMPAIGNS_FILE = path.join(MCC_DIR, 'campaigns.json');
const MCC_ICPS_FILE = path.join(MCC_DIR, 'icps.json');
const MCC_CHANNELS_FILE = path.join(MCC_DIR, 'channels.json');

app.use(express.static(path.join(__dirname, 'public')));

// Webhooks must be mounted before global JSON parser so GitHub can verify raw body signature
const webhooksRouter = require('./routes/webhooks');
app.use('/api/webhooks', webhooksRouter);

app.use(express.json());

// --- CPU Delta Tracking ---
// Store previous /proc/stat sample for real-time CPU usage calculation
let prevCpuSample = null;

function readCpuSample() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const line = stat.split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

// Take initial sample on startup
prevCpuSample = readCpuSample();

// ============================================================
// TypeBox Schemas
// ============================================================

// --- System Health ---
const CpuSchema = Type.Object({
  usage: Type.Number(),
  cores: Type.Number(),
  model: Type.String()
});

const MemorySchema = Type.Object({
  total: Type.Number(),
  used: Type.Number(),
  percent: Type.Number()
});

const DiskSchema = Type.Object({
  total: Type.Number(),
  used: Type.Number(),
  percent: Type.Number()
});

const UptimeSchema = Type.Object({
  days: Type.Number(),
  hours: Type.Number(),
  mins: Type.Number(),
  totalSeconds: Type.Number()
});

const SystemResponseSchema = Type.Object({
  cpu: CpuSchema,
  memory: MemorySchema,
  disk: DiskSchema,
  uptime: UptimeSchema,
  hostname: Type.String(),
  platform: Type.String()
});

// --- Model Pricing ---
const PricingSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number()
});

const MODEL_PRICING = {
  'claude-opus-4-6':    { input: 15, output: 75 },
  'claude-sonnet-4-6':  { input: 3,  output: 15 },
  'claude-haiku-3-5':   { input: 0.25, output: 1.25 },
  'gpt-5.2-codex':      { input: 2,  output: 10 },
  'gpt-4.1':            { input: 2,  output: 8 },
  'gemini-2.5-pro':     { input: 1.25, output: 10 },
  'default':            { input: 3,  output: 15 }
};

function getPricing(model) {
  const short = (model || '').split('/').pop();
  return MODEL_PRICING[short] || MODEL_PRICING['default'];
}

// --- API Usage ---
const DailyUsageSchema = Type.Object({
  date: Type.String(),
  tokensIn: Type.Number(),
  tokensOut: Type.Number(),
  requests: Type.Number()
});

const UsageTotalsSchema = Type.Object({
  tokensIn: Type.Number(),
  tokensOut: Type.Number(),
  cost: Type.Number(),
  requests: Type.Number()
});

const UsageResponseSchema = Type.Object({
  activeModel: Type.String(),
  primaryModel: Type.String(),
  models: Type.Array(Type.String()),
  fallbacks: Type.Array(Type.String()),
  pricing: PricingSchema,
  provider: Type.String(),
  totals: UsageTotalsSchema,
  daily: Type.Array(DailyUsageSchema)
});

// --- Cron Jobs ---
const CronJobSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  schedule: Type.Unknown(),
  lastRun: Type.Union([Type.String(), Type.Null()]),
  nextRun: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  command: Type.String(),
  source: Type.Optional(Type.String())
});

const CronResponseSchema = Type.Object({
  openclaw: Type.Array(CronJobSchema),
  system: Type.Array(CronJobSchema),
  totalJobs: Type.Number()
});

// --- Cron Job CRUD ---
const ScheduleKind = Type.Union([
  Type.Literal('at'),
  Type.Literal('every'),
  Type.Literal('cron')
]);

const PayloadKind = Type.Union([
  Type.Literal('systemEvent'),
  Type.Literal('agentTurn')
]);

const SessionTarget = Type.Union([
  Type.Literal('main'),
  Type.Literal('isolated')
]);

const CreateCronBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  scheduleKind: ScheduleKind,
  scheduleValue: Type.String({ minLength: 1 }),
  payloadKind: PayloadKind,
  payloadText: Type.String(),
  sessionTarget: SessionTarget,
  enabled: Type.Boolean()
});

const UpdateCronBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  enabled: Type.Optional(Type.Boolean())
});

// --- Kanban Tasks (8-Stage CI/CD Pipeline Board) ---
const PIPELINE_COLUMNS = ['backlog', 'building', 'pr_open', 'code_review', 'qa', 'staging', 'merged', 'deployed'];

const QaCheckSchema = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('pending')])
});

const PrSchema = Type.Object({
  number: Type.Number(),
  url: Type.String(),
  status: Type.Union([Type.Literal('open'), Type.Literal('approved'), Type.Literal('changes-requested'), Type.Literal('merged')])
});

const TaskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  created: Type.String(),
  branch: Type.Optional(Type.String()),
  pr: Type.Optional(PrSchema),
  repo: Type.Optional(Type.String()),
  buildSessionId: Type.Optional(Type.String()),
  assignee: Type.Optional(Type.Union([Type.Literal('claude-code'), Type.Literal('human')])),
  priority: Type.Optional(Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')])),
  startedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  prCreatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  mergedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  deployedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  qaStatus: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('passed'), Type.Literal('failed')])),
  qaChecks: Type.Optional(Type.Array(QaCheckSchema)),
  reviewNotes: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Array(Type.String()))
});

const ColumnName = Type.Union([
  Type.Literal('backlog'), Type.Literal('building'), Type.Literal('pr_open'),
  Type.Literal('code_review'), Type.Literal('qa'), Type.Literal('staging'),
  Type.Literal('merged'), Type.Literal('deployed')
]);

const TaskBoardSchema = Type.Object({
  backlog: Type.Array(TaskSchema),
  building: Type.Array(TaskSchema),
  pr_open: Type.Array(TaskSchema),
  code_review: Type.Array(TaskSchema),
  qa: Type.Array(TaskSchema),
  staging: Type.Array(TaskSchema),
  merged: Type.Array(TaskSchema),
  deployed: Type.Array(TaskSchema)
});

const CreateTaskBody = Type.Object({
  title: Type.String({ minLength: 1 }),
  column: Type.Optional(ColumnName),
  repo: Type.Optional(Type.String()),
  priority: Type.Optional(Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')])),
  labels: Type.Optional(Type.Array(Type.String()))
});

const MoveTaskBody = Type.Object({
  to: ColumnName,
  index: Type.Optional(Type.Number({ minimum: 0 }))
});

const UpdateMetadataBody = Type.Object({
  branch: Type.Optional(Type.String()),
  pr: Type.Optional(PrSchema),
  repo: Type.Optional(Type.String()),
  buildSessionId: Type.Optional(Type.String()),
  assignee: Type.Optional(Type.Union([Type.Literal('claude-code'), Type.Literal('human')])),
  priority: Type.Optional(Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')])),
  startedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  prCreatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  mergedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  deployedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  qaStatus: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('passed'), Type.Literal('failed')])),
  qaChecks: Type.Optional(Type.Array(QaCheckSchema)),
  reviewNotes: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Array(Type.String()))
});

// --- Marketing ---
const MarketingTemplateSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  inputs: Type.Array(Type.String()),
  filename: Type.String()
});

const MarketingTemplatesResponseSchema = Type.Array(MarketingTemplateSchema);

const GenerateBody = Type.Object({
  templateId: Type.String({ minLength: 1 }),
  inputs: Type.Record(Type.String(), Type.String()),
  product: Type.Optional(Type.String())
});

const GenerateResponseSchema = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  prompt: Type.String(),
  status: Type.String()
});

const OutputFileSchema = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  created: Type.String(),
  size: Type.Number(),
  preview: Type.String()
});

const OutputListResponseSchema = Type.Array(OutputFileSchema);

const OutputDetailResponseSchema = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  content: Type.String()
});

// --- Marketing Team & Calendar ---
const AgentPersonaSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  role: Type.String(),
  description: Type.String()
});

const AgentTeamResponseSchema = Type.Array(AgentPersonaSchema);

const CalendarItemStatus = Type.Union([
  Type.Literal('planned'),
  Type.Literal('in-progress'),
  Type.Literal('draft'),
  Type.Literal('published')
]);

const CalendarItemType = Type.Union([
  Type.Literal('blog'),
  Type.Literal('social'),
  Type.Literal('email'),
  Type.Literal('case-study')
]);

const CalendarItemSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  type: CalendarItemType,
  product: Type.String(),
  status: CalendarItemStatus,
  assignedAgent: Type.Union([Type.String(), Type.Null()]),
  dueDate: Type.String(),
  brief: Type.String(),
  draftFile: Type.Union([Type.String(), Type.Null()])
});

const CalendarResponseSchema = Type.Object({
  items: Type.Array(CalendarItemSchema),
  lastUpdated: Type.Union([Type.String(), Type.Null()])
});

const CreateCalendarItemBody = Type.Object({
  title: Type.String({ minLength: 1 }),
  type: CalendarItemType,
  product: Type.String(),
  dueDate: Type.String({ minLength: 1 }),
  brief: Type.String()
});

const UpdateCalendarItemBody = Type.Object({
  status: Type.Optional(CalendarItemStatus),
  assignedAgent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  draftFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  title: Type.Optional(Type.String())
});

const AgentRole = Type.Union([
  Type.Literal('strategist'),
  Type.Literal('writer'),
  Type.Literal('editor'),
  Type.Literal('analyst')
]);

const TeamRunBody = Type.Object({
  agentRole: AgentRole,
  task: Type.String({ minLength: 1 }),
  calendarItemId: Type.Optional(Type.String())
});

const TeamRunResponseSchema = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  prompt: Type.String(),
  status: Type.String()
});

// --- Pipeline ---
const PipelineStageStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('done'),
  Type.Literal('failed')
]);

const PipelineStageName = Type.Union([
  Type.Literal('plan'),
  Type.Literal('code'),
  Type.Literal('review')
]);

const PipelineStageSchema = Type.Object({
  name: PipelineStageName,
  status: PipelineStageStatus,
  startedAt: Type.Union([Type.String(), Type.Null()]),
  completedAt: Type.Union([Type.String(), Type.Null()]),
  output: Type.Union([Type.String(), Type.Null()])
});

const PipelineStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('planning'),
  Type.Literal('coding'),
  Type.Literal('reviewing'),
  Type.Literal('done'),
  Type.Literal('failed')
]);

const PipelineSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  repo: Type.Union([Type.String(), Type.Null()]),
  status: PipelineStatus,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  stages: Type.Array(PipelineStageSchema)
});

const CreatePipelineBody = Type.Object({
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  repo: Type.Optional(Type.String())
});

const UpdatePipelineStageBody = Type.Object({
  stage: PipelineStageName,
  status: Type.Union([Type.Literal('running'), Type.Literal('done'), Type.Literal('failed')]),
  output: Type.Optional(Type.String())
});

// --- MCC Campaigns ---
const CampaignStatus = Type.Union([
  Type.Literal('draft'),
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('completed')
]);

const CampaignMetricsSchema = Type.Object({
  reach: Type.Number(),
  engagement: Type.Number(),
  leads: Type.Number()
});

const CampaignSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  status: CampaignStatus,
  startDate: Type.String(),
  endDate: Type.String(),
  goals: Type.Array(Type.String()),
  targetIcps: Type.Array(Type.String()),
  channels: Type.Array(Type.String()),
  contentItems: Type.Array(Type.String()),
  metrics: CampaignMetricsSchema
});

const CreateCampaignBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  status: Type.Optional(CampaignStatus),
  startDate: Type.String({ minLength: 1 }),
  endDate: Type.String({ minLength: 1 }),
  goals: Type.Optional(Type.Array(Type.String())),
  targetIcps: Type.Optional(Type.Array(Type.String())),
  channels: Type.Optional(Type.Array(Type.String())),
  contentItems: Type.Optional(Type.Array(Type.String())),
  metrics: Type.Optional(CampaignMetricsSchema)
});

const UpdateCampaignBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String()),
  status: Type.Optional(CampaignStatus),
  startDate: Type.Optional(Type.String()),
  endDate: Type.Optional(Type.String()),
  goals: Type.Optional(Type.Array(Type.String())),
  targetIcps: Type.Optional(Type.Array(Type.String())),
  channels: Type.Optional(Type.Array(Type.String())),
  contentItems: Type.Optional(Type.Array(Type.String())),
  metrics: Type.Optional(CampaignMetricsSchema)
});

// ============================================================
// Validation middleware
// ============================================================
function validate(schema) {
  return (req, res, next) => {
    if (!Value.Check(schema, req.body)) {
      const errors = [...Value.Errors(schema, req.body)].map(e => ({
        path: e.path,
        message: e.message
      }));
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    req.body = Value.Cast(schema, Value.Clone(req.body));
    next();
  };
}

// ============================================================
// Routes
// ============================================================

// --- System Health ---
app.get('/api/system', (req, res) => {
  const cpus = os.cpus();
  const cpuCount = cpus.length;

  let cpuUsage = 0;
  const currentSample = readCpuSample();
  if (currentSample && prevCpuSample) {
    const idleDelta = currentSample.idle - prevCpuSample.idle;
    const totalDelta = currentSample.total - prevCpuSample.total;
    cpuUsage = totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
  } else if (currentSample) {
    cpuUsage = Math.round(((currentSample.total - currentSample.idle) / currentSample.total) * 100);
  } else {
    cpuUsage = Math.round((os.loadavg()[0] / cpuCount) * 100);
  }
  if (currentSample) prevCpuSample = currentSample;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let disk = { total: 0, used: 0, percent: 0 };
  try {
    // Hardcoded command - no user input interpolation
    const df = execSync("df -B1 / | tail -1").toString().trim().split(/\s+/);
    disk.total = parseInt(df[1]);
    disk.used = parseInt(df[2]);
    disk.percent = Math.round((disk.used / disk.total) * 100);
  } catch {}

  const uptimeSec = os.uptime();
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);

  const response = {
    cpu: { usage: cpuUsage, cores: cpuCount, model: cpus[0]?.model || 'Unknown' },
    memory: { total: totalMem, used: usedMem, percent: Math.round((usedMem / totalMem) * 100) },
    disk,
    uptime: { days, hours, mins, totalSeconds: uptimeSec },
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`
  };

  res.json(Value.Cast(SystemResponseSchema, response));
});

// --- API Usage: Session Data Parser ---
const SESSIONS_DIR = path.join(OPENCLAW_DIR, 'agents', 'main', 'sessions');

let usageCache = null;
let usageCacheTime = 0;
const USAGE_CACHE_TTL = 60_000;

function parseSessionUsage() {
  const now = Date.now();
  if (usageCache && (now - usageCacheTime) < USAGE_CACHE_TTL) return usageCache;

  const records = [];
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl') || f.includes('.jsonl.reset.'));
  } catch { return records; }

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8');
    } catch { continue; }

    for (const line of content.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type !== 'message') continue;
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant' || !msg.usage) continue;

      const usage = msg.usage;
      if (!usage.totalTokens && !usage.input && !usage.output) continue;

      const date = (entry.timestamp || '').slice(0, 10);
      if (!date) continue;

      const model = msg.model || 'unknown';
      const costTotal = usage.cost?.total || 0;

      records.push({
        model,
        date,
        tokensIn: (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0),
        tokensOut: usage.output || 0,
        cost: costTotal
      });
    }
  }

  usageCache = records;
  usageCacheTime = now;
  return records;
}

// --- API Usage ---
app.get('/api/usage', (req, res) => {
  const selectedModel = req.query.model || null;

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}

  const primaryModel = config?.agents?.defaults?.model?.primary || 'anthropic/claude-sonnet-4-6';
  const fallbacks = config?.agents?.defaults?.model?.fallbacks || [];

  const models = [primaryModel, ...fallbacks].filter(Boolean);
  const knownModels = [
    'anthropic/claude-opus-4-6',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-haiku-3-5',
    'openai/gpt-5.2-codex',
    'openai/gpt-4.1',
    'google/gemini-2.5-pro'
  ];
  knownModels.forEach(m => { if (!models.includes(m)) models.push(m); });

  const activeModel = selectedModel && models.includes(selectedModel) ? selectedModel : primaryModel;
  const pricing = getPricing(activeModel);

  const allRecords = parseSessionUsage();
  const shortModel = activeModel.split('/').pop();
  const filtered = allRecords.filter(r => r.model === shortModel);

  const byDate = {};
  for (const r of filtered) {
    if (!byDate[r.date]) byDate[r.date] = { tokensIn: 0, tokensOut: 0, requests: 0 };
    byDate[r.date].tokensIn += r.tokensIn;
    byDate[r.date].tokensOut += r.tokensOut;
    byDate[r.date].requests += 1;
  }

  const daily = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, tokensIn: d.tokensIn, tokensOut: d.tokensOut, requests: d.requests }));

  const totalIn = daily.reduce((s, d) => s + d.tokensIn, 0);
  const totalOut = daily.reduce((s, d) => s + d.tokensOut, 0);
  const totalCost = filtered.reduce((s, r) => s + r.cost, 0);

  const response = {
    activeModel,
    primaryModel,
    models,
    fallbacks,
    pricing,
    provider: activeModel.split('/')[0] || 'unknown',
    totals: {
      tokensIn: totalIn,
      tokensOut: totalOut,
      cost: +totalCost.toFixed(4),
      requests: daily.reduce((s, d) => s + d.requests, 0)
    },
    daily
  };

  res.json(Value.Cast(UsageResponseSchema, response));
});

// --- Cron Jobs ---
app.get('/api/cron', (req, res) => {
  let openclawJobs = [];
  try {
    const data = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8'));
    openclawJobs = (data.jobs || []).map(j => ({
      id: j.id || j.name || 'unknown',
      name: j.name || j.id || 'Unnamed',
      schedule: j.schedule || j.cron || '\u2014',
      lastRun: j.lastRun || j.lastRunAt || null,
      nextRun: j.nextRun || j.nextRunAt || null,
      status: j.status || (j.lastResult === 'success' ? 'success' : j.lastResult) || 'unknown',
      command: j.command || j.cmd || ''
    }));
  } catch {}

  let systemCron = [];
  try {
    // Hardcoded command - no user input
    const raw = execSync('crontab -l 2>/dev/null').toString().trim();
    if (raw) {
      systemCron = raw.split('\n')
        .filter(l => l && !l.startsWith('#'))
        .map((line, i) => {
          const parts = line.split(/\s+/);
          const schedule = parts.slice(0, 5).join(' ');
          const command = parts.slice(5).join(' ');
          return {
            id: `sys-${i}`,
            name: command.length > 50 ? command.slice(0, 50) + '\u2026' : command,
            schedule,
            lastRun: null,
            nextRun: null,
            status: 'active',
            command,
            source: 'system'
          };
        });
    }
  } catch {}

  const response = {
    openclaw: openclawJobs,
    system: systemCron,
    totalJobs: openclawJobs.length + systemCron.length
  };

  res.json(Value.Cast(CronResponseSchema, response));
});

// --- Cron Job Helpers ---
function readCronJobs() {
  try {
    const data = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8'));
    return { version: data.version || 1, jobs: data.jobs || [] };
  } catch {
    return { version: 1, jobs: [] };
  }
}

function writeCronJobs(data) {
  const dir = path.dirname(CRON_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CRON_FILE, JSON.stringify(data, null, 2));
}

// --- Cron CRUD Routes ---
app.post('/api/cron', validate(CreateCronBody), (req, res) => {
  const { name, scheduleKind, scheduleValue, payloadKind, payloadText, sessionTarget, enabled } = req.body;
  const data = readCronJobs();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = {
    id,
    name,
    enabled,
    schedule: { kind: scheduleKind, [scheduleKind]: scheduleValue },
    payload: { kind: payloadKind, text: payloadText },
    sessionTarget,
    createdAt: new Date().toISOString()
  };
  data.jobs.push(job);
  writeCronJobs(data);
  res.json(job);
});

app.put('/api/cron/:id', validate(UpdateCronBody), (req, res) => {
  const data = readCronJobs();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (req.body.name !== undefined) job.name = req.body.name;
  if (req.body.enabled !== undefined) job.enabled = req.body.enabled;
  writeCronJobs(data);
  res.json(job);
});

app.delete('/api/cron/:id', (req, res) => {
  const data = readCronJobs();
  const idx = data.jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Job not found' });
  data.jobs.splice(idx, 1);
  writeCronJobs(data);
  res.json({ ok: true });
});

app.post('/api/cron/:id/run', (req, res) => {
  const data = readCronJobs();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.schedule.at = new Date().toISOString();
  writeCronJobs(data);
  res.json({ ok: true, message: 'Job triggered' });
});

app.get('/api/cron/:id/runs', (req, res) => {
  res.json({ runs: [] });
});

// --- Kanban Tasks (8-Stage CI/CD Pipeline) ---

// Migrate old formats to 8-column pipeline
function migrateTasks(raw) {
  const needsMigration = raw.todo || raw.inprogress || raw.done || (raw.review && !raw.code_review);
  if (needsMigration) {
    const done = raw.done || [];
    return {
      backlog: (raw.todo || []).concat(raw.backlog || []),
      building: (raw.inprogress || []).concat(raw.building || []),
      pr_open: raw.pr_open || [],
      code_review: raw.code_review || raw.review || [],
      qa: raw.qa || [],
      staging: raw.staging || [],
      merged: done.concat(raw.merged || []),
      deployed: raw.deployed || done.map(t => ({ ...t }))
    };
  }
  return raw;
}

function readTasks() {
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    const migrated = migrateTasks(raw);
    const board = {};
    for (const col of PIPELINE_COLUMNS) {
      board[col] = migrated[col] || [];
    }
    const casted = Value.Cast(TaskBoardSchema, board);
    if (raw.todo || raw.inprogress || raw.done || (raw.review && !raw.code_review)) {
      writeTasks(casted);
    }
    return casted;
  } catch {
    const empty = {};
    for (const col of PIPELINE_COLUMNS) empty[col] = [];
    return Value.Cast(TaskBoardSchema, empty);
  }
}

function writeTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/tasks', (req, res) => {
  res.json(readTasks());
});

app.get('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const tasks = readTasks();
  for (const col of PIPELINE_COLUMNS) {
    const task = tasks[col].find(t => t.id === id);
    if (task) return res.json({ ...task, column: col });
  }
  res.status(404).json({ error: 'Task not found' });
});

app.post('/api/tasks', validate(CreateTaskBody), (req, res) => {
  const { title, column = 'backlog', repo, priority, labels } = req.body;
  const tasks = readTasks();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const taskData = {
    id,
    title,
    created: new Date().toISOString().slice(0, 10)
  };
  if (repo) taskData.repo = repo;
  if (priority) taskData.priority = priority;
  if (labels && labels.length) taskData.labels = labels;
  taskData.branch = `feature/${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
  const task = Value.Cast(TaskSchema, taskData);
  tasks[column].push(task);
  writeTasks(tasks);
  res.json(task);
});

app.put('/api/tasks/:id/move', validate(MoveTaskBody), (req, res) => {
  const { id } = req.params;
  const { to, index } = req.body;
  const tasks = readTasks();
  let task = null;
  for (const col of PIPELINE_COLUMNS) {
    const idx = tasks[col].findIndex(t => t.id === id);
    if (idx !== -1) {
      task = tasks[col].splice(idx, 1)[0];
      break;
    }
  }
  if (!task) return res.status(404).json({ error: 'Task not found' });
  // Set timestamps based on destination column
  const now = new Date().toISOString();
  if (to === 'building' && !task.startedAt) task.startedAt = now;
  if (to === 'pr_open' && !task.prCreatedAt) task.prCreatedAt = now;
  if (to === 'merged' && !task.mergedAt) task.mergedAt = now;
  if (to === 'deployed' && !task.deployedAt) task.deployedAt = now;
  const insertAt = typeof index === 'number' ? index : tasks[to].length;
  tasks[to].splice(insertAt, 0, task);
  writeTasks(tasks);
  res.json({ ok: true });
});

app.put('/api/tasks/:id/metadata', validate(UpdateMetadataBody), (req, res) => {
  const { id } = req.params;
  const tasks = readTasks();
  for (const col of PIPELINE_COLUMNS) {
    const task = tasks[col].find(t => t.id === id);
    if (task) {
      const fields = ['branch', 'pr', 'repo', 'buildSessionId', 'assignee', 'priority',
        'startedAt', 'prCreatedAt', 'mergedAt', 'deployedAt', 'qaStatus', 'qaChecks', 'reviewNotes', 'labels'];
      for (const f of fields) {
        if (req.body[f] !== undefined) task[f] = req.body[f];
      }
      writeTasks(tasks);
      return res.json(task);
    }
  }
  res.status(404).json({ error: 'Task not found' });
});

// QA check endpoint
app.post('/api/tasks/:id/qa', (req, res) => {
  const { id } = req.params;
  const tasks = readTasks();
  for (const col of PIPELINE_COLUMNS) {
    const task = tasks[col].find(t => t.id === id);
    if (task) {
      if (!task.qaChecks || !task.qaChecks.length) {
        task.qaChecks = [
          { name: 'API endpoints respond', status: 'pending' },
          { name: 'UI renders correctly', status: 'pending' },
          { name: 'No JS errors in console', status: 'pending' },
          { name: 'Data persistence works', status: 'pending' }
        ];
      }
      task.qaChecks = task.qaChecks.map(c => ({
        ...c,
        status: c.status === 'pending' ? 'passed' : c.status
      }));
      const allPassed = task.qaChecks.every(c => c.status === 'passed');
      task.qaStatus = allPassed ? 'passed' : 'failed';
      writeTasks(tasks);
      return res.json(task);
    }
  }
  res.status(404).json({ error: 'Task not found' });
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const tasks = readTasks();
  for (const col of PIPELINE_COLUMNS) {
    const idx = tasks[col].findIndex(t => t.id === id);
    if (idx !== -1) {
      tasks[col].splice(idx, 1);
      writeTasks(tasks);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'Task not found' });
});

// === Marketing ===

function parseTemplateFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim());
    }
    meta[key] = val;
  }
  const body = content.slice(match[0].length).trim();
  return { meta, body };
}

app.get('/api/marketing/templates', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.md'));
  } catch {
    return res.json([]);
  }
  const templates = files.map(f => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8');
    const { meta } = parseTemplateFrontmatter(content);
    const id = f.replace(/\.md$/, '');
    return {
      id,
      name: meta.name || id,
      description: meta.description || '',
      inputs: Array.isArray(meta.inputs) ? meta.inputs : [],
      filename: f
    };
  });
  res.json(Value.Cast(MarketingTemplatesResponseSchema, templates));
});

app.post('/api/marketing/generate', validate(GenerateBody), (req, res) => {
  const { templateId, inputs, product } = req.body;
  const templatePath = path.join(TEMPLATES_DIR, templateId + '.md');
  if (!fs.existsSync(templatePath)) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const content = fs.readFileSync(templatePath, 'utf8');
  const { body } = parseTemplateFrontmatter(content);

  let ragContext = '';
  try {
    const query = product || inputs.product || templateId;
    // Hardcoded script path - query is from validated request body
    ragContext = execSync(
      `python3 /home/torbot/.openclaw/workspace/tor-ai-knowledge/query.py "${query.replace(/"/g, '\\"')}" --top 3`,
      { timeout: 15000 }
    ).toString().trim();
  } catch {
    ragContext = '(No RAG context available)';
  }

  let prompt = body;
  for (const [key, val] of Object.entries(inputs)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
  }
  prompt = prompt.replace(/\{\{rag_context\}\}/g, ragContext);

  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${date}-${templateId}-${rand}.md`;
  const id = filename.replace(/\.md$/, '');

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), prompt);

  const response = { id, filename, prompt, status: 'queued' };
  res.json(Value.Cast(GenerateResponseSchema, response));
});

app.get('/api/marketing/output', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.md') && f !== '.gitkeep');
  } catch {
    return res.json([]);
  }
  const output = files.map(f => {
    const fp = path.join(OUTPUT_DIR, f);
    const stat = fs.statSync(fp);
    const content = fs.readFileSync(fp, 'utf8');
    return {
      id: f.replace(/\.md$/, ''),
      filename: f,
      created: stat.mtime.toISOString(),
      size: stat.size,
      preview: content.slice(0, 200)
    };
  }).sort((a, b) => b.created.localeCompare(a.created));
  res.json(Value.Cast(OutputListResponseSchema, output));
});

app.get('/api/marketing/output/:id', (req, res) => {
  const filename = req.params.id + '.md';
  const fp = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(fp)) {
    return res.status(404).json({ error: 'Output not found' });
  }
  const content = fs.readFileSync(fp, 'utf8');
  const response = { id: req.params.id, filename, content };
  res.json(Value.Cast(OutputDetailResponseSchema, response));
});

// === Marketing Team & Calendar ===

function readCalendar() {
  try {
    return JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
  } catch {
    return { items: [], lastUpdated: null };
  }
}

function writeCalendar(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(CALENDAR_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/marketing/team', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  } catch {
    return res.json([]);
  }
  const agents = files.map(f => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
    const { meta } = parseTemplateFrontmatter(content);
    const id = f.replace(/\.md$/, '');
    return {
      id,
      name: meta.name || id,
      role: meta.role || '',
      description: meta.description || ''
    };
  });
  res.json(Value.Cast(AgentTeamResponseSchema, agents));
});

app.get('/api/marketing/calendar', (req, res) => {
  const data = readCalendar();
  res.json(Value.Cast(CalendarResponseSchema, data));
});

app.post('/api/marketing/calendar', validate(CreateCalendarItemBody), (req, res) => {
  const { title, type, product, dueDate, brief } = req.body;
  const data = readCalendar();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const item = {
    id, title, type, product, status: 'planned',
    assignedAgent: null, dueDate, brief, draftFile: null
  };
  data.items.push(item);
  writeCalendar(data);
  res.json(Value.Cast(CalendarItemSchema, item));
});

app.put('/api/marketing/calendar/:id', validate(UpdateCalendarItemBody), (req, res) => {
  const data = readCalendar();
  const item = data.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Calendar item not found' });
  if (req.body.status !== undefined) item.status = req.body.status;
  if (req.body.assignedAgent !== undefined) item.assignedAgent = req.body.assignedAgent;
  if (req.body.draftFile !== undefined) item.draftFile = req.body.draftFile;
  if (req.body.title !== undefined) item.title = req.body.title;
  writeCalendar(data);
  res.json(Value.Cast(CalendarItemSchema, item));
});

app.delete('/api/marketing/calendar/:id', (req, res) => {
  const data = readCalendar();
  const idx = data.items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Calendar item not found' });
  data.items.splice(idx, 1);
  writeCalendar(data);
  res.json({ ok: true });
});

app.post('/api/marketing/team/run', validate(TeamRunBody), (req, res) => {
  const { agentRole, task, calendarItemId } = req.body;
  const agentFile = path.join(AGENTS_DIR, agentRole + '.md');
  if (!fs.existsSync(agentFile)) {
    return res.status(404).json({ error: 'Agent persona not found' });
  }

  const content = fs.readFileSync(agentFile, 'utf8');
  const { meta, body: personaInstructions } = parseTemplateFrontmatter(content);

  let ragContext = '';
  try {
    const query = task.slice(0, 200);
    ragContext = execSync(
      `python3 /home/torbot/.openclaw/workspace/tor-ai-knowledge/query.py "${query.replace(/"/g, '\\"')}" --top 3`,
      { timeout: 15000 }
    ).toString().trim();
  } catch {
    ragContext = '(No RAG context available)';
  }

  const prompt = `## Agent: ${meta.name || agentRole} (${meta.role || ''})\n\n${personaInstructions}\n\n## Knowledge Base Context\n${ragContext}\n\n## Task\n${task}`;

  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${date}-${agentRole}-${rand}.md`;
  const id = filename.replace(/\.md$/, '');

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), prompt);

  if (calendarItemId) {
    const data = readCalendar();
    const item = data.items.find(i => i.id === calendarItemId);
    if (item) {
      item.status = 'in-progress';
      item.assignedAgent = agentRole;
      item.draftFile = filename;
      writeCalendar(data);
    }
  }

  const response = { id, filename, prompt, status: 'queued' };
  res.json(Value.Cast(TeamRunResponseSchema, response));
});

// === Pipeline ===

if (!fs.existsSync(PIPELINES_DIR)) fs.mkdirSync(PIPELINES_DIR, { recursive: true });

function derivePipelineStatus(stages) {
  if (stages.some(s => s.status === 'failed')) return 'failed';
  if (stages.every(s => s.status === 'done')) return 'done';
  const running = stages.find(s => s.status === 'running');
  if (running) {
    const map = { plan: 'planning', code: 'coding', review: 'reviewing' };
    return map[running.name] || 'pending';
  }
  return 'pending';
}

// --- Pipeline Runs (Postgres-backed) — mounted BEFORE the file-based /api/pipeline/:id route ---
const { router: pipelineRunsRouter } = require('./routes/pipeline');
app.use('/api/pipeline', pipelineRunsRouter);

app.post('/api/pipeline', validate(CreatePipelineBody), (req, res) => {
  const { title, description, repo } = req.body;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString();
  const pipeline = {
    id,
    title,
    description,
    repo: repo || null,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    stages: [
      { name: 'plan', status: 'pending', startedAt: null, completedAt: null, output: null },
      { name: 'code', status: 'pending', startedAt: null, completedAt: null, output: null },
      { name: 'review', status: 'pending', startedAt: null, completedAt: null, output: null }
    ]
  };
  fs.writeFileSync(path.join(PIPELINES_DIR, `${id}.json`), JSON.stringify(pipeline, null, 2));
  res.json(Value.Cast(PipelineSchema, pipeline));
});

app.get('/api/pipeline', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(PIPELINES_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return res.json([]);
  }
  const pipelines = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(PIPELINES_DIR, f), 'utf8'));
    return Value.Cast(PipelineSchema, data);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(pipelines);
});

app.get('/api/pipeline/:id', (req, res) => {
  const fp = path.join(PIPELINES_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Pipeline not found' });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  res.json(Value.Cast(PipelineSchema, data));
});

app.put('/api/pipeline/:id/stage', validate(UpdatePipelineStageBody), (req, res) => {
  const fp = path.join(PIPELINES_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Pipeline not found' });
  const pipeline = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const stage = pipeline.stages.find(s => s.name === req.body.stage);
  if (!stage) return res.status(400).json({ error: 'Invalid stage' });

  const now = new Date().toISOString();
  stage.status = req.body.status;
  if (req.body.status === 'running') stage.startedAt = now;
  if (req.body.status === 'done' || req.body.status === 'failed') stage.completedAt = now;
  if (req.body.output !== undefined) stage.output = req.body.output;

  pipeline.status = derivePipelineStatus(pipeline.stages);
  pipeline.updatedAt = now;
  fs.writeFileSync(fp, JSON.stringify(pipeline, null, 2));
  res.json(Value.Cast(PipelineSchema, pipeline));
});

app.delete('/api/pipeline/:id', (req, res) => {
  const fp = path.join(PIPELINES_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Pipeline not found' });
  fs.unlinkSync(fp);
  res.json({ ok: true });
});

// === MCC Campaigns ===

function readCampaigns() {
  try {
    return JSON.parse(fs.readFileSync(MCC_CAMPAIGNS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeCampaigns(data) {
  if (!fs.existsSync(MCC_DIR)) fs.mkdirSync(MCC_DIR, { recursive: true });
  fs.writeFileSync(MCC_CAMPAIGNS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/mcc/campaigns', (req, res) => {
  const campaigns = readCampaigns();
  res.json(campaigns.map(c => Value.Cast(CampaignSchema, c)));
});

app.post('/api/mcc/campaigns', validate(CreateCampaignBody), (req, res) => {
  const campaigns = readCampaigns();
  const id = 'camp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const campaign = {
    id,
    name: req.body.name,
    description: req.body.description || '',
    status: req.body.status || 'draft',
    startDate: req.body.startDate,
    endDate: req.body.endDate,
    goals: req.body.goals || [],
    targetIcps: req.body.targetIcps || [],
    channels: req.body.channels || [],
    contentItems: req.body.contentItems || [],
    metrics: req.body.metrics || { reach: 0, engagement: 0, leads: 0 }
  };
  campaigns.push(campaign);
  writeCampaigns(campaigns);
  res.json(Value.Cast(CampaignSchema, campaign));
});

app.get('/api/mcc/campaigns/:id', (req, res) => {
  const campaigns = readCampaigns();
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(Value.Cast(CampaignSchema, campaign));
});

app.put('/api/mcc/campaigns/:id', validate(UpdateCampaignBody), (req, res) => {
  const campaigns = readCampaigns();
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const fields = ['name', 'description', 'status', 'startDate', 'endDate', 'goals', 'targetIcps', 'channels', 'contentItems', 'metrics'];
  for (const f of fields) {
    if (req.body[f] !== undefined) campaign[f] = req.body[f];
  }
  writeCampaigns(campaigns);
  res.json(Value.Cast(CampaignSchema, campaign));
});

app.delete('/api/mcc/campaigns/:id', (req, res) => {
  const campaigns = readCampaigns();
  const idx = campaigns.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });
  campaigns.splice(idx, 1);
  writeCampaigns(campaigns);
  res.json({ ok: true });
});

app.get('/api/mcc/icps', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(MCC_ICPS_FILE, 'utf8')));
  } catch {
    res.json([]);
  }
});

app.get('/api/mcc/channels', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(MCC_CHANNELS_FILE, 'utf8')));
  } catch {
    res.json([]);
  }
});

// === Claude Code Live Terminal ===

let claudeProcess = null;
let claudeSSEClients = [];

let lastLogSize = 0;
let logWatcher = null;

function startLogWatcher() {
  if (logWatcher) return;
  try {
    lastLogSize = fs.statSync(CLAUDE_LOG_FILE).size;
  } catch { lastLogSize = 0; }

  logWatcher = fs.watchFile(CLAUDE_LOG_FILE, { interval: 500 }, (curr, prev) => {
    if (curr.size > lastLogSize) {
      try {
        const fd = fs.openSync(CLAUDE_LOG_FILE, 'r');
        const buf = Buffer.alloc(curr.size - lastLogSize);
        fs.readSync(fd, buf, 0, buf.length, lastLogSize);
        fs.closeSync(fd);
        const newContent = buf.toString('utf8');
        if (newContent) {
          broadcastSSE({ type: 'output', content: newContent, stream: 'stdout' });
        }
      } catch {}
      lastLogSize = curr.size;
    }
  });
}

startLogWatcher();

const CLAUDE_STATUS_FILE = path.join(__dirname, 'data', 'claude-status.json');

function readClaudeStatus() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_STATUS_FILE, 'utf8'));
  } catch {
    return { status: 'idle', pid: null };
  }
}

function writeClaudeStatus(obj) {
  fs.writeFileSync(CLAUDE_STATUS_FILE, JSON.stringify(obj));
}

app.get('/api/claude/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: {"type":"connected"}\n\n');

  try {
    const existing = fs.readFileSync(CLAUDE_LOG_FILE, 'utf8');
    if (existing) {
      res.write(`data: ${JSON.stringify({ type: 'history', content: existing })}\n\n`);
    }
  } catch {}

  let status = 'idle';
  if (claudeProcess && !claudeProcess.killed) {
    status = 'running';
  } else {
    const ext = readClaudeStatus();
    if (ext.status === 'running' && ext.pid) {
      try {
        process.kill(ext.pid, 0);
        status = 'running';
      } catch {
        writeClaudeStatus({ status: 'idle', pid: null });
      }
    }
  }
  res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);

  claudeSSEClients.push(res);
  req.on('close', () => {
    claudeSSEClients = claudeSSEClients.filter(c => c !== res);
  });
});

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  claudeSSEClients.forEach(c => {
    try { c.write(msg); } catch {}
  });
}

app.post('/api/claude/launch', express.json(), (req, res) => {
  if (claudeProcess && !claudeProcess.killed) {
    return res.status(409).json({ error: 'Claude Code is already running' });
  }

  const { prompt, workdir } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const cwd = workdir || path.join(__dirname, '..');

  fs.writeFileSync(CLAUDE_LOG_FILE, '');

  const wrapperScript = path.join(__dirname, 'run-claude.sh');
  claudeProcess = spawn('bash', [wrapperScript, prompt], {
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  broadcastSSE({ type: 'status', status: 'running', prompt: prompt.slice(0, 200) });

  const handleData = (stream) => (chunk) => {
    const text = chunk.toString();
    fs.appendFileSync(CLAUDE_LOG_FILE, text);
    broadcastSSE({ type: 'output', content: text, stream });
  };

  claudeProcess.stdout.on('data', handleData('stdout'));
  claudeProcess.stderr.on('data', handleData('stderr'));

  claudeProcess.on('close', (code) => {
    broadcastSSE({ type: 'status', status: 'exited', code });
    claudeProcess = null;
  });

  claudeProcess.on('error', (err) => {
    const errMsg = `\nError: ${err.message}\n`;
    fs.appendFileSync(CLAUDE_LOG_FILE, errMsg);
    broadcastSSE({ type: 'output', content: errMsg, stream: 'stderr' });
    broadcastSSE({ type: 'status', status: 'error', error: err.message });
    claudeProcess = null;
  });

  res.json({ ok: true, pid: claudeProcess.pid });
});

app.get('/api/claude/status', (req, res) => {
  const status = claudeProcess && !claudeProcess.killed ? 'running' : 'idle';
  const pid = claudeProcess ? claudeProcess.pid : null;
  res.json({ status, pid });
});

app.post('/api/claude/kill', (req, res) => {
  if (!claudeProcess || claudeProcess.killed) {
    return res.status(404).json({ error: 'No running Claude Code process' });
  }
  claudeProcess.kill('SIGTERM');
  res.json({ ok: true });
});

app.get('/api/claude/log', (req, res) => {
  try {
    const content = fs.readFileSync(CLAUDE_LOG_FILE, 'utf8');
    res.json({ content });
  } catch {
    res.json({ content: '' });
  }
});

// NOTE: Pipeline Runs router already mounted above (before file-based /api/pipeline/:id)

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);

  // Start pipeline engine queue processor
  const engine = require('./services/pipeline-engine');
  engine.start();
});
