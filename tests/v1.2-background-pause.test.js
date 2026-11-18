/**
 * TERRITORY WALK - Node tests
 * v1.2 電池最適化（画面非表示時の停止と復帰）と GPS watcher の停止／再開
 *
 *   1) document.hidden の間は 8秒ポーリングと1秒カウントダウンを止める（タイマー起床ゼロ）
 *      - 非表示に切り替わった直後の1回分もスキップする（二重ガード）
 *   2) 復帰時はカウントダウンを即時更新し、陣地を1回だけ取り直す（連続復帰では重ねない）
 *   3) visibilitychange の配線: 画面非表示で止め、復帰で戻す
 *      - 歩行記録用のバックグラウンド測位 watcher は止めない（別物）
 *   4) マーキング停止中はどの導線からもバックグラウンド watcher を起こさない
 *   5) 停止中でも「現在地」ボタンのワンショット測位は動く（watcher は張らない）
 *   6) 再開で watcher を張り直す
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = readAppSource();

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ *
 * 最小限の環境（document / window / localStorage / setInterval をすべて記録）
 * ------------------------------------------------------------------ */
function loadApp(options = {}) {
    const storage = options.storage || {};
    const documentListeners = {};
    const windowListeners = {};
    const elements = options.elements || {};
    const timers = { intervals: new Map(), nextId: 1, cleared: [] };

    const documentStub = {
        hidden: options.hidden === true,
        body: { dataset: {} },
        getElementById: (id) => elements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: (type, handler) => {
            (documentListeners[type] = documentListeners[type] || []).push(handler);
        },
        dispatch(type) {
            (documentListeners[type] || []).forEach((handler) => handler({ type }));
        }
    };

    const windowStub = Object.assign({
        addEventListener: (type, handler) => {
            (windowListeners[type] = windowListeners[type] || []).push(handler);
        }
    }, options.window || {});

    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: documentStub,
        navigator: options.navigator || {},
        window: windowStub,
        localStorage: {
            getItem: (key) => (key in storage ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; }
        },
        setTimeout,
        clearTimeout,
        setInterval: (fn, ms) => {
            const id = timers.nextId++;
            timers.intervals.set(id, { fn, ms });
            return id;
        },
        clearInterval: (id) => {
            timers.intervals.delete(id);
            timers.cleared.push(id);
        }
    };

    const context = vm.createContext(sandbox);
    vm.runInContext(APP_SOURCE, context, { filename: 'app.js' });

    return {
        context,
        document: documentStub,
        window: windowStub,
        storage,
        timers,
        TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context),
        /** 登録中のタイマーをすべて1回ずつ発火させる */
        fireTimers() {
            [...timers.intervals.values()].forEach((timer) => timer.fn());
        }
    };
}

/** コンストラクタを通さず、テストに必要な状態だけを持つインスタンスを作る */
function createApp(loaded, overrides = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    Object.assign(app, {
        remoteTilesPollTimer: null,
        resetCountdownTimer: null,
        updateResetCountdown: null,
        lastForegroundRefreshAt: 0,
        backgroundGeolocationPlugin: null,
        backgroundWatcherId: null,
        backgroundWatcherStarted: false,
        watchId: null,
        nativeWatchId: null,
        nativeGeolocationAttempt: 0,
        geolocationStarted: false,
        servicesStarted: true,
        markingPaused: false,
        powerSaveMode: false,
        isAppInBackground: false,
        backgroundClaimCount: 0,
        virtualPos: null,
        map: null,
        syncQueue: null,
        locationBanner: null,
        watchBridge: null,
        gridManager: null,
        lastRealPosition: null,
        savedPosition: null
    }, overrides);

    app.remoteTilesCalls = 0;
    app.countdownUpdates = 0;
    app.loadRemoteTiles = () => { app.remoteTilesCalls += 1; return Promise.resolve(); };
    app.updateResetCountdown = () => { app.countdownUpdates += 1; };
    app.showToast = () => {};
    app.updateGPSStatus = () => {};
    app.updatePlayerMarker = () => {};
    app.layoutTopNotices = () => {};
    app.repositionToastContainer = () => {};
    app.refreshGlobalTeamCounts = () => {};
    app.initWatchBridge = () => {};
    app.notifyWatchState = () => {};
    return app;
}

/** バックグラウンド位置情報プラグイン（addWatcher / removeWatcher を数える） */
function createBackgroundPlugin() {
    const calls = { addWatcher: 0, removeWatcher: [] };
    return {
        calls,
        async addWatcher() {
            calls.addWatcher += 1;
            return 'watcher-1';
        },
        async removeWatcher(args) {
            calls.removeWatcher.push(args);
            return true;
        }
    };
}

/** ネイティブの Geolocation プラグイン（ワンショット測位のみ） */
function createNativeGeolocation(position) {
    const calls = { getCurrentPosition: 0, watchPosition: 0, clearWatch: [] };
    return {
        calls,
        async getCurrentPosition() {
            calls.getCurrentPosition += 1;
            return position || { coords: { latitude: 34.6, longitude: 135.6 } };
        },
        async watchPosition() {
            calls.watchPosition += 1;
            return 'native-watch';
        },
        async clearWatch(id) {
            calls.clearWatch.push(id);
            return true;
        }
    };
}

/* ------------------------------------------------------------------ *
 * 1. 8秒ポーリング・1秒カウントダウンの開始／停止
 * ------------------------------------------------------------------ */

test('停止: 8秒ポーリングと1秒カウントダウンを二重起動せずに張る', () => {
    const loaded = loadApp();
    const app = createApp(loaded);

    assert.equal(app.startRemoteTilesPolling(), true);
    assert.equal(app.startResetCountdown(), true);
    assert.equal(loaded.timers.intervals.size, 2);

    // 2回目は何もしない（タイマーが増えない）
    assert.equal(app.startRemoteTilesPolling(), false);
    assert.equal(app.startResetCountdown(), false);
    assert.equal(loaded.timers.intervals.size, 2);

    // 間隔はアプリの定数どおり（8秒 / 1秒）
    const intervals = [...loaded.timers.intervals.values()].map((t) => t.ms).sort((a, b) => a - b);
    assert.deepEqual(intervals, [1000, 8000]);
});

test('停止: pauseForegroundUpdates でタイマーを clearInterval し、復帰で張り直す', () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    app.startRemoteTilesPolling();
    app.startResetCountdown();
    const before = [...loaded.timers.intervals.keys()];

    assert.equal(app.pauseForegroundUpdates(), true);
    assert.equal(loaded.timers.intervals.size, 0, 'タイマー起床ゼロ');
    assert.deepEqual(loaded.timers.cleared.sort(), before.sort(), '両方 clearInterval する');
    assert.equal(app.remoteTilesPollTimer, null);
    assert.equal(app.resetCountdownTimer, null);

    // 同じ画面で何もしない（止まっているものは止められない）
    assert.equal(app.pauseForegroundUpdates(), false);

    app.resumeForegroundUpdates();
    assert.equal(loaded.timers.intervals.size, 2, '復帰で両方張り直す');
});

/* ------------------------------------------------------------------ *
 * 2. 非表示中の通信スキップ（二重ガード）と復帰時の1回だけの取り直し
 * ------------------------------------------------------------------ */

test('非表示: タイマーが残っていても document.hidden 中は loadRemoteTiles を呼ばない', () => {
    const loaded = loadApp({ hidden: true });
    const app = createApp(loaded);
    app.startRemoteTilesPolling();

    loaded.fireTimers();
    loaded.fireTimers();
    assert.equal(app.remoteTilesCalls, 0, '非表示中は通信しない');
});

test('表示中: タイマーが発火すると loadRemoteTiles を1回呼ぶ', () => {
    const loaded = loadApp({ hidden: false });
    const app = createApp(loaded);
    app.startRemoteTilesPolling();

    loaded.fireTimers();
    assert.equal(app.remoteTilesCalls, 1);
});

test('非表示: カウントダウンも document.hidden 中は更新しない', () => {
    const loaded = loadApp({ hidden: true });
    const app = createApp(loaded);
    app.startResetCountdown();

    loaded.fireTimers();
    assert.equal(app.countdownUpdates, 0);
});

test('復帰: カウントダウンを即時更新し、陣地は1回だけ取り直す', () => {
    const loaded = loadApp({ hidden: false });
    const app = createApp(loaded);
    app.pauseForegroundUpdates();

    assert.equal(app.resumeForegroundUpdates(), true);
    assert.equal(app.countdownUpdates, 1, '止めていた分をすぐ追いつかせる');
    assert.equal(app.remoteTilesCalls, 1, '取り直しは1回だけ');
    assert.equal(loaded.timers.intervals.size, 2, 'タイマーも戻る');
});

test('復帰: 1秒以内の連続復帰では陣地を取り直さない（通信を重ねない）', () => {
    const loaded = loadApp();
    const app = createApp(loaded);

    assert.equal(app.resumeForegroundUpdates(), true);
    assert.equal(app.remoteTilesCalls, 1);

    assert.equal(app.resumeForegroundUpdates(), false, '直後の復帰では通信しない');
    assert.equal(app.remoteTilesCalls, 1);
    assert.equal(app.countdownUpdates, 2, 'カウントダウンは毎回復帰で即時更新する');
});

/* ------------------------------------------------------------------ *
 * 3. visibilitychange の配線
 * ------------------------------------------------------------------ */

test('配線: visibilitychange で非表示は止まり、復帰で戻る（バックグラウンド測位は止めない）', async () => {
    const plugin = createBackgroundPlugin();
    const loaded = loadApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: (name) => name === 'BackgroundGeolocation',
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);
    app.initLifecycleListeners();

    // 稼働中の状態を作る（タイマー2本＋バックグラウンド watcher ON）
    app.startRemoteTilesPolling();
    app.startResetCountdown();
    app.backgroundWatcherStarted = true;
    app.backgroundWatcherId = 'watcher-1';
    app.backgroundGeolocationPlugin = plugin;

    // 画面が非表示になる
    loaded.document.hidden = true;
    loaded.document.dispatch('visibilitychange');
    assert.equal(loaded.timers.intervals.size, 0, '8秒ポーリングとカウントダウンを止める');
    assert.equal(app.isAppInBackground, true);
    assert.equal(app.backgroundWatcherStarted, true, '歩行記録用の測位は止めない');
    assert.equal(plugin.calls.removeWatcher.length, 0, 'removeWatcher は呼ばない');

    // 復帰
    loaded.document.hidden = false;
    loaded.document.dispatch('visibilitychange');
    assert.equal(app.isAppInBackground, false);
    assert.equal(app.countdownUpdates, 1, '復帰時にカウントダウンを即時更新');
    assert.equal(app.remoteTilesCalls, 1, '復帰時に陣地を1回だけ取り直す');
    assert.equal(loaded.timers.intervals.size, 2, 'タイマーを張り直す');
    await tick();
});

test('配線: Capacitor の appStateChange でも非表示は止め、復帰で戻す', () => {
    let stateListener = null;
    const loaded = loadApp();
    const app = createApp(loaded);
    loaded.window.Capacitor = {
        Plugins: {
            App: {
                addListener: (event, handler) => { if (event === 'appStateChange') stateListener = handler; }
            }
        }
    };
    app.initLifecycleListeners();
    app.startRemoteTilesPolling();
    app.startResetCountdown();
    assert.equal(typeof stateListener, 'function');

    stateListener({ isActive: false });
    assert.equal(loaded.timers.intervals.size, 0, 'ネイティブのバックグラウンドでも止める');

    stateListener({ isActive: true });
    assert.equal(loaded.timers.intervals.size, 2, '復帰で戻す');
});

/* ------------------------------------------------------------------ *
 * 4. マーキング停止中は watcher を起こさない
 * ------------------------------------------------------------------ */

test('停止中: startBackgroundGeolocation は addWatcher を呼ばない', async () => {
    const plugin = createBackgroundPlugin();
    const loaded = loadApp();
    const app = createApp(loaded, { markingPaused: true });

    assert.equal(app.startBackgroundGeolocation(plugin), false);
    await tick();
    assert.equal(plugin.calls.addWatcher, 0, 'GPS 消費はゼロのまま');
    assert.equal(app.backgroundWatcherStarted, false);
});

test('停止中: 位置情報バナーの「再確認」からも watcher を起こさない', async () => {
    const plugin = createBackgroundPlugin();
    const loaded = loadApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: (name) => name === 'BackgroundGeolocation',
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded, { markingPaused: true });

    app.recheckLocationPermission();
    await tick();
    assert.equal(plugin.calls.addWatcher, 0);
});

test('停止中: 省電力モードの切り替えでも watcher を起こさない', () => {
    const plugin = createBackgroundPlugin();
    const loaded = loadApp();
    const app = createApp(loaded, {
        markingPaused: true,
        powerSaveMode: false,
        backgroundGeolocationPlugin: plugin,
        backgroundWatcherStarted: false
    });

    assert.equal(app.restartGeolocationWatcher(), false);
    assert.equal(plugin.calls.addWatcher, 0);
});

/* ------------------------------------------------------------------ *
 * 5. 停止中でも「現在地」ボタンのワンショット測位は動く
 * ------------------------------------------------------------------ */

test('停止中: 現在地ボタンはワンショット測位だけを行い、watcher は張らない', async () => {
    const geo = createNativeGeolocation({ coords: { latitude: 34.61, longitude: 135.51 } });
    const plugin = createBackgroundPlugin();
    const loaded = loadApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: (name) => name === 'BackgroundGeolocation' || name === 'Geolocation',
                Plugins: { BackgroundGeolocation: plugin, Geolocation: geo }
            }
        }
    });
    const app = createApp(loaded, { markingPaused: true });
    let markerPositions = 0;
    app.updatePlayerMarker = () => { markerPositions += 1; };

    const pos = await app.requestFreshPosition();

    assert.equal(Number(pos[0]), 34.61, '最新の現在地を返す（緯度）');
    assert.equal(Number(pos[1]), 135.51, '最新の現在地を返す（経度）');
    assert.equal(geo.calls.getCurrentPosition, 1, 'ワンショット測位は1回');
    assert.equal(geo.calls.watchPosition, 0, 'watchPosition は張らない');
    assert.equal(plugin.calls.addWatcher, 0, 'バックグラウンド watcher も張らない');
    assert.ok(markerPositions >= 1, '停止中でもピン位置は更新する');
    assert.equal(app.isMarkingPaused(), true, '停止状態は維持される');
});

/* ------------------------------------------------------------------ *
 * 6. 再開で watcher を張り直す
 * ------------------------------------------------------------------ */

test('再開: setMarkingPaused(false) でバックグラウンド watcher を張り直す', async () => {
    const plugin = createBackgroundPlugin();
    const loaded = loadApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: (name) => name === 'BackgroundGeolocation',
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded, { markingPaused: true, markingToggleBound: true });
    app.initGeolocation = loaded.TerritoryWalkApp.prototype.initGeolocation.bind(app);

    app.setMarkingPaused(false);
    await tick();

    assert.equal(app.isMarkingPaused(), false);
    assert.equal(plugin.calls.addWatcher, 1, '再開で1本だけ張る');
    assert.equal(app.backgroundWatcherStarted, true);
});

/* ------------------------------------------------------------------ *
 * 7. ソース配線（Canvas 化・ポーリングの入口）
 * ------------------------------------------------------------------ */

test('配線: 地図は preferCanvas: true で、マス描画も同じキャンバスを使う', () => {
    assert.match(APP_SOURCE, /preferCanvas:\s*true/, 'L.map のオプションで Canvas を優先する');

    const gridSource = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    assert.match(gridSource, /resolveCanvasRenderer\(\)/, '共通キャンバスの解決を通す');
    assert.match(gridSource, /map\.options\.preferCanvas === true/, 'preferCanvas のとき共通レンダラを使う');
});

test('配線: 8秒ポーリングは startRemoteTilesPolling 経由で張る（裸の setInterval を残さない）', () => {
    assert.match(APP_SOURCE, /this\.startRemoteTilesPolling\(\)/);
    assert.match(APP_SOURCE, /REMOTE_TILES_POLL_MS/);
    assert.doesNotMatch(APP_SOURCE, /setInterval\(\(\) => \{\s*this\.loadRemoteTiles\(\);\s*\}, 8000\)/);
    assert.doesNotMatch(APP_SOURCE, /setInterval\(updateTimer, 1000\)/);
    assert.doesNotMatch(APP_SOURCE, /fetchAndRenderTilesInBounds/, '存在しないメソッドを呼ばない（復帰時の例外を防ぐ）');
});
