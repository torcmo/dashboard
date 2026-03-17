// Git provider abstraction — GitHub implementation via gh CLI
const { execFileSync } = require('child_process');

class GitHubProvider {
  constructor(org) {
    this.org = org || 'torcmo';
  }

  pushBranch(branch, workdir) {
    return execFileSync('git', ['push', '-u', 'origin', branch], {
      cwd: workdir,
      encoding: 'utf8',
      timeout: 60000
    });
  }

  createPR(repo, branch, title, body) {
    const fullRepo = repo.includes('/') ? repo : `${this.org}/${repo}`;
    const output = execFileSync('gh', [
      'pr', 'create',
      '--repo', fullRepo,
      '--head', branch,
      '--title', title,
      '--body', body
    ], { encoding: 'utf8', timeout: 60000 });
    const url = output.trim();
    const number = parseInt(url.match(/(\d+)$/)?.[1] || '0', 10);
    return { url, number };
  }

  mergePR(repo, prNumber, strategy = 'squash') {
    const fullRepo = repo.includes('/') ? repo : `${this.org}/${repo}`;
    try {
      return execFileSync('gh', [
        'pr', 'merge', String(prNumber),
        '--repo', fullRepo,
        `--${strategy}`, '--delete-branch'
      ], { encoding: 'utf8', timeout: 60000 });
    } catch (err) {
      // Fallback: try merge without delete-branch
      return execFileSync('gh', [
        'pr', 'merge', String(prNumber),
        '--repo', fullRepo,
        `--${strategy}`
      ], { encoding: 'utf8', timeout: 60000 });
    }
  }

  getPRStatus(repo, prNumber) {
    const fullRepo = repo.includes('/') ? repo : `${this.org}/${repo}`;
    const output = execFileSync('gh', [
      'pr', 'view', String(prNumber),
      '--repo', fullRepo,
      '--json', 'state', '-q', '.state'
    ], { encoding: 'utf8', timeout: 30000 });
    return output.trim();
  }

  postPRComment(repo, prNumber, comment) {
    const fullRepo = repo.includes('/') ? repo : `${this.org}/${repo}`;
    return execFileSync('gh', [
      'pr', 'comment', String(prNumber),
      '--repo', fullRepo,
      '--body', comment
    ], { encoding: 'utf8', timeout: 30000 });
  }
}

function createProvider(provider, org) {
  if (provider === 'github' || !provider) {
    return new GitHubProvider(org);
  }
  throw new Error(`Unsupported git provider: ${provider}`);
}

module.exports = { createProvider, GitHubProvider };
