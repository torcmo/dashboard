// Pipeline engine — polls pipeline_runs for queued jobs using SELECT FOR UPDATE SKIP LOCKED
const { execFileSync } = require('child_process');
const path = require('path');
const { pool } = require('./db');
const { STAGES, executeStageWithTracking, updateRun } = require('./pipeline-stages');

const WORKSPACE_DIR = path.join(__dirname, '..', '..');

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

// Record an action in the audit log
async function auditLog(runId, action, actor, details = {}) {
  try {
    await pool.query(
      'INSERT INTO pipeline_audit_log (run_id, action, actor, details) VALUES ($1, $2, $3, $4)',
      [runId, action, actor || 'system', JSON.stringify(details)]
    );
  } catch (err) {
    console.error('[pipeline-engine] Audit log write failed:', err.message);
  }
}

// Rollback a deploy failure: revert the merge commit, push, restart from previous commit
async function rollbackDeploy(run) {
  const workdir = path.join(WORKSPACE_DIR, run.repo.split('/').pop());
  const defaultBranch = run.config?.defaultBranch || 'master';

  try {
    // Get the merge commit (HEAD on the default branch after merge)
    const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workdir, encoding: 'utf8'
    }).trim();

    // Revert the merge commit (use -m 1 for merge commits, --no-edit to avoid editor)
    execFileSync('git', ['revert', '--no-edit', '-m', '1', 'HEAD'], {
      cwd: workdir, encoding: 'utf8'
    });

    // Push the revert
    execFileSync('git', ['push', 'origin', defaultBranch], {
      cwd: workdir, encoding: 'utf8', timeout: 60000
    });

    // Restart server from the reverted state
    const repoName = run.repo.split('/').pop();
    const port = run.config?.port || (repoName === 'dashboard' ? 3333 : 3500);
    try {
      const pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch {}
        }
      }
    } catch { /* no process on port */ }

    const { spawn } = require('child_process');
    const serverProc = spawn('node', ['server.js'], {
      cwd: workdir, stdio: 'ignore', detached: true,
      env: { ...process.env, PORT: String(port) }
    });
    serverProc.unref();

    await auditLog(run.id, 'deploy.rollback.success', 'system', {
      revertedCommit: mergeCommit,
      branch: defaultBranch
    });

    console.log(`[pipeline-engine] Rollback successful for run ${run.id}: reverted ${mergeCommit}`);
    return { success: true, revertedCommit: mergeCommit };
  } catch (rollbackErr) {
    await auditLog(run.id, 'deploy.rollback.failed', 'system', {
      error: rollbackErr.message
    });

    console.error(`[pipeline-engine] Rollback FAILED for run ${run.id}:`, rollbackErr.message);
    return { success: false, error: rollbackErr.message };
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
  let mergeCompleted = false;

  try {
    // When retrying from a specific stage, skip earlier stages that already passed
    const fromStage = run.config?.fromStage || null;
    let reachedFromStage = !fromStage;

    for (const stageName of STAGES) {
      const stageRow = stageMap[stageName];
      if (!stageRow) continue;

      // Skip already-passed/skipped stages when retrying from a later stage
      if (!reachedFromStage) {
        if (stageName === fromStage) {
          reachedFromStage = true;
        } else {
          continue;
        }
      }

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

      // Track which stages have passed for rollback decisions
      if (stageName === 'merge') mergeCompleted = true;
    }

    // All stages passed
    await updateRun(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });

    console.log(`[pipeline-engine] Run ${run.id} completed successfully`);
  } catch (err) {
    // Refresh run to get current_stage
    const { rows: failedRows } = await pool.query(
      'SELECT current_stage FROM pipeline_runs WHERE id = $1', [run.id]
    );
    const failedStage = failedRows[0]?.current_stage;

    // Rollback if deploy failed after merge was completed
    let rollbackResult = null;
    if (failedStage === 'deploy' && mergeCompleted) {
      console.log(`[pipeline-engine] Deploy failed after merge — attempting rollback for run ${run.id}`);
      rollbackResult = await rollbackDeploy(currentRun);
    }

    // Mark run as failed
    const resultPayload = { error: err.message };
    if (rollbackResult) {
      resultPayload.rollback = rollbackResult;
    }

    await updateRun(run.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      result: JSON.stringify(resultPayload)
    });

    console.error(`[pipeline-engine] Run ${run.id} failed at stage ${failedStage}:`, err.message);
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
