# Apple Watch（コンパニオン）— v1.1 Phase 1

テリトリーウォークの Watch アプリは **iPhone のコンパニオン**として動く。
Watch 画面は3要素だけ（①地図＋陣地マス ②＋／－ ③マーキングON/OFF）。

## 構成

```
watch/
  TerritoryWatch/
    TerritoryWatchApp.swift   画面（SwiftUI + MapKit）
    WatchModel.swift          WCSession 受信・ズーム・ON/OFF・窓データ
    Info.plist                WKApplication / WKCompanionAppBundleIdentifier
    Assets.xcassets/          CI が生成（scripts/generate-watch-assets.py）
  ios/
    WatchBridgePlugin.swift   iPhone側 Capacitor プラグイン（WatchConnectivity + 無音通知）
    silent.wav                CI が生成（無音通知音。sound=nil だと Watch が振動しないため）
scripts/
  generate-watch-assets.py    Watchアイコン（明るい背景）＋無音wav を生成
  configure-watch.js          生成された ios/ へファイルを配置し packageClassList を更新
  add-watch-target.rb         pbxproj に Watch ターゲット・Embed Watch Content を追加
```

JS 側の窓口は `watch-bridge.js`（`window.Capacitor.Plugins.WatchBridge`）。
プラグインが無いビルド（Web・Watch未対応）では何もしない。

## CI への組み込み（既定は OFF）

Watch の組み込みステップは `ci/watch-step.yml` に用意してある。
`.github/workflows/ios-build.yml` への挿入は次の1コマンド（冪等）。

```bash
node scripts/apply-watch-workflow-step.js
```

なぜスクリプトか: Pickle の GitHub 連携（GitHub App）は `.github/workflows/` を書き換える権限を
持っていないため、ワークフローの変更だけは本人の push で反映する必要がある。
挿入したらワークフローは次のように動く。

- ステップ名: `Add watchOS companion target (optional, vars.ENABLE_WATCH_TARGET=true)`
- `vars.ENABLE_WATCH_TARGET == 'true'` のときだけ走る（既定は何もしない）
- 走る位置: pod install の後、クリーンビルドの前（Swift のコンパイルエラーを署名前に検出）

理由: Watch 用 Bundle ID（`com.oekaki.territorywalk.watchkitapp`）が
Apple Developer / App Store Connect に無い状態で配信まで進むと、署名/検証で落ちるため。
v1.0 の審査が終わるまでは **変数を入れない**（＝従来どおり iOS 単体でビルド）。

## 有効化の手順（ASC 側の登録が済んだあと）

1. Apple Developer / App Store Connect で Watch 用 Bundle ID
   `com.oekaki.territorywalk.watchkitapp` を登録（App ID 種別: App、Watch App 用）。
2. ワークフローへステップを挿入（未挿入の import 時のみ）:
   `node scripts/apply-watch-workflow-step.js` → commit → push
3. GitHub リポジトリの Settings → Secrets and variables → Actions → Variables で
   `ENABLE_WATCH_TARGET` = `true` を追加。
4. `feat/v1.1-privacy-watch` を `main` にマージ（v1.0 の審査通過後）。
   以降の main push で Watch ターゲット込みのアーカイブ＆TestFlight 配信になる。
5. TestFlight で実機（Apple Watch SE 3）にインストールし、下の「実機確認」を実施。

## 実機確認（初回だけは必ず）

- iPhone と Watch をペアリングし、Watch 側にアプリが自動インストールされること
- iPhone で数十メートル歩くと Watch のマスが増えること（`updateApplicationContext`）
- Watch の ＋／－ でマスの表示範囲が変わること（`sendMessage {cmd:"window", r}`）
- Watch のマーキング ON/OFF で iPhone 側の状態が変わること（`setMarkingPaused`）
- 陣地獲得時の無音通知：`WatchBridge.notifyCapture('claim','1マス獲得')` を
  Safari の Web Inspector から叩き、手首が振動すること（`silent.wav` が効いているか）
- アプリを閉じている間、月曜9時の結果通知が音を出さずに通知センターへ入ること

## 初回ビルドで落ちやすいところ（切り分けメモ）

| 症状 | 見どころ | 対処 |
| --- | --- | --- |
| `must be embedded in the parent app bundle's PlugIns directory` | Embed 先 | ワークフローが自動で `WATCH_EMBED=plugins` を再実行 |
| `Cycle inside App` | build phase の順序 | スクリプトが Embed Watch Content を Thin Binary の前に移動 |
| 署名で Watch のプロファイルが無い | Bundle ID 登録漏れ | 手順1を先に済ませる |
| `Invalid Image ... alpha channel` | Watchアイコン | 生成スクリプトは RGB（アルファ無し）で出力済み |
| アイコン未設定の警告 | Assets | `python3 scripts/generate-watch-assets.py` を実行したか |
| プラグインが `undefined` | 自動登録 | `ios/App/App/capacitor.config.json` の `packageClassList` を確認 |

## 仕様メモ

- Watch は位置情報を取りに行かない（Phase 1）。許可ダイアログは増えない。
- Watch のマスの色は iPhone と同じ解決（初期配置のハッシュ・実績・非表示ピン）を通す。
  そのため **Watch を見ても「歩いた跡」が浮かない**。
- 黒チームは Watch ではアンバーで描く（黒地図上で見えなくなるため）。
- Watch 単独 GPS（Phase 2）は `transferUserInfo` → `watch-inbox.json` → 既存 Outbox の順で
  受ける口だけ用意済み（`drainInbox`）。
