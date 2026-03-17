// Pipeline runs API — creates queued runs with stage rows in Postgres
const express = require('express');
const { Type } = require('@sinclair/typebox');
const { Value } = require('@sinclair/typebox/value');
const { pool } = require('../services/db');
const { STAGES } = require('../services/pipeline-stages');

const router = express.Router();

// --- RBAC ---

// Default roles seeded into pipeline_config on first access
const DEFAULT_RBAC = {
  roles: {
    operator: { canTrigger: true, canApprove: false, canCancelOwn: true, canCancelAny: false, canConfigure: false },
    reviewer: { canTrigger: true, canApprove: true, canCancelOwn: true, canCancelAny: false, canConfigure: false },
    admin:    { canTrigger: true, canApprove: true, canCancelOwn: true, canCancelAny: true, canConfigure: true }
  },
  users: {}  // Maps user ID to role, e.g. { "nihal@tor.ai": "admin" }
};

// Seed RBAC config if it doesn't exist yet
async function ensureRbacConfig() {
  const { rows } = await pool.query(
    "SELECT value FROM pipeline_config WHERE key = 'rbac'"
  );
  if (rows.length === 0) {
    await pool.query(
      "INSERT INTO pipeline_config (key, value, updated_by) VALUES ('rbac', $1, 'system') ON CONFLICT (key) DO NOTHING",
      [JSON.stringify(DEFAULT_RBAC)]
    );
    return DEFAULT_RBAC;
  }
  return rows[0].value;
}

// Get the user's role from the request. Identity comes from x-pipeline-user header or triggeredBy body field.
function getUserId(req) {
  return req.headers['x-pipeline-user'] || req.body?.triggeredBy || null;
}

// RBAC middleware factory. permission is one of: canTrigger, canApprove, canCancelOwn, canCancelAny, canConfigure
// For cancel, pass 'canCancel' — the middleware checks own vs any based on run ownership.
function requirePermission(permission) {
  return async (req, res, next) => {
    const userId = getUserId(req);

    // No user identity — allow read-only endpoints (GET), block mutating ones
    if (!userId) {
      if (req.method === 'GET') return next();
      return res.status(401).json({ error: 'Missing user identity. Set x-pipeline-user header.' });
    }

    try {
      const rbac = await ensureRbacConfig();
      const userRole = rbac.users?.[userId] || 'operator'; // Default to operator
      const rolePerms = rbac.roles?.[userRole];

      if (!rolePerms) {
        return res.status(403).json({ error: `Unknown role: ${userRole}` });
      }

      // Special handling for cancel — check ownership
      if (permission === 'canCancel') {
        const runId = req.params.id;
        const { rows } = await pool.query('SELECT triggered_by FROM pipeline_runs WHERE id = $1', [runId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Run not found' });

        const isOwner = rows[0].triggered_by === userId;
        if (isOwner && rolePerms.canCancelOwn) return next();
        if (rolePerms.canCancelAny) return next();
        return res.status(403).json({ error: `Role '${userRole}' cannot cancel this run` });
      }

      if (!rolePerms[permission]) {
        return res.status(403).json({ error: `Role '${userRole}' lacks permission: ${permission}` });
      }

      next();
    } catch (err) {
      console.error('[pipeline-routes] RBAC check error:', err.message);
      next(); // Fail open for DB errors to avoid blocking the entire pipeline
    }
  };
}

// --- Schemas ---

const CreatePipelineRunBody = Type.Object({
  taskId: Type.Optional(Type.String()),
  repo: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  provider: Type.Optional(Type.Union([Type.Literal('github'), Type.Literal('azure_devops')])),
  triggeredBy: Type.Optional(Type.String()),
  config: Type.Optional(Type.Object({
    autoMerge: Type.Optional(Type.Boolean()),
    skipReview: Type.Optional(Type.Boolean()),
    skipQA: Type.Optional(Type.Boolean()),
    timeoutSeconds: Type.Optional(Type.Number()),
    reviewTimeout: Type.Optional(Type.Number()),
    mergeStrategy: Type.Optional(Type.Union([Type.Literal('squash'), Type.Literal('merge'), Type.Literal('rebase')])),
    defaultBranch: Type.Optional(Type.String()),
    port: Type.Optional(Type.Number()),
    workItemId: Type.Optional(Type.String()),
    organization: Type.Optional(Type.String()),
    project: Type.Optional(Type.String())
  }))
});

const PipelineRunResponseSchema = Type.Object({
  id: Type.String(),
  taskId: Type.Union([Type.String(), Type.Null()]),
  repo: Type.String(),
  status: Type.String(),
  currentStage: Type.Union([Type.String(), Type.Null()]),
  provider: Type.String(),
  stages: Type.Array(Type.Object({
    stage: Type.String(),
    status: Type.String()
  })),
  triggeredBy: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String()
});

// --- Validation middleware ---

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

// --- GET /api/pipeline/runs — List runs with optional filters ---

router.get('/runs', async (req, res) => {
  const { status, repo, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  let i = 1;

  if (status) { conditions.push(`r.status = $${i++}`); params.push(status); }
  if (repo) { conditions.push(`r.repo ILIKE $${i++}`); params.push(`%${repo}%`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(parseInt(limit, 10), parseInt(offset, 10));

  try {
    const { rows } = await pool.query(`
      SELECT r.*,
        EXTRACT(EPOCH FROM (COALESCE(r.completed_at, NOW()) - r.started_at)) AS duration_secs
      FROM pipeline_runs r
      ${where}
      ORDER BY r.created_at DESC
      LIMIT $${i++} OFFSET $${i++}
    `, params);

    const runs = rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      repo: r.repo,
      branch: r.branch,
      prompt: r.prompt,
      status: r.status,
      currentStage: r.current_stage,
      provider: r.provider,
      prNumber: r.pr_number,
      prUrl: r.pr_url,
      config: r.config,
      result: r.result,
      costUsd: parseFloat(r.cost_usd) || 0,
      triggeredBy: r.triggered_by,
      durationSecs: r.duration_secs ? Math.round(parseFloat(r.duration_secs)) : null,
      startedAt: r.started_at ? r.started_at.toISOString() : null,
      completedAt: r.completed_at ? r.completed_at.toISOString() : null,
      createdAt: r.created_at.toISOString()
    }));

    res.json(runs);
  } catch (err) {
    console.error('[pipeline-routes] List runs error:', err.message);
    res.status(500).json({ error: 'Failed to list pipeline runs', details: err.message });
  }
});

// --- GET /api/pipeline/runs/:id — Get run detail with stages and audit log ---

router.get('/runs/:id', async (req, res) => {
  try {
    const { rows: runRows } = await pool.query(
      `SELECT r.*,
        EXTRACT(EPOCH FROM (COALESCE(r.completed_at, NOW()) - r.started_at)) AS duration_secs
       FROM pipeline_runs r WHERE r.id = $1`,
      [req.params.id]
    );
    if (runRows.length === 0) return res.status(404).json({ error: 'Run not found' });

    const r = runRows[0];

    const { rows: stages } = await pool.query(
      'SELECT * FROM pipeline_stages WHERE run_id = $1 ORDER BY id',
      [r.id]
    );

    // Audit log — may not exist yet, fail silently
    let auditLog = [];
    try {
      const { rows: logs } = await pool.query(
        'SELECT * FROM pipeline_audit_log WHERE run_id = $1 ORDER BY created_at',
        [r.id]
      );
      auditLog = logs.map(l => ({
        id: l.id,
        action: l.action,
        actor: l.actor,
        details: l.details,
        createdAt: l.created_at.toISOString()
      }));
    } catch { /* table may not exist */ }

    res.json({
      id: r.id,
      taskId: r.task_id,
      repo: r.repo,
      branch: r.branch,
      prompt: r.prompt,
      status: r.status,
      currentStage: r.current_stage,
      provider: r.provider,
      prNumber: r.pr_number,
      prUrl: r.pr_url,
      config: r.config,
      result: r.result,
      costUsd: parseFloat(r.cost_usd) || 0,
      triggeredBy: r.triggered_by,
      durationSecs: r.duration_secs ? Math.round(parseFloat(r.duration_secs)) : null,
      startedAt: r.started_at ? r.started_at.toISOString() : null,
      completedAt: r.completed_at ? r.completed_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
      stages: stages.map(s => ({
        id: s.id,
        stage: s.stage,
        status: s.status,
        output: s.output,
        error: s.error,
        durationMs: s.duration_ms,
        costUsd: parseFloat(s.cost_usd) || 0,
        retryCount: s.retry_count,
        startedAt: s.started_at ? s.started_at.toISOString() : null,
        completedAt: s.completed_at ? s.completed_at.toISOString() : null
      })),
      auditLog
    });
  } catch (err) {
    console.error('[pipeline-routes] Get run error:', err.message);
    res.status(500).json({ error: 'Failed to get pipeline run', details: err.message });
  }
});

// --- POST /api/pipeline/runs/:id/cancel — Cancel a running pipeline ---

router.post('/runs/:id/cancel', requirePermission('canCancel'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      "UPDATE pipeline_runs SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND status IN ('queued', 'running') RETURNING *",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Run not found or not cancellable' });

    // Mark any running stages as failed
    await pool.query(
      "UPDATE pipeline_stages SET status = 'failed', error = 'Cancelled by user', completed_at = NOW() WHERE run_id = $1 AND status = 'running'",
      [req.params.id]
    );

    res.json({ message: 'Run cancelled', id: req.params.id });
  } catch (err) {
    console.error('[pipeline-routes] Cancel error:', err.message);
    res.status(500).json({ error: 'Failed to cancel run', details: err.message });
  }
});

// --- POST /api/pipeline/runs/:id/approve — Approve staging gate ---

router.post('/runs/:id/approve', requirePermission('canApprove'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM pipeline_runs WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Run not found' });

    const run = rows[0];
    const config = { ...(run.config || {}), approved: true };

    await pool.query(
      'UPDATE pipeline_runs SET config = $1 WHERE id = $2',
      [JSON.stringify(config), req.params.id]
    );

    res.json({ message: 'Staging approved', id: req.params.id });
  } catch (err) {
    console.error('[pipeline-routes] Approve error:', err.message);
    res.status(500).json({ error: 'Failed to approve run', details: err.message });
  }
});

// --- POST /api/pipeline/runs — Create and queue a new pipeline run ---

router.post('/runs', requirePermission('canTrigger'), validate(CreatePipelineRunBody), async (req, res) => {
  const { taskId, repo, prompt, provider = 'github', triggeredBy, config = {} } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert the run
    const { rows } = await client.query(`
      INSERT INTO pipeline_runs (task_id, repo, prompt, status, provider, config, triggered_by)
      VALUES ($1, $2, $3, 'queued', $4, $5, $6)
      RETURNING *
    `, [taskId || null, repo, prompt, provider, JSON.stringify(config), triggeredBy || null]);

    const run = rows[0];

    // Create stage rows for all 7 stages
    for (const stage of STAGES) {
      await client.query(`
        INSERT INTO pipeline_stages (run_id, stage, status)
        VALUES ($1, $2, 'pending')
      `, [run.id, stage]);
    }

    await client.query('COMMIT');

    // Fetch stages for response
    const { rows: stageRows } = await pool.query(
      'SELECT stage, status FROM pipeline_stages WHERE run_id = $1 ORDER BY id',
      [run.id]
    );

    const response = {
      id: run.id,
      taskId: run.task_id,
      repo: run.repo,
      status: run.status,
      currentStage: run.current_stage,
      provider: run.provider,
      stages: stageRows,
      triggeredBy: run.triggered_by,
      createdAt: run.created_at.toISOString()
    };

    res.status(201).json(Value.Cast(PipelineRunResponseSchema, response));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pipeline-routes] Create run error:', err.message);
    res.status(500).json({ error: 'Failed to create pipeline run', details: err.message });
  } finally {
    client.release();
  }
});

// --- POST /api/pipeline/runs/:id/retry — Retry a run from a specific stage ---

const RetryBody = Type.Object({
  fromStage: Type.String({ minLength: 1 })
});

router.post('/runs/:id/retry', requirePermission('canTrigger'), validate(RetryBody), async (req, res) => {
  const runId = req.params.id;
  const { fromStage } = req.body;

  if (!STAGES.includes(fromStage)) {
    return res.status(400).json({ error: `Invalid stage: ${fromStage}. Must be one of: ${STAGES.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify the run exists
    const { rows: runRows } = await client.query(
      'SELECT * FROM pipeline_runs WHERE id = $1 FOR UPDATE',
      [runId]
    );
    if (runRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pipeline run not found' });
    }

    const run = runRows[0];
    const config = { ...(run.config || {}), fromStage };

    // Reset the run to queued
    await client.query(`
      UPDATE pipeline_runs
      SET status = 'queued', current_stage = NULL, config = $1, completed_at = NULL
      WHERE id = $2
    `, [JSON.stringify(config), runId]);

    // Reset stages from fromStage onwards back to pending
    const fromIndex = STAGES.indexOf(fromStage);
    const stagesToReset = STAGES.slice(fromIndex);
    await client.query(`
      UPDATE pipeline_stages
      SET status = 'pending', started_at = NULL, completed_at = NULL, output = NULL, error = NULL, duration_ms = NULL, cost_usd = 0
      WHERE run_id = $1 AND stage = ANY($2)
    `, [runId, stagesToReset]);

    await client.query('COMMIT');

    // Fetch updated stages for response
    const { rows: stageRows } = await pool.query(
      'SELECT stage, status FROM pipeline_stages WHERE run_id = $1 ORDER BY id',
      [runId]
    );

    res.json({
      id: run.id,
      taskId: run.task_id,
      repo: run.repo,
      status: 'queued',
      currentStage: null,
      provider: run.provider,
      stages: stageRows,
      triggeredBy: run.triggered_by,
      createdAt: run.created_at.toISOString()
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pipeline-routes] Retry error:', err.message);
    res.status(500).json({ error: 'Failed to retry pipeline run', details: err.message });
  } finally {
    client.release();
  }
});

// --- GET /api/pipeline/runs/:id/logs — SSE stream of stage output (real-time poll) ---

router.get('/runs/:id/logs', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const runId = req.params.id;
  let lastStageStatus = {};
  let lastOutput = {};
  let closed = false;

  req.on('close', () => { closed = true; });

  // Send initial snapshot then poll every 2s for changes
  async function poll() {
    if (closed) return;

    try {
      const { rows: runRows } = await pool.query(
        'SELECT status, current_stage FROM pipeline_runs WHERE id = $1', [runId]
      );
      if (runRows.length === 0) {
        res.write('data: {"type":"error","message":"Run not found"}\n\n');
        res.end();
        return;
      }

      const run = runRows[0];

      const { rows: stages } = await pool.query(
        'SELECT stage, status, output, error, duration_ms, cost_usd, started_at, completed_at FROM pipeline_stages WHERE run_id = $1 ORDER BY id',
        [runId]
      );

      // Emit stage transition events
      for (const s of stages) {
        const prevStatus = lastStageStatus[s.stage];
        if (prevStatus !== s.status) {
          res.write(`data: ${JSON.stringify({
            type: 'stage',
            stage: s.stage,
            status: s.status,
            durationMs: s.duration_ms,
            costUsd: parseFloat(s.cost_usd) || 0
          })}\n\n`);
          lastStageStatus[s.stage] = s.status;
        }

        // Emit new output/error content
        const currentOut = (s.output || '') + (s.error ? '\n[ERROR] ' + s.error : '');
        if (currentOut && currentOut !== lastOutput[s.stage]) {
          res.write(`data: ${JSON.stringify({
            type: 'output',
            stage: s.stage,
            content: currentOut
          })}\n\n`);
          lastOutput[s.stage] = currentOut;
        }
      }

      // Emit run status
      res.write(`data: ${JSON.stringify({
        type: 'status',
        status: run.status,
        currentStage: run.current_stage
      })}\n\n`);

      // Stop polling if run is terminal
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        res.write(`data: ${JSON.stringify({ type: 'done', status: run.status })}\n\n`);
        res.end();
        return;
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }

    if (!closed) setTimeout(poll, 2000);
  }

  poll();
});

// --- GET /api/pipeline/stats — Aggregate pipeline stats ---

router.get('/stats', async (req, res) => {
  try {
    // Success rate (last 7 days)
    const { rows: rateRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status IN ('completed', 'failed')) AS total
      FROM pipeline_runs
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    const rate = rateRows[0];
    const successRate = rate.total > 0
      ? Math.round((parseInt(rate.completed) / parseInt(rate.total)) * 100)
      : 0;

    // Last 5 runs
    const { rows: recentRows } = await pool.query(`
      SELECT id, task_id, repo, status, current_stage, cost_usd,
        EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - started_at)) AS duration_secs,
        created_at
      FROM pipeline_runs
      ORDER BY created_at DESC
      LIMIT 5
    `);
    const recentRuns = recentRows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      repo: r.repo,
      status: r.status,
      currentStage: r.current_stage,
      costUsd: parseFloat(r.cost_usd) || 0,
      durationSecs: r.duration_secs ? Math.round(parseFloat(r.duration_secs)) : null,
      createdAt: r.created_at.toISOString()
    }));

    // Total cost this week
    const { rows: costRows } = await pool.query(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
      FROM pipeline_runs
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    const totalCostWeek = parseFloat(costRows[0].total_cost) || 0;

    // Average duration (completed runs, last 7 days)
    const { rows: durRows } = await pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) AS avg_dur
      FROM pipeline_runs
      WHERE status = 'completed' AND completed_at IS NOT NULL
        AND created_at > NOW() - INTERVAL '7 days'
    `);
    const avgDurationSecs = durRows[0].avg_dur ? Math.round(parseFloat(durRows[0].avg_dur)) : null;

    res.json({
      successRate,
      completed: parseInt(rate.completed),
      failed: parseInt(rate.failed),
      total: parseInt(rate.total),
      recentRuns,
      totalCostWeek,
      avgDurationSecs
    });
  } catch (err) {
    console.error('[pipeline-routes] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to get pipeline stats', details: err.message });
  }
});

// --- GET /api/pipeline/repos — Known repos for dropdown ---

router.get('/repos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT repo FROM pipeline_runs ORDER BY repo'
    );
    const repos = rows.map(r => r.repo);
    // Add default repos if none found
    if (repos.length === 0) {
      repos.push('torcmo/marketing-command-center', 'torcmo/dashboard');
    }
    res.json(repos);
  } catch (err) {
    res.json(['torcmo/marketing-command-center', 'torcmo/dashboard']);
  }
});

// --- GET /api/pipeline/config — Get pipeline configuration (RBAC roles + users) ---

router.get('/config', async (req, res) => {
  try {
    const rbac = await ensureRbacConfig();
    res.json(rbac);
  } catch (err) {
    console.error('[pipeline-routes] Config get error:', err.message);
    res.status(500).json({ error: 'Failed to get pipeline config', details: err.message });
  }
});

// --- PUT /api/pipeline/config — Update pipeline configuration (admin only) ---

router.put('/config', requirePermission('canConfigure'), async (req, res) => {
  const { roles, users } = req.body;

  if (!roles && !users) {
    return res.status(400).json({ error: 'Must provide roles, users, or both' });
  }

  try {
    const current = await ensureRbacConfig();
    const updated = {
      roles: roles || current.roles,
      users: users || current.users
    };

    const userId = getUserId(req);
    await pool.query(
      "UPDATE pipeline_config SET value = $1, updated_by = $2, updated_at = NOW() WHERE key = 'rbac'",
      [JSON.stringify(updated), userId || 'unknown']
    );

    res.json(updated);
  } catch (err) {
    console.error('[pipeline-routes] Config update error:', err.message);
    res.status(500).json({ error: 'Failed to update pipeline config', details: err.message });
  }
});

// --- GET /api/pipeline/cleanup — Truncate old stage outputs (log rotation) ---
// Stages older than 30 days get their output truncated to first 500 chars.

router.get('/cleanup', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE pipeline_stages
      SET output = LEFT(output, 500)
      WHERE completed_at < NOW() - INTERVAL '30 days'
        AND output IS NOT NULL
        AND LENGTH(output) > 500
      RETURNING id, stage, run_id
    `);

    const message = rows.length > 0
      ? `Truncated ${rows.length} stage outputs older than 30 days`
      : 'No stage outputs needed truncation';

    console.log(`[pipeline-routes] Cleanup: ${message}`);
    res.json({ message, truncated: rows.length });
  } catch (err) {
    console.error('[pipeline-routes] Cleanup error:', err.message);
    res.status(500).json({ error: 'Failed to run cleanup', details: err.message });
  }
});

// --- GET /api/pipeline/repo-configs — List all repo configurations ---

router.get('/repo-configs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value, updated_by, updated_at FROM pipeline_config WHERE key LIKE 'repo:%' ORDER BY key"
    );
    const configs = rows.map(r => ({
      key: r.key,
      repoId: r.key.replace('repo:', ''),
      ...r.value,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at ? r.updated_at.toISOString() : null
    }));
    res.json(configs);
  } catch (err) {
    console.error('[pipeline-routes] List repo configs error:', err.message);
    res.json([]);
  }
});

// --- PUT /api/pipeline/repo-configs/:repoId — Create or update a repo config ---

router.put('/repo-configs/:repoId', async (req, res) => {
  const repoId = req.params.repoId;
  const key = `repo:${repoId}`;
  const { provider, organization, project, repoName, defaultBranch, mergeStrategy } = req.body;

  if (!provider || !repoName) {
    return res.status(400).json({ error: 'provider and repoName are required' });
  }

  const value = { provider, repoName, defaultBranch: defaultBranch || 'master', mergeStrategy: mergeStrategy || 'squash' };
  if (provider === 'github') {
    value.org = organization || '';
  } else if (provider === 'azure_devops') {
    value.organization = organization || '';
    value.project = project || '';
  }

  const userId = getUserId(req);

  try {
    await pool.query(
      `INSERT INTO pipeline_config (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()`,
      [key, JSON.stringify(value), userId || 'system']
    );
    res.json({ key, repoId, ...value });
  } catch (err) {
    console.error('[pipeline-routes] Save repo config error:', err.message);
    res.status(500).json({ error: 'Failed to save repo config', details: err.message });
  }
});

// --- DELETE /api/pipeline/repo-configs/:repoId — Delete a repo config ---

router.delete('/repo-configs/:repoId', async (req, res) => {
  const key = `repo:${req.params.repoId}`;
  try {
    await pool.query('DELETE FROM pipeline_config WHERE key = $1', [key]);
    res.json({ message: 'Repo config deleted', key });
  } catch (err) {
    console.error('[pipeline-routes] Delete repo config error:', err.message);
    res.status(500).json({ error: 'Failed to delete repo config', details: err.message });
  }
});

module.exports = router;
