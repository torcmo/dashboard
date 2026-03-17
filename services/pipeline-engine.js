// Pipeline engine — polls pipeline_runs for queued jobs using SELECT FOR UPDATE SKIP LOCKED
const { pool } = require('./db');
const { STAGES, executeStageWithTracking, updateRun } = require('./pipeline-stages');

let pollInterval = null;
let running = false;

// Poll for queued runs every 5 seconds
async function pollQueue() {
  if (running) return;
  running = true;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Grab the next queued run, locking it so no other worker picks it up
    const { rows } = await client.query(`
      SELECT * FROM pipeline_runs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);

    if (rows.length === 0) {
      await client.query('COMMIT');
      return;
    }

    const run = rows[0];

    // Mark as running
    await client.query(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [run.id]
    );
    await client.query('COMMIT');

    // Execute the pipeline outside the transaction
    await executePipeline(run);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pipeline-engine] Poll error:', err.message);
  } finally {
    client.release();
    running = false;
  }
}

// Execute all stages sequentially for a run
async function executePipeline(run) {
  console.log(`[pipeline-engine] Starting run ${run.id} (task: ${run.task_id}, repo: ${run.repo})`);

  // Get all stage rows for this run (created when the run was queued)
  const { rows: stageRows } = await pool.query(
    'SELECT * FROM pipeline_stages WHERE run_id = $1 ORDER BY id',
    [run.id]
  );

  // Build a stage map for quick lookup
  const stageMap = {};
  for (const row of stageRows) {
    stageMap[row.stage] = row;
  }

  // Determine which stages to skip
  const skipReview = run.config?.skipReview === true;
  const skipQA = run.config?.skipQA === true;

  // Refresh run data between stages (branch, pr_number may be updated)
  let currentRun = { ...run };

  try {
    for (const stageName of STAGES) {
      const stageRow = stageMap[stageName];
      if (!stageRow) continue;

      // Skip stages if configured
      if (stageName === 'review' && skipReview) {
        await pool.query(
          `UPDATE pipeline_stages SET status = 'skipped', completed_at = NOW() WHERE id = $1`,
          [stageRow.id]
        );
        continue;
      }
      if (stageName === 'qa' && skipQA) {
        await pool.query(
          `UPDATE pipeline_stages SET status = 'skipped', completed_at = NOW() WHERE id = $1`,
          [stageRow.id]
        );
        continue;
      }

      // Refresh run data to pick up updates from prior stages (branch, pr_number, etc.)
      const { rows: refreshed } = await pool.query(
        'SELECT * FROM pipeline_runs WHERE id = $1',
        [currentRun.id]
      );
      if (refreshed.length > 0) currentRun = refreshed[0];

      await executeStageWithTracking(currentRun, stageName, stageRow);
    }

    // All stages passed
    await updateRun(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });

    console.log(`[pipeline-engine] Run ${run.id} completed successfully`);
  } catch (err) {
    // Mark run as failed
    await updateRun(run.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      result: JSON.stringify({ error: err.message })
    });

    console.error(`[pipeline-engine] Run ${run.id} failed at stage ${run.current_stage}:`, err.message);
  }
}

function start() {
  if (pollInterval) return;
  console.log('[pipeline-engine] Starting queue processor (polling every 5s)');
  pollInterval = setInterval(pollQueue, 5000);
  // Run immediately on start
  pollQueue();
}

function stop() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[pipeline-engine] Queue processor stopped');
  }
}

module.exports = { start, stop };
