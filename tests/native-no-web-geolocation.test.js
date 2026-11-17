/**
 * TERRITORY WALK - Node tests
 * iOS 実機の WebView ダイアログ対策:
 *   "localhost" would like to use your current location.
 *
 * Capacitor のネイティブアプリ（isNativePlatform() === true）では、
 * 初期化・現在地ボタン・バナーの再確認・測位エラー・BackgroundGeolocation 失敗の
 * どの経路でも navigator.geolocation を 0 回しか呼ばないこと。
 * （Web ブラウザでは従来どおり高精度 → 低精度のフォールバックが動くこと）
 *
 * あわせて、@capacitor/geolocation の導入と Info.plist の位置情報キーも点検する。
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const PERMISSION_SOURCE = fs.readFileSync(path.join(ROOT, 'permission.js'), 'utf8');

/** コメントを外したコード（ソース点検用。行番号の対応は不要） */
function stripComments(source) {
    let out = '';
    let quote = null;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        const next = source[i + 1];
        if (quote) {
            out += ch;
            if (ch === '\\') { out += next || ''; i += 1; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
        if (ch === '/' && next === '/') {
            while (i < source.length && source[i] !== '\n') i += 1;
            out += '\n';
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
            i += 1;
            continue;
        }
        out += ch;
    }
    return out;
}

const APP_CODE = stripComments(APP_SOURCE);
const PERMISSION_CODE = stripComments(PERMISSION_SOURCE);
const { LocationPermissionBanner } = require(path.join(ROOT, 'permission.js'));

/* ------------------------------------------------------------------ *
 * 最小限のDOMスタブ（jsdomを使わず、app.js を vm 上で動かす）
 * ------------------------------------------------------------------ */
function createClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        contains: (name) => set.has(name)
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
        'btn-location-banner-retry': createStubElement('btn-location-banner-retry')
    };
    return {
        elements,
        body: { dataset: {} },
        addEventListener() {},
        getElementById: (id) => elements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => []
    };
}

/** permission.js と app.js を同じ vm コンテキストに読み込む */
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
    vm.runInContext(PERMISSION_SOURCE, context, { filename: 'permission.js' });
    vm.runInContext(APP_SOURCE, context, { filename: 'app.js' });

    return {
        context,
        document: doc,
        storage,
        TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context)
    };
}

/** 測位まわりを動かすのに必要な最小限のアプリインスタンス */
function createApp(loaded, overrides = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    Object.assign(app, {
        watchId: null,
        webGeolocationMode: 'precise',
        webGeolocationAttempt: 0,
        webCoarseFallbackNotified: false,
        webUnavailableNotified: false,
        webCoarseAccuracyNotified: false,
        backgroundGeolocationPlugin: null,
        backgroundWatcherId: null,
        backgroundWatcherStarted: false,
        nativeGeolocationPlugin: null,
        nativeWatchId: null,
        locationBanner: null,
        markingPaused: false,
        servicesStarted: true,
        geolocationStarted: false,
        lastRealPosition: null,
        lastProcessedLat: null,
        lastProcessedLng: null,
        currentMeshId: null,
        virtualPos: null,
        savedPosition: null,
        currentTeam: 'black',
        isAppInBackground: false,
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
    app.showToast = (message, subtitle) => { app.toasts.push([message, subtitle]); };
    app.repositionToastContainer = () => {};
    app.layoutTopNotices = () => {};
    app.refreshGlobalTeamCounts = () => {};
    return app;
}

/** navigator.geolocation のスタブ（呼ばれたら必ず記録する＝0回の検証用） */
function createCountingWebGeolocation() {
    const calls = { getCurrentPosition: [], watchPosition: [], clearWatch: [] };
    return {
        calls,
        get total() {
            return calls.getCurrentPosition.length + calls.watchPosition.length + calls.clearWatch.length;
        },
        getCurrentPosition(success, error, options) {
            calls.getCurrentPosition.push({ success, error, options });
        },
        watchPosition(success, error, options) {
            calls.watchPosition.push({ success, error, options });
            return 100 + calls.watchPosition.length;
        },
        clearWatch(id) {
            calls.clearWatch.push(id);
        }
    };
}

/** navigator.permissions のスタブ（query が呼ばれたかを記録） */
function createCountingPermissions() {
    const queries = [];
    return {
        queries,
        query(descriptor) {
            queries.push(descriptor);
            return Promise.resolve({ state: 'prompt' });
        }
    };
}

/**
 * Capacitor のネイティブ Geolocation プラグインのスタブ。
 * nextGet を差し替えると getCurrentPosition の結果（成功/失敗）を制御できる。
 */
function createNativeGeoPlugin() {
    const calls = { getCurrentPosition: [], watchPosition: [], clearWatch: [] };
    const plugin = {
        calls,
        nextGet: null,
        getCurrentPosition(options) {
            calls.getCurrentPosition.push({ options });
            if (typeof plugin.nextGet === 'function') return plugin.nextGet(options);
            return Promise.resolve({
                coords: { latitude: 34.611234, longitude: 135.500871, accuracy: 8 }
            });
        },
        watchPosition(options, callback) {
            calls.watchPosition.push({ options, callback });
            return Promise.resolve(`native-watch-${calls.watchPosition.length}`);
        },
        clearWatch(args) {
            calls.clearWatch.push(args);
            return Promise.resolve();
        }
    };
    return plugin;
}

/** BackgroundGeolocation プラグインのスタブ */
function createBackgroundPlugin(options = {}) {
    const calls = { addWatcher: 0, removeWatcher: [] };
    const plugin = {
        calls,
        callback: null,
        async addWatcher(watchOptions, callback) {
            calls.addWatcher += 1;
            plugin.callback = callback;
            if (options.addWatcherError) throw options.addWatcherError;
            return 'watcher-1';
        },
        async removeWatcher(args) {
            calls.removeWatcher.push(args);
            return true;
        }
    };
    return plugin;
}

/** ネイティブ（iOS アプリ）の window.Capacitor を組み立てる */
function createNativeCapacitor({ plugins = {}, available = null } = {}) {
    const names = Object.keys(plugins);
    return {
        isNativePlatform: () => true,
        isPluginAvailable: (name) => (available ? available(name) : names.includes(name)),
        Plugins: plugins
    };
}

function setupNative({ plugins = {}, available = null, navigator = null } = {}) {
    const webGeo = createCountingWebGeolocation();
    const permissions = createCountingPermissions();
    const loaded = loadTerritoryWalkApp({
        navigator: navigator || { geolocation: webGeo, permissions },
        window: { Capacitor: createNativeCapacitor({ plugins, available }) }
    });
    const app = createApp(loaded);
    return { app, loaded, webGeo, permissions };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/* ------------------------------------------------------------------ *
 * 1. 初期化（initGeolocation）
 * ------------------------------------------------------------------ */
test('ネイティブ初期化: BackgroundGeolocation が動くとき navigator.geolocation は 0 回', async () => {
    const background = createBackgroundPlugin();
    const { app, webGeo, permissions } = setupNative({ plugins: { BackgroundGeolocation: background } });

    app.initGeolocation();
    await tick();

    assert.equal(background.calls.addWatcher, 1);
    assert.equal(webGeo.total, 0, 'Web の Geolocation API は一切呼ばない');
    assert.equal(permissions.queries.length, 0, 'navigator.permissions.query も呼ばない');
});

test('ネイティブ初期化: BackgroundGeolocation が無くても Capacitor Geolocation だけで測位する', async () => {
    const nativeGeo = createNativeGeoPlugin();
    const { app, webGeo, permissions } = setupNative({ plugins: { Geolocation: nativeGeo } });

    app.initGeolocation();
    await tick();

    assert.equal(nativeGeo.calls.getCurrentPosition.length, 1);
    assert.equal(nativeGeo.calls.watchPosition.length, 1);
    assert.equal(app.nativeWatchId, 'native-watch-1');
    assert.deepEqual(plain(app.claims), [[34.61123, 135.50087]], 'ネイティブの位置で陣地を塗る');
    assert.equal(webGeo.total, 0);
    assert.equal(permissions.queries.length, 0);
});

test('ネイティブ初期化: プラグインが2つとも使えなくても navigator.geolocation には落ちない', () => {
    const { app, webGeo } = setupNative({ plugins: {}, available: () => false });

    assert.doesNotThrow(() => app.initGeolocation());

    assert.equal(webGeo.total, 0, 'Web の Geolocation API は呼ばない');
    assert.equal(app.watchId, null);
    assert.ok(app.gpsStatuses.includes('GPS: 測位できません'));
});

test('ネイティブ初期化: addWatcher が reject しても navigator.geolocation は 0 回', async () => {
    const background = createBackgroundPlugin({ addWatcherError: new Error('boom') });
    const { app, webGeo } = setupNative({ plugins: { BackgroundGeolocation: background } });

    app.initGeolocation();
    await tick();

    assert.equal(background.calls.addWatcher, 1);
    assert.equal(webGeo.total, 0);
    assert.equal(app.watchId, null);
});

/* ------------------------------------------------------------------ *
 * 2. 現在地ボタン（requestFreshPosition）
 * ------------------------------------------------------------------ */
test('ネイティブ現在地ボタン: プラグインの getCurrentPosition だけを使う', async () => {
    const nativeGeo = createNativeGeoPlugin();
    const { app, webGeo } = setupNative({ plugins: { Geolocation: nativeGeo } });

    const pos = await app.requestFreshPosition();

    assert.deepEqual(plain(pos), [34.611234, 135.500871], '生の座標を返す（地図移動用）');
    assert.equal(nativeGeo.calls.getCurrentPosition.length, 1);
    assert.equal(nativeGeo.calls.getCurrentPosition[0].options.enableHighAccuracy, true);
    assert.deepEqual(plain(app.claims), [[34.61123, 135.50087]]);
    assert.equal(webGeo.total, 0);
});

test('ネイティブ現在地ボタン: 高精度が TIMEOUT ならプラグインで低精度に切り替える（Web には落とさない）', async () => {
    const nativeGeo = createNativeGeoPlugin();
    const attempts = [];
    nativeGeo.nextGet = (options) => {
        attempts.push(options);
        if (options.enableHighAccuracy) return Promise.reject({ code: 3, message: 'Timeout expired' });
        return Promise.resolve({ coords: { latitude: 34.611234, longitude: 135.500871, accuracy: 90 } });
    };
    const { app, webGeo } = setupNative({ plugins: { Geolocation: nativeGeo } });

    const pos = await app.requestFreshPosition();

    assert.equal(attempts.length, 2, '高精度 → 低精度の順に1回ずつ');
    assert.equal(attempts[0].enableHighAccuracy, true);
    assert.equal(attempts[1].enableHighAccuracy, false);
    assert.deepEqual(plain(pos), [34.611234, 135.500871]);
    assert.equal(app.webGeolocationMode, 'coarse');
    assert.equal(webGeo.total, 0, 'Web の Geolocation API は呼ばない');
});

test('ネイティブ現在地ボタン: プラグインが無ければ reject し、navigator.geolocation は呼ばない', async () => {
    const { app, webGeo } = setupNative({ plugins: {}, available: () => false });

    await assert.rejects(app.requestFreshPosition());
    assert.equal(webGeo.total, 0);
});

test('ネイティブ現在地ボタン: 拒否エラーは低精度で再試行しない', async () => {
    const nativeGeo = createNativeGeoPlugin();
    nativeGeo.nextGet = () => Promise.reject({ code: 1, message: 'User denied Geolocation' });
    const { app, webGeo, loaded } = setupNative({ plugins: { Geolocation: nativeGeo } });
    app.locationBanner = new LocationPermissionBanner(loaded.document);

    await assert.rejects(app.requestFreshPosition());

    assert.equal(nativeGeo.calls.getCurrentPosition.length, 1);
    assert.equal(nativeGeo.calls.getCurrentPosition[0].options.enableHighAccuracy, true);
    assert.equal(webGeo.total, 0);
});

/* ------------------------------------------------------------------ *
 * 3. バナーの「再確認」（recheckLocationPermission）
 * ------------------------------------------------------------------ */
test('ネイティブ再確認: バックグラウンド watcher を張り直すだけで Web は呼ばない', async () => {
    const background = createBackgroundPlugin();
    const { app, webGeo } = setupNative({ plugins: { BackgroundGeolocation: background } });

    app.initGeolocation();
    await tick();
    app.recheckLocationPermission();
    await tick();

    assert.equal(background.calls.addWatcher, 2, 'watcher を張り直す');
    assert.equal(webGeo.total, 0);
});

test('ネイティブ再確認: watcher が無いときは Capacitor Geolocation で再確認する', async () => {
    const nativeGeo = createNativeGeoPlugin();
    const { app, webGeo } = setupNative({ plugins: { Geolocation: nativeGeo } });

    app.recheckLocationPermission();
    await tick();

    assert.equal(nativeGeo.calls.getCurrentPosition.length, 1);
    assert.equal(webGeo.total, 0);
});

test('ネイティブ再確認: 何も使えないときも navigator.geolocation は呼ばない', () => {
    const { app, webGeo } = setupNative({ plugins: {}, available: () => false });

    assert.doesNotThrow(() => app.recheckLocationPermission());
    assert.equal(webGeo.total, 0);
});

/* ------------------------------------------------------------------ *
 * 4. エラー時・低精度への切り替え
 * ------------------------------------------------------------------ */
test('ネイティブ測位エラー: TIMEOUT はプラグインの低精度へ切り替え、拒否はバナーへ', async () => {
    const nativeGeo = createNativeGeoPlugin();
    nativeGeo.nextGet = (options) => (options.enableHighAccuracy
        ? Promise.reject({ code: 3, message: 'Timeout expired' })
        : Promise.resolve({ coords: { latitude: 34.611234, longitude: 135.500871, accuracy: 70 } }));
    const { app, webGeo, loaded } = setupNative({ plugins: { Geolocation: nativeGeo } });
    app.locationBanner = new LocationPermissionBanner(loaded.document);

    app.startWebGeolocation();
    await tick();

    assert.equal(nativeGeo.calls.watchPosition.length, 2, '高精度 → 低精度で watch を張り直す');
    assert.equal(nativeGeo.calls.watchPosition[1].options.enableHighAccuracy, false);
    assert.equal(nativeGeo.calls.clearWatch.length, 1, '張り直す前に前の watch を止める');
    assert.equal(app.nativeWatchId, 'native-watch-2');
    assert.equal(webGeo.total, 0);
});

test('ネイティブ測位エラー: 拒否(NOT_AUTHORIZED)はバナー表示で止まり、Web は呼ばない', async () => {
    const nativeGeo = createNativeGeoPlugin();
    nativeGeo.nextGet = () => Promise.reject({ code: 'NOT_AUTHORIZED', message: 'Not authorized' });
    const { app, webGeo, loaded } = setupNative({
        plugins: { BackgroundGeolocation: createBackgroundPlugin(), Geolocation: nativeGeo }
    });
    app.locationBanner = new LocationPermissionBanner(loaded.document);

    app.startWebGeolocation();
    await tick();

    assert.equal(loaded.document.elements['location-permission-banner'].classList.contains('hidden'), false);
    assert.equal(webGeo.total, 0);
});

/* ------------------------------------------------------------------ *
 * 5. バナー単体（permission.js）の retry / refreshPermissionState
 * ------------------------------------------------------------------ */
test('バナー再確認: retryHandler が無いネイティブではプラグインで再確認し、Web は呼ばない', async () => {
    const nativeGeo = createNativeGeoPlugin();
    const { loaded, webGeo, permissions } = setupNative({ plugins: { Geolocation: nativeGeo } });
    const Banner = vm.runInContext('LocationPermissionBanner', loaded.context);
    const banner = new Banner(loaded.document);
    banner.show();

    banner.retry();
    await tick();

    assert.equal(nativeGeo.calls.getCurrentPosition.length, 1);
    assert.equal(banner.isVisible(), false, '位置が取れたらバナーは消える');
    assert.equal(webGeo.total, 0);
    assert.equal(permissions.queries.length, 0);
});

test('バナー再確認: ネイティブでは refreshPermissionState が Permissions API を問い合わせない', () => {
    const { loaded, permissions } = setupNative({ plugins: {} });
    const Banner = vm.runInContext('LocationPermissionBanner', loaded.context);
    const banner = new Banner(loaded.document);

    banner.refreshPermissionState();
    assert.equal(permissions.queries.length, 0);
});

/* ------------------------------------------------------------------ *
 * 6. Web ブラウザでは従来どおり（ガードがネイティブ限定であること）
 * ------------------------------------------------------------------ */
test('Web: isNativePlatform() が false なら従来どおり navigator.geolocation を使う', () => {
    const webGeo = createCountingWebGeolocation();
    const permissions = createCountingPermissions();
    const loaded = loadTerritoryWalkApp({
        navigator: { geolocation: webGeo, permissions },
        window: { Capacitor: { isNativePlatform: () => false, isPluginAvailable: () => true, Plugins: {} } }
    });
    const app = createApp(loaded);
    const Banner = vm.runInContext('LocationPermissionBanner', loaded.context);
    app.locationBanner = new Banner(loaded.document);

    app.startWebGeolocation();

    assert.equal(app.isNativePlatform(), false);
    assert.equal(webGeo.calls.watchPosition.length, 1);
    assert.equal(webGeo.calls.getCurrentPosition.length, 1);
    assert.equal(permissions.queries.length, 1, 'Web では拒否済みバナーの確認に Permissions API を使う');
});

/* ------------------------------------------------------------------ *
 * 7. 依存関係・iOS 設定・ソース点検
 * ------------------------------------------------------------------ */
test('依存: package.json に Capacitor 6 互換の @capacitor/geolocation が入っている', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const version = pkg.dependencies['@capacitor/geolocation'];

    assert.ok(version, '@capacitor/geolocation が依存に追加されている');
    assert.match(version, /^\^?6\./);
    assert.match(pkg.dependencies['@capacitor/core'], /^\^?6\./);
    assert.match(pkg.dependencies['@capacitor/ios'], /^\^?6\./);

    // cap sync で pod が入る（インストール済みなら実体も確認）
    const installed = path.join(ROOT, 'node_modules', '@capacitor', 'geolocation', 'package.json');
    if (fs.existsSync(installed)) {
        const pkgInstalled = JSON.parse(fs.readFileSync(installed, 'utf8'));
        assert.match(pkgInstalled.version, /^6\./);
    }
});

test('iOS設定: 位置情報の利用目的（Info.plist）が設定対象に入っている', () => {
    const { CONFIG_ENTRIES } = require(path.join(ROOT, 'scripts', 'configure-ios.js'));
    const keys = CONFIG_ENTRIES.map((entry) => entry.key);

    ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription']
        .forEach((key) => assert.ok(keys.includes(key), `${key} が設定対象にある`));
});

/** ソースから `    name(...) {` のメソッド本体を取り出す（ブレース対応） */
function methodBody(source, name) {
    const start = source.search(new RegExp(`\\n    ${name}\\([^)]*\\)\\s*\\{`));
    if (start < 0) return null;
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    return null;
}

test('実装: navigator.geolocation を触る関数はすべてネイティブ判定ガードの後ろにある（app.js）', () => {
    const methods = [
        'requestFreshPosition',
        'startWebGeolocation',
        'startWebGeolocationWatch',
        'clearWebGeolocationWatch',
        'startCoarseWebGeolocation',
        'recheckLocationPermission'
    ];

    methods.forEach((name) => {
        const body = methodBody(APP_CODE, name);
        assert.ok(body, `${name} が見つかる`);
        assert.ok(body.includes('isNativePlatform()'), `${name} はネイティブ判定を行う`);
        const navAt = body.indexOf('navigator.geolocation');
        if (navAt >= 0) {
            assert.ok(body.indexOf('isNativePlatform()') < navAt,
                `${name} は navigator.geolocation より前にネイティブ判定を置く`);
        }
    });

    // 上記以外の場所で navigator.geolocation を直に呼んでいない（呼び出し箇所の総数で確認）
    const directCalls = APP_CODE.match(/navigator\.geolocation\.(getCurrentPosition|watchPosition)\(/g) || [];
    assert.equal(directCalls.length, 3,
        'Web 測位の直接呼び出しは watch 用2箇所 + 再確認1箇所だけ');
    assert.match(APP_SOURCE, /if \(this\.isNativePlatform\(\)\) \{\n            const nativeGeo = this\.getNativeGeolocation\(\);\n            if \(!nativeGeo\) return Promise\.reject\(new Error\('native geolocation unavailable'\)\);/);
});

test('実装: permission.js の retry / refreshPermissionState もネイティブでは Web API を呼ばない', () => {
    const retry = methodBody(PERMISSION_CODE, 'retry');
    const refresh = methodBody(PERMISSION_CODE, 'refreshPermissionState');

    assert.ok(retry && retry.includes('isNativePlatform()'));
    const navAt = retry.indexOf('navigator.geolocation');
    assert.ok(navAt >= 0, 'Web 用の経路は残す');
    assert.ok(retry.indexOf('isNativePlatform()') < navAt, 'ネイティブ判定が先');

    assert.ok(refresh && refresh.includes('isNativePlatform()'));
    assert.ok(refresh.indexOf('isNativePlatform()') < refresh.indexOf('navigator.permissions.query'));
});

test('配線: アプリ本体と配布用 www/ が同期している（npm run build）', () => {
    assert.equal(fs.readFileSync(path.join(ROOT, 'www', 'app.js'), 'utf8'), APP_SOURCE);
    assert.equal(fs.readFileSync(path.join(ROOT, 'www', 'permission.js'), 'utf8'), PERMISSION_SOURCE);
});
