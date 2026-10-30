#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYASH_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI="$PYASH_ROOT/command/unified-writer-cli.mjs"
BASE_PREFIX="${ANDRII_BASE_PREFIX:-meeting-qwen-auto}"
NORM_PREFIX="${BASE_PREFIX}-normalized"

if [[ $# -eq 0 ]]; then
  exec node "$CLI" next --writer andrii
fi

if [[ "$1" == "--list" ]]; then
  shift
  exec node "$CLI" list --writer andrii "$@"
fi

if [[ "$1" == "--redo" ]]; then
  shift
  STAGE="${1:-}"
  if [[ -z "$STAGE" ]]; then
    echo "Usage: ./run-next-story.sh --redo <normalize|prep|full|image|verify|publish> --meeting <selector>" >&2
    exit 2
  fi
  shift

  case "$STAGE" in
    normalize)
      MEETING=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --meeting) MEETING="${2:-}"; shift 2 ;;
          *) echo "Unknown arg for --redo normalize: $1" >&2; exit 2 ;;
        esac
      done
      if [[ -z "$MEETING" ]]; then
        echo "--redo normalize requires --meeting <selector>" >&2
        exit 2
      fi
      INSPECT="$(node "$CLI" inspect --writer andrii --meeting "$MEETING")"
      TRANSCRIPT_DIR="$(printf '%s\n' "$INSPECT" | awk -F': ' '/^transcript_dir:/ {print $2}')"
      if [[ -z "$TRANSCRIPT_DIR" || ! -d "$TRANSCRIPT_DIR" ]]; then
        echo "Could not resolve transcript_dir from meeting selector: $MEETING" >&2
        exit 1
      fi
      exec node "$SCRIPT_DIR/program/normalize-transcript-from-transcript-folder.mjs" "$TRANSCRIPT_DIR" "$BASE_PREFIX" "$NORM_PREFIX"
      ;;
    prep|full|image|verify|publish)
      exec node "$CLI" rerun-stage --writer andrii --stage "$STAGE" "$@"
      ;;
    *)
      echo "Unsupported --redo stage: $STAGE" >&2
      echo "Supported: normalize, prep, full, image, verify, publish" >&2
      exit 2
      ;;
  esac
fi

if [[ "$1" == "--meeting" ]]; then
  exec node "$CLI" run --writer andrii "$@"
fi

case "$1" in
  -*) exec node "$CLI" next --writer andrii "$@" ;;
  *)
    CMD="$1"
    shift
    exec node "$CLI" "$CMD" --writer andrii "$@"
    ;;
esac
