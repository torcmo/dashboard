// Pipeline runs API — creates queued runs with stage rows in Postgres
const express = require('express');
const { Type } = require('@sinclair/typebox');
const { Value } = require('@sinclair/typebox/value');
const { pool } = require('../services/db');
const { STAGES } = require('../services/pipeline-stages');

const router = express.Router();

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
    port: Type.Optional(Type.Number())
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

router.post('/runs/:id/cancel', async (req, res) => {
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

router.post('/runs/:id/approve', async (req, res) => {
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

router.post('/runs', validate(CreatePipelineRunBody), async (req, res) => {
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

router.post('/runs/:id/retry', validate(RetryBody), async (req, res) => {
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

module.exports = router;
