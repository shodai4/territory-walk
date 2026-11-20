/**
 * TERRITORY WALK - Node tests
 * 10kmブロック（zoom 6〜9）の足跡ハイライト:
 *   1) 今週の自分の足跡を含む10kmブロックだけ、薄いオレンジ塗り＋オレンジ枠線になる
 *   2) 足跡を含まないブロックは従来どおりの白黒（薄い半透明）のまま
 *   3) 非表示ピンの中の足跡は数えない（区域の外に足跡があるときだけハイライトする）
 *   4) 1kmブロック（zoom 10〜13）には付けない（10kmブロックだけ）
 *   5) 足跡の追加・非表示ピンの変更・週リセットで見た目が正しく更新される
 *   6) 描画のたびに footprintSet を走査しない（索引は描画1回につき1回だけ作る）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
    GridManager,
    BLOCK_TILES,
    MACRO_BLOCKS,
    MACRO_FILL_OPACITY,
    FOOTPRINT_STROKE_COLOR,
    FOOTPRINT_BLOCK_FILL_OPACITY,
    FOOTPRINT_BLOCK_STROKE_WEIGHT,
    FOOTPRINT_BLOCK_STROKE_OPACITY,
    displayModeForZoom
} = require(path.join(ROOT, 'grid.js'));

const LAT_GRID = 0.0009;
const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);
const WEEK = '2026-W47';

/* ------------------------------------------------------------------ *
 * テスト用の最小環境（Leaflet・localStorage・document をスタブ）
 * ------------------------------------------------------------------ */

global.document = { body: { dataset: {} } };

function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
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

/** 中心 lat/lng・指定ズームのときの地図範囲（緯度経度）。size は CSS サイズ（既定 375×812） */
function viewportBounds(lat, lng, zoom, size = [375, 812]) {
    const [width, height] = size;
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    const halfHeight = (height / 2) * metersPerPixel / 111320;
    const halfWidth = (width / 2) * metersPerPixel / (111320 * Math.cos(lat * Math.PI / 180));
    return [lat - halfHeight, lng - halfWidth, lat + halfHeight, lng + halfWidth];
}

/** 指定した10kmブロック（latMacro, lngMacro）まわりだけを写す範囲（テストを軽くする） */
function macroWindowBounds(latMacro, lngMacro) {
    const cells = BLOCK_TILES * MACRO_BLOCKS;
    const south = (latMacro - 1) * cells * LAT_GRID;
    const west = (lngMacro - 1) * cells * LNG_GRID;
    return [south, west, south + 3 * cells * LAT_GRID, west + 3 * cells * LNG_GRID];
}

/**
 * 非表示ピンのスタブ。中心と半径（m）で内外を判定し、getZones は今の配列を返す
 * （区域の追加後に足跡の索引が作り直されるかを見るため）。
 */
function createPrivacyStub(zones = []) {
    const list = zones.slice();
    return {
        list,
        getZones: () => list.slice(),
        addZone(zone) { list.push(zone); },
        containsMesh(latIdx, lngIdx, grid) {
            const center = grid.getMeshCenter(latIdx, lngIdx);
            for (const zone of list) {
                const dLat = (center.lat - zone.lat) * 111320;
                const dLng = (center.lng - zone.lng) * 111320 * Math.cos(zone.lat * Math.PI / 180);
                if (Math.hypot(dLat, dLng) <= zone.radius) return { id: zone.id };
            }
            return null;
        }
    };
}

/**
 * 実際の GridManager を、地図と Leaflet のスタブで組み立てる。
 * footprint には「今週踏んだマス」の meshId を渡す。
 */
function createRealGrid({
    claimed = [],
    footprint = [],
    zones = null,
    weekId = WEEK,
    zoom = 7,
    bounds = null,
    center = [34.6, 135.6]
} = {}) {
    global.localStorage = createMemoryStorage();
    installLeafletStub();

    const map = createMapStub(bounds || viewportBounds(center[0], center[1], zoom), zoom);
    const app = {
        supabaseManager: { getCurrentWeekId: () => weekId },
        privacyZones: zones
    };
    const grid = new GridManager(map, app);
    grid.LAT_GRID = LAT_GRID;
    grid.LNG_GRID = LNG_GRID;
    grid.weekId = weekId;
    grid.claimedTilesCache = new Map(claimed);
    grid.footprintWeek = weekId;
    grid.footprintIds = footprint.slice();
    grid.footprintSet = new Set(footprint);
    grid.footprintMacroCache = null;
    return { grid, map, app };
}

/** 中心付近のマス座標（zoom 7 で画面の真ん中に来る10kmブロックの内側） */
function centerMacro() {
    const latIdx = Math.floor(34.6 / LAT_GRID);
    const lngIdx = Math.floor(135.6 / LNG_GRID);
    const cells = BLOCK_TILES * MACRO_BLOCKS;
    return {
        latIdx,
        lngIdx,
        latMacro: Math.floor(Math.floor(latIdx / cells)),
        lngMacro: Math.floor(Math.floor(lngIdx / cells)),
        cells
    };
}

// 中心ブロックの内側に収まるマス座標（境界をまたがない）
function tileInsideMacro(latMacro, lngMacro, dLat = 5, dLng = 5) {
    const cells = BLOCK_TILES * MACRO_BLOCKS;
    return {
        latIdx: latMacro * cells + dLat,
        lngIdx: lngMacro * cells + dLng
    };
}

/* ------------------------------------------------------------------ *
 * 1. スタイル
 * ------------------------------------------------------------------ */

test('スタイル: 足跡を含む10kmブロックは薄いオレンジ塗り＋オレンジ枠線になる', () => {
    const { grid } = createRealGrid();
    const style = grid.getMacroStyle('white', { ownFootprint: true });

    assert.equal(style.fillColor, FOOTPRINT_STROKE_COLOR, '塗りはオレンジ #f59e0b');
    assert.equal(style.color, FOOTPRINT_STROKE_COLOR, '枠線もオレンジ #f59e0b');
    assert.ok(style.fillOpacity >= 0.35 && style.fillOpacity <= 0.4, `透過率は0.35〜0.4（実際: ${style.fillOpacity}）`);
    assert.equal(style.fillOpacity, FOOTPRINT_BLOCK_FILL_OPACITY);
    assert.ok(style.weight >= 1.8 && style.weight <= 2.0, `枠線は1.8〜2.0（実際: ${style.weight}）`);
    assert.equal(style.weight, FOOTPRINT_BLOCK_STROKE_WEIGHT);
    assert.equal(style.opacity, FOOTPRINT_BLOCK_STROKE_OPACITY);
    assert.ok(style.opacity >= 0.85, '枠線はほぼ不透明（広域でも見える）');
    assert.equal(style.interactive, false);
    // 下の地図の文字・道路は読める（塗りは濃すぎない）
    assert.ok(style.fillOpacity <= 0.45, '地図が透けて読める濃さ');
});

test('スタイル: 足跡を含まない10kmブロックは従来どおりの白黒（薄い半透明）のまま', () => {
    const { grid } = createRealGrid();
    for (const team of ['white', 'black']) {
        const style = grid.getMacroStyle(team);
        assert.notEqual(style.fillColor, FOOTPRINT_STROKE_COLOR, 'オレンジにしない');
        assert.equal(style.fillOpacity, MACRO_FILL_OPACITY);
        assert.ok(style.weight <= 1, '枠線は10kmブロックの細い線のまま');
        assert.ok(style.opacity <= 0.15, '枠線はほぼ透明のまま（＝目立たせない）');
        assert.equal(style.interactive, false);
    }
    // 未指定（引数なし）でも同じ
    assert.equal(grid.getMacroStyle('black').fillOpacity, MACRO_FILL_OPACITY);
});

/* ------------------------------------------------------------------ *
 * 2. 描画（足跡の有無でハイライトが分かれる）
 * ------------------------------------------------------------------ */

test('描画: 足跡を含む10kmブロックだけがオレンジでハイライトされる', () => {
    const { latMacro, lngMacro } = centerMacro();
    const inside = tileInsideMacro(latMacro, lngMacro);
    const footprint = [`tile_${inside.latIdx}_${inside.lngIdx}`];
    const { grid, map } = createRealGrid({
        footprint,
        zoom: 7,
        bounds: macroWindowBounds(latMacro, lngMacro)
    });
    grid.updateGrids();

    const target = grid.getMacroId(latMacro, lngMacro);
    const rect = grid.renderedMacroBlocks.get(target);
    assert.ok(rect, '足跡を含む10kmブロックを描く');
    assert.equal(rect.options.fillColor, FOOTPRINT_STROKE_COLOR, 'オレンジで塗る');
    assert.equal(rect.options.fillOpacity, FOOTPRINT_BLOCK_FILL_OPACITY);
    assert.equal(rect.options.color, FOOTPRINT_STROKE_COLOR);
    assert.equal(rect.options.weight, FOOTPRINT_BLOCK_STROKE_WEIGHT);

    // ハイライトは1枚だけ（他のブロックは従来の白黒）
    let highlighted = 0;
    for (const [macroId, rectangle] of grid.renderedMacroBlocks.entries()) {
        const isOrange = rectangle.options.fillColor === FOOTPRINT_STROKE_COLOR;
        if (isOrange) highlighted += 1;
        if (macroId !== target) {
            assert.equal(isOrange, false, `${macroId} はハイライトしない`);
            assert.equal(rectangle.options.fillOpacity, MACRO_FILL_OPACITY, `${macroId} は従来の薄い塗り`);
        }
    }
    assert.equal(highlighted, 1, 'ハイライトされるのは足跡を含む1枚だけ');

    // ズーム（zoom 6 / 7 / 8 / 9）が変わっても同じ規則
    for (const zoom of [6, 7, 8, 9]) {
        const next = createRealGrid({ footprint, zoom, bounds: macroWindowBounds(latMacro, lngMacro) }).grid;
        next.updateGrids();
        const nextRect = next.renderedMacroBlocks.get(target);
        assert.ok(nextRect, `zoom ${zoom} でもブロックを描く`);
        assert.equal(nextRect.options.fillColor, FOOTPRINT_STROKE_COLOR, `zoom ${zoom} でもオレンジ`);
    }
    assert.equal(map.state.zoom, 7);
});

test('描画: 足跡が1マスも無ければ、どの10kmブロックもハイライトしない', () => {
    const { latMacro, lngMacro } = centerMacro();
    const { grid } = createRealGrid({ zoom: 7, bounds: macroWindowBounds(latMacro, lngMacro) });
    grid.updateGrids();

    assert.ok(grid.renderedMacroBlocks.size > 0);
    for (const [macroId, rectangle] of grid.renderedMacroBlocks.entries()) {
        assert.notEqual(rectangle.options.fillColor, FOOTPRINT_STROKE_COLOR, `${macroId} はオレンジにしない`);
    }
});

/* ------------------------------------------------------------------ *
 * 3. 非表示ピン
 * ------------------------------------------------------------------ */

test('プライバシー: 非表示ピンの中の足跡だけなら、その10kmブロックはハイライトしない', () => {
    const { latMacro, lngMacro } = centerMacro();
    const inside = tileInsideMacro(latMacro, lngMacro);
    const footprint = [`tile_${inside.latIdx}_${inside.lngIdx}`];
    const privacy = createPrivacyStub();

    const { grid } = createRealGrid({ footprint, zones: privacy, zoom: 7, bounds: macroWindowBounds(latMacro, lngMacro) });
    // 足跡マスの中心に半径300mの非表示ピンを置く
    const center = grid.getMeshCenter(inside.latIdx, inside.lngIdx);
    privacy.addZone({ id: 'z1', lat: center.lat, lng: center.lng, radius: 300 });
    grid.footprintMacroCache = null;

    grid.updateGrids();
    assert.equal(grid.footprintMacroIndex().size, 0, '区域内の足跡は索引に入れない');
    const rect = grid.renderedMacroBlocks.get(grid.getMacroId(latMacro, lngMacro));
    assert.ok(rect);
    assert.notEqual(rect.options.fillColor, FOOTPRINT_STROKE_COLOR, '区域の中の足跡ではハイライトしない');
    assert.equal(rect.options.fillOpacity, MACRO_FILL_OPACITY);
});

test('プライバシー: 区域の外に足跡が1つでもあればハイライトする（同じブロック内）', () => {
    const { latMacro, lngMacro } = centerMacro();
    const target = tileInsideMacro(latMacro, lngMacro, 5, 5);
    // 同じ10kmブロックの中、区域から十分離れた場所（約5km東）
    const far = tileInsideMacro(latMacro, lngMacro, 5, 95);
    const footprint = [`tile_${target.latIdx}_${target.lngIdx}`, `tile_${far.latIdx}_${far.lngIdx}`];
    const privacy = createPrivacyStub();

    const { grid } = createRealGrid({ footprint, zones: privacy, zoom: 7, bounds: macroWindowBounds(latMacro, lngMacro) });
    const center = grid.getMeshCenter(target.latIdx, target.lngIdx);
    privacy.addZone({ id: 'z1', lat: center.lat, lng: center.lng, radius: 400 });
    grid.footprintMacroCache = null;

    grid.updateGrids();
    assert.equal(grid.footprintMacroIndex().size, 1, '区域の外の足跡は数える');
    const rect = grid.renderedMacroBlocks.get(grid.getMacroId(latMacro, lngMacro));
    assert.equal(rect.options.fillColor, FOOTPRINT_STROKE_COLOR, '区域の外に足跡があればハイライトする');
});

test('プライバシー: 区域の中のブロックだけが消え、区域の外のブロックはハイライトが残る', () => {
    const { latMacro, lngMacro } = centerMacro();
    const masked = tileInsideMacro(latMacro, lngMacro, 5, 5);
    const outside = tileInsideMacro(latMacro + 2, lngMacro, 5, 5);
    const footprint = [`tile_${masked.latIdx}_${masked.lngIdx}`, `tile_${outside.latIdx}_${outside.lngIdx}`];
    const privacy = createPrivacyStub();

    const { grid } = createRealGrid({
        footprint,
        zones: privacy,
        zoom: 7,
        bounds: macroWindowBounds(latMacro, lngMacro)
    });
    const center = grid.getMeshCenter(masked.latIdx, masked.lngIdx);
    privacy.addZone({ id: 'z1', lat: center.lat, lng: center.lng, radius: 400 });
    grid.footprintMacroCache = null;

    grid.updateGrids();
    const index = grid.footprintMacroIndex();
    assert.equal(index.has(grid.getMacroId(latMacro, lngMacro)), false, '区域の中だけのブロックは外す');
    assert.equal(index.has(grid.getMacroId(latMacro + 2, lngMacro)), true, '区域の外のブロックは残す');

    assert.notEqual(
        grid.renderedMacroBlocks.get(grid.getMacroId(latMacro, lngMacro)).options.fillColor,
        FOOTPRINT_STROKE_COLOR
    );
    assert.equal(
        grid.renderedMacroBlocks.get(grid.getMacroId(latMacro + 2, lngMacro)).options.fillColor,
        FOOTPRINT_STROKE_COLOR
    );
});

/* ------------------------------------------------------------------ *
 * 4. 10kmブロックだけ（1kmブロックには付けない）
 * ------------------------------------------------------------------ */

test('範囲: 1kmブロック（zoom 10〜13）には足跡ハイライトを付けない', () => {
    const latIdx = Math.floor(34.6 / LAT_GRID);
    const lngIdx = Math.floor(135.6 / LNG_GRID);
    const footprint = [`tile_${latIdx}_${lngIdx}`];

    for (const zoom of [10, 11, 13]) {
        const { grid } = createRealGrid({ footprint, zoom });
        grid.updateGrids();
        assert.equal(displayModeForZoom(zoom), 'blocks');
        assert.ok(grid.renderedBlocks.size > 0, `zoom ${zoom} は1kmブロックを描く`);
        assert.equal(grid.renderedMacroBlocks.size, 0, '10kmブロックは描かない');

        for (const [blockId, rectangle] of grid.renderedBlocks.entries()) {
            assert.notEqual(rectangle.options.fillColor, FOOTPRINT_STROKE_COLOR, `zoom ${zoom}: ${blockId} はオレンジにしない`);
        }
        // 1kmブロックのスタイル関数そのものにも足跡の分岐が無い
        const style = grid.getBlockStyle('white');
        assert.notEqual(style.fillColor, FOOTPRINT_STROKE_COLOR);
    }

    // ソース上も 1km ブロックのスタイルにはハイライトを入れない
    const source = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    const blockStyle = source.slice(source.indexOf('    getBlockStyle('), source.indexOf('    renderSingleBlock('));
    assert.doesNotMatch(blockStyle, /FOOTPRINT_BLOCK_|ownFootprint/, '1kmブロックには付けない（10kmブロックだけ）');
});

/* ------------------------------------------------------------------ *
 * 5. 即時反映（足跡追加・非表示ピン変更・週リセット）
 * ------------------------------------------------------------------ */

test('更新: 10kmブロック表示中に足跡が増えると、そのブロックがすぐオレンジになる', () => {
    const { latMacro, lngMacro } = centerMacro();
    const inside = tileInsideMacro(latMacro, lngMacro, 5, 5);
    const meshId = `tile_${inside.latIdx}_${inside.lngIdx}`;
    const { grid, map } = createRealGrid({
        zoom: 8,
        bounds: macroWindowBounds(latMacro, lngMacro)
    });
    grid.updateGrids();

    const target = grid.getMacroId(latMacro, lngMacro);
    assert.notEqual(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR, '最初は白黒');

    // マスを塗った直後の流れ（recordFootprint → renderTileForCurrentZoom）
    grid.recordFootprint(meshId);
    grid.renderTileForCurrentZoom(meshId, inside.latIdx, inside.lngIdx);

    assert.equal(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR, 'すぐハイライトされる');
    assert.equal(grid.renderedMacroBlocks.get(target).options.weight, FOOTPRINT_BLOCK_STROKE_WEIGHT);
    assert.equal(map.state.zoom, 8);
});

test('更新: 非表示ピンを足すとハイライトが消え、外すと戻る（描画済みブロックも更新）', () => {
    const { latMacro, lngMacro } = centerMacro();
    const inside = tileInsideMacro(latMacro, lngMacro, 5, 5);
    const footprint = [`tile_${inside.latIdx}_${inside.lngIdx}`];
    const privacy = createPrivacyStub();

    const { grid } = createRealGrid({
        footprint,
        zones: privacy,
        zoom: 7,
        bounds: macroWindowBounds(latMacro, lngMacro)
    });
    const target = grid.getMacroId(latMacro, lngMacro);
    grid.updateGrids();
    assert.equal(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR, '最初はハイライト');

    // 非表示ピンを追加（privacy.js の refreshTiles と同じ順序で描き直す）
    const center = grid.getMeshCenter(inside.latIdx, inside.lngIdx);
    const zone = { id: 'z1', lat: center.lat, lng: center.lng, radius: 400 };
    privacy.addZone(zone);
    grid.clearBlockTeamCache();
    grid.updateGrids();
    assert.notEqual(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR, '区域の中だけならハイライトを外す');

    // 区域を消す（createPrivacyStub の list を空にする）
    privacy.list.length = 0;
    grid.updateGrids();
    assert.equal(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR, '区域を外すとハイライトが戻る');
});

test('更新: 週が変わると先週の足跡ではハイライトしない', () => {
    const { latMacro, lngMacro } = centerMacro();
    const inside = tileInsideMacro(latMacro, lngMacro, 5, 5);
    const footprint = [`tile_${inside.latIdx}_${inside.lngIdx}`];
    const { grid } = createRealGrid({
        footprint,
        zoom: 7,
        bounds: macroWindowBounds(latMacro, lngMacro)
    });
    const target = grid.getMacroId(latMacro, lngMacro);
    grid.updateGrids();
    assert.equal(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR);

    // 週が変わった（checkWeekReset 相当）: 足跡は作り直され、索引も捨てる
    grid.weekId = '2026-W48';
    grid.weekIdCachedAt = Date.now();
    grid.footprintIds = [];
    grid.footprintSet = new Set();
    grid.footprintWeek = '2026-W48';
    grid.footprintMacroCache = null;
    grid.updateGrids();
    assert.equal(grid.footprintMacroIndex().size, 0);
    assert.notEqual(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR, '先週の足跡は出さない');
});

test('更新: 画面の切り替えで10kmブロックを描き直してもハイライトが残る', () => {
    const { latMacro, lngMacro } = centerMacro();
    const inside = tileInsideMacro(latMacro, lngMacro, 5, 5);
    const footprint = [`tile_${inside.latIdx}_${inside.lngIdx}`];
    const { grid, map } = createRealGrid({ footprint, zoom: 7, bounds: macroWindowBounds(latMacro, lngMacro) });
    const target = grid.getMacroId(latMacro, lngMacro);

    grid.updateGrids();
    assert.equal(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR);

    // 近距離へ（10kmブロックは消える）→ 広域へ戻る
    map.state.zoom = 15;
    map.state.bounds = viewportBounds(34.6, 135.6, 15);
    grid.updateGrids();
    assert.equal(grid.renderedMacroBlocks.size, 0);

    map.state.zoom = 7;
    map.state.bounds = macroWindowBounds(latMacro, lngMacro);
    grid.updateGrids();
    assert.equal(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR, '戻してもハイライトされる');

    // skin（redrawTiles）を変えてもハイライトは残る
    global.document.body.dataset.skin = 'neon';
    try {
        grid.redrawTiles();
        assert.equal(grid.renderedMacroBlocks.get(target).options.fillColor, FOOTPRINT_STROKE_COLOR, 'スキン変更後もオレンジ');
    } finally {
        global.document.body.dataset.skin = 'default';
    }
});

/* ------------------------------------------------------------------ *
 * 6. 性能（footprintSet を描画中に何度も走査しない）
 * ------------------------------------------------------------------ */

test('性能: 10kmブロックの索引は描画1回につき1回だけ作る（全マスで使い回す）', () => {
    const { latMacro, lngMacro } = centerMacro();
    const inside = tileInsideMacro(latMacro, lngMacro, 5, 5);
    const footprint = [`tile_${inside.latIdx}_${inside.lngIdx}`];
    const { grid } = createRealGrid({ footprint, zoom: 7, bounds: macroWindowBounds(latMacro, lngMacro) });

    // footprintSet の走査回数を数える
    const realSet = grid.footprintSet;
    let scanned = 0;
    const spy = new Set(realSet);
    spy[Symbol.iterator] = function* iterate() {
        scanned += 1;
        yield* realSet;
    };
    grid.footprintSet = spy;
    grid.footprintMacroCache = null;

    grid.updateGrids();
    assert.ok(grid.renderedMacroBlocks.size > 1);
    assert.equal(scanned, 1, `描画1回の走査は1回だけ（実際: ${scanned}回）`);

    // 変化が無ければ作り直さない（同じ Set を使い回す）
    const index = grid.footprintMacroIndex();
    assert.equal(grid.footprintMacroIndex(), index, 'キャッシュした索引を返す');
    grid.updateGrids();
    assert.equal(scanned, 1, '再描画でも footprintSet を走査し直さない');
});

test('性能: 10kmブロックの判定は Set（O(1)）で、1万ブロックを描いても軽い', () => {
    const { grid } = createRealGrid({ footprint: ['tile_1000_1000'], zoom: 6 });
    const start = process.hrtime.bigint();
    grid.updateGrids();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(grid.renderedMacroBlocks.size >= 12000, `zoom 6 は約12,500枚（実際: ${grid.renderedMacroBlocks.size}）`);
    assert.ok(ms < 400, `足跡の索引を足しても初回描画は400ms以内（実際: ${ms.toFixed(1)}ms）`);
    assert.equal(typeof grid.footprintMacroIndex().has, 'function', '索引は Set');
});
