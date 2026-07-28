#!/usr/bin/env bash
# 計測スクリプトの実行ラッパ（node は nvm 配下にあるため読み込む）
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")/.."
exec node test/measure-stability.mjs "$@"
