#!/usr/bin/env bash
set -euo pipefail

# Builds the tinbot .vsix package and copies it into distribute/.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DISTRIBUTE_DIR="$ROOT_DIR/distribute"

cd "$ROOT_DIR"
npm install
npx vsce package

mkdir -p "$DISTRIBUTE_DIR"
mv ./*.vsix "$DISTRIBUTE_DIR/"

echo "Package placed in $DISTRIBUTE_DIR"
