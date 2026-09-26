#!/usr/bin/env bash
# DepTend — OpenCode task runner for the 2026-09-25 fix/improvement pass.
#
# Runs the five staged task files in .opencode-tasks/ SEQUENTIALLY (they touch
# overlapping files: package.json/lockfile, CHANGELOG.md — AGENTS.md §0a's
# high-conflict set), each as one `opencode run` invocation. Expect up to 5
# interactive approval prompts (one per invocation) — that is the only
# interaction this script needs from you.
#
# Binary note: uses the nvm OpenCode binary explicitly. The homebrew install
# (/opt/homebrew/bin/opencode, 1.15.13) is stale and crashes on the shared
# storage schema (NOT NULL constraint failed: session_message.seq) — do not
# let PATH pick it.
#
# Order: TASK-03 (deps) → TASK-04 (core deps block) → TASK-02 (rate limiter)
# → TASK-01 (home perf) → TASK-05 (docs drift, last so it reflects final
# state). Each task file documents both orderings of the 03/04 interaction.
#
# Continue-on-error: a failed task does not stop the run — failures are
# reported at the end and the full §6 verification gate runs last, which is
# the acceptance check for the whole pass.
#
# Per-task output is saved to .opencode-tasks/logs/<task>.log for review.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OC="$HOME/.nvm/versions/node/v22.23.1/bin/opencode"
LOGS_DIR="$SCRIPT_DIR/logs"

mkdir -p "$LOGS_DIR"
printf 'logs/\n' > "$SCRIPT_DIR/.gitignore"

if [[ ! -f "$OC" ]]; then
  echo "ERROR: OpenCode binary not found at $OC" >&2
  echo "Check: which -a opencode  — and pin the newest binary's path in this script." >&2
  exit 1
fi

cd "$REPO_ROOT" || exit 1

# §0a lock hygiene: expired locks are fair game — clean them up if seen.
NOW=$(date -u +%s)
for lock in .agent-locks/*.lock; do
  [[ -e "$lock" ]] || continue
  expires=$(python3 -c "import json,sys;d=json.load(open('$lock'));print(d.get('expires',''))" 2>/dev/null)
  exp_ts=$(python3 -c "from datetime import datetime;print(int(datetime.fromisoformat('$expires'.replace('Z','+00:00')).timestamp()))" 2>/dev/null)
  if [[ -n "$exp_ts" && "$exp_ts" -lt "$NOW" ]]; then
    echo "Removing expired lock: $lock"
    rm -f "$lock"
  fi
done

TASKS=(
  ".opencode-tasks/TASK-03-dep-vulnerabilities.md"
  ".opencode-tasks/TASK-04-core-dependencies-block.md"
  ".opencode-tasks/TASK-02-rate-limiter-failures.md"
  ".opencode-tasks/TASK-01-home-perf-regression.md"
  ".opencode-tasks/TASK-05-docs-drift.md"
)

PROMPT_TEMPLATE="Load the task file at %s and follow it exactly. Work inside this repository (drop-in-ready files, matching AGENTS.md conventions). Load .opencode/skills/actually-code before writing code. When done, run the task's verification gate in order and report every result, including any step you could not complete and why. Do not commit."

FAILED=0
for task_file in "${TASKS[@]}"; do
  name="$(basename "$task_file" .md)"
  echo ""
  echo "=== [$name] starting $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
  printf -- "$PROMPT_TEMPLATE\n" "$task_file" > "$LOGS_DIR/$name.prompt.txt"
  "$OC" run "$(printf -- "$PROMPT_TEMPLATE" "$task_file")" > "$LOGS_DIR/$name.log" 2>&1
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "=== [$name] FAILED rc=$rc — log: $LOGS_DIR/$name.log (continuing) ==="
    FAILED=$((FAILED + 1))
  else
    echo "=== [$name] finished rc=0 — log: $LOGS_DIR/$name.log ==="
  fi
done

echo ""
echo "=== Final §6 verification gate (the acceptance check for the whole pass) ==="
GATE_RC=0
pnpm run typecheck || GATE_RC=1
pnpm -r test || GATE_RC=1
pnpm run build || GATE_RC=1
pnpm run lint || GATE_RC=1
pnpm run format:check || GATE_RC=1

echo ""
echo "=== Summary ==="
echo "Tasks run: ${#TASKS[@]}, failed: $FAILED"
echo "Final gate: $([[ $GATE_RC -eq 0 ]] && echo PASS || echo FAIL)"
echo ""
echo "git status (uncommitted changes from the pass — review before staging):"
git status --short
echo ""
echo "Per-task logs: $LOGS_DIR/"
if [[ $GATE_RC -ne 0 ]]; then
  echo ""
  echo "NOTE: the final gate FAILED — the tree is broken. Do not stage/PR until fixed."
fi
exit $GATE_RC
