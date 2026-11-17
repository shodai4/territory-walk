/**
 * TERRITORY WALK - Node tests
 * Web版（Chrome ブラウザ）の位置情報フォールバック:
 *   1) 高精度（enableHighAccuracy: true）が TIMEOUT(3) / POSITION_UNAVAILABLE(2) で
 *      失敗したら、低精度（enableHighAccuracy: false, timeout: 15000, maximumAge: 60000）で
 *      getCurrentPosition / watchPosition を張り直す
 *   2) 権限拒否（code=1）はフォールバックせず、従来どおり常設バナーへ繋ぐ
 *   3) 張り直す前の遅延コールバックは状態（ステータス・watch）を壊さない
 *   4) 低精度でも取れないときはタイムアウト表示と案内を一度だけ出す
 *   5) 誤差がkm単位の低精度測位では陣地を塗らない（ピンは動かす／初期位置にも保存しない）
 *   6) 現在地ボタン（requestFreshPosition）・バナーの再確認（recheckLocationPermission）も同じ経路
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
    return {
        id,
        classList: createClassList(hidden ? ['hidden'] : []),
        style: {},
        dataset: {},
        addEventListener() {},
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
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'permission.js'), 'utf8'), context, { filename: 'permission.js' });
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
        backgroundGeolocationPlugin: null,
        backgroundWatcherId: null,
        backgroundWatcherStarted: false,
        nativeWatchId: null,
        locationBanner: null,
        markingPaused: false,
        lastRealPosition: null,
        lastProcessedLat: null,
        lastProcessedLng: null,
        currentMeshId: null,
        virtualPos: null,
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
    return app;
}

/**
 * navigator.geolocation のスタブ。
 * 呼ばれた順に entries へ積み、テストから success / error を任意のタイミングで発火できる。
 */
function createGeolocationStub() {
    const entries = [];
    const watchIds = [];
    const clearedIds = [];
    let watchCount = 0;
    return {
        entries,
        watchIds,
        clearedIds,
        get getCount() { return entries.filter((e) => e.type === 'getCurrentPosition').length; },
        get watchCount() { return watchCount; },
        getCurrentPosition(success, error, options) {
            entries.push({ type: 'getCurrentPosition', success, error, options });
        },
        watchPosition(success, error, options) {
            entries.push({ type: 'watchPosition', success, error, options });
            watchCount += 1;
            const id = 100 + watchCount;
            watchIds.push(id);
            return id;
        },
        clearWatch(id) { clearedIds.push(id); }
    };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
const watchEntries = (geo) => geo.entries.filter((e) => e.type === 'watchPosition');
const lastWatch = (geo) => watchEntries(geo).slice(-1)[0];
const lastGet = (geo) => geo.entries.filter((e) => e.type === 'getCurrentPosition').slice(-1)[0];
const toastTexts = (app) => app.toasts.map((t) => String(t[0]));

function setup(overrides = {}) {
    const geo = createGeolocationStub();
    const loaded = loadTerritoryWalkApp({ navigator: { geolocation: geo } });
    const app = createApp(loaded, overrides);
    return { geo, loaded, app };
}

const COARSE_OPTIONS = { timeout: 15000, maximumAge: 60000 };

/* ------------------------------------------------------------------ *
 * 1. 高精度 → 低精度の自動フォールバック（watch）
 * ------------------------------------------------------------------ */
test('Web測位: 高精度が TIMEOUT(3) なら低精度オプションで watch を張り直す', () => {
    const { geo, app } = setup();

    app.startWebGeolocation();
    const preciseWatch = lastWatch(geo);
    assert.equal(preciseWatch.options.enableHighAccuracy, true, '最初は高精度で試す');
    assert.equal(geo.watchCount, 1);

    preciseWatch.error({ code: 3, message: 'Timeout expired' });

    assert.equal(geo.watchCount, 2, 'watch を1本だけ張り直す');
    assert.deepEqual(geo.clearedIds, [geo.watchIds[0]], '張り直す前に古い watch を止める');

    const coarseWatch = lastWatch(geo);
    assert.equal(coarseWatch.options.enableHighAccuracy, false, '低精度へ切り替える');
    assert.equal(coarseWatch.options.timeout, COARSE_OPTIONS.timeout);
    assert.equal(coarseWatch.options.maximumAge, COARSE_OPTIONS.maximumAge);
    assert.equal(app.webGeolocationMode, 'coarse');

    // getCurrentPosition も低精度で取り直している
    assert.equal(lastGet(geo).options.enableHighAccuracy, false);

    // タイムアウトで止めず、測位を続ける
    assert.ok(!app.gpsStatuses.includes('GPS: タイムアウト'));
    assert.ok(app.gpsStatuses.includes('GPS: 簡易測位中'));
    assert.ok(toastTexts(app).includes('簡易測位に切り替えました'));
});

test('Web測位: POSITION_UNAVAILABLE(2) でも低精度へ切り替える', () => {
    const { geo, app } = setup();

    app.startWebGeolocation();
    lastWatch(geo).error({ code: 2, message: 'Position unavailable' });

    assert.equal(geo.watchCount, 2);
    assert.equal(lastWatch(geo).options.enableHighAccuracy, false);
    assert.equal(app.webGeolocationMode, 'coarse');
});

test('Web測位: 低精度への切り替えは1回だけ（エラーが続いても張り直し続けない）', () => {
    const { geo, app } = setup();

    app.startWebGeolocation();
    lastWatch(geo).error({ code: 3 });
    lastWatch(geo).error({ code: 3 });
    lastWatch(geo).error({ code: 2 });

    assert.equal(geo.watchCount, 2, '低精度の watch は1本のまま');
    assert.equal(toastTexts(app).filter((text) => text === '簡易測位に切り替えました').length, 1);
});

/* ------------------------------------------------------------------ *
 * 2. 拒否（code=1）はフォールバックしない
 * ------------------------------------------------------------------ */
test('Web測位: 権限拒否(code=1)は低精度へ切り替えず、常設バナーを出す', () => {
    const { geo, loaded, app } = setup();
    app.locationBanner = new LocationPermissionBanner(loaded.document);

    app.startWebGeolocation();
    lastWatch(geo).error({ code: 1, message: 'User denied Geolocation' });

    assert.equal(geo.watchCount, 1, '拒否では watch を張り直さない');
    assert.equal(app.webGeolocationMode, 'precise');
    assert.ok(app.gpsStatuses.includes('GPS: 拒否'));
    const banner = loaded.document.elements['location-permission-banner'];
    assert.equal(banner.classList.contains('hidden'), false, '拒否バナーの導線は従来どおり');
    assert.deepEqual(toastTexts(app), ['位置情報がオフになっています']);
});

test('Web測位: 拒否は code=1 の文字列や PERMISSION_DENIED でもフォールバックしない', () => {
    const { geo, app } = setup();

    app.startWebGeolocation();
    lastWatch(geo).error({ code: '1', message: 'PERMISSION_DENIED' });

    assert.equal(geo.watchCount, 1);
    assert.ok(app.gpsStatuses.includes('GPS: 拒否'));
});

/* ------------------------------------------------------------------ *
 * 3. 張り直す前の遅延コールバック
 * ------------------------------------------------------------------ */
test('Web測位: 切り替え前の高精度リクエストの遅延エラーは状態を上書きしない', async () => {
    const { geo, app } = setup();

    app.startWebGeolocation();
    const preciseGet = lastGet(geo);
    const preciseWatch = lastWatch(geo);

    preciseWatch.error({ code: 3 });
    assert.equal(app.webGeolocationMode, 'coarse');

    // 切り替えたあとに、高精度の getCurrentPosition のエラーが遅れて届く
    preciseGet.error({ code: 3, message: 'Timeout expired' });
    await tick();

    assert.equal(geo.watchCount, 2, '追加の張り直しはしない');
    assert.ok(!app.gpsStatuses.includes('GPS: タイムアウト'), '低精度側の結果を待つ');
    assert.equal(toastTexts(app).filter((text) => text.includes('位置情報を取得できませんでした')).length, 0);
});

/* ------------------------------------------------------------------ *
 * 4. 低精度での成功・失敗
 * ------------------------------------------------------------------ */
test('Web測位: 低精度で取れた位置でマーカー・陣地を更新し、拒否バナーを消す', () => {
    const { geo, loaded, app } = setup();
    app.locationBanner = new LocationPermissionBanner(loaded.document);
    app.locationBanner.show();

    app.startWebGeolocation();
    lastWatch(geo).error({ code: 3 });
    lastWatch(geo).success({
        coords: { latitude: 34.611234, longitude: 135.500871, accuracy: 60 }
    });

    assert.deepEqual(plain(app.claims), [[34.61123, 135.50087]], '5桁丸めで陣地を塗る');
    assert.equal(app.markerUpdates, 1, 'ピンも現在地へ');
    assert.equal(loaded.document.elements['location-permission-banner'].classList.contains('hidden'), true,
        '位置が取れたらバナーは自動で消える');
    assert.equal(app.webGeolocationMode, 'coarse');
});

test('Web測位: 低精度でも取れないときは、タイムアウト表示と案内を一度だけ出す', () => {
    const { geo, app } = setup();

    app.startWebGeolocation();
    lastWatch(geo).error({ code: 3 });
    lastWatch(geo).error({ code: 3 });
    lastWatch(geo).error({ code: 3 });

    assert.ok(app.gpsStatuses.includes('GPS: タイムアウト'));
    const notices = toastTexts(app).filter((text) => text === '位置情報を取得できませんでした');
    assert.equal(notices.length, 1, '同じ案内は繰り返さない');
    assert.equal(geo.watchCount, 2, '張り直しは高精度→低精度の1回だけ');
});

test('Web測位: 低精度の誤差が1km超なら陣地は塗らない（ピンは動かす・初期位置にも保存しない）', () => {
    const { geo, loaded, app } = setup();

    app.startWebGeolocation();
    lastWatch(geo).error({ code: 3 });
    lastWatch(geo).success({
        coords: { latitude: 35.681236, longitude: 139.767125, accuracy: 5000 }
    });

    assert.equal(app.claims.length, 0, 'IP推定のkm単位のズレで陣地を開拓しない');
    assert.equal(app.markerUpdates, 1, '現在地の目安としてピンは動かす');
    assert.ok(toastTexts(app).includes('現在地の精度が低いため陣地は塗りません'));
    assert.equal(loaded.storage.tw_last_position, undefined, '次回起動の初期位置には使わない');
});

test('Web測位: 低精度でも誤差1km以内なら従来どおり塗る', () => {
    const { geo, loaded, app } = setup();

    app.startWebGeolocation();
    lastWatch(geo).error({ code: 2 });
    lastWatch(geo).success({
        coords: { latitude: 34.611234, longitude: 135.500871, accuracy: 320 }
    });

    assert.deepEqual(plain(app.claims), [[34.61123, 135.50087]]);
    assert.ok(loaded.storage.tw_last_position, '位置は次回起動用に保存する');
});

/* ------------------------------------------------------------------ *
 * 5. 現在地ボタン（requestFreshPosition）
 * ------------------------------------------------------------------ */
test('現在地ボタン: 高精度が TIMEOUT(3) なら低精度で取り直し、その座標を返す', async () => {
    const { geo, app } = setup();

    const promise = app.requestFreshPosition();
    await tick();

    assert.equal(geo.getCount, 1);
    assert.equal(lastGet(geo).options.enableHighAccuracy, true, '最初は高精度');

    lastGet(geo).error({ code: 3, message: 'Timeout expired' });
    await tick();

    assert.equal(geo.getCount, 2, '低精度で1回だけ再試行する');
    const retry = lastGet(geo);
    assert.equal(retry.options.enableHighAccuracy, false);
    assert.equal(retry.options.timeout, COARSE_OPTIONS.timeout);
    assert.equal(retry.options.maximumAge, COARSE_OPTIONS.maximumAge);

    retry.success({ coords: { latitude: 34.611234, longitude: 135.500871, accuracy: 80 } });
    const pos = await promise;

    // 戻り値は生の座標（地図移動用。陣地の塗りは handlePositionUpdate が5桁丸めで行う）
    assert.deepEqual(plain(pos), [34.611234, 135.500871], '再試行で取れた座標を返す');
    assert.equal(app.webGeolocationMode, 'coarse');
});

test('現在地ボタン: 権限拒否(code=1)は低精度で再試行せず、そのまま失敗する', async () => {
    const { geo, app } = setup();

    const promise = app.requestFreshPosition();
    await tick();
    const denied = { code: 1, message: 'User denied Geolocation' };
    lastGet(geo).error(denied);

    await assert.rejects(promise, (error) => error && error.code === 1);
    assert.equal(geo.getCount, 1, '拒否では測位を繰り返さない');
    assert.equal(app.webGeolocationMode, 'precise');
});

test('現在地ボタン: 低精度でも取れなければ従来どおり失敗する（無限に再試行しない）', async () => {
    const { geo, app } = setup();

    const promise = app.requestFreshPosition();
    await tick();
    lastGet(geo).error({ code: 3 });
    await tick();
    lastGet(geo).error({ code: 2, message: 'Position unavailable' });

    await assert.rejects(promise, (error) => error && error.code === 2);
    assert.equal(geo.getCount, 2);
});

/* ------------------------------------------------------------------ *
 * 6. バナーの「再確認」（recheckLocationPermission）
 * ------------------------------------------------------------------ */
test('再確認: 高精度が TIMEOUT(3) なら低精度の watch を張り直す', () => {
    const { geo, loaded, app } = setup();
    app.locationBanner = new LocationPermissionBanner(loaded.document);

    app.recheckLocationPermission();
    assert.equal(lastGet(geo).options.enableHighAccuracy, true, 'まず高精度で確認する');

    lastGet(geo).error({ code: 3, message: 'Timeout expired' });

    assert.equal(geo.watchCount, 1, '低精度の watch を張って測位を続ける');
    assert.equal(lastWatch(geo).options.enableHighAccuracy, false);
    assert.equal(lastGet(geo).options.enableHighAccuracy, false);
    assert.ok(!app.gpsStatuses.includes('GPS: タイムアウト'));
});

test('再確認: 権限拒否(code=1)はフォールバックせずバナーを維持する', () => {
    const { geo, loaded, app } = setup();
    app.locationBanner = new LocationPermissionBanner(loaded.document);

    app.recheckLocationPermission();
    lastGet(geo).error({ code: 1, message: 'User denied Geolocation' });

    assert.equal(geo.watchCount, 0, 'watch は張らない');
    assert.ok(app.gpsStatuses.includes('GPS: 拒否'));
    assert.equal(loaded.document.elements['location-permission-banner'].classList.contains('hidden'), false);
});

/* ------------------------------------------------------------------ *
 * 7. 実装の取りこぼし防止（オプションの直書き）
 * ------------------------------------------------------------------ */
test('実装: 高精度・低精度のオプションは定数にまとめ、直書きを残さない', () => {
    const precise = APP_SOURCE.match(/enableHighAccuracy:\s*true\s*,/g) || [];
    const coarse = APP_SOURCE.match(/enableHighAccuracy:\s*false\s*,/g) || [];

    assert.equal(precise.length, 1, 'enableHighAccuracy: true は WEB_GEOLOCATION_PRECISE_OPTIONS のみ');
    assert.equal(coarse.length, 1, 'enableHighAccuracy: false は WEB_GEOLOCATION_COARSE_OPTIONS のみ');
    assert.match(APP_SOURCE, /WEB_GEOLOCATION_COARSE_OPTIONS = \{\s*\n\s*enableHighAccuracy: false,\s*\n\s*timeout: 15000,\s*\n\s*maximumAge: 60000/);
    assert.match(APP_SOURCE, /const WEB_GEOLOCATION_PRECISE_OPTIONS = \{\s*\n\s*enableHighAccuracy: true,\s*\n\s*timeout: 10000,\s*\n\s*maximumAge: 0/);
});

test('実装: アプリ本体と配布用 www/app.js が同期している（npm run build）', () => {
    assert.equal(fs.readFileSync(path.join(ROOT, 'www', 'app.js'), 'utf8'), APP_SOURCE);
});
