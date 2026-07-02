#!/usr/bin/env bash
# hook-body.sh — git hook body for post-commit / post-checkout.
# Install into .git/hooks/post-commit and .git/hooks/post-checkout
# (managed by setup.sh or `ai-catapult graph-hooks install`; never tracked).
#
# Rebase/merge/cherry-pick skip guards — lifted verbatim from
# graphify/graphify/hooks.py lines 51-55.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
[ -d "$GIT_DIR/rebase-merge" ] && exit 0
[ -d "$GIT_DIR/rebase-apply" ] && exit 0
[ -f "$GIT_DIR/MERGE_HEAD" ]  && exit 0
[ -f "$GIT_DIR/CHERRY_PICK_HEAD" ] && exit 0
# Resolve-then-delegate: honor GRAPH_HOOKS_WRAPPER or walk parents for wrapper.
WRAPPER="${GRAPH_HOOKS_WRAPPER:-}"
DIR="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && pwd)"
while [ -z "$WRAPPER" ] && [ "$DIR" != "/" ] && [ "$DIR" != "$HOME" ]; do
    [ -f "$DIR/scripts/graph-refresh.sh" ] && [ -d "$DIR/.git" ] && WRAPPER="$DIR/scripts/graph-refresh.sh"
    DIR="$(dirname "$DIR")"
done
[ -z "$WRAPPER" ] && exit 0
(cd "$(dirname "$(dirname "$WRAPPER")")" && bash "$WRAPPER") &
