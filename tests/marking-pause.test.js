/**
 * TERRITORY WALK - Node tests
 * 陣地マーキング（歩いた場所の自動塗り）ON / OFF トグル
 *   1) localStorage への永続化と復元（既定は ON）
 *   2) 停止中に起動したら位置情報ウォッチャーを張らない（起動直後の一瞬塗り防止）
 *   3) 稼働中の停止で watcher / watchPosition を実際に止める（電池消費の停止）
 *   4) 停止中は実GPS由来の塗りを二重ガードで止める（D-Pad の手動操作は除く）
 *   5) 再開で測位を張り直す（OS権限拒否時は既存バナー導線が生きる）
 *   6) UI（トグルボタン・一時停止バー・タップ再開・積み上げレイアウト）
 *   7) index.html / style.css / www の配線とキャッシュバスター
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
const { readAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

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

function createStubElement(id, { hidden = false, top = 0, height = 0 } = {}) {
    const listeners = {};
    return {
        id,
        classList: createClassList(hidden ? ['hidden'] : []),
        style: {},
        dataset: {},
        title: '',
        textContent: '',
        attributes: {},
        listeners,
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        dispatch(type) {
            (listeners[type] || []).forEach((handler) => handler({ type, preventDefault() {} }));
        },
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        getAttribute(name) {
            return this.attributes[name];
        },
        getBoundingClientRect() {
            return { top, bottom: top + height, height, left: 0, right: 375, width: 375 };
        }
    };
}

function createStubDocument(options = {}) {
    const headerHeight = options.headerHeight === undefined ? 150 : options.headerHeight;
    const permissionVisible = options.permissionVisible === true;
    const elements = {
        'location-permission-banner': createStubElement('location-permission-banner', {
            hidden: !permissionVisible,
            top: headerHeight + 8,
            height: 60
        }),
        'btn-location-banner-retry': createStubElement('btn-location-banner-retry'),
        'marking-paused-banner': createStubElement('marking-paused-banner', {
            hidden: true,
            top: 0,
            height: 62
        }),
        'btn-marking-resume': createStubElement('btn-marking-resume'),
        'btn-marking-toggle': createStubElement('btn-marking-toggle'),
        'marking-toggle-label': createStubElement('marking-toggle-label')
    };
    const header = createStubElement('header', { top: 0, height: headerHeight });
    const doc = {
        elements,
        body: { dataset: {} },
        getElementById: (id) => elements[id] || null,
        querySelector: (selector) => (selector === 'header' ? header : null),
        querySelectorAll: () => [],
        addEventListener() {}
    };
    return doc;
}

/** app.js を vm 上に読み込み、プロトタイプと利用したコンテキストを返す */
function loadApp(options = {}) {
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
    vm.runInContext(readAppSource(), context, { filename: 'app.js' });
    return { context, document: doc, storage, TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context) };
}

/** コンストラクタを通さず、テストに必要な状態だけを持つインスタンスを作る */
function createApp(loaded, overrides = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    Object.assign(app, {
        watchId: null,
        nativeWatchId: null,
        backgroundGeolocationPlugin: null,
        backgroundWatcherId: null,
        backgroundWatcherStarted: false,
        virtualPos: [35.6580, 139.7016],
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
        locationBanner: null,
        markingPaused: false,
        geolocationStarted: false,
        servicesStarted: false,
        gpsStatuses: [],
        claims: [],
        toasts: [],
        markerUpdates: 0,
        geoInits: 0,
        adMobInits: 0
    }, overrides);

    app.updateGPSStatus = (label) => { app.gpsStatuses.push(label); };
    app.updatePlayerMarker = () => { app.markerUpdates += 1; };
    app.processMeshAndClaim = (lat, lng) => {
        app.claims.push([lat, lng]);
        return Promise.resolve({ changed: true });
    };
    app.showToast = (message) => { app.toasts.push(message); };
    app.repositionToastContainer = () => {};
    app.layoutTopNotices = () => {};
    app.initGeolocation = () => { app.geoInits += 1; };
    app.adMobManager = { init: () => { app.adMobInits += 1; } };
    return app;
}

/** バックグラウンド位置情報プラグイン（addWatcher は watcher ID の Promise） */
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
            if (options.pending) {
                return new Promise((resolve) => { plugin.resolveWatcher = () => resolve(options.watcherId || 'watcher-late'); });
            }
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
        watchPosition() {
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

/** 塗りパイプライン用のグリッドスタブ（マス獲得の副作用を数える） */
function createGridStub() {
    const state = { saved: 0, rendered: 0, claims: 0 };
    const grid = {
        state,
        claimedTilesCache: new Map(),
        renderedMeshes: new Map(),
        getMeshIdFromLatLng: () => ({ meshId: 'tile_100x100', latIdx: 100, lngIdx: 100 }),
        saveTilesToStorage() { state.saved += 1; },
        renderSingleTile() { state.rendered += 1; },
        getTileStyle() { return {}; }
    };
    return grid;
}

function attachClaimPipeline(app) {
    // createApp のスタブ（呼び出し記録）ではなく、実際の塗りパイプラインを使う
    const proto = Object.getPrototypeOf(app);
    app.processMeshAndClaim = proto.processMeshAndClaim.bind(app);
    app.gridManager = createGridStub();
    app.updateScoreUI = () => {};
    app.playClaimSound = () => {};
    app.triggerHaptic = () => {};
    app.enqueueTileSync = () => {};
    app.statsManager = { recordTileClaimed: () => {} };
    app.coinManager = { onTileClaimed: () => {} };
    return app;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** vm コンテキスト内で作られたオブジェクト/配列を、この Realm の値に直して比較する */
function plain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * 1. 既定は ON、保存した状態を復元する
 * ------------------------------------------------------------------ */
test('既定: localStorage 未設定ならマーキングは ON（停止していない）', () => {
    const loaded = loadApp();
    const app = createApp(loaded);

    assert.equal(app.readMarkingPausePreference(), false);
    assert.equal(app.isMarkingPaused(), false);
});

test('永続化: 停止すると localStorage に 1、再開で 0 を書き、次回起動で引き継ぐ', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { markingToggleBound: true });

    app.setMarkingPaused(true);
    assert.equal(loaded.storage.tw_marking_paused, '1');
    assert.equal(app.isMarkingPaused(), true);

    // 再起動相当：新しいインスタンスが同じ storage を読む
    const restarted = createApp(loaded);
    assert.equal(restarted.readMarkingPausePreference(), true, '前回の停止状態を引き継ぐ');

    app.setMarkingPaused(false);
    assert.equal(loaded.storage.tw_marking_paused, '0');
    assert.equal(createApp(loaded).readMarkingPausePreference(), false, '再開も引き継ぐ');
});

/* ------------------------------------------------------------------ *
 * 2. 起動時 OFF ならウォッチャーを張らない（一瞬塗り事故の防止）
 * ------------------------------------------------------------------ */
test('起動: 停止中に起動したら initGeolocation を呼ばず、AdMob だけ初期化する', () => {
    const loaded = loadApp({ storage: { tw_marking_paused: '1' } });
    const app = createApp(loaded, {
        markingPaused: app_read(loaded),
        markingToggleBound: true
    });

    assert.equal(app.markingPaused, true, 'ストレージから停止中を復元する');

    const started = app.startDeferredServices('repeat-launch');
    assert.equal(started, true);
    assert.equal(app.geoInits, 0, '位置情報ウォッチャーは張らない');
    assert.equal(app.geolocationStarted, false);
    assert.equal(app.adMobInits, 1, '広告初期化は通常どおり');
    assert.ok(app.gpsStatuses.includes('GPS: マーキング停止中'), 'GPSランプは停止中を表示');
});

test('起動: 停止していなければ従来どおり位置情報を開始し、二重には開始しない', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { markingPaused: app_read(loaded) });

    assert.equal(app.startDeferredServices('repeat-launch'), true);
    assert.equal(app.geoInits, 1);
    assert.equal(app.geolocationStarted, true);
    assert.equal(app.startDeferredServices('repeat-launch'), false, '2回目は何もしない');
    assert.equal(app.geoInits, 1);
});

test('起動ゲート通過前は再開操作でも測位を始めない（初回のルール説明中）', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { markingPaused: true, servicesStarted: false });

    assert.equal(app.startLocationTracking(), false, 'ゲート前は開始しない');
    assert.equal(app.geoInits, 0);
    assert.equal(app.isMarkingPaused(), true, '停止状態は維持される');
});

/* ヘルパー：ストレージから復元した値 */
function app_read(loaded) {
    const tmp = Object.create(loaded.TerritoryWalkApp.prototype);
    return tmp.readMarkingPausePreference();
}

/* ------------------------------------------------------------------ *
 * 3. 稼働中の停止で watcher / watchPosition を実際に止める
 * ------------------------------------------------------------------ */
test('停止: ネイティブの watcher を removeWatcher で外し、電池消費を止める', async () => {
    const plugin = createNativePlugin({ watcherId: 'watcher-abc' });
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
    app.initGeolocation = loaded.TerritoryWalkApp.prototype.initGeolocation.bind(app);

    app.initGeolocation();
    await tick();
    assert.equal(plugin.calls.addWatcher, 1);
    assert.equal(app.backgroundWatcherStarted, true);

    app.setMarkingPaused(true);
    await tick();

    assert.deepEqual(plain(plugin.calls.removeWatcher), [{ id: 'watcher-abc' }], 'watcher を確実に解除する');
    assert.equal(app.backgroundWatcherStarted, false);
    assert.equal(app.backgroundWatcherId, null);
    assert.equal(app.geolocationStarted, false);
});

test('停止: Web の watchPosition も clearWatch で止める', () => {
    const geo = createWebGeolocation();
    const loaded = loadApp({ navigator: { geolocation: geo } });
    const app = createApp(loaded);
    app.initGeolocation = loaded.TerritoryWalkApp.prototype.initGeolocation.bind(app);

    app.initGeolocation();
    assert.equal(geo.calls.watchPosition, 1);
    assert.equal(app.watchId, 77);

    app.setMarkingPaused(true);

    assert.deepEqual(geo.calls.clearWatch, [77], 'フォアグラウンド測位を止める');
    assert.equal(app.watchId, null);
});

test('停止: watcher ID の解決が停止より遅れても、届いた watcher をすぐ止める', async () => {
    const plugin = createNativePlugin({ pending: true, watcherId: 'watcher-late' });
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
    app.initGeolocation = loaded.TerritoryWalkApp.prototype.initGeolocation.bind(app);

    app.initGeolocation();
    // まだ watcher ID が来ていないうちに停止する
    app.setMarkingPaused(true);
    assert.equal(plugin.calls.removeWatcher.length, 0, 'ID 未取得なので、この時点では外せない');

    plugin.resolveWatcher();
    await tick();
    await tick();

    assert.deepEqual(plain(plugin.calls.removeWatcher), [{ id: 'watcher-late' }], '解決後に必ず停止する');
    assert.equal(app.backgroundWatcherId, null);
});

/* ------------------------------------------------------------------ *
 * 4. 停止中は実GPS由来の塗りを二重ガードで止める
 * ------------------------------------------------------------------ */
test('停止中: processMeshAndClaim は実GPS由来の塗りを拒否する', async () => {
    const loaded = loadApp();
    const app = attachClaimPipeline(createApp(loaded, { markingPaused: true }));

    const result = await app.processMeshAndClaim(35.65821, 139.70162);

    assert.equal(result.changed, false);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'marking-paused');
    assert.equal(app.gridManager.claimedTilesCache.size, 0, 'マスを獲得しない');
    assert.equal(app.gridManager.state.rendered, 0, '描画もしない');
});

test('停止中でも D-Pad（手動テスト操作）は塗れる', async () => {
    const loaded = loadApp();
    const app = attachClaimPipeline(createApp(loaded, { markingPaused: true }));

    const byOption = await app.processMeshAndClaim(35.65821, 139.70162, { source: 'debug' });
    assert.equal(byOption.blocked, undefined, '手動操作は停止中でも通す');
    assert.equal(byOption.changed, true);

    app.currentMeshId = null;
    app.manualMarkingInProgress = true;
    const byFlag = await app.processMeshAndClaim(35.65900, 139.70162);
    app.manualMarkingInProgress = false;
    assert.equal(byFlag.changed, true, 'D-Pad の呼び出し経路（フラグ）でも通す');
});

test('停止中: handlePositionUpdate も実GPSからの塗りを二重に止める（マーカーは動かす）', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { markingPaused: true, isMarkingPaused: loaded.TerritoryWalkApp.prototype.isMarkingPaused });

    app.handlePositionUpdate({ coords: { latitude: 35.65821, longitude: 139.70162 }, timestamp: 1 }, true);

    assert.equal(app.claims.length, 0, '塗りパイプラインへ流さない');
    assert.deepEqual(plain(app.lastRealPosition), [35.65821, 139.70162], '実GPS座標は保持する');
    assert.equal(app.markerUpdates, 1, 'マーカーの位置は更新して地図を自然に保つ');
    assert.ok(app.gpsStatuses.includes('GPS: マーキング停止中'));
});

/* ------------------------------------------------------------------ *
 * 5. 再開で測位を張り直す
 * ------------------------------------------------------------------ */
test('再開: localStorage を更新し、バッジを消して測位を張り直す', () => {
    const loaded = loadApp({ storage: { tw_marking_paused: '1' } });
    const app = createApp(loaded, {
        markingPaused: true,
        servicesStarted: true,
        geolocationStarted: false,
        markingToggleBound: true
    });

    const banner = loaded.document.getElementById('marking-paused-banner');
    app.renderMarkingPauseUI();
    assert.equal(banner.classList.contains('hidden'), false, '停止中はバッジが見えている');

    const changed = app.setMarkingPaused(false);
    assert.equal(changed, true);
    assert.equal(loaded.storage.tw_marking_paused, '0');
    assert.equal(app.geoInits, 1, '再開で測位を開始する');
    assert.equal(app.geolocationStarted, true);
    assert.equal(banner.classList.contains('hidden'), true, 'バッジはすぐ消える');
    assert.deepEqual(app.toasts, ['マーキングを再開しました']);
});

test('再開: すでに測位中なら watcher を二重に張らない', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { markingPaused: false, servicesStarted: true, geolocationStarted: true });

    app.setMarkingPaused(false);
    assert.equal(app.geoInits, 0, '変化なしの再開では開始処理を呼ばない');

    app.setMarkingPaused(true);
    assert.equal(app.geolocationStarted, false);
    app.setMarkingPaused(false);
    assert.equal(app.geoInits, 1, '停止→再開の1回だけ張り直す');
});

/* ------------------------------------------------------------------ *
 * 6. UI（ボタン・バッジ・タップ再開・積み上げ）
 * ------------------------------------------------------------------ */
test('UI: トグルボタンで ON / OFF を切り替え、表示が追従する', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { markingToggleBound: false });
    app.initMarkingToggle();

    const btn = loaded.document.getElementById('btn-marking-toggle');
    const label = loaded.document.getElementById('marking-toggle-label');
    const banner = loaded.document.getElementById('marking-paused-banner');

    assert.equal(btn.dataset.state, 'active');
    assert.equal(btn.attributes['aria-pressed'], 'true');
    assert.match(btn.attributes['aria-label'], /マーキング ON/);
    assert.equal(label.textContent, 'ON');
    assert.equal(banner.classList.contains('hidden'), true);

    btn.dispatch('click');
    assert.equal(app.isMarkingPaused(), true);
    assert.equal(btn.dataset.state, 'paused');
    assert.equal(btn.attributes['aria-pressed'], 'false');
    assert.equal(label.textContent, '停止中');
    assert.match(btn.title, /停止中（タップで再開）/);
    assert.equal(banner.classList.contains('hidden'), false);

    btn.dispatch('click');
    assert.equal(app.isMarkingPaused(), false);
    assert.equal(label.textContent, 'ON');
    assert.equal(banner.classList.contains('hidden'), true);
});

test('UI: 一時停止バーのタップでワンタップ再開できる', () => {
    const loaded = loadApp({ storage: { tw_marking_paused: '1' } });
    const app = createApp(loaded, {
        markingPaused: true,
        servicesStarted: true,
        markingToggleBound: false
    });
    app.initMarkingToggle();

    const resume = loaded.document.getElementById('btn-marking-resume');
    assert.equal(app.isMarkingPaused(), true);

    resume.dispatch('click');

    assert.equal(app.isMarkingPaused(), false);
    assert.equal(loaded.storage.tw_marking_paused, '0');
    assert.equal(loaded.document.getElementById('marking-paused-banner').classList.contains('hidden'), true);
});

test('レイアウト: 一時停止バーはヘッダー直下、拒否バナー表示中はその下に積む', () => {
    const loaded = loadApp({ document: createStubDocument({ headerHeight: 150 }) });
    const app = createApp(loaded, { markingPaused: true });
    app.layoutTopNotices = loaded.TerritoryWalkApp.prototype.layoutTopNotices.bind(app);

    const banner = loaded.document.getElementById('marking-paused-banner');
    banner.classList.remove('hidden');

    assert.equal(app.layoutTopNotices(), '158px', 'ヘッダー下端 + 8px');

    // 位置情報オフの警告バナーが出ている場合は、その下にずらす
    loaded.document.getElementById('location-permission-banner').classList.remove('hidden');
    assert.equal(app.layoutTopNotices(), '226px', '拒否バナー（158+60）の下 + 8px');
});

/* ------------------------------------------------------------------ *
 * 7. 配線・キャッシュバスター・ビルド同期
 * ------------------------------------------------------------------ */
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const APP = readAppSource();

test('HTML: トグルは現在地ボタンの真上、一時停止バーはヘッダー直下に置く', () => {
    assert.match(HTML, /id="btn-marking-toggle"[^>]*aria-pressed="true"/, 'トグルボタンがある');
    assert.match(HTML, /id="marking-toggle-label"[^>]*>ON</, 'ボタン表示は「マーキング ON」');

    const controls = HTML.slice(HTML.indexOf('id="map-controls-container"'), HTML.indexOf('id="dpad-container"'));
    const toggleIndex = controls.indexOf('id="btn-marking-toggle"');
    const recenterIndex = controls.indexOf('id="btn-recenter"');
    assert.ok(toggleIndex > 0, 'マップ操作群の中にある');
    assert.ok(recenterIndex > toggleIndex, '現在地ボタンより上（先）に配置');

    assert.match(HTML, /id="marking-paused-banner"[^>]*role="status"/);
    assert.match(HTML, /マーキング一時停止中（タップで再開）/, 'バーの文言は確定仕様どおり');
    assert.match(HTML, /id="btn-marking-resume"/, 'バー自体がタップで再開できる');
});

test('HTML: 位置情報オフの警告バナーと文言・役割が混ざらない', () => {
    assert.match(HTML, /id="location-permission-banner"/);
    assert.match(HTML, /位置情報がオフになっています/, 'OS権限オフは従来の警告文言のまま');
    assert.doesNotMatch(HTML, /btn-location-banner-close/, '警告バナーは閉じる操作を持たない');
});

test('文言: 今回の機能のユーザー向け文言は「マーキング」で統一する', () => {
    assert.match(APP, /マーキング/, 'app.js のトースト等でマーキング表記を使う');
    assert.doesNotMatch(APP, /陣地塗りを一時停止しました|塗りを再開しました/, '旧「塗り」表記を残さない');
    assert.match(APP, /マーキングを一時停止しました/);
    assert.match(APP, /マーキングを再開しました/);
    assert.match(APP, /aria-label', paused\s*\n?\s*\? 'マーキング停止中（タップで再開）'/, '読み上げラベルもマーキング');
});

test('CSS: 375px幅で崩れない固定サイズと状態別の配色がある', () => {
    assert.match(CSS, /#marking-paused-banner \{[^}]*width: calc\(100% - 1\.5rem\);[^}]*max-width: 25rem;/);
    assert.match(CSS, /#marking-paused-banner\.hidden \{\s*display: none !important;/);
    // v1.2: ＋／－／現在地と同じ正方形（52×52・角丸16px）に揃えた
    assert.match(CSS, /\.marking-toggle-btn \{[^}]*width: 52px;[^}]*height: 52px;[^}]*border-radius: 16px;/);
    assert.match(CSS, /\.marking-toggle-btn\[data-state="paused"\] \{[^}]*background: rgba\(8, 47, 73, 0\.92\);[^}]*border-color: rgba\(56, 189, 248, 0\.85\);/);
});

test('キャッシュバスター: 変更した app.js は v63、style.css は v52 を参照する', () => {
    assert.match(HTML, /app\.js\?v=20261122v67/);
    assert.match(HTML, /style\.css\?v=20261119v53/);
});

test('ビルド: www/ の index.html / style.css / app.js がルートと一致する', () => {
    ['index.html', 'style.css', 'app.js'].forEach((file) => {
        const wwwPath = path.join(ROOT, 'www', file);
        assert.ok(fs.existsSync(wwwPath), `www/${file} が存在する`);
        assert.equal(fs.readFileSync(wwwPath, 'utf8'), fs.readFileSync(path.join(ROOT, file), 'utf8'), `www/${file} が同一`);
    });
});

test('提出ビルド: デバッグ機能は無効（ENABLE_DEBUG_TOOLS: false）で、D-Pad の経路は残っている', () => {
    assert.match(APP, /ENABLE_DEBUG_TOOLS: false/);
    assert.match(APP, /isVirtualWalkActive\(\)/, 'D-Pad の判定は残っている');
    assert.match(APP, /this\.manualMarkingInProgress = true;/, 'D-Pad は停止中でも塗れる経路を持つ');
});

test('permisison.js: 拒否バナーの再確認導線は変更していない', () => {
    assert.equal(typeof LocationPermissionBanner, 'function');
    assert.equal(LocationPermissionBanner.isPermissionDeniedError({ code: 'NOT_AUTHORIZED' }), true);
});
