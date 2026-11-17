#!/usr/bin/env bash
# Apple Watch（コンパニオン）ターゲットを iOS プロジェクトへ組み込む。
# CI では vars.ENABLE_WATCH_TARGET == 'true' のときだけ呼ばれる（ci/watch-step.yml）。
#
# pod install の後に実行すること（App ターゲットの build phase を触るため）。

set -e

# ビルド番号は iPhone 側と揃える（ずれるとアップロード検証で落ちる）
export CURRENT_PROJECT_VERSION="${CURRENT_PROJECT_VERSION:-${GITHUB_RUN_NUMBER:-1}}"

echo "=== xcodeproj gem ==="
ruby -e "require 'xcodeproj'; puts 'xcodeproj ' + Xcodeproj::VERSION" \
  || gem install xcodeproj --no-document

echo "=== Watch icons + silent sound ==="
python3 scripts/generate-watch-assets.py

echo "=== Copy Watch sources / bridge into generated iOS project ==="
node scripts/configure-watch.js

echo "=== Add Watch target to pbxproj ==="
ruby scripts/add-watch-target.rb \
  || WATCH_EMBED=plugins ruby scripts/add-watch-target.rb

echo "=== Targets after injection ==="
xcodebuild -list -project ios/App/App.xcodeproj
