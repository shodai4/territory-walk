/**
 * TERRITORY WALK - Node tests
 * v1.2 県レベル（zoom 11）の1kmブロック描画を軽くする仕組みと、リモート取得の安全設計
 *
 *   1) ブロック色（100マスの多数決）はブロック単位でキャッシュする
 *      - 2回目以降の描画は数え直さない（1,400ブロックでも数十ms → 数ms）
 *   2) 陣地が変わったらキャッシュを捨てる（古い色を残さない）
 *      - 自分の塗り（invalidateBlockTeamAt）/ 非表示ピン / 週リセット
 *   3) zoom 11 では Supabase から100mマスを取得しない（DB負荷ゼロ）
 *      - grid.js 側の下限ズームで早期 return
 *      - supabase.js 側も 15km を超える範囲は問い合わせない（二重ガード）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { GridManager } = require(path.join(ROOT, 'grid.js'));

const LAT_GRID = 0.0009;
const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);
const WEEK = '2026-W47';

/* ------------------------------------------------------------------ *
 * 最小環境（Leaflet / localStorage / document）
 * ------------------------------------------------------------------ */
function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
        clear: () => map.clear()
    };
}

function installLeafletStub() {
    const created = [];
    global.L = {
        canvas: () => ({}),
        layerGroup: () => ({ addTo() { return this; }, removeLayer() {} }),
        rectangle: (bounds, options) => {
            const layer = {
                bounds,
                options: { ...options },
                addTo() { return this; },
                setStyle(style) { this.options = { ...this.options, ...style }; }
            };
            created.push(layer);
            return layer;
        }
    };
    return created;
}

function createMapStub(bounds, zoom) {
    const state = { zoom, bounds };
    return {
        state,
        options: {},
        on() {},
        getZoom() { return state.zoom; },
        getBounds() {
            return {
                getSouth: () => state.bounds[0],
                getWest: () => state.bounds[1],
                getNorth: () => state.bounds[2],
                getEast: () => state.bounds[3]
            };
        }
    };
}

/** 中心 lat/lng・画面 375×812px・指定ズームのときの地図範囲 */
function viewportBounds(lat, lng, zoom) {
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    const halfHeight = (812 / 2) * metersPerPixel / 111320;
    const halfWidth = (375 / 2) * metersPerPixel / (111320 * Math.cos(lat * Math.PI / 180));
    return [lat - halfHeight, lng - halfWidth, lat + halfHeight, lng + halfWidth];
}

function createGrid({ zoom = 11, zones = null } = {}) {
    global.document = { body: { dataset: {} } };
    global.localStorage = createMemoryStorage();
    installLeafletStub();

    const map = createMapStub(viewportBounds(34.6, 135.6, zoom), zoom);
    const app = {
        supabaseManager: {
            getCurrentWeekId: () => WEEK,
            fetchTilesInBounds: async () => []
        },
        privacyZones: zones ? { containsMesh: (latIdx, lngIdx) => zones(latIdx, lngIdx) } : null
    };
    const grid = new GridManager(map, app);
    grid.LAT_GRID = LAT_GRID;
    grid.LNG_GRID = LNG_GRID;
    grid.weekId = WEEK;
    return { grid, map, app };
}

/* ------------------------------------------------------------------ *
 * 1. ブロック色のキャッシュ
 * ------------------------------------------------------------------ */

test('性能: 同じ画面を描き直すときはブロックを数え直さない（キャッシュが効く）', () => {
    const { grid } = createGrid({ zoom: 11 });
    grid.updateGrids();
    const blocks = grid.renderedBlocks.size;
    assert.ok(blocks > 1000, `県レベルでは1,000枚以上のブロック（実際: ${blocks}）`);
    assert.equal(grid.blockTeamCache.size, blocks, '描いたブロックの色を覚える');

    // 2回目の描画では tallyBlock を一度も呼ばない
    const original = grid.tallyBlock.bind(grid);
    let tallyCalls = 0;
    grid.tallyBlock = (...args) => { tallyCalls += 1; return original(...args); };

    grid.updateGrids();
    assert.equal(tallyCalls, 0, 'キャッシュ済みのブロックは100マスを数え直さない');
});

test('性能: パンして新しい範囲に入っても、数え直すのは新しく見えたブロックだけ', () => {
    const { grid, map } = createGrid({ zoom: 11 });
    grid.updateGrids();
    const firstCount = grid.blockTeamCache.size;

    const original = grid.tallyBlock.bind(grid);
    let tallyCalls = 0;
    grid.tallyBlock = (...args) => { tallyCalls += 1; return original(...args); };

    // 東へ約2km（2ブロック）パン（ズーム・緯度は同じ）
    const bounds = map.getBounds();
    const shiftLng = 0.022;
    map.state.bounds = [bounds.getSouth(), bounds.getWest() + shiftLng, bounds.getNorth(), bounds.getEast() + shiftLng];
    grid.updateGrids();

    assert.ok(tallyCalls > 0, '新しく見えたブロックは数える');
    assert.ok(
        tallyCalls <= 200,
        `数え直すのは新しく見えた分だけ（${tallyCalls} / 全${grid.blockTeamCache.size}）`
    );

    // 同じ範囲をもう一度描いても、数え直しは0
    tallyCalls = 0;
    grid.updateGrids();
    assert.equal(tallyCalls, 0);
});

test('更新: 自分の塗りでキャッシュを捨て、そのブロックだけ数え直す', () => {
    const { grid } = createGrid({ zoom: 11 });
    grid.updateGrids();
    const { latIdx, lngIdx } = grid.getMeshIndices(34.6, 135.6);
    const { latBlock, lngBlock } = grid.getBlockIndices(latIdx, lngIdx);
    const key = grid.blockTeamCacheKey(latBlock, lngBlock);
    assert.ok(grid.blockTeamCache.has(key));

    grid.claimedTilesCache.set(grid.getMeshId(latIdx, lngIdx), 'white');
    assert.equal(grid.invalidateBlockTeamAt(latIdx, lngIdx), true, '該当ブロックのキャッシュを捨てる');
    assert.equal(grid.blockTeamCache.has(key), false);
    assert.equal(grid.blockTeamCache.size, grid.renderedBlocks.size - 1, '他のブロックはそのまま');
});

test('更新: 週が変われば別キーになる（前週の色を使わない）', () => {
    const { grid } = createGrid({ zoom: 11 });
    grid.updateGrids();
    assert.ok(grid.blockTeamCache.size > 0);
    assert.match(grid.blockTeamCacheKey(0, 0), /^2026-W47\|0_0$/, 'キーに週が入る');

    // 週が変わった端末（別インスタンス）は別キーで数え直す
    const next = createGrid({ zoom: 11 });
    next.app.supabaseManager.getCurrentWeekId = () => '2026-W48';
    next.grid.weekId = null;
    next.grid.weekIdCachedAt = 0;
    assert.equal(next.grid.blockTeamCacheKey(0, 0), '2026-W48|0_0');
    assert.equal(next.grid.blockTeamCache.size, 0, '新しい週の色はキャッシュに無い');
});

test('性能: 週IDの計算（toLocaleString）は描画中に何度も呼ばない', () => {
    const { grid } = createGrid({ zoom: 11 });
    let calls = 0;
    grid.app.supabaseManager.getCurrentWeekId = () => { calls += 1; return WEEK; };
    grid.weekId = null;
    grid.weekIdCachedAt = 0;

    grid.updateGrids();
    assert.ok(calls <= 2, `1回の描画で週IDの計算は数回まで（実際: ${calls}回 / ブロック比）`);
    assert.ok(grid.renderedBlocks.size > 1000);
});

test('更新: 非表示ピンが変わると全ブロックのキャッシュを捨てる（消し忘れ防止）', () => {
    const { grid } = createGrid({ zoom: 11 });
    grid.updateGrids();
    assert.ok(grid.blockTeamCache.size > 0);
    const cachedBefore = grid.blockTeamCache.size;
    assert.equal(grid.clearBlockTeamCache(), cachedBefore, '捨てた件数を返す');
    assert.equal(grid.blockTeamCache.size, 0);
});

test('更新: リモート取り込みで陣地が変わったらキャッシュを捨てる（ソース配線）', () => {
    const source = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    const fetchStart = source.indexOf('async fetchAndSyncTiles()');
    const fetchBody = source.slice(fetchStart, source.indexOf('saveTilesToStorage();', fetchStart));
    assert.match(fetchBody, /clearBlockTeamCache\(\)/, 'リモート反映時にキャッシュを捨てる');
});

/* ------------------------------------------------------------------ *
 * 2. zoom 11 のリモート取得（重くしない）
 * ------------------------------------------------------------------ */

test('取得: zoom 11 では Supabase へ問い合わせない（100mマスの取得は13以上）', async () => {
    const { grid, app } = createGrid({ zoom: 11 });
    let fromCalls = 0;
    app.supabaseManager.fetchTilesInBounds = async () => { fromCalls += 1; return []; };

    await grid.fetchAndSyncTiles();
    assert.equal(fromCalls, 0, '県レベルでは1マス単位の取得を投げない');
});

test('取得: zoom 14 でも 15km を超える範囲は supabase.js 側で問い合わせない（二重ガード）', async () => {
    const { SupabaseManager } = require(path.join(ROOT, 'supabase.js'));
    global.window = global.window || {};

    const queries = { from: 0, limit: 0 };
    const chain = {
        select() { return this; },
        eq() { return this; },
        gte() { return this; },
        lte() { return this; },
        limit() { queries.limit += 1; return this; },
        then(resolve) { resolve({ data: [], error: null }); }
    };
    const manager = new SupabaseManager();
    manager.client = { from() { queries.from += 1; return chain; } };

    // zoom 11 相当（約60km × 25km）→ ガードで 0 件
    const wide = viewportBounds(34.6, 135.6, 11);
    const wideResult = await manager.fetchTilesInBounds(wide[0], wide[2], wide[1], wide[3], WEEK);
    assert.deepEqual(wideResult, []);
    assert.equal(queries.from, 0, '広すぎる範囲は DB を叩かない');
    assert.equal(queries.limit, 0);

    // zoom 17 相当（数百m）→ 問い合わせる
    const narrow = viewportBounds(34.6, 135.6, 17);
    const narrowResult = await manager.fetchTilesInBounds(narrow[0], narrow[2], narrow[1], narrow[3], WEEK);
    assert.deepEqual(narrowResult, []);
    assert.equal(queries.from, 1, '近距離は従来どおり問い合わせる');
    assert.equal(queries.limit, 1);
});
