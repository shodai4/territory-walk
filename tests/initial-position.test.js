/**
 * TERRITORY WALK - Node tests
 * アプリ起動時の地図初期位置（渋谷）:
 *   1) CONFIG.DEFAULT_CENTER が渋谷駅の座標になっている
 *   2) 地図の center / プレイヤーマーカー / D-Pad（仮想散歩）の出発点が同じ定数を使う
 *   3) 旧・東大阪の初期座標が残っていない
 *   4) 実GPSの初回測位では実座標へ移動する（初期位置は取得前のフォールバックのみ）
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

/** 渋谷駅（ハチ公口付近）の座標 */
const SHIBUYA = { lat: 35.658034, lng: 139.701636 };
/** 変更前の初期位置（東大阪・近鉄瓢箪山駅〜東花園エリア） */
const OLD_OSAKA = { lat: 34.6662, lng: 135.6276 };

/* ------------------------------------------------------------------ *
 * app.js を vm で読み込み、CONFIG と TerritoryWalkApp を取り出す
 * ------------------------------------------------------------------ */
function loadApp(options = {}) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: options.document || {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            body: { dataset: {} }
        },
        navigator: {},
        window: {},
        localStorage: {
            getItem: () => null,
            setItem() {},
            removeItem() {}
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
        TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context)
    };
}

/** 距離（m）— 座標が本当に渋谷かを確かめるための簡易ヒュベニ計算 */
function distanceMeters(a, b) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat = toRad((a.lat + b.lat) / 2);
    const x = dLng * Math.cos(lat);
    return Math.sqrt(x * x + dLat * dLat) * R;
}

const toPlain = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * 1. 定数の値
 * ------------------------------------------------------------------ */
test('初期位置: CONFIG.DEFAULT_CENTER は渋谷駅の座標', () => {
    const { CONFIG } = loadApp();
    assert.deepEqual(
        toPlain(CONFIG.DEFAULT_CENTER),
        [SHIBUYA.lat, SHIBUYA.lng],
        'DEFAULT_CENTER を渋谷駅の座標にする'
    );
});

test('初期位置: 渋谷駅から500m以内（別の街の座標になっていない）', () => {
    const { CONFIG } = loadApp();
    const [lat, lng] = toPlain(CONFIG.DEFAULT_CENTER);
    const d = distanceMeters({ lat, lng }, SHIBUYA);
    assert.ok(d < 500, `渋谷駅から ${Math.round(d)}m（500m以内であること）`);
});

test('初期位置: ズームは従来どおり 17（100mマスが見える倍率）', () => {
    const { CONFIG } = loadApp();
    assert.equal(CONFIG.DEFAULT_ZOOM, 17);
});

test('初期位置: デバッグ機能のマスタースイッチは true のまま', () => {
    const { CONFIG } = loadApp();
    assert.equal(CONFIG.ENABLE_DEBUG_TOOLS, true);
});

/* ------------------------------------------------------------------ *
 * 2. 同じ定数を初期表示の3か所が使っている
 * ------------------------------------------------------------------ */
test('初期表示: 地図 center・プレイヤーマーカー・D-Pad出発点がすべて DEFAULT_CENTER を参照', () => {
    assert.match(APP_SOURCE, /DEFAULT_CENTER:\s*\[/, 'CONFIG に DEFAULT_CENTER がある');
    assert.match(APP_SOURCE, /center:\s*CONFIG\.DEFAULT_CENTER/, 'L.map の center に使う');
    assert.match(APP_SOURCE, /updatePlayerMarker\(CONFIG\.DEFAULT_CENTER\)/, '初期マーカー位置に使う');
    assert.match(APP_SOURCE, /this\.virtualPos\s*=\s*\[\.\.\.CONFIG\.DEFAULT_CENTER\]/, 'D-Pad の出発点に使う');
});

test('初期表示: ハードコードされた座標リテラルは DEFAULT_CENTER の1か所だけ', () => {
    const literals = APP_SOURCE.match(/\b\d{2,3}\.\d{4,}\b/g) || [];
    const unique = [...new Set(literals)];
    assert.deepEqual(
        unique.sort(),
        [String(SHIBUYA.lat), String(SHIBUYA.lng)].sort(),
        `app.js の座標リテラルは渋谷の緯度経度のみ（実際: ${unique.join(', ')}）`
    );
});

test('初期位置: 旧・東大阪の初期座標（34.6662 / 135.6276）が残っていない', () => {
    assert.ok(!APP_SOURCE.includes(String(OLD_OSAKA.lat)), '旧緯度が残っていない');
    assert.ok(!APP_SOURCE.includes(String(OLD_OSAKA.lng)), '旧経度が残っていない');
});

/* ------------------------------------------------------------------ *
 * 3. 実GPSが来たら実座標へ移る（初期位置はフォールバックのみ）
 * ------------------------------------------------------------------ */
function createApp(loaded, overrides = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    const mapCalls = [];
    Object.assign(
        app,
        {
            locationBanner: null,
            gridManager: null,
            isAppInBackground: false,
            isDebugMode: false,
            debugEnabled: true,
            currentMeshId: null,
            lastProcessedLat: null,
            lastProcessedLng: null,
            virtualPos: toPlain(loaded.CONFIG.DEFAULT_CENTER),
            map: {
                getZoom: () => 17,
                setView: (center, zoom) => mapCalls.push([toPlain(center), zoom]),
                panTo: () => {}
            },
            markerPositions: [],
            claims: [],
            gpsStatuses: []
        },
        overrides
    );
    app.mapCalls = mapCalls;
    app.updateGPSStatus = (label) => app.gpsStatuses.push(label);
    app.updatePlayerMarker = (pos) => app.markerPositions.push(toPlain(pos));
    app.processMeshAndClaim = (lat, lng) => {
        app.claims.push([lat, lng]);
        return Promise.resolve({ changed: true });
    };
    app.showToast = () => {};
    return app;
}

test('実GPS: 初回測位で実座標へ setView（初期位置のまま固定されない）', async () => {
    const loaded = loadApp();
    const app = createApp(loaded);

    // 渋谷とは別の場所（東大阪）で測位できたケース＝実データを壊さない
    app.handlePositionUpdate(
        { coords: { latitude: OLD_OSAKA.lat, longitude: OLD_OSAKA.lng } },
        true
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(app.markerPositions[0], [OLD_OSAKA.lat, OLD_OSAKA.lng], 'マーカーは実座標');
    assert.deepEqual(app.mapCalls[0], [[OLD_OSAKA.lat, OLD_OSAKA.lng], 17], '初回測位で実座標へ寄る');
    assert.deepEqual(toPlain(app.virtualPos), [OLD_OSAKA.lat, OLD_OSAKA.lng], '以降の基準点も実座標');
});

test('実GPS: 測位前は渋谷が初期表示（フォールバック）', () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    assert.deepEqual(app.virtualPos, [SHIBUYA.lat, SHIBUYA.lng]);
    assert.equal(app.mapCalls.length, 0, '測位前は地図移動を起こさない');
});
