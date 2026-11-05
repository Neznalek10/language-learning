#!/usr/bin/env bash
# Runs every automated test in the project: the Python unittest suite, then the JavaScript suite.
#
# Usage: tools/test.sh   (from any folder; it moves to the repository root first)
# Both suites always run, so one failure does not hide the other. The script exits 1 when either fails.
# Python tests need the project venv (venv/, see requirements.txt). JavaScript tests run under gjs,
# falling back to node when gjs is not installed.
set -euo pipefail

# Work from the repository root so every relative path below resolves the same way from any caller folder.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Fail early with the fix when the venv is missing, instead of a "No such file" error from the Python step.
check_venv() {
  if [[ ! -x venv/bin/python ]]; then
    echo "venv/bin/python not found. Create the venv: python3 -m venv venv && venv/bin/pip install -r requirements.txt" >&2
    exit 1
  fi
}

# Runs the Python unittest suite; returns its exit status without stopping the script.
# An empty suite (exit 5) counts as a failure, so tests that stop being discovered are noticed.
run_python_tests() {
  echo "== Python tests =="
  local status=0
  venv/bin/python -m unittest discover -s tests -t . -p "test_*.py" -v || status=$?
  return "$status"
}

# Runs the JavaScript suite with gjs, or node when gjs is missing; returns its exit status.
run_js_tests() {
  echo "== JavaScript tests =="
  if command -v gjs >/dev/null 2>&1; then
    gjs -m tests/js/run.mjs
  elif command -v node >/dev/null 2>&1; then
    node tests/js/run.mjs
  else
    echo "Neither gjs nor node is installed; cannot run the JavaScript tests." >&2
    return 127
  fi
}

# Runs both suites and records each status, so a failing suite does not skip the other one.
main() {
  local python_status=0 js_status=0
  check_venv
  run_python_tests || python_status=$?
  run_js_tests || js_status=$?
  if [[ $python_status -ne 0 || $js_status -ne 0 ]]; then
    echo "Tests failed: Python exit $python_status, JavaScript exit $js_status." >&2
    exit 1
  fi
  echo "All tests passed."
}

main "$@"
