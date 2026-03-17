// Webhook endpoints — receive GitHub/Azure DevOps events and auto-create pipeline runs
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../services/db');
const { STAGES } = require('../services/pipeline-stages');

const router = express.Router();

// --- Helpers ---

// Load webhook config for a repo from pipeline_config
async function getWebhookConfig(repoKey) {
  const { rows } = await pool.query(
    "SELECT value FROM pipeline_config WHERE key = $1",
    [`webhook:${repoKey}`]
  );
  return rows.length ? rows[0].value : null;
}

// Load repo config to get provider, default branch, etc.
async function getRepoConfig(repoKey) {
  const { rows } = await pool.query(
    "SELECT value FROM pipeline_config WHERE key = $1",
    [`repo:${repoKey}`]
  );
  return rows.length ? rows[0].value : null;
}

// Verify GitHub webhook signature (HMAC-SHA256)
function verifyGitHubSignature(payload, signature, secret) {
  if (!signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Check if a branch matches any of the configured patterns
// Supports exact match and simple wildcard (*) patterns
function branchMatches(branch, patterns) {
  if (!patterns || patterns.length === 0) return true; // No filter = match all
  return patterns.some(pattern => {
    if (pattern === '*') return true;
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(branch);
    }
    return branch === pattern;
  });
}

// Create a pipeline run from a webhook event
async function createWebhookRun(repo, branch, prompt, provider, triggeredBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      INSERT INTO pipeline_runs (task_id, repo, branch, prompt, status, provider, config, triggered_by)
      VALUES (NULL, $1, $2, $3, 'queued', $4, $5, $6)
      RETURNING *
    `, [repo, branch, prompt, provider, JSON.stringify({ autoMerge: false }), triggeredBy]);

    const run = rows[0];

    for (const stage of STAGES) {
      await client.query(
        "INSERT INTO pipeline_stages (run_id, stage, status) VALUES ($1, $2, 'pending')",
        [run.id, stage]
      );
    }

    // Audit log entry
    try {
      await client.query(
        "INSERT INTO pipeline_audit_log (run_id, action, actor, details) VALUES ($1, 'run.created', $2, $3)",
        [run.id, triggeredBy, JSON.stringify({ source: 'webhook', repo, branch })]
      );
    } catch { /* audit table may not exist */ }

    await client.query('COMMIT');

    console.log(`[webhooks] Created pipeline run ${run.id} for ${repo}@${branch} (triggered by ${triggeredBy})`);
    return run;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// --- POST /api/webhooks/github — Receive GitHub push/PR webhooks ---

router.post('/github', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];

  // Parse the raw body
  let payload;
  try {
    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  // Determine repo identifier
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    return res.status(400).json({ error: 'Missing repository information' });
  }

  // Load webhook config for this repo
  const webhookConfig = await getWebhookConfig(repoFullName);
  if (!webhookConfig || !webhookConfig.enabled) {
    return res.status(200).json({ message: 'Webhook not configured or disabled for this repo' });
  }

  // Verify signature
  const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
  if (webhookConfig.secret) {
    if (!verifyGitHubSignature(rawBody, signature, webhookConfig.secret)) {
      console.warn(`[webhooks] GitHub signature verification failed for ${repoFullName}`);
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }

  // Check event type is in allowed list
  const allowedEvents = webhookConfig.events || ['push', 'pull_request'];
  if (!allowedEvents.includes(event)) {
    return res.status(200).json({ message: `Event '${event}' not configured for this repo` });
  }

  try {
    if (event === 'push') {
      // Extract branch from ref (refs/heads/main → main)
      const ref = payload.ref || '';
      const branch = ref.replace('refs/heads/', '');

      if (!branchMatches(branch, webhookConfig.branches)) {
        return res.status(200).json({ message: `Branch '${branch}' does not match configured patterns` });
      }

      const commits = payload.commits || [];
      const commitMessages = commits.map(c => c.message).join('; ');
      const pusher = payload.pusher?.name || 'github-webhook';
      const prompt = `Webhook push to ${branch}: ${commitMessages || 'no commit messages'}`;

      const run = await createWebhookRun(repoFullName, branch, prompt, 'github', `webhook:${pusher}`);
      return res.status(201).json({ message: 'Pipeline run created', runId: run.id });

    } else if (event === 'pull_request') {
      const action = payload.action; // opened, synchronize, reopened
      const allowedActions = webhookConfig.prActions || ['opened', 'synchronize', 'reopened'];

      if (!allowedActions.includes(action)) {
        return res.status(200).json({ message: `PR action '${action}' not configured` });
      }

      const pr = payload.pull_request;
      const branch = pr?.head?.ref || 'unknown';

      if (!branchMatches(branch, webhookConfig.branches)) {
        return res.status(200).json({ message: `Branch '${branch}' does not match configured patterns` });
      }

      const prompt = `Webhook PR #${pr?.number}: ${pr?.title || 'no title'} (${action})`;
      const sender = payload.sender?.login || 'github-webhook';

      const run = await createWebhookRun(repoFullName, branch, prompt, 'github', `webhook:${sender}`);
      return res.status(201).json({ message: 'Pipeline run created', runId: run.id });
    }

    res.status(200).json({ message: 'Event received but no action taken' });
  } catch (err) {
    console.error('[webhooks] GitHub webhook error:', err.message);
    res.status(500).json({ error: 'Failed to process webhook', details: err.message });
  }
});

// --- POST /api/webhooks/azure-devops — Receive Azure DevOps Service Hooks ---

router.post('/azure-devops', express.json(), async (req, res) => {
  const payload = req.body;

  if (!payload || !payload.eventType) {
    return res.status(400).json({ error: 'Invalid Azure DevOps payload' });
  }

  // Azure DevOps sends repo info in resource.repository
  const resource = payload.resource || {};
  const repoName = resource.repository?.name
    || resource.repository?.remoteUrl
    || payload.resource?.pullRequestId && 'unknown';

  // Build a repo key from org/project/repo
  const orgUrl = payload.resourceContainers?.account?.baseUrl || '';
  const project = resource.repository?.project?.name || '';
  const repo = resource.repository?.name || '';
  const repoKey = repo ? `${project}/${repo}` : null;

  if (!repoKey) {
    return res.status(400).json({ error: 'Could not determine repository from payload' });
  }

  // Try multiple key formats to find webhook config
  let webhookConfig = await getWebhookConfig(repoKey);
  if (!webhookConfig) {
    webhookConfig = await getWebhookConfig(repo);
  }
  if (!webhookConfig || !webhookConfig.enabled) {
    return res.status(200).json({ message: 'Webhook not configured or disabled for this repo' });
  }

  // Verify shared secret via HTTP header if configured
  if (webhookConfig.secret) {
    const authHeader = req.headers['authorization'];
    const expectedToken = `Basic ${Buffer.from(':' + webhookConfig.secret).toString('base64')}`;
    if (authHeader !== expectedToken) {
      console.warn(`[webhooks] Azure DevOps auth verification failed for ${repoKey}`);
      return res.status(401).json({ error: 'Invalid webhook authorization' });
    }
  }

  const eventType = payload.eventType;
  const allowedEvents = webhookConfig.events || ['git.push', 'git.pullrequest.created', 'git.pullrequest.updated'];

  if (!allowedEvents.includes(eventType)) {
    return res.status(200).json({ message: `Event '${eventType}' not configured for this repo` });
  }

  try {
    if (eventType === 'git.push') {
      // Push event
      const refUpdates = resource.refUpdates || [];
      const branch = refUpdates[0]?.name?.replace('refs/heads/', '') || 'unknown';

      if (!branchMatches(branch, webhookConfig.branches)) {
        return res.status(200).json({ message: `Branch '${branch}' does not match configured patterns` });
      }

      const commits = resource.commits || [];
      const commitMessages = commits.map(c => c.comment).join('; ');
      const pusher = resource.pushedBy?.displayName || 'azure-devops-webhook';
      const prompt = `Webhook push to ${branch}: ${commitMessages || 'code pushed'}`;

      const run = await createWebhookRun(repoKey, branch, prompt, 'azure_devops', `webhook:${pusher}`);
      return res.status(201).json({ message: 'Pipeline run created', runId: run.id });

    } else if (eventType === 'git.pullrequest.created' || eventType === 'git.pullrequest.updated') {
      const pr = resource;
      const branch = pr.sourceRefName?.replace('refs/heads/', '') || 'unknown';

      if (!branchMatches(branch, webhookConfig.branches)) {
        return res.status(200).json({ message: `Branch '${branch}' does not match configured patterns` });
      }

      const action = eventType === 'git.pullrequest.created' ? 'created' : 'updated';
      const prompt = `Webhook PR #${pr.pullRequestId}: ${pr.title || 'no title'} (${action})`;
      const sender = pr.createdBy?.displayName || 'azure-devops-webhook';

      const run = await createWebhookRun(repoKey, branch, prompt, 'azure_devops', `webhook:${sender}`);
      return res.status(201).json({ message: 'Pipeline run created', runId: run.id });
    }

    res.status(200).json({ message: 'Event received but no action taken' });
  } catch (err) {
    console.error('[webhooks] Azure DevOps webhook error:', err.message);
    res.status(500).json({ error: 'Failed to process webhook', details: err.message });
  }
});

// --- GET /api/webhooks/configs — List all webhook configurations ---

router.get('/configs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value, updated_by, updated_at FROM pipeline_config WHERE key LIKE 'webhook:%' ORDER BY key"
    );
    const configs = rows.map(r => ({
      key: r.key,
      repoId: r.key.replace('webhook:', ''),
      ...r.value,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at ? r.updated_at.toISOString() : null
    }));
    res.json(configs);
  } catch (err) {
    console.error('[webhooks] List configs error:', err.message);
    res.json([]);
  }
});

// --- PUT /api/webhooks/configs/:repoId — Create or update webhook config ---

router.put('/configs/:repoId', express.json(), async (req, res) => {
  const repoId = decodeURIComponent(req.params.repoId);
  const key = `webhook:${repoId}`;
  const { enabled, secret, events, branches, prActions } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }

  const value = {
    enabled,
    secret: secret || '',
    events: events || ['push', 'pull_request'],
    branches: branches || [],
    prActions: prActions || ['opened', 'synchronize', 'reopened']
  };

  const userId = req.headers['x-pipeline-user'] || 'system';

  try {
    await pool.query(
      `INSERT INTO pipeline_config (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()`,
      [key, JSON.stringify(value), userId]
    );
    res.json({ key, repoId, ...value });
  } catch (err) {
    console.error('[webhooks] Save config error:', err.message);
    res.status(500).json({ error: 'Failed to save webhook config', details: err.message });
  }
});

// --- DELETE /api/webhooks/configs/:repoId — Delete webhook config ---

router.delete('/configs/:repoId', async (req, res) => {
  const repoId = decodeURIComponent(req.params.repoId);
  const key = `webhook:${repoId}`;
  try {
    await pool.query('DELETE FROM pipeline_config WHERE key = $1', [key]);
    res.json({ message: 'Webhook config deleted', key });
  } catch (err) {
    console.error('[webhooks] Delete config error:', err.message);
    res.status(500).json({ error: 'Failed to delete webhook config', details: err.message });
  }
});

// --- POST /api/webhooks/configs/:repoId/regenerate-secret — Generate a new secret ---

router.post('/configs/:repoId/regenerate-secret', async (req, res) => {
  const repoId = decodeURIComponent(req.params.repoId);
  const key = `webhook:${repoId}`;

  try {
    const { rows } = await pool.query(
      "SELECT value FROM pipeline_config WHERE key = $1", [key]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Webhook config not found' });
    }

    const config = rows[0].value;
    config.secret = crypto.randomBytes(32).toString('hex');

    const userId = req.headers['x-pipeline-user'] || 'system';
    await pool.query(
      "UPDATE pipeline_config SET value = $1, updated_by = $2, updated_at = NOW() WHERE key = $3",
      [JSON.stringify(config), userId, key]
    );

    res.json({ secret: config.secret });
  } catch (err) {
    console.error('[webhooks] Regenerate secret error:', err.message);
    res.status(500).json({ error: 'Failed to regenerate secret', details: err.message });
  }
});

module.exports = router;
