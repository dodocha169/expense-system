#!/usr/bin/env bash
# WSL 上でテストを実行するためのラッパ。
# node は nvm 配下にあり、非対話シェルでは PATH に載らないため明示的に読み込む。
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")/.."
exec node --test test/*.test.mjs
