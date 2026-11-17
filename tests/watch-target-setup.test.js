/**
 * TERRITORY WALK - Node tests
 * v1.1 Apple Watch（コンパニオン）の組み込み・CI配線
 *   1) Watch アプリは3要素だけ（地図＋陣地マス / ＋－ / マーキングON/OFF）
 *   2) Info.plist に WKApplication と WKCompanionAppBundleIdentifier
 *   3) ターゲット追加スクリプトが Watch 用 Bundle ID・埋め込み・バージョン一致を扱う
 *   4) CI は変数 ENABLE_WATCH_TARGET=true のときだけ Watch を組み込む（既定OFF）
 *   5) watchOS 最小バージョンとアイコン（アルファ無し）の生成
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const WATCH_APP = read('watch', 'TerritoryWatch', 'TerritoryWatchApp.swift');
const WATCH_MODEL = read('watch', 'TerritoryWatch', 'WatchModel.swift');
const WATCH_PLIST = read('watch', 'TerritoryWatch', 'Info.plist');
const BRIDGE_SWIFT = read('watch', 'ios', 'WatchBridgePlugin.swift');
const ADD_TARGET = read('scripts', 'add-watch-target.rb');
const CONFIGURE_WATCH = read('scripts', 'configure-watch.js');
const ASSET_SCRIPT = read('scripts', 'generate-watch-assets.py');
const WORKFLOW = read('.github', 'workflows', 'ios-build.yml');
const WATCH_README = read('watch', 'README.md');

/* ------------------------------------------------------------------ *
 * 1: 3要素だけ
 * ------------------------------------------------------------------ */

test('Watch画面: 3要素（地図＋陣地マス / ＋－ / マーキングON/OFF）だけ', () => {
    assert.match(WATCH_APP, /Map\(position: \$model\.camera/, '地図');
    assert.match(WATCH_APP, /MapPolygon\(coordinates:/, '陣地マス');
    assert.match(WATCH_APP, /"plus"/, 'ズームイン');
    assert.match(WATCH_APP, /"minus"/, 'ズームアウト');
    assert.match(WATCH_APP, /model\.toggleMarking\(\)/, 'マーキングON/OFF');
    assert.match(WATCH_APP, /マーキング ON/, 'ON表示');
    assert.match(WATCH_APP, /停止中/, 'OFF表示');
    // 画面に余計なタブ・設定・リストを足していない
    assert.doesNotMatch(WATCH_APP, /TabView|List\s*\{/, '3要素以外の画面を足さない');
});

test('Watch: 位置情報を取りに行かない（Phase 1はコンパニオン）', () => {
    assert.doesNotMatch(WATCH_MODEL, /CLLocationManager\(/, 'Watch側で測位を開始しない');
    assert.match(WATCH_MODEL, /updateApplicationContext|didReceiveApplicationContext/, 'iPhoneから受け取る');
    assert.match(WATCH_MODEL, /"cmd": "toggle", "to": next/, 'ON/OFFはiPhoneへ送る');
    assert.match(WATCH_MODEL, /"cmd": "window"/, 'ズームで窓サイズを要求');
});

test('Watch: マスの色は iPhone と同じ解決を通す（歩いた跡が浮かない）', () => {
    const bridge = read('watch-bridge.js');
    assert.match(bridge, /resolveTileTeam\(/, '初期配置・実績・非表示ピンを同じ関数で解決');
    assert.match(bridge, /g \+= team === 'white' \? '1'/, '1=白で送る');
});

/* ------------------------------------------------------------------ *
 * 2: Info.plist
 * ------------------------------------------------------------------ */

test('Watch Info.plist: WKApplication と コンパニオン Bundle ID', () => {
    assert.match(WATCH_PLIST, /<key>WKApplication<\/key>\s*<true\/>/, 'WKApplication');
    assert.match(WATCH_PLIST, /<key>WKCompanionAppBundleIdentifier<\/key>\s*<string>com\.oekaki\.territorywalk<\/string>/);
    assert.match(WATCH_PLIST, /\$\(MARKETING_VERSION\)/, 'バージョンはビルド設定から');
});

/* ------------------------------------------------------------------ *
 * 3: ターゲット追加スクリプト
 * ------------------------------------------------------------------ */

test('pbxproj: Watch用Bundle ID・watchos・埋め込み・バージョン一致', () => {
    assert.match(ADD_TARGET, /com\.oekaki\.territorywalk\.watchkitapp/);
    assert.match(ADD_TARGET, /SDKROOT'\] = 'watchos'/);
    assert.match(ADD_TARGET, /TARGETED_DEVICE_FAMILY'\] = '4'/);
    assert.match(ADD_TARGET, /Embed Watch Content/);
    assert.match(ADD_TARGET, /CONTENTS_FOLDER_PATH\)\/Watch/, 'Watch/ へ埋め込む');
    assert.match(ADD_TARGET, /WATCH_EMBED=plugins/, 'PlugIns 埋め込みへの切替');
    assert.match(ADD_TARGET, /MARKETING_VERSION'\] = APP_MARKETING_VERSION/, 'iPhoneと同じバージョン');
    assert.match(ADD_TARGET, /CURRENT_PROJECT_VERSION'\] = APP_BUILD_NUMBER/, 'iPhoneと同じビルド番号');
    assert.match(ADD_TARGET, /ASSETCATALOG_COMPILER_APPICON_NAME'\] = 'AppIcon'/);
});

test('配置: WatchBridgePlugin を App ターゲットへ入れ、packageClassList に登録する', () => {
    assert.match(CONFIGURE_WATCH, /packageClassList/);
    assert.match(CONFIGURE_WATCH, /WatchBridgePlugin/);
    assert.match(CONFIGURE_WATCH, /silent\.wav/);
    assert.match(CONFIGURE_WATCH, /WatchSessionManager\.shared\.activate\(\)/);
    assert.match(BRIDGE_SWIFT, /CAPBridgedPlugin/, 'Capacitor 6 の自動登録に対応');
    assert.match(BRIDGE_SWIFT, /public let jsName = "WatchBridge"/);
    assert.match(BRIDGE_SWIFT, /import WatchConnectivity/);
});

test('無音通知: sound に無音の音源を指定する（sound=nil ではWatchが振動しない）', () => {
    assert.match(BRIDGE_SWIFT, /UNNotificationSound\(named: UNNotificationSoundName\(soundFileName\)\)/);
    assert.match(BRIDGE_SWIFT, /soundFileName = "silent\.wav"/);
});

/* ------------------------------------------------------------------ *
 * 4: CI の配線（既定OFF・mainのみ）
 * ------------------------------------------------------------------ */

test('CI: トリガーは main のみ（作業ブランチではビルドしない）', () => {
    assert.match(WORKFLOW, /branches: \[ "main" \]/);
    assert.doesNotMatch(WORKFLOW, /feat\/v1\.1/, '作業ブランチをトリガーにしない');
});

test('CI: Watch 組み込みステップは変数ONのときだけ走る形で用意されている', () => {
    const step = read('ci', 'watch-step.yml');
    assert.match(step, /if: vars\.ENABLE_WATCH_TARGET == 'true'/, '既定は組み込まない');
    assert.match(step, /run: bash ci\/watch-setup\.sh/, '実処理はウォッチ用スクリプトに置く');

    const setup = read('ci', 'watch-setup.sh');
    assert.match(setup, /set -e/, '途中で失敗したら止まる');
    assert.match(setup, /node scripts\/configure-watch\.js/);
    assert.match(setup, /ruby scripts\/add-watch-target\.rb/);
    assert.match(setup, /python3 scripts\/generate-watch-assets\.py/);
    assert.match(setup, /WATCH_EMBED=plugins/, 'PlugIns 埋め込みの再試行');
    assert.match(setup, /CURRENT_PROJECT_VERSION/, 'iPhone と同じビルド番号を渡す');
});

test('CI: 適用スクリプトは冪等に挿入でき、正本と写しが揃う', () => {
    const os = require('node:os');
    const { applyTo, stripExisting, MARKER } =
        require(path.join(ROOT, 'scripts', 'apply-watch-workflow-step.js'));
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'ios-build.yml');
    const mirrorPath = path.join(ROOT, 'ci', 'ios-build.yml');
    const source = fs.readFileSync(workflowPath, 'utf8');
    const temp = path.join(os.tmpdir(), `ios-build-${process.pid}.yml`);
    // 挿入済みの ワークフローでも同じ冪等性を検証できるよう、いったんステップを外してから始める
    fs.writeFileSync(temp, stripExisting(source));
    try {
        const before = fs.readFileSync(temp, 'utf8');
        assert.ok(!before.includes('ENABLE_WATCH_TARGET'), '取り外した状態から始める');
        assert.equal(applyTo(temp), true, '1回目は挿入する');
        const once = fs.readFileSync(temp, 'utf8');
        assert.equal(applyTo(temp), false, '2回目以降は変更しない（重複しない）');
        const twice = fs.readFileSync(temp, 'utf8');
        assert.equal(once, twice);
        assert.equal(once.split(MARKER).length, 2, 'ステップは1つだけ');
        assert.ok(once.indexOf('ENABLE_WATCH_TARGET') < once.indexOf('Compile & Verify iOS Build'),
            'pod install の後・ビルドの前に挿入される');
        assert.equal(source, once, '正本 .github/workflows/ios-build.yml がスクリプトの出力と一致する');
        assert.equal(fs.readFileSync(mirrorPath, 'utf8'), source, '写し ci/ios-build.yml も正本と一致する');
    } finally {
        fs.rmSync(temp, { force: true });
    }
});

test('ドキュメント: 有効化手順と実機確認が書かれている', () => {
    assert.match(WATCH_README, /ENABLE_WATCH_TARGET/);
    assert.match(WATCH_README, /apply-watch-workflow-step/);
    assert.match(WATCH_README, /com\.oekaki\.territorywalk\.watchkitapp/);
    assert.match(WATCH_README, /Apple Watch SE 3/, '実機（SE3）で確認する');
    assert.match(WATCH_README, /TestFlight/);
    const docs = read('docs', 'v1.1-privacy-watch.md');
    assert.match(docs, /feat\/v1\.1-privacy-watch/);
    assert.match(docs, /v1\.0 の審査通過後/, 'v1.0審査後にマージする');
});

/* ------------------------------------------------------------------ *
 * 5: アセット生成
 * ------------------------------------------------------------------ */

test('アイコン: 明るい背景・アルファ無しで全サイズを生成する', () => {
    assert.match(ASSET_SCRIPT, /BACKGROUND = \(244, 244, 245\)/, '黒背景を避ける');
    assert.match(ASSET_SCRIPT, /convert\("RGBA"\)/, '元アイコンはRGBAで読み込み');
    assert.match(ASSET_SCRIPT, /canvas = Image\.new\("RGB"/, '出力はRGB（アルファ無し）');
    assert.match(ASSET_SCRIPT, /watch-marketing/, '1024のApp Store用アイコン');
    assert.match(ASSET_SCRIPT, /notificationCenter/);
    assert.match(ASSET_SCRIPT, /appLauncher/);
});

test('無音音源: 有効な WAV を生成する（30秒以内）', () => {
    assert.match(ASSET_SCRIPT, /seconds = 0\.5/);
    assert.match(ASSET_SCRIPT, /b"RIFF"/);
    assert.match(ASSET_SCRIPT, /b"WAVE"/);
});

test('watchOS 最小バージョンは 10.0（SwiftUI Map の下限）', () => {
    assert.match(ADD_TARGET, /WATCHOS_DEPLOYMENT_TARGET/, '変数で管理');
    assert.match(ADD_TARGET, /'10\.0'/);
});
