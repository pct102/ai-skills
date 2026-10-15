#!/usr/bin/env bash
# link-skills.sh — point ~/.claude/skills/<name> at this repo's skills/<name>.
# Claude Code and opencode both read ~/.claude/skills, so after this one `git pull` updates both.
#
#   link-skills.sh [--hook] [target-dir]
#
# --hook  also install a git post-merge hook, so every `git pull` re-links (picks up new skills).
# A real directory in the way is moved to ~/.claude/skills-backup-<time>, never deleted.
# Links to skills that no longer exist in the repo are removed. Other skills are left alone.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
hook=0; [ "${1:-}" = "--hook" ] && { hook=1; shift; }
target=${1:-$HOME/.claude/skills}
backup=$HOME/.claude/skills-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$target"

for d in "$repo"/skills/*/; do
  src=${d%/}; name=$(basename "$src"); link=$target/$name
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$src" ] && continue
    rm "$link"
  elif [ -e "$link" ]; then
    mkdir -p "$backup"; mv "$link" "$backup/"; echo "backed up  $name -> $backup/"
  fi
  ln -s "$src" "$link"; echo "linked     $name"
done

for l in "$target"/*; do
  [ -L "$l" ] || continue
  case "$(readlink "$l")" in "$repo"/skills/*) [ -e "$l" ] || { rm "$l"; echo "removed    $(basename "$l") (gone from repo)"; } ;; esac
done

if [ "$hook" = 1 ]; then
  printf '#!/bin/sh\nexec bash "%s/tools/link-skills.sh"\n' "$repo" > "$repo/.git/hooks/post-merge"
  chmod +x "$repo/.git/hooks/post-merge"; echo "hook       .git/hooks/post-merge installed"
fi
echo "done: $(ls "$target" | wc -l) entries in $target"
