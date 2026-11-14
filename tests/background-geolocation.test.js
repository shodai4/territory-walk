/**
 * TERRITORY WALK - Node tests
 * バックグラウンド位置情報（@capacitor-community/background-geolocation）
 *   1) ネイティブ addWatcher 経路（Plugins 経由 / registerPlugin 経由）
 *   2) 権限拒否（NOT_AUTHORIZED）が常設バナーへ繋がる
 *   3) watcher の二重起動防止・removeWatcher での停止
 *   4) Web ブラウザ（Capacitor なし／プラグイン未組込）での navigator.geolocation フォールバック
 *   5) D-Pad 仮想散歩中の実GPSによる上書き防止
 *   6) iOS 設定（Info.plist）と依存関係の点検
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const { LocationPermissionBanner } = require(path.join(ROOT, 'permission.js'));

/* ------------------------------------------------------------------ *
 * 最小限のDOMスタブ（jsdomを使わず、app.js を vm 上で動かす）
 * ------------------------------------------------------------------ */
function createClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        contains: (name) => set.has(name),
        values: () => [...set]
    };
}

function createStubElement(id, { hidden = false } = {}) {
    const listeners = {};
    return {
        id,
        classList: createClassList(hidden ? ['hidden'] : []),
        style: {},
        dataset: {},
        listeners,
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        dispatch(type) {
            (listeners[type] || []).forEach((handler) => handler({ type, preventDefault() {} }));
        },
        getBoundingClientRect() {
            return { top: 0, bottom: 150, height: 150, left: 0, right: 375, width: 375 };
        },
        setAttribute() {}
    };
}

function createStubDocument() {
    const elements = {
        'location-permission-banner': createStubElement('location-permission-banner', { hidden: true }),
        'btn-location-banner-close': createStubElement('btn-location-banner-close'),
        'btn-location-banner-retry': createStubElement('btn-location-banner-retry')
    };
    const docListeners = {};
    return {
        elements,
        listeners: docListeners,
        body: { dataset: {} },
        addEventListener(type, handler) {
            (docListeners[type] = docListeners[type] || []).push(handler);
        },
        getElementById: (id) => elements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => []
    };
}

/**
 * permission.js と app.js を同じ vm コンテキストに読み込み、
 * TerritoryWalkApp のプロトタイプを返す（コンストラクタは重いので使わない）。
 */
function loadTerritoryWalkApp(options = {}) {
    const doc = options.document || createStubDocument();
    const storage = options.storage || {};
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: doc,
        navigator: options.navigator || {},
        window: options.window || {},
        localStorage: {
            getItem: (key) => (key in storage ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; }
        },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {}
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'permission.js'), 'utf8'), context, { filename: 'permission.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), context, { filename: 'app.js' });

    return {
        context,
        document: doc,
        TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context)
    };
}

/** initGeolocation を動かすのに必要な最小限のアプリインスタンス */
function createApp(loaded, overrides = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    Object.assign(app, {
        watchId: null,
        backgroundGeolocationPlugin: null,
        backgroundWatcherId: null,
        backgroundWatcherStarted: false,
        nativeWatchId: null,
        virtualPos: [34.6662, 135.6276],
        lastRealPosition: null,
        lastProcessedLat: null,
        lastProcessedLng: null,
        currentMeshId: null,
        currentTeam: 'black',
        isAppInBackground: false,
        backgroundClaimCount: 0,
        isDebugMode: false,
        debugEnabled: true,
        map: null,
        gpsStatuses: [],
        claims: [],
        toasts: [],
        markerUpdates: 0
    }, overrides);

    app.updateGPSStatus = (label) => { app.gpsStatuses.push(label); };
    app.updatePlayerMarker = () => { app.markerUpdates += 1; };
    app.processMeshAndClaim = (lat, lng) => {
        app.claims.push([lat, lng]);
        return Promise.resolve({ changed: true });
    };
    app.showToast = (message) => { app.toasts.push(message); };
    app.repositionToastContainer = () => {};
    return app;
}

/** 位置情報プラグインのスタブ（addWatcher は watcher ID を返す Promise） */
function createNativePlugin(options = {}) {
    const calls = { addWatcher: 0, removeWatcher: [] };
    const plugin = {
        calls,
        options: null,
        callback: null,
        async addWatcher(watchOptions, callback) {
            calls.addWatcher += 1;
            plugin.options = watchOptions;
            plugin.callback = callback;
            if (options.addWatcherError) throw options.addWatcherError;
            return options.watcherId || 'watcher-1';
        },
        async removeWatcher(args) {
            calls.removeWatcher.push(args);
            return true;
        }
    };
    return plugin;
}

function createWebGeolocation() {
    const calls = { watchPosition: 0, getCurrentPosition: 0, clearWatch: [] };
    return {
        calls,
        watchPosition(success) {
            calls.watchPosition += 1;
            return 77;
        },
        getCurrentPosition() {
            calls.getCurrentPosition += 1;
        },
        clearWatch(id) {
            calls.clearWatch.push(id);
        }
    };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** vm コンテキスト内で作られた配列を、この Realm の配列に直して比較する */
function plain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * 1. ネイティブ addWatcher 経路
 * ------------------------------------------------------------------ */
test('ネイティブ: addWatcher でバックグラウンド測位を開始し、位置更新を陣地処理へ流す', async () => {
    const plugin = createNativePlugin({ watcherId: 'watcher-abc' });
    const loaded = loadTerritoryWalkApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: (name) => name === 'BackgroundGeolocation',
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);

    app.initGeolocation();
    await tick();

    assert.equal(plugin.calls.addWatcher, 1, 'addWatcher は1回だけ呼ぶ');
    assert.equal(app.backgroundWatcherStarted, true);
    assert.equal(app.backgroundWatcherId, 'watcher-abc', 'removeWatcher 用に ID を保持する');

    // backgroundMessage を渡さないとバックグラウンド更新が止まる（プラグイン仕様）
    assert.ok(plugin.options.backgroundMessage, 'backgroundMessage を必ず渡す');
    assert.equal(plugin.options.requestPermissions, true);
    assert.equal(plugin.options.stale, false, '古い測位結果で別マスを塗らない');
    assert.equal(typeof plugin.options.distanceFilter, 'number');
    assert.ok(plugin.options.distanceFilter > 0 && plugin.options.distanceFilter < 100, '100mマスを取りこぼさない距離');

    // プラグイン形式（coords 無し）の位置更新が、通常の測位処理に乗る
    plugin.callback({ latitude: 34.666212, longitude: 135.627618, accuracy: 8, time: 1760000000000 }, undefined);
    await tick();

    assert.deepEqual(plain(app.claims), [[34.66621, 135.62762]], '5桁丸めで processMeshAndClaim へ渡す');
    assert.deepEqual(plain(app.lastRealPosition), [34.66621, 135.62762]);
    assert.equal(app.markerUpdates, 1, '前景ならマーカーも更新する');
});

test('ネイティブ: Plugins 未登録でも registerPlugin("BackgroundGeolocation") で開始できる', async () => {
    const plugin = createNativePlugin();
    const registered = [];
    const loaded = loadTerritoryWalkApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: {},
                registerPlugin: (name) => {
                    registered.push(name);
                    return plugin;
                }
            }
        }
    });
    const app = createApp(loaded);

    app.initGeolocation();
    await tick();

    assert.deepEqual(registered, ['BackgroundGeolocation']);
    assert.equal(plugin.calls.addWatcher, 1);
    assert.equal(app.backgroundWatcherStarted, true);
});

test('ネイティブ: プラグインでは画面消灯中でも保存・同期まで進む（背景中はマーカーを触らない）', async () => {
    const plugin = createNativePlugin();
    const loaded = loadTerritoryWalkApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded, { isAppInBackground: true });

    app.initGeolocation();
    await tick();
    plugin.callback({ latitude: 34.667, longitude: 135.628, accuracy: 6 });
    await tick();

    assert.equal(app.claims.length, 1, 'バックグラウンドでも陣地処理は止めない');
    assert.equal(app.markerUpdates, 0, '見えない地図のマーカーは更新しない');
});

/* ------------------------------------------------------------------ *
 * 2. 拒否エラー → 常設バナー
 * ------------------------------------------------------------------ */
test('拒否: NOT_AUTHORIZED はバナー表示・GPS:拒否・トーストまで繋がる', () => {
    const plugin = createNativePlugin();
    const loaded = loadTerritoryWalkApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);

    app.initGeolocation();
    plugin.callback(undefined, { code: 'NOT_AUTHORIZED', message: 'Permission denied.' });

    const banner = loaded.document.elements['location-permission-banner'];
    assert.equal(banner.classList.contains('hidden'), false, '常設バナーが出る');
    assert.ok(app.gpsStatuses.includes('GPS: 拒否'));
    assert.deepEqual(app.toasts, ['位置情報がオフになっています']);
    assert.equal(app.claims.length, 0, '拒否時に陣地は塗らない');
});

test('拒否: プラグインの位置取得失敗（それ以外）はバナーではなくGPS:エラーに留める', () => {
    const plugin = createNativePlugin();
    const loaded = loadTerritoryWalkApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);

    app.initGeolocation();
    plugin.callback(undefined, { code: 'LOCATION_UNKNOWN', message: 'Location unknown' });

    const banner = loaded.document.elements['location-permission-banner'];
    assert.equal(banner.classList.contains('hidden'), true, 'バナーは出さない');
    assert.ok(app.gpsStatuses.includes('GPS: エラー'));
});

test('拒否バナー判定: NOT_AUTHORIZED（BackgroundGeolocation）を拒否として扱う', () => {
    assert.equal(LocationPermissionBanner.isPermissionDeniedError({ code: 'NOT_AUTHORIZED' }), true);
    assert.equal(LocationPermissionBanner.isPermissionDeniedError({ message: 'NOT_AUTHORIZED' }), true);
    assert.equal(LocationPermissionBanner.isPermissionDeniedError({ code: 'NOT_AUTHORIZED', message: 'Permission denied.' }), true);
    // 位置情報サービス無効など、拒否ではないエラーは従来どおり除外
    assert.equal(LocationPermissionBanner.isPermissionDeniedError({ code: 'OS-PLUG-GLOC-0001', message: 'Location services are not enabled' }), false);
    assert.equal(LocationPermissionBanner.isPermissionDeniedError({ code: 'LOCATION_UNKNOWN' }), false);
});

/* ------------------------------------------------------------------ *
 * 3. 二重起動防止・停止
 * ------------------------------------------------------------------ */
test('二重起動防止: initGeolocation を繰り返しても watcher は1本だけ', async () => {
    const plugin = createNativePlugin();
    const loaded = loadTerritoryWalkApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);

    app.initGeolocation();
    app.initGeolocation();
    app.startBackgroundGeolocation(plugin);
    await tick();

    assert.equal(plugin.calls.addWatcher, 1);
    assert.equal(app.backgroundWatcherStarted, true);
});

test('停止: removeWatcher に保持した watcher ID を渡し、再開できる', async () => {
    const plugin = createNativePlugin({ watcherId: 'watcher-9' });
    const loaded = loadTerritoryWalkApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);

    app.initGeolocation();
    await tick();
    assert.equal(app.stopBackgroundGeolocation(), true);
    await tick();

    assert.deepEqual(plain(plugin.calls.removeWatcher), [{ id: 'watcher-9' }]);
    assert.equal(app.backgroundWatcherStarted, false);
    assert.equal(app.backgroundWatcherId, null);

    // 停止後は同じプラグインで張り直せる（バナーの「再確認」経路）
    app.startBackgroundGeolocation(plugin);
    await tick();
    assert.equal(plugin.calls.addWatcher, 2);
    assert.equal(app.backgroundWatcherStarted, true);
});

test('再確認: ネイティブ測位中は watcher を張り直す（Web の getCurrentPosition は使わない）', async () => {
    const plugin = createNativePlugin({ watcherId: 'watcher-1' });
    const geolocation = createWebGeolocation();
    const loaded = loadTerritoryWalkApp({
        navigator: { geolocation, permissions: undefined },
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);
    app.locationBanner = new LocationPermissionBanner(loaded.document);

    app.initGeolocation();
    await tick();
    app.recheckLocationPermission();
    await tick();

    assert.equal(plugin.calls.addWatcher, 2, 'watcher を張り直して測位を再開する');
    assert.equal(plugin.calls.removeWatcher.length, 1);
    assert.equal(geolocation.calls.getCurrentPosition, 0);
});

/* ------------------------------------------------------------------ *
 * 4. Web フォールバック
 * ------------------------------------------------------------------ */
test('Web: Capacitor が無いブラウザでは従来どおり navigator.geolocation を使う', () => {
    const geolocation = createWebGeolocation();
    const loaded = loadTerritoryWalkApp({ navigator: { geolocation } });
    const app = createApp(loaded);

    app.initGeolocation();

    assert.equal(geolocation.calls.getCurrentPosition, 1);
    assert.equal(geolocation.calls.watchPosition, 1);
    assert.equal(app.watchId, 77);
    assert.equal(app.backgroundWatcherStarted, false);
});

test('Web: ネイティブでもプラグイン未組込（cap sync 前）なら navigator.geolocation へ戻す', () => {
    const geolocation = createWebGeolocation();
    const plugin = createNativePlugin();
    const loaded = loadTerritoryWalkApp({
        navigator: { geolocation },
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => false,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);

    app.initGeolocation();

    assert.equal(plugin.calls.addWatcher, 0, '未組込のプラグインは呼ばない');
    assert.equal(geolocation.calls.watchPosition, 1);
});

test('Web: addWatcher が失敗（promise reject）しても navigator.geolocation で動き続ける', async () => {
    const geolocation = createWebGeolocation();
    const plugin = createNativePlugin({ addWatcherError: new Error('boom') });
    const loaded = loadTerritoryWalkApp({
        navigator: { geolocation },
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded);

    app.initGeolocation();
    await tick();

    assert.equal(app.backgroundWatcherStarted, false, '失敗した watcher は立ち上げ済みにしない');
    assert.equal(geolocation.calls.watchPosition, 1, 'Web フォールバックで測位は続く');
});

test('Web: 位置情報非対応の環境でも落ちない', () => {
    const loaded = loadTerritoryWalkApp({ navigator: {} });
    const app = createApp(loaded);

    assert.doesNotThrow(() => app.initGeolocation());
    assert.ok(app.gpsStatuses.includes('GPS: 非対応'));
});

/* ------------------------------------------------------------------ *
 * 5. D-Pad 仮想散歩との競合防止
 * ------------------------------------------------------------------ */
test('D-Pad: 仮想散歩中の実GPS更新は仮想座標・塗りを上書きしない（実位置だけ保持）', async () => {
    const plugin = createNativePlugin();
    const loaded = loadTerritoryWalkApp({
        window: {
            Capacitor: {
                isNativePlatform: () => true,
                isPluginAvailable: () => true,
                Plugins: { BackgroundGeolocation: plugin }
            }
        }
    });
    const app = createApp(loaded, { isDebugMode: true });
    app.virtualPos = [34.6700, 135.6300];

    app.initGeolocation();
    await tick();
    plugin.callback({ latitude: 34.6662, longitude: 135.6276, accuracy: 9 });
    await tick();

    assert.deepEqual(plain(app.virtualPos), [34.6700, 135.6300], '仮想散歩の座標を守る');
    assert.deepEqual(plain(app.lastRealPosition), [34.6662, 135.6276], '実GPSはデバッグ終了時の戻り先として保持');
    assert.equal(app.claims.length, 0, '実GPSでマスを塗らない');
    assert.ok(app.gpsStatuses.includes('GPS: 仮想散歩中'));
});

/* ------------------------------------------------------------------ *
 * 6. 依存関係と iOS 設定の点検
 * ------------------------------------------------------------------ */
test('依存: package.json に Capacitor 6 互換の background-geolocation が入っている', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const pluginVersion = pkg.dependencies['@capacitor-community/background-geolocation'];

    assert.ok(pluginVersion, 'プラグインが依存に追加されている');
    assert.match(pluginVersion, /^\^?1\./);
    assert.match(pkg.dependencies['@capacitor/core'], /^\^?6\./);
    assert.match(pkg.dependencies['@capacitor/ios'], /^\^?6\./);
});

test('iOS設定: Info.plist がバックグラウンド位置情報の要件を満たす', () => {
    const { CONFIG_ENTRIES, configureContent, verifyContent } = require(path.join(ROOT, 'scripts', 'configure-ios.js'));

    const keys = CONFIG_ENTRIES.map((entry) => entry.key);
    ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription', 'UIBackgroundModes', 'ITSAppUsesNonExemptEncryption']
        .forEach((key) => assert.ok(keys.includes(key), `${key} が設定対象にある`));

    const template = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n</dict>\n</plist>\n';
    const { content } = configureContent(template);

    assert.match(content, /<key>NSLocationAlwaysAndWhenInUseUsageDescription<\/key>/);
    assert.match(content, /<key>UIBackgroundModes<\/key>\s*<array>\s*<string>location<\/string>\s*<\/array>/);
    assert.match(content, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    assert.deepEqual(verifyContent(content), [], '生成した Info.plist は検証を通る');
});

test('iOS設定: UIBackgroundModes に location が無い plist は検証で検出される', () => {
    const { configureContent, verifyContent } = require(path.join(ROOT, 'scripts', 'configure-ios.js'));
    const template = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>UIBackgroundModes</key>
\t<array>
\t\t<string>fetch</string>
\t</array>
</dict>
</plist>
`;
    const { content } = configureContent(template);
    const problems = verifyContent(content);

    assert.ok(problems.some((problem) => problem.includes('location')), 'location 欠落を問題として返す');
});

test('配線: index.html が最新 app.js を読み、www/ と同期されている', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const wwwApp = fs.readFileSync(path.join(ROOT, 'www', 'app.js'), 'utf8');

    assert.match(html, /app\.js\?v=\d{8}v\d+/);
    assert.match(app, /registerPlugin\(BACKGROUND_GEOLOCATION_PLUGIN_NAME\)/);
    assert.match(app, /addWatcher\(BACKGROUND_GEOLOCATION_OPTIONS/);
    assert.match(app, /removeWatcher\(\{ id: watcherId \}\)/);
    assert.equal(wwwApp, app, 'www/app.js は app.js と同一（npm run build で同期）');
});
