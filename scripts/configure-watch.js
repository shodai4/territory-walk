/**
 * TERRITORY WALK - configure-watch.js
 * `npx cap add ios` / `npx cap sync ios` の直後に走らせて、Apple Watch（コンパニオン）の
 * ファイルを生成された iOS プロジェクトへ配置する。pbxproj の書き換えは add-watch-target.rb。
 *
 * やること（すべて冪等）
 *   1. watch/TerritoryWatch/*.swift と Info.plist と Assets.xcassets を ios/App/TerritoryWatch/ へコピー
 *   2. watch/ios/WatchBridgePlugin.swift を ios/App/App/ へコピー
 *   3. watch/ios/silent.wav を ios/App/App/ へコピー（無音通知用）
 *   4. ios/App/App/capacitor.config.json の packageClassList に WatchBridgePlugin を追加
 *   5. AppDelegate.swift に WatchSessionManager.shared.activate() を1行（best-effort）
 *
 * 使い方:
 *    node scripts/configure-watch.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WATCH_SRC = path.join(ROOT, 'watch');
const IOS_APP = path.join(ROOT, 'ios', 'App');
const WATCH_DEST = path.join(IOS_APP, 'TerritoryWatch');
const APP_DEST = path.join(IOS_APP, 'App');

const PLUGIN_CLASS = 'WatchBridgePlugin';

function log(message) {
    console.log(`[watch] ${message}`);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
    if (!fs.existsSync(from)) {
        throw new Error(`watch source missing: ${path.relative(ROOT, from)}`);
    }
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
    return true;
}

function copyDir(from, to) {
    if (!fs.existsSync(from)) return false;
    ensureDir(to);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyDir(src, dest);
        } else {
            fs.copyFileSync(src, dest);
        }
    }
    return true;
}

/** Watch アプリ本体（Swift + Info.plist + Assets） */
function copyWatchApp() {
    if (!fs.existsSync(IOS_APP)) {
        throw new Error('ios/App がありません（先に npx cap add ios を実行してください）');
    }
    ensureDir(WATCH_DEST);
    const swiftFiles = fs.readdirSync(path.join(WATCH_SRC, 'TerritoryWatch'))
        .filter((name) => name.endsWith('.swift'));
    swiftFiles.forEach((name) => {
        copyFile(path.join(WATCH_SRC, 'TerritoryWatch', name), path.join(WATCH_DEST, name));
    });
    copyFile(path.join(WATCH_SRC, 'TerritoryWatch', 'Info.plist'), path.join(WATCH_DEST, 'Info.plist'));
    if (copyDir(path.join(WATCH_SRC, 'TerritoryWatch', 'Assets.xcassets'), path.join(WATCH_DEST, 'Assets.xcassets'))) {
        log('Assets.xcassets（Watchアイコン）を配置');
    }
    log(`Watchソース ${swiftFiles.length} 本を ios/App/TerritoryWatch/ へ配置`);
}

/** iPhone 側のブリッジ（App ターゲットに置く） */
function copyBridge() {
    ensureDir(APP_DEST);
    copyFile(path.join(WATCH_SRC, 'ios', 'WatchBridgePlugin.swift'),
        path.join(APP_DEST, 'WatchBridgePlugin.swift'));
    const sound = path.join(WATCH_SRC, 'ios', 'silent.wav');
    if (fs.existsSync(sound)) {
        copyFile(sound, path.join(APP_DEST, 'silent.wav'));
        log('無音通知音 silent.wav を配置');
    } else {
        log('silent.wav が無いため通知音は既定（iOSは無音）にフォールバック');
    }
    log('WatchBridgePlugin.swift を App ターゲットへ配置');
}

/**
 * Capacitor 6 は capacitor.config.json の packageClassList に載ったクラスを
 * NSClassFromString で自動登録する（CLI が plugins の一覧を書く場所）。
 */
function patchPackageClassList() {
    const configPath = path.join(APP_DEST, 'capacitor.config.json');
    if (!fs.existsSync(configPath)) {
        log('capacitor.config.json が見つからないため packageClassList の更新をスキップ');
        return false;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const list = Array.isArray(config.packageClassList) ? config.packageClassList : [];
    if (!list.includes(PLUGIN_CLASS)) {
        list.push(PLUGIN_CLASS);
    }
    config.packageClassList = Array.from(new Set(list)).sort();
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, '\t')}\n`);
    log(`packageClassList: ${config.packageClassList.join(', ')}`);
    return true;
}

/** AppDelegate で WCSession を起動しておく（プラグインの load() でも起動するので補助） */
function patchAppDelegate() {
    const delegatePath = path.join(APP_DEST, 'AppDelegate.swift');
    if (!fs.existsSync(delegatePath)) {
        log('AppDelegate.swift が見つからないためスキップ');
        return false;
    }
    let source = fs.readFileSync(delegatePath, 'utf8');
    if (source.includes('WatchSessionManager.shared.activate()')) {
        log('AppDelegate は設定済み');
        return true;
    }
    const anchor = /(func application\([^\n]*didFinishLaunchingWithOptions[^\n]*\{\n)/;
    if (!anchor.test(source)) {
        log('AppDelegate の起動メソッドが見つからないためスキップ（プラグインの load() で起動します）');
        return false;
    }
    source = source.replace(anchor, '$1        WatchSessionManager.shared.activate()\n');
    if (!source.includes('import WatchConnectivity')) {
        source = source.replace('import Capacitor', 'import Capacitor\nimport WatchConnectivity');
    }
    fs.writeFileSync(delegatePath, source);
    log('AppDelegate に WatchSessionManager.shared.activate() を追加');
    return true;
}

function main() {
    copyWatchApp();
    copyBridge();
    patchPackageClassList();
    patchAppDelegate();
    log('configure-watch: 完了（pbxproj は scripts/add-watch-target.rb が更新します）');
    return 0;
}

if (require.main === module) {
    try {
        process.exit(main());
    } catch (error) {
        console.error(`[watch] ${error.message}`);
        process.exit(1);
    }
}

module.exports = { copyWatchApp, copyBridge, patchPackageClassList, patchAppDelegate };
