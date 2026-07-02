#!/usr/bin/env bash
# scripts/graph-refresh.sh — lock+coalesce wrapper for {{ENGINE}} --update
#
# Install location: scripts/graph-refresh.sh (umbrella or standalone repo root).
# Called by: child-repo git hooks (hook-body.sh) and harness hooks (Stop event).
#
# Token: {{ENGINE}} — replaced by ai-catapult graph-hooks install.
#        Default value: graphify
#        Alternative:   graphwiki
#
# ENGINE_OUT_DIR: derived in shell as "${ENGINE}-out" (e.g. graphify-out,
#        graphwiki-out). No separate template token needed; Slice 6 token
#        normalization only needs to handle {{ENGINE}}.
#
# CONTRACT (Slice 1, graph-hooks spec):
#   - Engine-absent no-op: `command -v {{ENGINE}}` check; exits 0 silently.
#   - Never blocks the caller: actual work is detached into the background
#     (subshell redirected to log + disown). The hook-facing call returns
#     exit 0 immediately.
#   - Lock+coalesce: one engine run at a time via `mkdir`-based lock (atomic
#     on macOS + Linux). A trigger that arrives while a run is active marks
#     AT MOST ONE pending rerun (a marker file). When the active run finishes,
#     if the marker exists the wrapper runs once more (clearing the marker
#     first). Bursts of N triggers → ≤2 engine runs total.
#   - All output → ${ENGINE}-out/refresh.log; nothing reaches the terminal.
#   - Exits 0 always (hook callers must never see a non-zero from this script).
#
# --status flag (optional debug aid):
#   Prints lock/pending/log-tail info; exits 0. Used by SessionStart hooks
#   for validate-only checks (no engine run).
#
# .git-dir PRECONDITION:
#   The sentinel walk in hook-body.sh stops only at directories that contain
#   both scripts/graph-refresh.sh AND a .git/ dir. This wrapper therefore
#   assumes it is always invoked from a directory that is the root of a git
#   repository (or a symlinked equivalent). Invocations outside a git repo
#   are unsupported and may resolve REPO_ROOT incorrectly.
#
# DETACH APPROACH (non-blocking + fd isolation):
#   We redirect the background subshell's stdin/stdout/stderr explicitly
#   (</dev/null >>"$LOG_FILE" 2>&1) before detaching with `disown`.
#   This is critical for git-hook callers: the hook runner holds a pipe on
#   fd 0/1/2, and if the background process inherits those fds the pipe stays
#   open for the entire engine run (proven ~4s block). By redirecting before
#   disown, the background process holds no reference to the caller's pipe
#   descriptors, so the caller sees EOF immediately.
#   `disown` removes the job from the shell's job table, preventing SIGHUP
#   when the hook-calling shell exits.  This pattern works on macOS (bash
#   3.2+) and Linux.
#
# LOCK DESIGN (PID-annotated mkdir lock + foreground acquire):
#   - The lock is stored at ${ENGINE}-out/graph-refresh-lock (repo-root,
#     co-located with the log file — no TMPDIR).
#   - The lock acquire/pending-mark decision is made in the FOREGROUND before
#     spawning any background subshell. This is what makes coalescing work:
#     only one background runner is ever spawned; subsequent callers that lose
#     the foreground acquire simply set the pending marker and return.
#   - Acquire: `mkdir "$LOCK_DIR"` (atomic). Write $$ to $LOCK_DIR/pid.
#   - Stale-lock recovery: if acquire fails, read the pid file — if empty or
#     `kill -0 <pid>` fails (process gone), rm -rf the stale lock and retry
#     the acquire ONCE. This handles SIGKILL'd runs.
#   - Release: `trap 'rm -rf "$LOCK_DIR"' EXIT` inside _run_engine ensures
#     the lock is released on normal exit AND on signals (SIGTERM, etc.).
#   - PID-reuse edge (accepted): between kill -0 failing and rm -rf, a new
#     unrelated process could reuse the pid. This window is vanishingly small
#     and the consequence is a missed-recovery (next trigger will reclaim), so
#     it is documented as an accepted race rather than guarded further.
#
# LOST-UPDATE WINDOW (bounded re-check):
#   After releasing the lock, _run_engine re-checks the pending marker once.
#   If a new trigger arrived in the brief window between the last marker-check
#   and lock release, we attempt one more lock acquire + run cycle. This is
#   bounded (no loop) and handles the most common race without complexity.

ENGINE="{{ENGINE}}"

# ── Resolve repo root via BASH_SOURCE (works when called via symlink) ─────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LOG_DIR="$REPO_ROOT/${ENGINE}-out"
LOG_FILE="$LOG_DIR/refresh.log"
LOCK_DIR="$LOG_DIR/graph-refresh-lock"
PENDING_MARKER="$LOG_DIR/graph-refresh-pending"

# ── --status flag ─────────────────────────────────────────────────────────────
if [ "${1:-}" = "--status" ]; then
  echo "=== graph-refresh status ==="
  echo "engine    : $ENGINE"
  echo "repo root : $REPO_ROOT"
  echo "lock      : $([ -d "$LOCK_DIR" ] && echo LOCKED || echo unlocked)"
  echo "pending   : $([ -f "$PENDING_MARKER" ] && echo YES || echo no)"
  echo "log       : $LOG_FILE"
  if [ -f "$LOG_FILE" ]; then
    echo "--- last 10 log lines ---"
    tail -n 10 "$LOG_FILE"
  fi
  exit 0
fi

# ── Engine-absent no-op ───────────────────────────────────────────────────────
command -v "$ENGINE" >/dev/null 2>&1 || exit 0

# ── Ensure log dir exists before detaching ───────────────────────────────────
# Must be done in the foreground so LOG_FILE is available for the redirect
# below. The guard keeps this from aborting the hook caller on permission
# errors (e.g. read-only fs) — we silently give up rather than fail the hook.
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

# ── Foreground lock acquire / pending-mark ───────────────────────────────────
# This decision happens in the foreground (before any background spawn) so that
# only one background runner is ever in-flight at a time. Callers that lose the
# acquire simply set the pending marker and return; they do NOT spawn a new job.

_fg_try_acquire() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    # Write "RUNNING" sentinel immediately. The background subshell will
    # overwrite this with its actual $BASHPID as its very first action.
    # Stale detection (below) treats "RUNNING" as live — this closes the
    # window between foreground mkdir and background pid-write where another
    # caller would otherwise see an empty/dead pid and steal the lock.
    echo "RUNNING" > "$LOCK_DIR/pid"
    return 0
  fi
  # Lock exists — check if holder is alive (stale-lock recovery).
  local held_pid
  held_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"
  # "RUNNING" means the background subshell is starting up — treat as live.
  if [ "$held_pid" = "RUNNING" ]; then
    return 1
  fi
  if [ -z "$held_pid" ] || ! kill -0 "$held_pid" 2>/dev/null; then
    # Stale lock — reclaim.
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "RUNNING" > "$LOCK_DIR/pid"
      return 0
    fi
  fi
  return 1
}

if ! _fg_try_acquire; then
  # A live run is in progress — mark ONE pending rerun and exit immediately.
  touch "$PENDING_MARKER"
  exit 0
fi

# We hold the lock. Spawn exactly one background runner.

# ── Background engine runner ──────────────────────────────────────────────────
_run_engine() {
  # Update the pid file to the background subshell's own PID so that stale-lock
  # detection works correctly. The foreground _fg_try_acquire wrote "RUNNING";
  # now we overwrite with the real PID. $BASHPID is bash 4+ only; on macOS
  # bash 3.2 we use the POSIX-portable `sh -c 'echo $PPID'` trick instead.
  sh -c 'echo $PPID' > "$LOCK_DIR/pid"

  # Ensure lock is released on any exit (normal or signalled).
  trap 'rm -rf "$LOCK_DIR"' EXIT

  # cd to repo root so {{ENGINE}} . --update resolves correctly regardless of
  # the caller's cwd (Slice 2 children may exec this from arbitrary directories).
  cd "$REPO_ROOT" || return

  # Loop: run engine, then check for pending marker.
  while true; do
    # Clear any pending marker before this run starts.
    rm -f "$PENDING_MARKER"

    {
      echo "--- graph-refresh: $(date '+%Y-%m-%dT%H:%M:%S') ---"
      "$ENGINE" . --update
    } >> "$LOG_FILE" 2>&1

    # After the run: if a NEW pending marker appeared during this run, loop
    # once more (clearing the marker is done at the top of the loop).
    if [ -f "$PENDING_MARKER" ]; then
      continue
    fi
    break
  done

  # Release the lock explicitly before the post-release re-check so the
  # re-check sees the lock as free.
  rm -rf "$LOCK_DIR"
  trap - EXIT  # disable trap — already released

  # ── Post-release re-check (lost-update guard) ────────────────────────────
  # A trigger that arrived in the window between the last marker-check above
  # and the lock release would have seen the lock held, set the pending marker,
  # but found no runner left to service it. Check once and re-run if needed.
  if [ -f "$PENDING_MARKER" ]; then
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      sh -c 'echo $PPID' > "$LOCK_DIR/pid"
      trap 'rm -rf "$LOCK_DIR"' EXIT
      rm -f "$PENDING_MARKER"
      {
        echo "--- graph-refresh (post-release recheck): $(date '+%Y-%m-%dT%H:%M:%S') ---"
        "$ENGINE" . --update
      } >> "$LOG_FILE" 2>&1
    fi
  fi
}

# ── Detach actual work into the background ───────────────────────────────────
# Redirect stdin/stdout/stderr explicitly so the background subshell holds no
# reference to the caller's pipe fds. This is the critical fix for git-hook
# callers: without </dev/null the background process keeps the hook's stdin
# pipe open for the entire engine run, blocking the caller.
( _run_engine ) </dev/null >>"$LOG_FILE" 2>&1 &
disown

exit 0
