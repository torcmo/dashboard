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

module.exports = router;
