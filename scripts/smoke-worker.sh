#!/usr/bin/env bash
set -euo pipefail

DM_API_BASE="${API_BASE:-${DM_API_BASE:-}}" node scripts/worker-smoke.mjs
