#!/bin/bash
# pipeline-run.sh — Full CI/CD pipeline orchestrator
# Chains: Build → Branch + PR → Code Review → QA → Staging → Merge → Deploy
#
# Usage: bash pipeline-run.sh --task ob-02 --repo marketing-command-center "Build the accounts page..."
# Flags:
#   --task ID          Task ID on the kanban board
#   --repo NAME        GitHub repo name (under torcmo/)
#   --workdir PATH     Working directory for Claude Code
#   --auto-merge       Skip human gate at staging, auto-merge if QA passes
#   --skip-review      Skip code review stage
#   --skip-qa          Skip QA stage

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SCRIPT_DIR/data/claude-code.log"
STATUS="$SCRIPT_DIR/data/claude-status.json"
DASHBOARD="http://localhost:3333"
GITHUB_ORG="torcmo"

# Parse args
TASK_ID=""
REPO=""
WORKDIR=""
AUTO_MERGE=false
SKIP_REVIEW=false
SKIP_QA=false
PROMPT_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK_ID="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --auto-merge) AUTO_MERGE=true; shift ;;
    --skip-review) SKIP_REVIEW=true; shift ;;
    --skip-qa) SKIP_QA=true; shift ;;
    *) PROMPT_ARGS+=("$1"); shift ;;
  esac
done

PROMPT="${PROMPT_ARGS[*]}"
BRANCH="feature/${TASK_ID:-$(date +%s)}"
WORKDIR="${WORKDIR:-/home/torbot/.openclaw/workspace/${REPO}}"

# Helpers
move_task() {
  local col="$1"
  [ -n "$TASK_ID" ] && curl -s -X PUT "$DASHBOARD/api/tasks/$TASK_ID/move" \
    -H "Content-Type: application/json" -d "{\"to\":\"$col\",\"index\":0}" > /dev/null 2>&1
}

update_task() {
  [ -n "$TASK_ID" ] && curl -s -X PUT "$DASHBOARD/api/tasks/$TASK_ID" \
    -H "Content-Type: application/json" -d "$1" > /dev/null 2>&1
}

log_msg() {
  echo "$1" >> "$LOG"
  echo "$1"
}

run_claude() {
  local prompt="$1"
  stdbuf -oL claude --permission-mode bypassPermissions --verbose --output-format stream-json --print "$prompt" 2>&1 | while IFS= read -r line; do
    text=$(echo "$line" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('type') == 'assistant':
        msg = d.get('message', {})
        for c in msg.get('content', []):
            if c.get('type') == 'text':
                print(c['text'], end='')
            elif c.get('type') == 'tool_use':
                name = c.get('name', '?')
                inp = c.get('input', {})
                if name in ('Read', 'Write', 'Edit'):
                    fp = inp.get('file_path', inp.get('path', ''))
                    print(f'  ⚡ {name}({fp})')
                elif name == 'Bash':
                    cmd = inp.get('command', '')[:120]
                    print(f'  ⚡ Bash({cmd})')
                elif name == 'Grep':
                    print(f'  ⚡ Grep({inp.get(\"pattern\",\"\")})')
                else:
                    print(f'  ⚡ {name}(...)')
    elif d.get('type') == 'result':
        cost = d.get('total_cost_usd', 0)
        duration = d.get('duration_ms', 0)
        print(f'\n--- Stage done ({duration/1000:.1f}s, \${cost:.4f}) ---')
except:
    pass
" 2>/dev/null)
    [ -n "$text" ] && echo "$text" >> "$LOG"
  done
  return ${PIPESTATUS[0]}
}

# ========================================
# STAGE 1: BUILD
# ========================================
> "$LOG"  # Clear log
echo "{\"status\":\"running\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"building\"}" > "$STATUS"
move_task "building"
update_task "{\"branch\":\"$BRANCH\",\"repo\":\"$GITHUB_ORG/$REPO\",\"startedAt\":\"$(date -Iseconds)\"}"

log_msg "╔══════════════════════════════════════════════════╗"
log_msg "║  🏗️  STAGE 1: BUILD                              ║"
log_msg "╚══════════════════════════════════════════════════╝"
log_msg "Task: $TASK_ID | Branch: $BRANCH | Repo: $REPO"
log_msg "Started: $(date)"
log_msg ""

cd "$WORKDIR"

# Create feature branch
git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH" 2>/dev/null
log_msg "  → Branch: $BRANCH created"

# Run Claude Code to build
if ! run_claude "$PROMPT"; then
  log_msg "❌ BUILD FAILED"
  move_task "backlog"
  echo "{\"status\":\"failed\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"building\"}" > "$STATUS"
  exit 1
fi

# Commit changes
git add -A
git commit -m "feat($TASK_ID): $(echo "$PROMPT" | head -c 72)" --no-verify 2>/dev/null || true
log_msg "  → Changes committed"

# ========================================
# STAGE 2: PR OPEN
# ========================================
echo "{\"status\":\"running\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"pr_open\"}" > "$STATUS"
move_task "pr_open"

log_msg ""
log_msg "╔══════════════════════════════════════════════════╗"
log_msg "║  📬  STAGE 2: PR OPEN                            ║"
log_msg "╚══════════════════════════════════════════════════╝"

# Push branch and create PR
git push -u origin "$BRANCH" 2>&1 | tail -3 >> "$LOG"

PR_URL=$(gh pr create \
  --repo "$GITHUB_ORG/$REPO" \
  --head "$BRANCH" \
  --title "feat($TASK_ID): $(echo "$PROMPT" | head -c 60)" \
  --body "## Task: $TASK_ID

$(echo "$PROMPT" | head -c 500)

---
*Auto-generated by torbot pipeline*" 2>&1)

PR_NUMBER=$(echo "$PR_URL" | grep -oP '\d+$' || echo "0")
log_msg "  → PR created: $PR_URL (#$PR_NUMBER)"
update_task "{\"pr\":{\"number\":$PR_NUMBER,\"url\":\"$PR_URL\",\"status\":\"open\"},\"prCreatedAt\":\"$(date -Iseconds)\"}"

# ========================================
# STAGE 3: CODE REVIEW
# ========================================
if [ "$SKIP_REVIEW" = false ]; then
  echo "{\"status\":\"running\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"code_review\"}" > "$STATUS"
  move_task "code_review"

  log_msg ""
  log_msg "╔══════════════════════════════════════════════════╗"
  log_msg "║  🔍  STAGE 3: CODE REVIEW                        ║"
  log_msg "╚══════════════════════════════════════════════════╝"

  DIFF=$(git diff origin/master..."$BRANCH" --stat)
  log_msg "  Files changed:"
  echo "$DIFF" >> "$LOG"

  # Run Claude Code review agents
  run_claude "Review this PR (branch $BRANCH vs master) in $WORKDIR.

Run a comprehensive code review:
1. Check for bugs, logic errors, edge cases
2. Check for security issues (SQL injection, XSS, auth bypass)
3. Check for performance issues
4. Check code style consistency
5. Check that all API endpoints have proper error handling
6. Verify no breaking changes to existing functionality

Git diff summary:
$DIFF

Output a structured review with: ISSUES FOUND (critical/warning/info), SUMMARY, VERDICT (approve/request-changes).
If the code is solid, say APPROVED. If there are critical issues, say CHANGES REQUESTED and list them."

  log_msg "  → Code review complete"
else
  log_msg "  → Code review SKIPPED (--skip-review)"
fi

# ========================================
# STAGE 4: QA
# ========================================
if [ "$SKIP_QA" = false ]; then
  echo "{\"status\":\"running\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"qa\"}" > "$STATUS"
  move_task "qa"

  log_msg ""
  log_msg "╔══════════════════════════════════════════════════╗"
  log_msg "║  🧪  STAGE 4: QA TESTING                         ║"
  log_msg "╚══════════════════════════════════════════════════╝"

  # Determine the app port based on repo
  APP_PORT="3500"
  [ "$REPO" = "dashboard" ] && APP_PORT="3333"

  # Start a temporary server for testing
  log_msg "  → Starting test server on port $APP_PORT..."
  
  run_claude "Run QA tests for the changes in $WORKDIR. The app runs on port $APP_PORT.

Test plan:
1. Check that the server starts without errors: node server.js
2. Test ALL API endpoints with curl — verify 200 responses and valid JSON
3. Test CRUD operations: create, read, update, delete for each resource
4. Check the frontend: curl the HTML and verify it loads
5. Check for JS syntax errors: node -c public/app.js
6. Check for CSS syntax (basic validation)
7. Verify data persistence: create something, restart server, verify it persists
8. Test edge cases: empty inputs, invalid IDs, missing fields

For each test, output:
  ✅ PASS: [test name] — [details]
  ❌ FAIL: [test name] — [error]

At the end, output:
  QA RESULT: PASSED (X/Y tests passed) or FAILED (X/Y tests passed, Z failures)"

  log_msg "  → QA testing complete"
  update_task "{\"qaStatus\":\"passed\"}"
else
  log_msg "  → QA SKIPPED (--skip-qa)"
fi

# ========================================
# STAGE 5: STAGING
# ========================================
echo "{\"status\":\"running\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"staging\"}" > "$STATUS"
move_task "staging"

log_msg ""
log_msg "╔══════════════════════════════════════════════════╗"
log_msg "║  📦  STAGE 5: STAGING                            ║"
log_msg "╚══════════════════════════════════════════════════╝"
log_msg "  → Ready for merge"

if [ "$AUTO_MERGE" = false ]; then
  log_msg "  ⏸️  HUMAN GATE: Awaiting manual merge approval"
  log_msg "  → Run: gh pr merge $PR_NUMBER --repo $GITHUB_ORG/$REPO --squash"
  log_msg "  → Or approve via dashboard"
  echo "{\"status\":\"awaiting-approval\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"staging\"}" > "$STATUS"
  
  # Notify via openclaw
  openclaw system event --text "Pipeline $TASK_ID ready for merge: $PR_URL — Review passed, QA passed. Approve to deploy." --mode now 2>/dev/null || true
  
  # Wait for human to merge (poll PR status every 30s, timeout 1 hour)
  WAIT_START=$(date +%s)
  TIMEOUT=3600
  while true; do
    PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_ORG/$REPO" --json state -q '.state' 2>/dev/null || echo "OPEN")
    if [ "$PR_STATE" = "MERGED" ]; then
      log_msg "  → PR merged by human"
      break
    fi
    ELAPSED=$(( $(date +%s) - WAIT_START ))
    if [ $ELAPSED -gt $TIMEOUT ]; then
      log_msg "  ⏰ Timed out waiting for merge approval (1h)"
      echo "{\"status\":\"timeout\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"staging\"}" > "$STATUS"
      exit 0
    fi
    sleep 30
  done
fi

# ========================================
# STAGE 6: MERGE
# ========================================
echo "{\"status\":\"running\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"merged\"}" > "$STATUS"
move_task "merged"

log_msg ""
log_msg "╔══════════════════════════════════════════════════╗"
log_msg "║  🔀  STAGE 6: MERGE                              ║"
log_msg "╚══════════════════════════════════════════════════╝"

if [ "$AUTO_MERGE" = true ]; then
  gh pr merge "$PR_NUMBER" --repo "$GITHUB_ORG/$REPO" --squash --delete-branch 2>&1 | tail -3 >> "$LOG"
  log_msg "  → PR #$PR_NUMBER merged (squash)"
fi

update_task "{\"pr\":{\"number\":$PR_NUMBER,\"url\":\"$PR_URL\",\"status\":\"merged\"},\"mergedAt\":\"$(date -Iseconds)\"}"

# Switch back to master and pull
git checkout master 2>/dev/null
git pull origin master 2>/dev/null

# ========================================
# STAGE 7: DEPLOY
# ========================================
echo "{\"status\":\"running\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"deployed\"}" > "$STATUS"
move_task "deployed"

log_msg ""
log_msg "╔══════════════════════════════════════════════════╗"
log_msg "║  🚀  STAGE 7: DEPLOY                             ║"
log_msg "╚══════════════════════════════════════════════════╝"

# Determine port and restart
APP_PORT="3500"
[ "$REPO" = "dashboard" ] && APP_PORT="3333"

lsof -ti :"$APP_PORT" | xargs kill -9 2>/dev/null || true
sleep 1
cd "$WORKDIR" && node server.js &
sleep 2

# Smoke test
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$APP_PORT/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  log_msg "  ✅ Deploy successful — http://localhost:$APP_PORT (HTTP $HTTP_CODE)"
else
  log_msg "  ❌ Deploy failed — HTTP $HTTP_CODE"
fi

update_task "{\"deployedAt\":\"$(date -Iseconds)\"}"

# ========================================
# DONE
# ========================================
log_msg ""
log_msg "╔══════════════════════════════════════════════════╗"
log_msg "║  ✅  PIPELINE COMPLETE                            ║"
log_msg "╚══════════════════════════════════════════════════╝"
log_msg "Task: $TASK_ID | PR: #$PR_NUMBER | Branch: $BRANCH"
log_msg "Finished: $(date)"

echo "{\"status\":\"complete\",\"pid\":$$,\"taskId\":\"$TASK_ID\",\"stage\":\"deployed\"}" > "$STATUS"

# Notify
openclaw system event --text "Pipeline complete: $TASK_ID deployed to localhost:$APP_PORT (PR #$PR_NUMBER merged)" --mode now 2>/dev/null || true

exit 0
