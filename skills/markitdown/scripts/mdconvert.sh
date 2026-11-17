#!/usr/bin/env bash
# mdconvert.sh — convert documents to Markdown for LLM reading.
# usage: mdconvert.sh [-o outdir] [--plugins] <file>...
set -euo pipefail

outdir=""
plugins=0
files=()

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) outdir=${2:?missing outdir}; shift 2 ;;
    --plugins) plugins=1; shift ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) files+=("$1"); shift ;;
  esac
done

if [ ${#files[@]} -eq 0 ]; then
  echo "usage: mdconvert.sh [-o outdir] [--plugins] <file>..." >&2
  exit 2
fi

if ! command -v markitdown >/dev/null 2>&1; then
  for c in "$HOME/.local/bin/markitdown" /opt/homebrew/bin/markitdown /usr/local/bin/markitdown; do
    if [ -x "$c" ]; then PATH="$(dirname "$c"):$PATH"; export PATH; break; fi
  done
fi
if ! command -v markitdown >/dev/null 2>&1; then
  echo "markitdown not found. Install: uv tool install 'markitdown[all]'" >&2
  exit 127
fi

args=()
[ "$plugins" = 1 ] && args+=(--use-plugins)

status=0
used=" "
for f in "${files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "skip (not a file): $f" >&2
    status=1
    continue
  fi

  base=$(basename "$f")
  stem=${base%.*}
  if [ -n "$outdir" ]; then
    mkdir -p "$outdir"
    out="$outdir/$stem.md"
  else
    out="$(dirname "$f")/$stem.md"
  fi
  case "$used" in *" $out "*) out="${out%.md}.${base#*.}.md" ;; esac
  used="$used$out "

  if ! markitdown "$f" ${args[@]+"${args[@]}"} -o "$out" 2>/dev/null; then
    echo "FAILED: $f" >&2
    status=1
    continue
  fi

  chars=$(wc -m < "$out" | tr -d ' ')
  echo "$out  (${chars} chars)"
  if [ "$chars" -lt 40 ]; then
    echo "  WARN: almost no text extracted — likely a scanned PDF or image. Use OCR (see SKILL.md)." >&2
    status=1
  fi
done

exit "$status"
