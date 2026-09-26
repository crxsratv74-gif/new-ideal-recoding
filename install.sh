#!/usr/bin/env bash
set -euo pipefail
npm install
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --only-shell
