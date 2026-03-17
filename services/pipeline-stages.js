// Stage executor functions for the 7-stage CI/CD pipeline
// Each stage receives a run context and writes results to pipeline_stages table
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pool } = require('./db');
const { createProvider } = require('./git-provider');

const WORKSPACE_DIR = path.join(__dirname, '..', '..');
const GITHUB_ORG = 'torcmo';

const STAGES = ['build', 'pr', 'review', 'qa', 'staging', 'merge', 'deploy'];

const STAGE_DEFAULTS = {
  build:   { timeout: 300, retries: 1 },
  pr:      { timeout: 60,  retries: 2 },
  review:  { timeout: 180, retries: 1 },
  qa:      { timeout: 120, retries: 0 },
  staging: { timeout: 3600, retries: 0 },
  merge:   { timeout: 60,  retries: 2 },
  deploy:  { timeout: 120, retries: 1 }
};

// --- Helpers ---

// Run claude --print as a child process with timeout, returns { output, costUsd }
function runClaude(prompt, workdir, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--permission-mode', 'bypassPermissions', prompt];
    const proc = spawn('claude', args, {
      cwd: workdir,
      timeout: timeoutSeconds * 1000,
      env: { ...process.env, HOME: process.env.HOME },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code === 0) {
        resolve({ output: stdout, costUsd: 0 });
      } else {
        reject(new Error(`Claude exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', err => reject(err));
  });
}

// Update a stage row in pipeline_stages
async function updateStage(stageId, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    // Convert camelCase to snake_case for DB columns
    const col = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    sets.push(`${col} = $${i}`);
    vals.push(val);
    i++;
  }
  vals.push(stageId);
  await pool.query(`UPDATE pipeline_stages SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

// Update the parent run
async function updateRun(runId, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    const col = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    sets.push(`${col} = $${i}`);
    vals.push(val);
    i++;
  }
  vals.push(runId);
  await pool.query(`UPDATE pipeline_runs SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

// HTTP GET with timeout — returns status code
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Stages that retry on transient failures (git push, server start).
// Claude Code stages (build, review) do NOT retry — bad prompt = bad prompt.
const RETRYABLE_STAGES = new Set(['pr', 'merge', 'deploy']);

// Exponential backoff delays: 5s, 15s, 45s
const RETRY_DELAYS_MS = [5000, 15000, 45000];

// --- Stage Executors ---

// STAGE 1: BUILD — run Claude Code to generate/modify code
async function executeBuild(run, stageRow) {
  const workdir = path.join(WORKSPACE_DIR, run.repo.split('/').pop());
  const branch = run.branch || `feature/${run.task_id || Date.now()}`;

  // Create/checkout feature branch
  try {
    execFileSync('git', ['checkout', '-b', branch], { cwd: workdir, encoding: 'utf8' });
  } catch {
    execFileSync('git', ['checkout', branch], { cwd: workdir, encoding: 'utf8' });
  }

  const timeout = run.config?.timeoutSeconds || STAGE_DEFAULTS.build.timeout;
  const result = await runClaude(run.prompt, workdir, timeout);

  // Commit any changes
  execFileSync('git', ['add', '-A'], { cwd: workdir });
  try {
    const msg = `feat(${run.task_id || 'pipeline'}): ${(run.prompt || '').slice(0, 72)}`;
    execFileSync('git', ['commit', '-m', msg], { cwd: workdir, encoding: 'utf8' });
  } catch {
    // Nothing to commit is OK
  }

  // Update branch on the run
  await updateRun(run.id, { branch });

  return { output: result.output, costUsd: result.costUsd };
}

// STAGE 2: PR — git push + create PR via git-provider
async function executePR(run, stageRow) {
  const workdir = path.join(WORKSPACE_DIR, run.repo.split('/').pop());
  const branch = run.branch;
  const provider = createProvider(run.provider, GITHUB_ORG);

  provider.pushBranch(branch, workdir);

  const title = `feat(${run.task_id || 'pipeline'}): ${(run.prompt || '').slice(0, 60)}`;
  const body = `## Task: ${run.task_id || 'N/A'}\n\n${(run.prompt || '').slice(0, 500)}\n\n---\n*Auto-generated by pipeline engine*`;
  const pr = provider.createPR(run.repo, branch, title, body);

  await updateRun(run.id, { prNumber: pr.number, prUrl: pr.url });

  return { output: `PR created: ${pr.url} (#${pr.number})`, costUsd: 0 };
}

// STAGE 3: REVIEW — Claude Code reviews the diff
async function executeReview(run, stageRow) {
  const workdir = path.join(WORKSPACE_DIR, run.repo.split('/').pop());
  const branch = run.branch;
  const defaultBranch = run.config?.defaultBranch || 'master';

  let diff = '';
  try {
    diff = execFileSync('git', ['diff', `origin/${defaultBranch}...${branch}`, '--stat'], {
      cwd: workdir, encoding: 'utf8'
    });
  } catch {
    diff = '(unable to generate diff)';
  }

  const prompt = `Review this PR (branch ${branch} vs ${defaultBranch}) in ${workdir}.

Run a comprehensive code review:
1. Check for bugs, logic errors, edge cases
2. Check for security issues (SQL injection, XSS, auth bypass)
3. Check for performance issues
4. Check code style consistency
5. Check that all API endpoints have proper error handling
6. Verify no breaking changes to existing functionality

Git diff summary:
${diff}

Output a structured review with: ISSUES FOUND (critical/warning/info), SUMMARY, VERDICT (approve/request-changes).`;

  const timeout = run.config?.reviewTimeout || STAGE_DEFAULTS.review.timeout;
  const result = await runClaude(prompt, workdir, timeout);

  return { output: result.output, costUsd: result.costUsd };
}

// STAGE 4: QA — JS syntax check + server start + API check + HTML check
async function executeQA(run, stageRow) {
  const repoName = run.repo.split('/').pop();
  const workdir = path.join(WORKSPACE_DIR, repoName);
  const results = [];

  // 1. JS syntax check
  try {
    const jsFiles = fs.readdirSync(path.join(workdir, 'public'))
      .filter(f => f.endsWith('.js'));
    for (const f of jsFiles) {
      execFileSync('node', ['-c', path.join(workdir, 'public', f)], { encoding: 'utf8' });
      results.push(`PASS: syntax check ${f}`);
    }
  } catch (err) {
    results.push(`FAIL: syntax check — ${err.message}`);
  }

  // Check server.js syntax
  const serverFile = path.join(workdir, 'server.js');
  if (fs.existsSync(serverFile)) {
    try {
      execFileSync('node', ['-c', serverFile], { encoding: 'utf8' });
      results.push('PASS: syntax check server.js');
    } catch (err) {
      results.push(`FAIL: syntax check server.js — ${err.message}`);
    }
  }

  // 2. Server start test
  const port = run.config?.port || (repoName === 'dashboard' ? 3333 : 3500);
  let serverProc = null;
  try {
    serverProc = spawn('node', ['server.js'], {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port) },
      detached: true
    });
    await sleep(2000);

    // 3. API check
    const statusCode = await httpGet(`http://localhost:${port}/`);
    if (statusCode === 200) {
      results.push(`PASS: server responds HTTP 200 on port ${port}`);
    } else {
      results.push(`FAIL: server responded HTTP ${statusCode} on port ${port}`);
    }

    // 4. HTML check
    const apiCode = await httpGet(`http://localhost:${port}/api/system`);
    if (apiCode === 200) {
      results.push('PASS: /api/system returns 200');
    } else {
      results.push(`FAIL: /api/system returned HTTP ${apiCode}`);
    }
  } catch (err) {
    results.push(`FAIL: server start — ${err.message}`);
  } finally {
    if (serverProc && !serverProc.killed) {
      try { process.kill(-serverProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const hasFail = results.some(r => r.startsWith('FAIL'));
  const output = results.join('\n') + `\n\nQA RESULT: ${hasFail ? 'FAILED' : 'PASSED'} (${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed)`;

  if (hasFail) {
    throw new Error(output);
  }

  return { output, costUsd: 0 };
}

// STAGE 5: STAGING — auto-proceed or wait based on config
async function executeStaging(run, stageRow) {
  const autoMerge = run.config?.autoMerge !== false;

  if (autoMerge) {
    return { output: 'Auto-merge enabled — proceeding to merge.', costUsd: 0 };
  }

  // Wait for approval: poll pipeline_runs.config for an approval flag
  const timeout = STAGE_DEFAULTS.staging.timeout;
  const start = Date.now();
  while (Date.now() - start < timeout * 1000) {
    const { rows } = await pool.query(
      'SELECT config FROM pipeline_runs WHERE id = $1',
      [run.id]
    );
    if (rows[0]?.config?.approved) {
      return { output: 'Staging approved — proceeding to merge.', costUsd: 0 };
    }
    await sleep(10000);
  }
  throw new Error('Staging approval timed out (1h)');
}

// STAGE 6: MERGE — merge PR via git-provider with fallback
async function executeMerge(run, stageRow) {
  const provider = createProvider(run.provider, GITHUB_ORG);
  const strategy = run.config?.mergeStrategy || 'squash';
  const output = provider.mergePR(run.repo, run.pr_number, strategy);

  // Pull merged changes
  const workdir = path.join(WORKSPACE_DIR, run.repo.split('/').pop());
  const defaultBranch = run.config?.defaultBranch || 'master';
  try {
    execFileSync('git', ['checkout', defaultBranch], { cwd: workdir, encoding: 'utf8' });
    execFileSync('git', ['pull', 'origin', defaultBranch], { cwd: workdir, encoding: 'utf8' });
  } catch {
    // Non-fatal — deploy will work from whatever state we're in
  }

  return { output: `PR #${run.pr_number} merged (${strategy}).\n${output}`, costUsd: 0 };
}

// STAGE 7: DEPLOY — kill old server + restart + smoke test HTTP 200
async function executeDeploy(run, stageRow) {
  const repoName = run.repo.split('/').pop();
  const workdir = path.join(WORKSPACE_DIR, repoName);
  const port = run.config?.port || (repoName === 'dashboard' ? 3333 : 3500);

  // Kill old server on that port
  try {
    const pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch {}
      }
    }
  } catch {
    // No process on port — that's fine
  }

  await sleep(1000);

  // Start new server
  const serverProc = spawn('node', ['server.js'], {
    cwd: workdir,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PORT: String(port) }
  });
  serverProc.unref();

  await sleep(2000);

  // Smoke test
  const statusCode = await httpGet(`http://localhost:${port}/`, 5000);
  if (statusCode === 200) {
    const deployUrl = `http://localhost:${port}`;
    await updateRun(run.id, { result: JSON.stringify({ deployUrl }) });
    return { output: `Deploy successful — ${deployUrl} (HTTP ${statusCode})`, costUsd: 0 };
  } else {
    throw new Error(`Deploy smoke test failed — HTTP ${statusCode} on port ${port}`);
  }
}

// --- Stage dispatcher ---

const EXECUTORS = {
  build: executeBuild,
  pr: executePR,
  review: executeReview,
  qa: executeQA,
  staging: executeStaging,
  merge: executeMerge,
  deploy: executeDeploy
};

// Execute a single stage with retry logic for transient failures.
// Retryable stages (pr, merge, deploy) use exponential backoff: 5s, 15s, 45s.
// Claude Code stages never retry. Retry count is persisted in pipeline_stages.
async function executeStageWithTracking(run, stageName, stageRow) {
  const startedAt = new Date();
  const executor = EXECUTORS[stageName];
  if (!executor) throw new Error(`Unknown stage: ${stageName}`);

  const maxRetries = RETRYABLE_STAGES.has(stageName) ? STAGE_DEFAULTS[stageName].retries : 0;
  let lastErr = null;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Wait before retry (skip delay on first attempt)
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      console.log(`[pipeline-stages] Retrying ${stageName} (attempt ${attempt + 1}/${maxRetries + 1}) after ${delay}ms`);
      await sleep(delay);
      retryCount = attempt;
      await updateStage(stageRow.id, { retryCount });
    }

    await updateStage(stageRow.id, {
      status: 'running',
      startedAt: startedAt.toISOString()
    });
    await updateRun(run.id, { currentStage: stageName });

    try {
      const result = await executor(run, stageRow);
      const durationMs = Date.now() - startedAt.getTime();

      await updateStage(stageRow.id, {
        status: 'passed',
        output: (result.output || '').slice(0, 50000),
        costUsd: result.costUsd || 0,
        durationMs,
        retryCount,
        completedAt: new Date().toISOString()
      });

      // Accumulate cost on the run
      if (result.costUsd > 0) {
        await pool.query(
          'UPDATE pipeline_runs SET cost_usd = cost_usd + $1 WHERE id = $2',
          [result.costUsd, run.id]
        );
      }

      return result;
    } catch (err) {
      lastErr = err;
      // If more retries remain, continue the loop
      if (attempt < maxRetries) continue;
    }
  }

  // All attempts exhausted — mark as failed
  const durationMs = Date.now() - startedAt.getTime();
  await updateStage(stageRow.id, {
    status: 'failed',
    error: (lastErr.message || String(lastErr)).slice(0, 10000),
    durationMs,
    retryCount,
    completedAt: new Date().toISOString()
  });

  throw lastErr;
}

module.exports = { STAGES, STAGE_DEFAULTS, executeStageWithTracking, updateRun };
