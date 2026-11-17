/**
 * TERRITORY WALK - Node tests
 * v1.1 実機報告：起動時に毎回渋谷が初期表示になり、「現在地」ボタンを押しても
 * 渋谷のままになることがある。
 *
 *   1) 前回の現在地を端末に保存し、次回起動はその位置を中心に開く
 *   2) 保存が無い初回は渋谷にピンを刺さず、広域表示で測位を待つ
 *   3) 「現在地」ボタンは必ず GPS を取り直してから移動する
 *   4) 測位に失敗したときは最後に分かっている位置へ戻す（無反応にしない）
 *   5) 仮想散歩（デバッグ）中は GPS で上書きしない
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

const toPlain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** localStorage と navigator を差し替えて app.js を読み込む */
function loadApp(storage = {}, options = {}) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: options.document || {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            body: { dataset: {} }
        },
        navigator: options.navigator || {},
        window: {},
        localStorage: {
            getItem: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; }
        },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval() {}
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(APP_SOURCE, context, { filename: 'app.js' });
    return {
        context,
        CONFIG: vm.runInContext('CONFIG', context),
        TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context),
        storage
    };
}

/** 現在地ボタンなどを単体で動かすための最小アプリ */
function createApp(loaded, overrides = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    Object.assign(app, {
        debugEnabled: false,
        isDebugMode: false,
        searchManager: null,
        locationBanner: null,
        gridManager: null,
        isAppInBackground: false,
        currentMeshId: null,
        lastProcessedLat: null,
        lastProcessedLng: null,
        virtualPos: [35.0, 135.0],
        savedPosition: null,
        lastRealPosition: null,
        userMarker: null,
        marker: [],
        mapCalls: [],
        toasts: []
    }, overrides);
    app.showToast = (title, subtitle) => app.toasts.push([title, subtitle]);
    app.updateGPSStatus = () => {};
    app.updatePlayerMarker = (pos) => app.marker.push(toPlain(pos));
    app.handlePositionUpdate = (position, isFirst = false) => {
        app.lastRealPosition = [position.coords.latitude, position.coords.longitude];
        if (isFirst && app.map) app.map.setView(app.lastRealPosition, 17);
    };
    if (!app.map) {
        app.map = {
            getZoom: () => 17,
            setView: (center, zoom) => app.mapCalls.push([toPlain(center), zoom])
        };
    }
    return app;
}

/* ------------------------------------------------------------------ *
 * 1. 前回の現在地の保存・読み出し
 * ------------------------------------------------------------------ */

test('起動位置: 保存された前回の現在地を読み出せる', () => {
    const storage = {
        tw_last_position: JSON.stringify({ lat: 34.6112, lng: 135.5008, at: 1763200000000 })
    };
    const loaded = loadApp(storage);
    const app = createApp(loaded);

    assert.deepEqual(toPlain(app.loadSavedPosition()), [34.6112, 135.5008]);
});

test('起動位置: 保存が無い・壊れている・範囲外なら null（渋谷フォールバックへ）', () => {
    const cases = [
        {},
        { tw_last_position: 'not-json' },
        { tw_last_position: JSON.stringify({ lat: 'x', lng: 135.5 }) },
        { tw_last_position: JSON.stringify({ lat: 91, lng: 135.5 }) },
        { tw_last_position: JSON.stringify({ lat: 34.6, lng: 200 }) }
    ];
    for (const storage of cases) {
        const app = createApp(loadApp(storage));
        assert.equal(app.loadSavedPosition(), null, JSON.stringify(storage));
    }
});

test('起動位置: 実GPSの座標は端末に保存される（サーバー送信なし）', () => {
    const loaded = loadApp();
    const app = createApp(loaded);

    app.saveLastPosition(34.6112, 135.5008);

    const saved = JSON.parse(loaded.storage.tw_last_position);
    assert.equal(saved.lat, 34.6112);
    assert.equal(saved.lng, 135.5008);
    assert.ok(typeof saved.at === 'number', '保存時刻を持つ');
});

test('起動位置: 実GPSの更新（handlePositionUpdate）で保存される', () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    // 実物の handlePositionUpdate で保存まで通す
    app.handlePositionUpdate = loaded.TerritoryWalkApp.prototype.handlePositionUpdate;
    app.processMeshAndClaim = () => Promise.resolve({ changed: true });
    app.isMarkingPaused = () => false;
    app.isVirtualWalkActive = () => false;

    app.handlePositionUpdate({ coords: { latitude: 34.61123, longitude: 135.50088 } }, true);

    const saved = JSON.parse(loaded.storage.tw_last_position);
    assert.ok(Math.abs(saved.lat - 34.61123) < 1e-4);
    assert.ok(Math.abs(saved.lng - 135.50088) < 1e-4);
});

/* ------------------------------------------------------------------ *
 * 2. initMap の初期表示（ソース検証）
 * ------------------------------------------------------------------ */

test('起動位置: initMap は前回の現在地を中心に開き、無いときは広域表示にする', () => {
    assert.match(APP_SOURCE, /const startCenter = this\.savedPosition \|\| CONFIG\.DEFAULT_CENTER/);
    assert.match(APP_SOURCE,
        /const startZoom = this\.savedPosition \? CONFIG\.DEFAULT_ZOOM : CONFIG\.WIDE_ZOOM/,
        '前回の現在地が無い初回は広域表示（日本全体）で測位を待つ');
    assert.ok(/WIDE_ZOOM:\s*5/.test(APP_SOURCE), '広域表示の倍率を定数で持つ');
});

test('起動位置: 初回は渋谷にピンを刺さない（hidePlayerMarker で外す）', () => {
    assert.match(APP_SOURCE, /this\.updatePlayerMarker\(CONFIG\.DEFAULT_CENTER\);\s*\n\s*this\.hidePlayerMarker\(\);/);
});

test('起動位置: 前回の現在地があればピンをそこに置く', () => {
    assert.match(APP_SOURCE, /this\.updatePlayerMarker\(this\.savedPosition\)/);
});

/* ------------------------------------------------------------------ *
 * 3. 現在地ボタン
 * ------------------------------------------------------------------ */

test('現在地ボタン: 押すたびに GPS を取り直し、その位置へ地図とピンを移す', async () => {
    let askedOptions = null;
    const navigator = {
        geolocation: {
            getCurrentPosition(success, error, options) {
                askedOptions = options;
                success({ coords: { latitude: 34.6112, longitude: 135.5008 } });
            }
        }
    };
    const loaded = loadApp({}, { navigator });
    const app = createApp(loaded, { lastRealPosition: [35.0, 135.0] });

    app.recenterToCurrentPosition();
    await tick();

    assert.ok(askedOptions, '必ず getCurrentPosition を呼ぶ');
    assert.equal(askedOptions.maximumAge, 0, 'キャッシュを使わず最新を取る');
    assert.equal(askedOptions.enableHighAccuracy, true);

    const lastMapCall = app.mapCalls[app.mapCalls.length - 1];
    assert.deepEqual(lastMapCall, [[34.6112, 135.5008], 17], '最新の現在地へ移動する');
    assert.deepEqual(app.marker[app.marker.length - 1], [34.6112, 135.5008], 'ピンも現在地へ');
    assert.deepEqual(toPlain(app.virtualPos), [34.6112, 135.5008], '以降の基準点も現在地');
    assert.ok(app.toasts.some(t => t[0] === '現在地に戻りました'));
});

test('現在地ボタン: 先に分かっている位置へ寄せてから取り直す（待たせない）', async () => {
    let resolveLater = null;
    const navigator = {
        geolocation: {
            getCurrentPosition() { /* わざと応答しない（測位待ち） */ }
        }
    };
    const loaded = loadApp({}, { navigator });
    const app = createApp(loaded, { lastRealPosition: [35.0, 135.0] });

    app.recenterToCurrentPosition();
    await tick();

    assert.deepEqual(app.mapCalls[0], [[35.0, 135.0], 17], 'まず手元の最新位置へ寄せる');
});

test('現在地ボタン: 測位に失敗したら最後に分かっている位置へ戻し、その旨を伝える', async () => {
    const navigator = {
        geolocation: {
            getCurrentPosition(success, error) {
                error({ code: 3, message: 'timeout' });
            }
        }
    };
    const loaded = loadApp({}, { navigator });
    const app = createApp(loaded, { lastRealPosition: [35.0, 135.0] });

    app.recenterToCurrentPosition();
    await tick();

    assert.deepEqual(app.mapCalls[app.mapCalls.length - 1], [[35.0, 135.0], 17]);
    assert.ok(app.toasts.some(t => String(t[0]).indexOf('取得できませんでした') >= 0),
        '無反応にせず理由を出す');
});

test('現在地ボタン: 位置情報が使えない環境でも例外を投げない', async () => {
    const loaded = loadApp({}, { navigator: {} });
    const app = createApp(loaded, { lastRealPosition: null, savedPosition: null });

    app.recenterToCurrentPosition();
    await tick();

    assert.ok(app.toasts.some(t => String(t[0]).indexOf('取得できませんでした') >= 0));
    assert.equal(app.mapCalls.length, 0, '分かっている位置が無いので地図は動かさない');
});

test('現在地ボタン: 仮想散歩中は GPS を取りに行かず仮想座標へ戻す', async () => {
    let called = false;
    const navigator = {
        geolocation: {
            getCurrentPosition() { called = true; }
        }
    };
    const loaded = loadApp({}, { navigator });
    const app = createApp(loaded, {
        debugEnabled: true,
        isDebugMode: true,
        virtualPos: [34.5, 135.4],
        lastRealPosition: [35.0, 135.0]
    });

    app.recenterToCurrentPosition();
    await tick();

    assert.equal(called, false, '仮想散歩中の位置を GPS で上書きしない');
    assert.deepEqual(app.mapCalls[app.mapCalls.length - 1], [[34.5, 135.4], 17]);
});
