/**
 * TERRITORY WALK - Node tests
 * v1.1 要件2: 非表示ピン（プライバシーゾーン）
 *   1) 中心は半径の 20〜30% だけランダムにずらして保存する（真の中心を残さない）
 *   2) 最大5個まで。半径は 300m / 500m のみ
 *   3) 区域内の判定（縁を含む）と、区域の外の判定
 *   4) 保存先は端末内（localStorage）だけで、サーバーへ送る項目を持たない
 *   5) 区域の中ではマスを塗らない・送らない・数えない（app.js の塗り処理の入口で止める）
 *   6) 設定UI（メニュー導線・モーダル・現在地／地図タップ・削除）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');

// grid.js の getTileStyle は document.body.dataset.skin を見る（描画スキン）。
// privacy.js の設定UIは document.createElement で行を組み立てる（ここでは最小限）。
function createStubElement() {
    return {
        children: [],
        style: {},
        dataset: {},
        textContent: '',
        className: '',
        disabled: false,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        appendChild(child) { this.children.push(child); return child; },
        setAttribute() {},
        getAttribute() { return null; }
    };
}
global.document = {
    body: { dataset: {} },
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: createStubElement
};
// Leaflet の最小スタブ（描画レイヤーを作るだけ）
global.L = {
    canvas: () => ({}),
    layerGroup: () => ({ addTo() { return this; }, removeLayer() {} }),
    circle: () => ({ addTo() { return this; } }),
    circleMarker: () => ({ addTo() { return this; } }),
    rectangle: () => ({ addTo() { return this; }, setStyle() {} })
};
const {
    PRIVACY_STORAGE_KEY,
    PRIVACY_MAX_ZONES,
    PRIVACY_RADIUS_OPTIONS,
    PRIVACY_DEFAULT_RADIUS,
    PRIVACY_JITTER_RATIO_MIN,
    PRIVACY_JITTER_RATIO_MAX,
    privacyDistanceMeters,
    privacyJitterCenter,
    privacyNormalizeRadius,
    privacyNormalizeLabel,
    privacyNormalizeZones,
    privacyZoneContains,
    privacyFindZone,
    privacyAddZone,
    privacyRemoveZone,
    PrivacyZoneManager
} = require(path.join(ROOT, 'privacy.js'));

const APP_SOURCE = readAppSource();
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 決まった値を返す疑似乱数（テストを再現可能にする） */
function seededRandom(values) {
    let i = 0;
    return () => {
        const value = values[i % values.length];
        i += 1;
        return value;
    };
}

function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
        clear: () => map.clear(),
        dump: () => Object.fromEntries(map.entries())
    };
}

/* ------------------------------------------------------------------ *
 * 1: ランダムずらし
 * ------------------------------------------------------------------ */

test('ずらし: 中心は半径の20〜30%だけ離れた場所になる', () => {
    const lat = 34.6;
    const lng = 135.6;
    const radius = 300;

    // ずらす前の距離は 0（＝真の中心）
    const distances = [];
    for (let i = 0; i < 60; i += 1) {
        const shifted = privacyJitterCenter(lat, lng, radius, seededRandom([i / 60, (i * 7 % 60) / 60]));
        distances.push(privacyDistanceMeters(lat, lng, shifted.lat, shifted.lng));
    }

    distances.forEach((distance) => {
        assert.ok(distance >= radius * PRIVACY_JITTER_RATIO_MIN - 1,
            `ずらし距離が半径の20%以上（実際: ${distance.toFixed(1)}m）`);
        assert.ok(distance <= radius * PRIVACY_JITTER_RATIO_MAX + 1,
            `ずらし距離が半径の30%以下（実際: ${distance.toFixed(1)}m）`);
    });
});

test('ずらし: 毎回同じ場所にはならない（方位もばらける）', () => {
    const lat = 34.6;
    const lng = 135.6;
    const radius = 500;
    const points = new Set();
    for (let i = 0; i < 20; i += 1) {
        const shifted = privacyJitterCenter(lat, lng, radius, seededRandom([i / 20, (i * 3 % 20) / 20]));
        points.add(`${shifted.lat.toFixed(6)},${shifted.lng.toFixed(6)}`);
    }
    assert.ok(points.size >= 15, `ずらした座標が毎回ばらける（${points.size}種類）`);
});

test('ずらし: 半径が不正なら中心を動かさない（壊れたデータで勝手に移動しない）', () => {
    const shifted = privacyJitterCenter(34.6, 135.6, 0);
    assert.equal(shifted.lat, 34.6);
    assert.equal(shifted.lng, 135.6);
});

/* ------------------------------------------------------------------ *
 * 2: 件数・半径・名前
 * ------------------------------------------------------------------ */

test('登録: 半径は300m / 500mのみ、それ以外は300mに丸める', () => {
    assert.deepEqual(PRIVACY_RADIUS_OPTIONS, [300, 500]);
    assert.equal(privacyNormalizeRadius(300), 300);
    assert.equal(privacyNormalizeRadius('500'), 500);
    assert.equal(privacyNormalizeRadius(1000), PRIVACY_DEFAULT_RADIUS);
    assert.equal(privacyNormalizeRadius(undefined), 300);
});

test('登録: 名前は空なら「自宅」、長すぎれば切り詰める', () => {
    assert.equal(privacyNormalizeLabel(''), '自宅');
    assert.equal(privacyNormalizeLabel('   '), '自宅');
    assert.equal(privacyNormalizeLabel('職場'), '職場');
    assert.equal(privacyNormalizeLabel('あ'.repeat(30)).length, 12);
});

test('登録: 最大5個まで（6個目は max-zones で拒否）', () => {
    let zones = [];
    for (let i = 0; i < PRIVACY_MAX_ZONES; i += 1) {
        const result = privacyAddZone(zones, {
            lat: 34.6 + i * 0.01,
            lng: 135.6,
            radius: 300,
            label: `場所${i + 1}`,
            createdAt: i
        }, seededRandom([0.1, 0.2]));
        assert.equal(result.ok, true);
        zones = result.zones;
    }
    const overflow = privacyAddZone(zones, { lat: 34.6, lng: 135.7, radius: 300, label: '6個目' });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.reason, 'max-zones');
    assert.equal(zones.length, PRIVACY_MAX_ZONES);
});

test('登録: 座標が壊れていれば拒否する', () => {
    const result = privacyAddZone([], { lat: 'abc', lng: 135.6 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-coordinate');
});

/* ------------------------------------------------------------------ *
 * 3: 内外判定
 * ------------------------------------------------------------------ */

test('判定: 区域内（縁を含む）と区域外を正しく分ける', () => {
    const zone = { id: 'z1', label: '自宅', lat: 34.6, lng: 135.6, radius: 300 };
    assert.equal(privacyZoneContains(zone, 34.6, 135.6), true, '中心は中');
    // 緯度 0.0018度 ≒ 200m
    assert.equal(privacyZoneContains(zone, 34.6018, 135.6), true, '200m は中');
    // 緯度 0.004度 ≒ 445m
    assert.equal(privacyZoneContains(zone, 34.604, 135.6), false, '445m は外');
    assert.equal(privacyFindZone([zone], 34.604, 135.6), null);
    assert.equal(privacyFindZone([zone], 34.6, 135.6).id, 'z1');
});

test('判定: 壊れた区域データは読み込み時に捨てる', () => {
    const zones = privacyNormalizeZones([
        { id: 'ok', lat: 34.6, lng: 135.6, radius: 300, label: '自宅' },
        { id: 'bad-lat', lat: 'x', lng: 135.6 },
        { id: 'bad-range', lat: 200, lng: 135.6 },
        null,
        'text'
    ]);
    assert.equal(zones.length, 1);
    assert.equal(zones[0].id, 'ok');
});

test('削除: 指定したIDだけ消える', () => {
    const zones = [
        { id: 'a', lat: 34.6, lng: 135.6, radius: 300 },
        { id: 'b', lat: 34.7, lng: 135.7, radius: 500 }
    ];
    const left = privacyRemoveZone(zones, 'a');
    assert.equal(left.length, 1);
    assert.equal(left[0].id, 'b');
});

/* ------------------------------------------------------------------ *
 * 4: 端末内保存のみ
 * ------------------------------------------------------------------ */

test('保存: localStorage だけに書き、サーバー送信用の項目を持たない', () => {
    const storage = createMemoryStorage();
    const app = {
        map: null,
        gridManager: null,
        showToast: () => {},
        supabaseManager: { claimTile: () => { throw new Error('サーバーへ送ってはいけない'); } }
    };
    const manager = new PrivacyZoneManager(app);
    manager.storage = () => storage;

    const result = manager.add({ lat: 34.6, lng: 135.6, radius: 300, label: '自宅', createdAt: 1 });
    assert.equal(result.ok, true);

    const saved = JSON.parse(storage.getItem(PRIVACY_STORAGE_KEY));
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0]).sort(), ['createdAt', 'id', 'label', 'lat', 'lng', 'radius']);
    assert.equal(manager.getZones()[0].label, '自宅');
    assert.equal(manager.getZones()[0].radius, 300);

    // 保存された中心は、入力した中心そのものではない（ずらしてある）
    const distance = privacyDistanceMeters(34.6, 135.6, saved[0].lat, saved[0].lng);
    assert.ok(distance >= 300 * PRIVACY_JITTER_RATIO_MIN - 1, `保存座標はずらしてある（${distance.toFixed(1)}m）`);
});

test('保存: アプリ側に Supabase へ送る呼び出しを書いていない', () => {
    const source = fs.readFileSync(path.join(ROOT, 'privacy.js'), 'utf8');
    // 「Supabase には送らない」という説明文は残してよいが、送るコードは持たない
    assert.doesNotMatch(source, /supabaseManager|supabase\.|\.from\(|fetch\s*\(/, 'サーバー送信のコードを持たない');
});

/* ------------------------------------------------------------------ *
 * 5: 塗らない・送らない・数えない（app.js 連携）
 * ------------------------------------------------------------------ */

test('塗り処理: 区域の中は claimedTiles にも送信キューにも入れずに戻る', () => {
    const claimBody = APP_SOURCE.slice(
        APP_SOURCE.indexOf('async processMeshAndClaim'),
        APP_SOURCE.indexOf('    playClaimSound(', APP_SOURCE.indexOf('async processMeshAndClaim'))
    );
    const gateIndex = claimBody.indexOf("reason: 'privacy-zone'");
    assert.ok(gateIndex > 0, 'privacy-zone で早期リターンする');
    assert.ok(gateIndex < claimBody.indexOf('claimedTilesCache.set'), '塗る前に止める');
    assert.ok(gateIndex < claimBody.indexOf('enqueueTileSync'), '送信前に止める');
    assert.ok(gateIndex < claimBody.indexOf('statsManager.recordTileClaimed'), '集計前に止める');
    assert.ok(gateIndex < claimBody.indexOf('coinManager.onTileClaimed'), 'コイン加算前に止める');
});

test('描画: 格子は非表示ピンを解決してから色を決める', () => {
    const gridSource = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    assert.match(gridSource, /getPrivacyZone\(latIdx, lngIdx\)/, '描画で区域を判定する');
    assert.match(gridSource, /resolveTileTeam\(/, '描画の色は1か所で決める');
});

/* ------------------------------------------------------------------ *
 * 6: 設定UI
 * ------------------------------------------------------------------ */

test('UI: メニューから開く導線と、モーダルの主要素がある', () => {
    assert.match(INDEX_HTML, /id="btn-open-privacy"/, 'メニューの導線');
    assert.match(INDEX_HTML, /id="privacy-modal"/, 'モーダル');
    assert.match(INDEX_HTML, /id="btn-privacy-add-current"/, '現在地で登録');
    assert.match(INDEX_HTML, /id="btn-privacy-add-map"/, '地図タップで登録');
    assert.match(INDEX_HTML, /data-privacy-radius="300"/);
    assert.match(INDEX_HTML, /data-privacy-radius="500"/);
    assert.match(INDEX_HTML, /id="input-privacy-label"/, '名前ラベル');
    assert.match(INDEX_HTML, /id="privacy-zone-list"/, '登録済み一覧');
    assert.match(INDEX_HTML, /最大5個/, '上限の説明');
    assert.match(INDEX_HTML, /サーバーには送りません/, '端末内保存の説明');
    assert.match(INDEX_HTML, /privacy\.js\?v=/, 'privacy.js を読み込む');
});

test('UI: 地図タップの登録モードは1回だけ拾って解除する', () => {
    const source = fs.readFileSync(path.join(ROOT, 'privacy.js'), 'utf8');
    assert.match(source, /map\.once\('click', handler\)/, '1回だけのタップ待ち');
    assert.match(source, /this\.pickMode = false/, 'タップ後に解除');
});

test('マネージャ: 設定UIの無い環境でも生成できて、判定だけは使える', () => {
    const manager = new PrivacyZoneManager(null);
    assert.equal(manager.contains(34.6, 135.6), null);
    assert.deepEqual(manager.getZones(), []);
    assert.equal(manager.canAdd(), true);
});

/* ------------------------------------------------------------------ *
 * 7: 塗り処理の実挙動（区域内は塗らない・送らない・数えない）
 * ------------------------------------------------------------------ */

const vm = require('node:vm');
const { GridManager } = require(path.join(ROOT, 'grid.js'));

const LAT_GRID = 0.0009;
const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);

function loadAppClass() {
    const sandbox = vm.createContext({
        document: {
            addEventListener() {},
            body: { dataset: {} },
            getElementById: () => null,
            querySelectorAll: () => []
        },
        window: {},
        navigator: {},
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval
    });
    vm.runInContext(readAppSource(), sandbox, { filename: 'app.js' });
    return vm.runInContext('TerritoryWalkApp', sandbox);
}

function createZoneApp(zone) {
    const TerritoryWalkApp = loadAppClass();
    const app = Object.create(TerritoryWalkApp.prototype);

    const grid = Object.create(GridManager.prototype);
    grid.LAT_GRID = LAT_GRID;
    grid.LNG_GRID = LNG_GRID;
    grid.claimedTilesCache = new Map();
    grid.renderedMeshes = new Map();
    grid.weekId = '2026-W47';
    grid.footprintWeek = '2026-W47';
    grid.footprintIds = [];
    grid.footprintSet = new Set();
    grid.app = { supabaseManager: { getCurrentWeekId: () => '2026-W47' }, privacyZones: null };
    grid.saveTilesToStorage = () => {};
    grid.recordFootprint = (meshId) => { grid.footprintIds.push(meshId); };

    app.currentTeam = 'black';
    app.currentMeshId = null;
    app.markingPaused = false;
    app.manualMarkingInProgress = false;
    app.isAppInBackground = false;
    app.gridManager = grid;
    app.supabaseManager = { getCurrentWeekId: () => '2026-W47' };
    app.privacyZones = {
        getZones: () => [zone],
        containsMesh: (latIdx, lngIdx) => {
            const center = grid.getMeshCenter(latIdx, lngIdx);
            return privacyZoneContains(zone, center.lat, center.lng) ? zone : null;
        }
    };
    app.syncQueue = {
        entries: [],
        enqueue(entry) { this.entries.push(entry); },
        pendingMeshIds() { return new Set(); },
        isOffline() { return false; },
        flush() { return Promise.resolve({}); }
    };
    app.scoreUpdates = 0;
    app.updateScoreUI = () => { app.scoreUpdates += 1; };
    app.playClaimSound = () => {};
    app.triggerHaptic = () => {};
    app.notifyWatchState = () => {};
    app.statsManager = { recordTileClaimed: () => { app.statsCalled = true; } };
    app.coinManager = { onTileClaimed: () => { app.coinCalled = true; } };
    // grid からも同じ非表示ピンを見えるようにする（描画と塗りで判定を揃える）
    grid.app.privacyZones = app.privacyZones;
    app.syncCalls = [];
    app.enqueueTileSync = function (meshId, latIdx, lngIdx, team) {
        app.syncCalls.push(meshId);
        this.syncQueue.enqueue({ meshId, latIdx, lngIdx, team });
    };
    return { app, grid };
}

test('実挙動: 区域の中では塗らず、送らず、戦績・コインにも数えない', async () => {
    const center = { lat: 34.6, lng: 135.6, radius: 300, id: 'z1', label: '自宅' };
    const { app, grid } = createZoneApp(center);

    // 区域の中心のマス
    const inside = grid.getMeshIndices(34.6, 135.6);
    const result = await app.processMeshAndClaim(34.6, 135.6);

    assert.equal(result.changed, false);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'privacy-zone');
    assert.equal(grid.claimedTilesCache.size, 0, 'ローカルにも塗らない');
    assert.equal(app.syncQueue.entries.length, 0, '送信キューに積まない');
    assert.deepEqual(app.syncCalls, []);
    assert.equal(app.statsCalled, undefined, '戦績に数えない');
    assert.equal(app.coinCalled, undefined, 'コインを加算しない');
    assert.deepEqual(grid.footprintIds, [], '足跡にも残さない');
    assert.equal(app.currentMeshId, null, '現在地のマスも更新しない');
    assert.equal(grid.getMeshId(inside.latIdx, inside.lngIdx).startsWith('tile_'), true);
});

test('実挙動: 区域の外では従来どおり塗って送る', async () => {
    const center = { lat: 34.6, lng: 135.6, radius: 300, id: 'z1', label: '自宅' };
    const { app, grid } = createZoneApp(center);

    // 約 1.3km 北（区域の外）
    const result = await app.processMeshAndClaim(34.612, 135.6);

    assert.equal(result.changed, true);
    assert.equal(result.blocked, undefined);
    assert.equal(grid.claimedTilesCache.size, 1);
    assert.equal(app.syncQueue.entries.length, 1, '送信キューに積む');
    assert.equal(app.statsCalled, true);
    assert.equal(app.coinCalled, true);
    assert.equal(grid.footprintIds.length, 1, '自分の足跡として記録');
});
