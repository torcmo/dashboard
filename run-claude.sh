#!/bin/bash
# Wrapper: runs Claude Code and streams output to dashboard log file + auto-updates kanban
LOG="/home/torbot/.openclaw/workspace/dashboard/data/claude-code.log"
STATUS="/home/torbot/.openclaw/workspace/dashboard/data/claude-status.json"
DASHBOARD="http://localhost:3333"
mkdir -p "$(dirname "$LOG")"

# Parse task ID from env or args
# Usage: TASK_ID=ob-01 bash run-claude.sh "prompt"
#    or: bash run-claude.sh --task ob-01 "prompt"
TASK_ID="${TASK_ID:-}"
PROMPT_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)
      TASK_ID="$2"
      shift 2
      ;;
    *)
      PROMPT_ARGS+=("$1")
      shift
      ;;
  esac
done

# Clear log for fresh session
> "$LOG"

# Write status
echo "{\"status\":\"running\",\"pid\":$$,\"taskId\":\"$TASK_ID\"}" > "$STATUS"

# Move task to inprogress if task ID provided
if [ -n "$TASK_ID" ]; then
  curl -s -X PUT "$DASHBOARD/api/tasks/$TASK_ID/move" \
    -H "Content-Type: application/json" \
    -d "{\"to\":\"inprogress\",\"index\":0}" > /dev/null 2>&1
  echo "=== Task $TASK_ID moved to In Progress ===" >> "$LOG"
fi

# Write start marker
echo "=== Claude Code started: $(date) ===" >> "$LOG"
echo "=== Working dir: $PWD ===" >> "$LOG"
[ -n "$TASK_ID" ] && echo "=== Task: $TASK_ID ===" >> "$LOG"
echo "" >> "$LOG"

# Run claude with stream-json so we get real-time output
# Parse JSON stream to extract readable text for the terminal
stdbuf -oL claude --permission-mode bypassPermissions --verbose --output-format stream-json --print "${PROMPT_ARGS[@]}" 2>&1 | while IFS= read -r line; do
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
                    pat = inp.get('pattern', '')
                    print(f'  ⚡ Grep({pat})')
                elif name == 'TodoWrite':
                    print(f'  ⚡ TodoWrite(...)')
                elif name == 'ToolSearch':
                    print(f'  ⚡ ToolSearch(...)')
                else:
                    print(f'  ⚡ {name}(...)')
    elif d.get('type') == 'result':
        result = d.get('result', '')
        cost = d.get('total_cost_usd', 0)
        duration = d.get('duration_ms', 0)
        print(f'\n--- Done ({duration/1000:.1f}s, \${cost:.4f}) ---')
except:
    pass
" 2>/dev/null)
  
  if [ -n "$text" ]; then
    echo "$text" >> "$LOG"
  fi
done

EXIT=${PIPESTATUS[0]}

echo "" >> "$LOG"
echo "=== Claude Code exited (code $EXIT): $(date) ===" >> "$LOG"

# Auto-move task to done if successful and task ID provided
if [ -n "$TASK_ID" ]; then
  if [ "$EXIT" -eq 0 ]; then
    curl -s -X PUT "$DASHBOARD/api/tasks/$TASK_ID/move" \
      -H "Content-Type: application/json" \
      -d "{\"to\":\"done\",\"index\":0}" > /dev/null 2>&1
    echo "=== Task $TASK_ID moved to Done ✅ ===" >> "$LOG"
  else
    # Failed — move back to todo
    curl -s -X PUT "$DASHBOARD/api/tasks/$TASK_ID/move" \
      -H "Content-Type: application/json" \
      -d "{\"to\":\"todo\",\"index\":0}" > /dev/null 2>&1
    echo "=== Task $TASK_ID moved back to Todo (exit code $EXIT) ❌ ===" >> "$LOG"
  fi
fi

# Write final status
echo "{\"status\":\"exited\",\"pid\":$$,\"code\":$EXIT,\"taskId\":\"$TASK_ID\"}" > "$STATUS"

exit $EXIT
