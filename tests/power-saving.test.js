/**
 * TERRITORY WALK - Node tests
 * v1.2 省電力対策
 *
 *   1) バックグラウンド測位の距離フィルタを 20m → 40m（省電力モードは 60m）へ拡大
 *      - 実測したプラグイン仕様（WatcherOptions の5キー）に反しないこと
 *      - desiredAccuracy / pausesLocationUpdatesAutomatically は「JSから渡せる口が無い」こと
 *   2) 同一マス滞在中の GPS 誤差更新を捨てる（再描画・Supabase 通信・Watch 送信をしない）
 *      - 初回取得・チーム変更・未取得マス・明示的な再取得は落とさない
 *   3) 省電力モードのトグル（localStorage 保存 / watcher 張り直し / UI 反映）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readAppSource, readWwwAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = readAppSource();
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 100mマス（grid.js と同じ刻み） */
const LAT_STEP = 0.0009;
const LNG_STEP = 0.0011;

/* ------------------------------------------------------------------ *
 * vm 上で app.js を読み、純粋関数と壊れにくいスタブを得る
 * ------------------------------------------------------------------ */
function loadApp(options = {}) {
    const storage = options.storage || {};
    const elements = options.elements || {};
    const body = { dataset: {} };
    const documentStub = {
        body,
        getElementById: (id) => elements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
    };
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: documentStub,
        navigator: {},
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
    vm.runInContext(APP_SOURCE, context, { filename: 'app.js' });

    return {
        context,
        storage,
        document: documentStub,
        body,
        TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context),
        resolveDistanceFilter: vm.runInContext('resolveDistanceFilter', context),
        resolveStationarySkipDistance: vm.runInContext('resolveStationarySkipDistance', context),
        buildBackgroundGeolocationOptions: vm.runInContext('buildBackgroundGeolocationOptions', context),
        shouldSkipStationaryUpdate: vm.runInContext('shouldSkipStationaryUpdate', context),
        BACKGROUND_GEOLOCATION_OPTIONS: vm.runInContext('BACKGROUND_GEOLOCATION_OPTIONS', context)
    };
}

/** マス計算は grid.js と同じ floor(lat / latStep) */
function meshOf(lat, lng) {
    const latIdx = Math.floor(lat / LAT_STEP);
    const lngIdx = Math.floor(lng / LNG_STEP);
    return { meshId: `tile_${latIdx}_${lngIdx}`, latIdx, lngIdx };
}

/** マスの中心（境界をまたがない移動を作るため） */
function cellCenter(latIdx, lngIdx) {
    return [(latIdx + 0.5) * LAT_STEP, (lngIdx + 0.5) * LNG_STEP];
}

/**
 * handlePositionUpdate を動かすための最小限のアプリ。
 * currentMeshId / claimedTilesCache はテスト側で操作する。
 */
function createApp(loaded, overrides = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    const cache = new Map();
    Object.assign(app, {
        currentTeam: 'black',
        currentMeshId: null,
        lastProcessedLat: null,
        lastProcessedLng: null,
        lastRealPosition: null,
        virtualPos: [35.65845, 139.70165],
        isAppInBackground: false,
        isDebugMode: false,
        debugEnabled: false,
        markingPaused: false,
        map: null,
        locationBanner: null,
        powerSaveMode: false,
        savedPositions: [],
        claims: [],
        markerUpdates: 0,
        watchNotifies: [],
        gpsStatuses: [],
        gridManager: {
            claimedTilesCache: cache,
            latStep: LAT_STEP,
            lngStep: LNG_STEP,
            getMeshIdFromLatLng: (lat, lng) => meshOf(lat, lng)
        }
    }, overrides);

    app.saveLastPosition = (lat, lng) => app.savedPositions.push([lat, lng]);
    app.updateGPSStatus = (label) => app.gpsStatuses.push(label);
    app.updatePlayerMarker = () => { app.markerUpdates += 1; };
    app.notifyWatchState = (reason) => app.watchNotifies.push(reason);
    app.processMeshAndClaim = (lat, lng) => {
        app.claims.push([lat, lng]);
        // 実機と同じく「そのマスは自陣になった」状態まで進める
        const { meshId } = meshOf(lat, lng);
        app.currentMeshId = meshId;
        app.gridManager.claimedTilesCache.set(meshId, app.currentTeam);
        return Promise.resolve({ changed: true, meshId });
    };
    app.showToast = (message, sub) => app.toasts.push([message, sub]);
    app.toasts = [];
    return app;
}

function position(lat, lng) {
    return { coords: { latitude: lat, longitude: lng, accuracy: 8 }, timestamp: Date.now() };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ *
 * 1. 距離フィルタ（プラグイン仕様の実測に沿う）
 * ------------------------------------------------------------------ */
test('距離フィルタ: 既定は 40m・省電力モードは 60m（100mマスを取りこぼさない範囲）', () => {
    const loaded = loadApp();

    assert.equal(loaded.resolveDistanceFilter(false), 40);
    assert.equal(loaded.resolveDistanceFilter(true), 60);
    // 100mマスに対して 1 更新以上が届く範囲に保つ
    assert.ok(loaded.resolveDistanceFilter(false) >= 40);
    assert.ok(loaded.resolveDistanceFilter(true) < 100);
    assert.ok(loaded.resolveDistanceFilter(true) > loaded.resolveDistanceFilter(false), '省電力は必ず広げる');
});

test('距離フィルタ: addWatcher へ渡すオプションはプラグインの WatcherOptions のキーだけ', (t) => {
    const loaded = loadApp();
    const standard = loaded.buildBackgroundGeolocationOptions(false);
    const power = loaded.buildBackgroundGeolocationOptions(true);

    // 既存の必須設定はそのまま
    assert.ok(standard.backgroundMessage, 'backgroundMessage が無いとバックグラウンド更新が止まる');
    assert.equal(standard.backgroundTitle, 'テリトリーウォーク');
    assert.equal(standard.requestPermissions, true);
    assert.equal(standard.stale, false);
    assert.equal(standard.distanceFilter, 40);
    assert.equal(power.distanceFilter, 60);

    // プラグインが定義しているキー以外を送らない（存在しないオプションを推測で足さない）
    assert.equal('desiredAccuracy' in power, false, 'desiredAccuracy は JS から渡せない（ネイティブ固定）');
    assert.equal('pausesLocationUpdatesAutomatically' in power, false, 'pausesLocationUpdatesAutomatically も渡せない');

    const definitionsPath = path.join(ROOT, 'node_modules', '@capacitor-community', 'background-geolocation', 'definitions.d.ts');
    if (!fs.existsSync(definitionsPath)) {
        t.skip('node_modules が無いためプラグイン定義の実測はスキップ（npm install 後に実行される）');
        return;
    }
    const definitions = fs.readFileSync(definitionsPath, 'utf8');
    const watcherBlock = definitions.slice(
        definitions.indexOf('interface WatcherOptions'),
        definitions.indexOf('interface Location')
    );
    const supported = [...watcherBlock.matchAll(/^\s{4}([a-zA-Z]+)\??:/gm)].map((m) => m[1]);
    assert.deepEqual(
        supported.sort(),
        ['backgroundMessage', 'backgroundTitle', 'distanceFilter', 'requestPermissions', 'stale'],
        '実測したプラグイン仕様（5キー）'
    );
    Object.keys(power).forEach((key) => {
        assert.ok(supported.includes(key), `${key} はプラグインが受け付けるキー`);
    });
});

test('距離フィルタ: ネイティブ側の固定値を壊す変更が入っていないこと（iOS）', (t) => {
    const swiftPath = path.join(
        ROOT, 'node_modules', '@capacitor-community', 'background-geolocation', 'ios', 'Plugin', 'Swift', 'Plugin.swift'
    );

    // アプリ側はバックグラウンド測位のモード（location）を宣言している
    const configureIos = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-ios.js'), 'utf8');
    assert.match(configureIos, /UIBackgroundModes/, 'Info.plist の UIBackgroundModes を設定している');

    if (!fs.existsSync(swiftPath)) {
        t.skip('node_modules が無いため Swift 側の実測はスキップ');
        return;
    }
    const swift = fs.readFileSync(swiftPath, 'utf8');
    // 省電力のための desiredAccuracy 指定はプラグイン側で固定されている（JS からは変えられない）
    assert.match(swift, /manager\.desiredAccuracy = \(/, 'desiredAccuracy はプラグインが決める');
    assert.match(swift, /kCLLocationAccuracyBestForNavigation/, '充電中は最高精度');
    assert.match(swift, /manager\.pausesLocationUpdatesAutomatically = false/, '静止時も止めない（取りこぼし防止）');
    assert.match(swift, /manager\.distanceFilter = distanceFilter!/, 'distanceFilter だけが JS から効く');
    assert.match(swift, /manager\.allowsBackgroundLocationUpdates = background/);
});

test('距離フィルタ: 既定の addWatcher は 40m で呼ばれる', async () => {
    const calls = [];
    const plugin = {
        addWatcher(options) { calls.push(options); return Promise.resolve('watcher-1'); },
        removeWatcher() { return Promise.resolve(); }
    };
    const loaded = loadApp();
    const app = createApp(loaded);

    app.startBackgroundGeolocation(plugin);
    await tick();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].distanceFilter, 40);
});

/* ------------------------------------------------------------------ *
 * 2. 同一マス滞在中のスキップ判定（純粋関数）
 * ------------------------------------------------------------------ */
test('スキップ判定: 同じマス・自陣・5m未満のときだけ捨てる', () => {
    const { shouldSkipStationaryUpdate } = loadApp();
    const base = { distanceMeters: 3, sameMesh: true, cellAlreadyMine: true };

    assert.equal(shouldSkipStationaryUpdate(base), true);
    assert.equal(shouldSkipStationaryUpdate({ ...base, distanceMeters: 6 }), false, '5m以上動いたら処理する');
    assert.equal(shouldSkipStationaryUpdate({ ...base, sameMesh: false }), false, 'マスが変わったら処理する');
    assert.equal(shouldSkipStationaryUpdate({ ...base, cellAlreadyMine: false }), false, 'まだ自陣でないマスは処理する');
    assert.equal(shouldSkipStationaryUpdate({ ...base, isFirst: true }), false, '初回取得は必ず処理する');
    assert.equal(shouldSkipStationaryUpdate({ ...base, force: true }), false, '明示的な再取得は必ず処理する');
    assert.equal(shouldSkipStationaryUpdate({ ...base, skipClaim: true }), false, '精度の低い測位は捨てない');
    assert.equal(shouldSkipStationaryUpdate({ ...base, distanceMeters: Infinity }), false);
    assert.equal(shouldSkipStationaryUpdate({ ...base, distanceMeters: 11, thresholdMeters: 12 }), true, '省電力は12mまで');
    assert.equal(shouldSkipStationaryUpdate(), false, '引数なしでも落ちない');
});

/* ------------------------------------------------------------------ *
 * 3. handlePositionUpdate の実挙動
 * ------------------------------------------------------------------ */
test('実挙動: 同じマスに留まっている間は再描画・通信・Watch送信をしない', async () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    const [lat, lng] = cellCenter(meshOf(35.658, 139.7016).latIdx, meshOf(35.658, 139.7016).lngIdx);

    app.handlePositionUpdate(position(lat, lng), true);
    await tick();
    assert.equal(app.claims.length, 1, '初回は塗る');
    assert.equal(app.markerUpdates, 1, '初回はピンを置く');
    assert.equal(app.watchNotifies.length, 1, '初回はWatchへ送る');

    const afterFirst = {
        claims: app.claims.length,
        markers: app.markerUpdates,
        watch: app.watchNotifies.length
    };

    // 同じマスの中で 3m 揺れただけ（GPS誤差）
    app.handlePositionUpdate(position(lat + 0.000027, lng), false);
    await tick();

    assert.equal(app.claims.length, afterFirst.claims, 'Supabase/塗りの処理をしない');
    assert.equal(app.markerUpdates, afterFirst.markers, '地図を描き直さない');
    assert.equal(app.watchNotifies.length, afterFirst.watch, 'Watchへ重複送信しない');
    assert.ok(app.lastSkippedPositionAt > 0, 'スキップした時刻を残す');
});

test('実挙動: マスが変われば（隣のマスへ歩いたら）必ず処理する', async () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    const mesh = meshOf(35.658, 139.7016);
    const [lat, lng] = cellCenter(mesh.latIdx, mesh.lngIdx);

    app.handlePositionUpdate(position(lat, lng), true);
    await tick();

    // 1マス北（100m）へ
    const nextLat = lat + LAT_STEP;
    app.handlePositionUpdate(position(nextLat, lng), false);
    await tick();

    assert.equal(app.claims.length, 2, '新しいマスは塗る');
    assert.equal(app.markerUpdates, 2);
    assert.notEqual(meshOf(nextLat, lng).meshId, mesh.meshId);
});

test('実挙動: 同じマスでもチームが変わったら塗り直す（スキップしない）', async () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    const mesh = meshOf(35.658, 139.7016);
    const [lat, lng] = cellCenter(mesh.latIdx, mesh.lngIdx);

    app.handlePositionUpdate(position(lat, lng), true);
    await tick();
    assert.equal(app.claims.length, 1);

    // チーム変更（デバッグの陣営入替など）: キャッシュは旧チームのまま
    app.currentTeam = 'white';
    app.handlePositionUpdate(position(lat + 0.000027, lng), false);
    await tick();

    assert.equal(app.claims.length, 2, 'チームが変わったマスは塗り直す');
    assert.equal(app.gridManager.claimedTilesCache.get(mesh.meshId), 'white');
});

test('実挙動: まだ自陣でないマスは、誤差レベルの移動でも処理する', async () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    const mesh = meshOf(35.658, 139.7016);
    const [lat, lng] = cellCenter(mesh.latIdx, mesh.lngIdx);

    app.handlePositionUpdate(position(lat, lng), true);
    await tick();

    // 送信に失敗してキャッシュが消えた（=まだ自陣になっていない）状態を再現
    app.gridManager.claimedTilesCache.delete(mesh.meshId);
    app.handlePositionUpdate(position(lat + 0.000027, lng), false);
    await tick();

    assert.equal(app.claims.length, 2, '取りこぼしたマスは取り返す');
});

test('実挙動: 明示的な再取得（force）と初回取得はスキップしない', async () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    const mesh = meshOf(35.658, 139.7016);
    const [lat, lng] = cellCenter(mesh.latIdx, mesh.lngIdx);

    app.handlePositionUpdate(position(lat, lng), true);
    await tick();
    const markersBefore = app.markerUpdates;
    const watchBefore = app.watchNotifies.length;

    app.handlePositionUpdate(position(lat + 0.000009, lng), false, { force: true });
    await tick();

    assert.equal(app.markerUpdates, markersBefore + 1, '現在地ボタンではピンを必ず更新する');
    assert.equal(app.watchNotifies.length, watchBefore + 1, 'Watchにも必ず送る');
});

test('実挙動: 省電力モードは静止中のしきい値を 5m → 12m に広げる', async () => {
    const loaded = loadApp();
    const mesh = meshOf(35.658, 139.7016);
    const [lat, lng] = cellCenter(mesh.latIdx, mesh.lngIdx);
    // 約 8m 北（同じマスの中）
    const nearLat = lat + 0.000072;

    // 標準モード: 8m 動いたので再描画と Watch 送信はする（マスは同じなので塗り直しはしない）
    const app = createApp(loaded);
    app.handlePositionUpdate(position(lat, lng), true);
    await tick();
    app.handlePositionUpdate(position(nearLat, lng), false);
    await tick();
    assert.equal(app.markerUpdates, 2, '標準は8mの移動を画面に反映する');
    assert.equal(app.watchNotifies.length, 2, '標準は8mの移動をWatchへ送る');
    assert.equal(app.claims.length, 1, '同じマスなので塗り直しはしない');

    // 省電力モード: 同じ8mの揺れは捨てる
    const powerApp = createApp(loaded, { powerSaveMode: true });
    powerApp.handlePositionUpdate(position(lat, lng), true);
    await tick();
    powerApp.handlePositionUpdate(position(nearLat, lng), false);
    await tick();
    assert.equal(powerApp.claims.length, 1);
    assert.equal(powerApp.markerUpdates, 1, '省電力は12m未満の揺れで描き直さない');
    assert.equal(powerApp.watchNotifies.length, 1, '省電力は12m未満の揺れをWatchへ送らない');
});

test('実挙動: マーキング停止中は従来どおりピンだけ動かし、マスは塗らない', async () => {
    const loaded = loadApp();
    const app = createApp(loaded, { markingPaused: true });

    app.handlePositionUpdate(position(35.65845, 139.70165), true);
    await tick();

    assert.equal(app.claims.length, 0);
    assert.equal(app.markerUpdates, 1, '停止中でも現在地は見せる');
});

/* ------------------------------------------------------------------ *
 * 4. 省電力モードのトグル
 * ------------------------------------------------------------------ */
function createToggleElements() {
    const make = () => ({
        dataset: {},
        textContent: '',
        title: '',
        attributes: {},
        classes: new Set(),
        addEventListener(type, handler) { this.handler = handler; },
        setAttribute(name, value) { this.attributes[name] = value; },
        classList: {
            toggle(name, force) {
                if (force) this._set.add(name);
                else this._set.delete(name);
            }
        }
    });
    const button = make();
    button.classList._set = button.classes;
    const dot = make();
    dot.classList._set = dot.classes;
    const text = make();
    const detail = make();
    return {
        'btn-toggle-power-save': button,
        'power-save-dot': dot,
        'power-save-text': text,
        'power-save-detail': detail
    };
}

test('トグル: OFF→ON で localStorage に保存され、UI と説明文が切り替わる', () => {
    const elements = createToggleElements();
    const loaded = loadApp({ elements });
    const app = createApp(loaded);
    app.btnTogglePowerSave = elements['btn-toggle-power-save'];
    app.powerSaveDot = elements['power-save-dot'];
    app.powerSaveText = elements['power-save-text'];
    app.powerSaveDetail = elements['power-save-detail'];

    assert.equal(app.isPowerSaveMode(), false);
    assert.equal(app.setPowerSaveMode(true), true);

    assert.equal(loaded.storage.tw_power_save, '1', '端末内に保存する');
    assert.equal(app.isPowerSaveMode(), true);
    assert.equal(elements['btn-toggle-power-save'].dataset.state, 'on');
    assert.equal(elements['btn-toggle-power-save'].attributes['aria-pressed'], 'true');
    assert.equal(elements['power-save-text'].textContent, 'ON');
    assert.match(elements['power-save-detail'].textContent, /60m/, 'ONの説明は60m');
    assert.equal(loaded.body.dataset.powerSave, 'on');
    assert.equal(app.toasts.length, 1, '切り替えたことを知らせる');
    assert.match(app.toasts[0][0], /省電力モードを ON/);

    // もう一度押すと OFF に戻る
    assert.equal(app.setPowerSaveMode(false), true);
    assert.equal(loaded.storage.tw_power_save, '0');
    assert.equal(elements['btn-toggle-power-save'].dataset.state, 'off');
    assert.equal(elements['power-save-text'].textContent, 'OFF');
    assert.match(elements['power-save-detail'].textContent, /40m/);
    assert.equal(app.setPowerSaveMode(false), false, '同じ値では何もしない');
});

test('トグル: 測位中に切り替えると新しい distanceFilter で watcher を張り直す', async () => {
    const pluginCalls = [];
    const plugin = {
        addWatcher(options) { pluginCalls.push(options); return Promise.resolve(`w-${pluginCalls.length}`); },
        removeWatcher(args) { pluginCalls.push({ removed: args.id }); return Promise.resolve(); }
    };
    const loaded = loadApp();
    const app = createApp(loaded, { backgroundGeolocationPlugin: plugin });

    app.backgroundWatcherStarted = true;
    app.backgroundWatcherId = 'w-1';

    app.setPowerSaveMode(true, { silent: true });
    await tick();

    assert.deepEqual(pluginCalls[0], { removed: 'w-1' }, '古い watcher を止める');
    const added = pluginCalls.filter((c) => c && c.distanceFilter);
    assert.equal(added.length, 1);
    assert.equal(added[0].distanceFilter, 60, '張り直しは 60m');
    assert.equal(app.backgroundWatcherStarted, true);
});

test('トグル: 保存済みの設定は起動時に読む（前回ONならONで始まる）', () => {
    const loaded = loadApp({ storage: { tw_power_save: '1' } });
    const app = createApp(loaded);
    assert.equal(app.readPowerSavePreference(), true);
    assert.equal(loaded.resolveDistanceFilter(app.readPowerSavePreference()), 60);

    const offLoaded = loadApp({ storage: {} });
    assert.equal(createApp(offLoaded).readPowerSavePreference(), false, '未設定はOFF');
});

/* ------------------------------------------------------------------ *
 * 5. UI と配線
 * ------------------------------------------------------------------ */
test('UI: MENU に省電力モードのトグルがあり、アプリが初期化時に配線する', () => {
    const menu = INDEX_HTML.slice(INDEX_HTML.indexOf('id="menu-modal"'), INDEX_HTML.indexOf('id="debug-mode-section"'));
    assert.match(menu, /id="btn-toggle-power-save"/, 'MENU の中にある');
    assert.match(menu, /id="power-save-text"/);
    assert.match(menu, /id="power-save-detail"/);
    assert.match(INDEX_HTML, /省電力モード/);
    assert.match(menu, /更新間隔 40m/, '既定は40mと表示する');

    assert.match(APP_SOURCE, /initPowerSaveToggle\(\)/, 'initDOM から配線する');
    assert.match(APP_SOURCE, /buildBackgroundGeolocationOptions\(this\.isPowerSaveMode\(\)\)/);
    assert.match(APP_SOURCE, /localStorage\.setItem\(POWER_SAVE_STORAGE_KEY/);
});

test('UI: 省電力モードの初期化で二重配線しない', () => {
    const elements = createToggleElements();
    const loaded = loadApp({ elements });
    const app = createApp(loaded, { btnTogglePowerSave: elements['btn-toggle-power-save'] });
    app.powerSaveDot = elements['power-save-dot'];
    app.powerSaveText = elements['power-save-text'];
    app.powerSaveDetail = elements['power-save-detail'];

    assert.equal(app.initPowerSaveToggle(), true);
    assert.equal(app.initPowerSaveToggle(), false, '2回目は何もしない');
    assert.equal(typeof elements['btn-toggle-power-save'].handler, 'function', 'タップで切り替えられる');
    elements['btn-toggle-power-save'].handler({ preventDefault() {} });
    assert.equal(app.isPowerSaveMode(), true);
});

test('配線: www/app.js が app.js と同期し、キャッシュバスターが上がっている', () => {
    const wwwApp = readWwwAppSource();
    assert.equal(wwwApp, APP_SOURCE, 'www/ の app 分割モジュールはルートと同一（npm run build で同期）');
    assert.match(INDEX_HTML, /app\.js\?v=20261123v70/);
});
