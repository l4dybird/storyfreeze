#!/bin/bash

set -euo pipefail

function run() {
  local fixture=$1
  echo "Start $fixture"
  pnpm --dir "$fixture" run test:storybook10-e2e
  echo "Success $fixture"
  echo ""
}

if [ -n "${1:-}" ]; then
  run "$1"
else
  for fixture in examples/*; do
    if [ -d "$fixture" ]; then
      run "$fixture"
    fi
  done
fi

echo "Storybook compatibility fixtures completed successfully 🎉"
