/**
 * TERRITORY WALK - Node tests
 * ズーム別の描画（4段階）:
 *   1) zoom >= 14 … 100mマス（初期配置＋実績＋自分の足跡）
 *   2) 10 〜 13 … 10×10マス（約1km四方）のブロックに集計して薄く描く
 *   3) 6 〜 9 … 1kmブロックを10×10にまとめた10kmブロック（さらに薄く）
 *   4) zoom <= 5 … マスもブロックも一切描かない（広域で居場所が分からない）
 *   5) ブロックの色は白黒の多数決。同数は week_id と座標の決定論的ハッシュ
 *   6) 非表示ピンの中のマスは集計から除外（中立）
 *   7) スコア（％バー）と歩行判定は claimedTilesCache だけを見る（描画と非干渉）
 *   8) 画面が欠けない描画上限と、フリーズしない性能
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readAppSource } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');
const {
    GridManager,
    deterministicInitialTeam,
    deterministicInitialTeamFast,
    deterministicBlockTeam,
    deterministicMacroTeam,
    displayModeForZoom,
    tileHash,
    tileHashWeekSeed,
    initialTeamWithSeed,
    BLOCK_TILES,
    MACRO_BLOCKS,
    BLOCK_FILL_OPACITY,
    MACRO_FILL_OPACITY,
    BLOCK_RENDER_MAX_COUNT,
    MACRO_RENDER_MAX_COUNT
} = require(path.join(ROOT, 'grid.js'));

const LAT_GRID = 0.0009;
const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);
const WEEK = '2026-W47';

/* ------------------------------------------------------------------ *
 * テスト用の最小環境（Leaflet・localStorage・document をスタブ）
 * ------------------------------------------------------------------ */

global.document = { body: { dataset: {} } };
global.localStorage = createMemoryStorage();

function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
        clear: () => map.clear()
    };
}

/** 描画されたレイヤーを数えられる最小の Leaflet スタブ */
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

/** 地図のスタブ。bounds は [south, west, north, east] を返す */
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

/** 中心 lat/lng・画面 375×812px・指定ズームのときの地図範囲（緯度経度） */
function viewportBounds(lat, lng, zoom) {
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    const halfHeight = (812 / 2) * metersPerPixel / 111320;
    const halfWidth = (375 / 2) * metersPerPixel / (111320 * Math.cos(lat * Math.PI / 180));
    return [lat - halfHeight, lng - halfWidth, lat + halfHeight, lng + halfWidth];
}

/**
 * 実際の GridManager を、地図と Leaflet のスタブで組み立てる。
 * localStorage はテストごとに空にする（週リセットの副作用を避ける）。
 */
function createRealGrid({ claimed = [], zones = null, weekId = WEEK, zoom = 17, center = [34.6, 135.6] } = {}) {
    global.localStorage = createMemoryStorage();
    installLeafletStub();

    const map = createMapStub(viewportBounds(center[0], center[1], zoom), zoom);
    const app = {
        supabaseManager: { getCurrentWeekId: () => weekId },
        privacyZones: zones ? { containsMesh: (latIdx, lngIdx) => zones(latIdx, lngIdx) } : null
    };
    const grid = new GridManager(map, app);
    grid.LAT_GRID = LAT_GRID;
    grid.LNG_GRID = LNG_GRID;
    grid.weekId = weekId;
    grid.claimedTilesCache = new Map(claimed);
    return { grid, map };
}

/** 中心まわりの n×n マスを塗った実績を作る */
function claimSquare(latIdx, lngIdx, size = 6, team = 'white') {
    const claimed = [];
    for (let dLat = 0; dLat < size; dLat += 1) {
        for (let dLng = 0; dLng < size; dLng += 1) {
            claimed.push([`tile_${latIdx + dLat}_${lngIdx + dLng}`, team]);
        }
    }
    return claimed;
}

/* ------------------------------------------------------------------ *
 * 1. ズームの4段階
 * ------------------------------------------------------------------ */

test('ズーム: 14以上は100mマス、10〜13は1kmブロック、6〜9は10kmブロック、5以下は何も描かない', () => {
    assert.equal(displayModeForZoom(20), 'tiles');
    assert.equal(displayModeForZoom(17), 'tiles');
    assert.equal(displayModeForZoom(14), 'tiles');
    assert.equal(displayModeForZoom(13.9), 'blocks');
    assert.equal(displayModeForZoom(13), 'blocks');
    assert.equal(displayModeForZoom(11), 'blocks');
    assert.equal(displayModeForZoom(10), 'blocks', 'zoom 10 でも1kmブロックを描く');
    assert.equal(displayModeForZoom(9.9), 'macroBlocks');
    assert.equal(displayModeForZoom(9), 'macroBlocks');
    assert.equal(displayModeForZoom(7), 'macroBlocks');
    assert.equal(displayModeForZoom(6), 'macroBlocks', 'zoom 6 でも10kmブロックを描く');
    assert.equal(displayModeForZoom(5.9), 'none');
    assert.equal(displayModeForZoom(5), 'none', 'zoom 5 以下は何も描かない');
    assert.equal(displayModeForZoom(2), 'none');
});

test('ズーム: しきい値は CONFIG で上書きできる（アプリ側の値と一致させる）', () => {
    const previous = global.CONFIG;
    global.CONFIG = { TILE_DETAIL_MIN_ZOOM: 16, TILE_RENDER_MIN_ZOOM: 11, MACRO_RENDER_MIN_ZOOM: 6 };
    try {
        assert.equal(displayModeForZoom(16), 'tiles');
        assert.equal(displayModeForZoom(15), 'blocks');
        assert.equal(displayModeForZoom(11), 'blocks');
        assert.equal(displayModeForZoom(10), 'macroBlocks');
        assert.equal(displayModeForZoom(6), 'macroBlocks');
        assert.equal(displayModeForZoom(5), 'none');
    } finally {
        if (previous === undefined) delete global.CONFIG;
        else global.CONFIG = previous;
    }
});

test('設定: CONFIG がこの仕様（マス=14以上 / 1km=10以上 / 10km=6以上 / マス取得は13以上）と一致する', () => {
    const source = readAppSource();
    const configBlock = source.slice(source.indexOf('const CONFIG = {'), source.indexOf('};', source.indexOf('const CONFIG = {')));
    assert.match(configBlock, /TILE_DETAIL_MIN_ZOOM:\s*14/);
    assert.match(configBlock, /TILE_RENDER_MIN_ZOOM:\s*10/);
    assert.match(configBlock, /MACRO_RENDER_MIN_ZOOM:\s*6/);
    assert.match(configBlock, /REMOTE_FETCH_MIN_ZOOM:\s*13/);
    // 描画上限: zoom 14 の約1,950マス / zoom 10 の約4,950ブロック / zoom 6 の約12,500ブロックが収まる
    assert.match(configBlock, /MAX_TILES_PER_RENDER:\s*3000/);
    assert.match(configBlock, /BLOCK_RENDER_MAX_COUNT:\s*6500/);
    assert.match(configBlock, /MACRO_RENDER_MAX_COUNT:\s*13000/);
    // 古いしきい値が残っていない
    assert.doesNotMatch(configBlock, /TILE_DETAIL_MIN_ZOOM:\s*16/);
    assert.doesNotMatch(configBlock, /TILE_RENDER_MIN_ZOOM:\s*11/);
    assert.match(configBlock, /ENABLE_DEBUG_TOOLS:\s*false/, 'App Store 提出ビルドのデバッグ無効は変えない');
});

/* ------------------------------------------------------------------ *
 * 2. 10×10 集計
 * ------------------------------------------------------------------ */

test('ブロック: 10×10マス（約1km四方）の範囲を1ブロックとして扱う', () => {
    const { grid } = createRealGrid();
    assert.equal(BLOCK_TILES, 10);

    // 同じブロックに入る/入らない座標
    assert.deepEqual(grid.getBlockIndices(123, 456), { latBlock: 12, lngBlock: 45 });
    assert.deepEqual(grid.getBlockIndices(129, 459), { latBlock: 12, lngBlock: 45 });
    assert.deepEqual(grid.getBlockIndices(130, 460), { latBlock: 13, lngBlock: 46 });
    // 負の座標でも切り下げで隣のブロックと混ざらない
    assert.deepEqual(grid.getBlockIndices(-1, -1), { latBlock: -1, lngBlock: -1 });
    assert.deepEqual(grid.getBlockIndices(-10, -10), { latBlock: -1, lngBlock: -1 });
    assert.deepEqual(grid.getBlockIndices(-11, -11), { latBlock: -2, lngBlock: -2 });

    const bounds = grid.getBlockBounds(12, 45);
    assert.equal(bounds[0][0], 120 * LAT_GRID);
    assert.equal(bounds[1][0], 130 * LAT_GRID);
    assert.equal(bounds[0][1], 450 * LNG_GRID);
    assert.equal(bounds[1][1], 460 * LNG_GRID);
    assert.equal(grid.getBlockId(12, 45), 'block_12_45');
});

test('ブロック: 中の100マスを数えて、白黒の多い方の色になる', () => {
    const latBlock = 3844;
    const lngBlock = 123456;
    const latBase = latBlock * BLOCK_TILES;
    const lngBase = lngBlock * BLOCK_TILES;

    // 60マスを白で塗る（残り40マスは初期配置）
    const claimed = [];
    for (let i = 0; i < 60; i += 1) {
        claimed.push([`tile_${latBase + Math.floor(i / 10)}_${lngBase + (i % 10)}`, 'white']);
    }
    const { grid } = createRealGrid({ claimed });

    const tally = grid.tallyBlock(latBlock, lngBlock);
    assert.equal(tally.counted, 100, '100マスすべてを数える（非表示ピンが無ければ）');
    assert.ok(tally.white >= 60, `塗った60マスは白に数える（実際: ${tally.white}）`);
    assert.equal(tally.white + tally.black, 100);
    assert.equal(grid.resolveBlockTeam(latBlock, lngBlock), 'white');
});

test('ブロック: 黒が多ければ黒、同数なら決定論的な色になる', () => {
    const latBlock = 2000;
    const lngBlock = 7000;
    const latBase = latBlock * BLOCK_TILES;
    const lngBase = lngBlock * BLOCK_TILES;

    // 100マスすべて黒 → 確実に黒
    const allBlack = [];
    for (let dLat = 0; dLat < 10; dLat += 1) {
        for (let dLng = 0; dLng < 10; dLng += 1) {
            allBlack.push([`tile_${latBase + dLat}_${lngBase + dLng}`, 'black']);
        }
    }
    const blackGrid = createRealGrid({ claimed: allBlack }).grid;
    assert.equal(blackGrid.resolveBlockTeam(latBlock, lngBlock), 'black');

    // 何も塗っていないブロックのうち、白黒が同数になるものを1つ見つけて検証
    const emptyGrid = createRealGrid().grid;
    let tieBlock = null;
    for (let b = 0; b < 50 && !tieBlock; b += 1) {
        const tally = emptyGrid.tallyBlock(3000 + b, 9000);
        if (tally.white === tally.black) tieBlock = { latBlock: 3000 + b, lngBlock: 9000, tally };
    }
    assert.ok(tieBlock, '白黒同数のブロックが見つかる（初期配置は約50:50）');

    const team = emptyGrid.resolveBlockTeam(tieBlock.latBlock, tieBlock.lngBlock);
    assert.equal(team, deterministicBlockTeam(WEEK, tieBlock.latBlock, tieBlock.lngBlock));
    assert.equal(emptyGrid.resolveBlockTeam(tieBlock.latBlock, tieBlock.lngBlock), team, '何度呼んでも同じ色');
    // 端末・実行タイミングに依存しない
    assert.equal(deterministicBlockTeam(WEEK, 1, 2), deterministicBlockTeam(WEEK, 1, 2));
    assert.ok(['white', 'black'].includes(deterministicBlockTeam(WEEK, 1, 2)));
});

test('ブロック: 同数の決め方がブロックごとに偏らない（白黒どちらも出る）', () => {
    let white = 0;
    let black = 0;
    for (let latBlock = 0; latBlock < 40; latBlock += 1) {
        for (let lngBlock = 0; lngBlock < 40; lngBlock += 1) {
            const team = deterministicBlockTeam(WEEK, 1000 + latBlock, 2000 + lngBlock);
            if (team === 'white') white += 1; else black += 1;
        }
    }
    const ratio = white / (white + black);
    assert.ok(ratio > 0.4 && ratio < 0.6, `同数のブロックの色はほぼ半々（実際: ${(ratio * 100).toFixed(1)}%）`);
});

test('ブロック: 週が変われば同数ブロックの色もシャッフルされる', () => {
    let flipped = 0;
    const total = 200;
    for (let i = 0; i < total; i += 1) {
        const a = deterministicBlockTeam('2026-W47', 5000 + i, 6000);
        const b = deterministicBlockTeam('2026-W48', 5000 + i, 6000);
        if (a !== b) flipped += 1;
    }
    assert.ok(flipped > total * 0.35, `週替わりで約半数が入れ替わる（実際: ${flipped}/${total}）`);
});

test('ブロック: 非表示ピンの中のマスは集計から除外する（中立）', () => {
    const latBlock = 3844;
    const lngBlock = 123456;
    const latBase = latBlock * BLOCK_TILES;
    const lngBase = lngBlock * BLOCK_TILES;

    // ブロックの左半分（50マス）を非表示ピンの区域にする
    const zones = (latIdx, lngIdx) => {
        const latBlockOf = Math.floor(latIdx / 10);
        const lngOffset = lngIdx - lngBase;
        return (latBlockOf === latBlock && lngOffset >= 0 && lngOffset < 5) ? { id: 'z1' } : null;
    };
    const claimed = [];
    for (let dLat = 0; dLat < 10; dLat += 1) {
        for (let dLng = 0; dLng < 5; dLng += 1) {
            claimed.push([`tile_${latBase + dLat}_${lngBase + dLng}`, 'black']);
        }
    }
    const { grid } = createRealGrid({ claimed, zones });
    const tally = grid.tallyBlock(latBlock, lngBlock);

    // 同じデータで区域が無い場合と比べる（初期配置は同じなので差がそのまま区域の効果）
    const plain = createRealGrid({ claimed }).grid.tallyBlock(latBlock, lngBlock);

    assert.equal(tally.masked, 50, '区域内の50マスは数えない');
    assert.equal(tally.counted, 50, '区域の外の50マスだけで判定する');
    assert.equal(tally.black, plain.black - 50, '区域内の黒50マスは色に滲まない');
});

/* ------------------------------------------------------------------ *
 * 3. 初期配置ハッシュの高速版が元と一致する（毎回の描画で使う）
 * ------------------------------------------------------------------ */

test('ハッシュ: 高速版の初期配置が deterministicInitialTeam と1マスも違わない', () => {
    const seed = tileHashWeekSeed(WEEK);
    assert.equal(BLOCK_TILES, 10);
    // 代表的な座標（正・負・0・桁上がり）で一致する
    const samples = [];
    for (let i = 0; i < 300; i += 1) {
        samples.push([38000 + i, 1230000 + i * 7]);
    }
    samples.push([0, 0], [0, -1], [-1, 0], [-10, -100], [999999, 999999], [-999999, 1000000]);
    for (const [latIdx, lngIdx] of samples) {
        assert.equal(
            initialTeamWithSeed(seed, latIdx, lngIdx),
            deterministicInitialTeam(WEEK, latIdx, lngIdx),
            `(${latIdx}, ${lngIdx}) の色が一致する`
        );
    }
    // 週が変われば別の配置になる（元のハッシュと同じ規則）
    assert.equal(
        initialTeamWithSeed(tileHashWeekSeed('2026-W48'), 38444, 1234567),
        deterministicInitialTeam('2026-W48', 38444, 1234567)
    );
    // 週IDから直接使う版も同じ（マス単位の描画で使う）
    assert.equal(deterministicInitialTeamFast(WEEK, 38444, 1234567), deterministicInitialTeam(WEEK, 38444, 1234567));
});

test('ハッシュ: 初期配置は白黒ほぼ半々（高速版でも偏らない）', () => {
    const seed = tileHashWeekSeed(WEEK);
    let white = 0;
    const total = 20000;
    for (let i = 0; i < total; i += 1) {
        if (initialTeamWithSeed(seed, 38000 + Math.floor(i / 200), 1230000 + (i % 200)) === 'white') white += 1;
    }
    const ratio = white / total;
    assert.ok(ratio > 0.47 && ratio < 0.53, `ほぼ半々（実際: ${(ratio * 100).toFixed(1)}%）`);
});

/* ------------------------------------------------------------------ *
 * 4. 描画の切り替え
 * ------------------------------------------------------------------ */

test('描画: zoom 17 では100mマスだけが並び、ブロックは描かない', () => {
    const { grid, map } = createRealGrid({ zoom: 17 });
    map.state.zoom = 17;
    grid.updateGrids();

    assert.ok(grid.renderedMeshes.size > 0, '100mマスを描く');
    assert.equal(grid.renderedBlocks.size, 0, 'ブロックは描かない');
    assert.equal(grid.renderedMacroBlocks.size, 0, '10kmブロックは描かない');
});

test('描画: zoom 14 では100mマスを描き、画面の四隅まで欠けない', () => {
    const { grid, map } = createRealGrid({ zoom: 14 });
    map.state.zoom = 14;
    grid.updateGrids();

    assert.equal(grid.renderedBlocks.size, 0);
    assert.equal(grid.renderedMacroBlocks.size, 0);
    assert.ok(grid.renderedMeshes.size >= 1900, `375×812 の zoom 14 は約1,950マス（実際: ${grid.renderedMeshes.size}）`);
    assert.ok(grid.renderedMeshes.size <= 3000, '描画上限以内');

    // 画面の四隅のマスが描かれている（上限で下側が欠けていない）
    const bounds = map.getBounds();
    const corners = [
        grid.getMeshIndices(bounds.getSouth(), bounds.getWest()),
        grid.getMeshIndices(bounds.getNorth(), bounds.getEast())
    ];
    for (const { latIdx, lngIdx } of corners) {
        assert.ok(grid.renderedMeshes.has(grid.getMeshId(latIdx, lngIdx)), `四隅のマス ${latIdx}_${lngIdx} も描く`);
    }
});

test('描画: zoom 13 では1kmブロックだけを描き、100mマスは残さない', () => {
    const { grid, map } = createRealGrid({ zoom: 14 });
    map.state.zoom = 14;
    grid.updateGrids();
    assert.ok(grid.renderedMeshes.size > 0);

    map.state.bounds = viewportBounds(34.6, 135.6, 13);
    map.state.zoom = 13;
    grid.updateGrids();
    assert.equal(grid.renderedMeshes.size, 0, '100mマスはすべて消える');
    assert.equal(grid.renderedMacroBlocks.size, 0);
    assert.ok(grid.renderedBlocks.size > 0, 'ブロックを描く');
    assert.ok(grid.renderedBlocks.size <= 200, `zoom 13 の画面は200ブロック以下（実際: ${grid.renderedBlocks.size}）`);
});

test('描画: zoom 10 では1kmブロックを描き、zoom 9 では10kmブロックへ切り替わる', () => {
    const { grid, map } = createRealGrid({ zoom: 11 });
    map.state.zoom = 11;
    grid.updateGrids();
    assert.ok(grid.renderedBlocks.size > 0);
    assert.equal(grid.renderedMacroBlocks.size, 0);

    // zoom 10（中距離の下限）: 1kmブロックのまま
    map.state.bounds = viewportBounds(34.6, 135.6, 10);
    map.state.zoom = 10;
    grid.updateGrids();
    assert.equal(grid.renderedMeshes.size, 0, '100mマスは描かない');
    assert.equal(grid.renderedMacroBlocks.size, 0, '10kmブロックはまだ描かない');
    assert.ok(grid.renderedBlocks.size >= 4500, `zoom 10 は約4,950ブロック（実際: ${grid.renderedBlocks.size}）`);

    // zoom 9（広域の上限）: 10kmブロックへ切り替わり、1kmブロックは残さない
    map.state.bounds = viewportBounds(34.6, 135.6, 9);
    map.state.zoom = 9;
    grid.updateGrids();
    assert.equal(grid.renderedBlocks.size, 0, '1kmブロックはすべて消える');
    assert.ok(grid.renderedMacroBlocks.size > 0, '10kmブロックを描く');
});

test('描画: zoom 6 では10kmブロックで画面が埋まり、zoom 5 では何も描かない', () => {
    const { grid, map } = createRealGrid({ zoom: 6 });
    grid.updateGrids();
    assert.equal(grid.renderedMeshes.size, 0);
    assert.equal(grid.renderedBlocks.size, 0);
    assert.ok(grid.renderedMacroBlocks.size >= 12000, `zoom 6 は約12,500枚（実際: ${grid.renderedMacroBlocks.size}）`);
    assert.ok(
        grid.renderedMacroBlocks.size <= MACRO_RENDER_MAX_COUNT,
        `描画上限 ${MACRO_RENDER_MAX_COUNT} 以内（実際: ${grid.renderedMacroBlocks.size}）`
    );

    // 四隅まで届いている（上限で欠けていない）
    const bounds = map.getBounds();
    for (const [lat, lng] of [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]]) {
        const { latIdx, lngIdx } = grid.getMeshIndices(lat, lng);
        const { latMacro, lngMacro } = grid.getMacroIndices(latIdx, lngIdx);
        assert.ok(grid.renderedMacroBlocks.has(grid.getMacroId(latMacro, lngMacro)), '四隅の10kmブロックも描く');
    }

    // zoom 5（初期の広域表示）: 何も描かない
    map.state.bounds = viewportBounds(34.6, 135.6, 5);
    map.state.zoom = 5;
    grid.updateGrids();
    assert.equal(grid.renderedMeshes.size + grid.renderedBlocks.size + grid.renderedMacroBlocks.size, 0);
});

test('描画: ブロックは薄い半透明で、細かな経路が見えない濃さにする', () => {
    const { grid } = createRealGrid();
    const block = grid.getBlockStyle('white');
    assert.equal(block.fillOpacity, BLOCK_FILL_OPACITY);
    assert.ok(BLOCK_FILL_OPACITY < 0.45, '100mマス（0.45）より薄い');
    assert.ok(BLOCK_FILL_OPACITY >= 0.15, '薄すぎて陣地が見えないことはない');
    assert.ok(block.weight <= 1, '枠線はごく細い');
    assert.ok(block.opacity <= 0.15, '枠線はほぼ透明（ブロックの境界を目立たせない）');
    assert.equal(block.interactive, false);

    // 10kmブロックはさらに薄い（広域で「歩いた場所」が浮き彫りにならない）
    const macro = grid.getMacroStyle('white');
    assert.equal(macro.fillOpacity, MACRO_FILL_OPACITY);
    assert.ok(MACRO_FILL_OPACITY < BLOCK_FILL_OPACITY, '1kmブロックより薄い');
    assert.ok(MACRO_FILL_OPACITY >= 0.15, '見えなくならない濃さは保つ');
    assert.ok(macro.weight <= 1 && macro.opacity <= 0.15, '枠線はごく細い');
    assert.equal(macro.interactive, false);
});

test('描画: 中距離・広域では塗った直後でもマスではなく区画を更新する', () => {
    const { grid, map } = createRealGrid({ zoom: 13 });
    map.state.zoom = 13;
    const latIdx = Math.floor(34.6 / LAT_GRID);
    const lngIdx = Math.floor(135.6 / LNG_GRID);

    grid.renderTileForCurrentZoom(grid.getMeshId(latIdx, lngIdx), latIdx, lngIdx);
    assert.equal(grid.renderedMeshes.size, 0, '100mマスは描かない');
    assert.equal(grid.renderedBlocks.size, 1, 'そのマスの属する1kmブロックを描く');
    const { latBlock, lngBlock } = grid.getBlockIndices(latIdx, lngIdx);
    assert.ok(grid.renderedBlocks.has(grid.getBlockId(latBlock, lngBlock)));

    // 広域: 10kmブロックを描く（画面全体）
    map.state.bounds = viewportBounds(34.6, 135.6, 8);
    map.state.zoom = 8;
    grid.updateGrids();
    assert.ok(grid.renderedMacroBlocks.size > 0, '10kmブロックを描く');
    const { latMacro, lngMacro } = grid.getMacroIndices(latIdx, lngIdx);
    assert.ok(grid.renderedMacroBlocks.has(grid.getMacroId(latMacro, lngMacro)), 'そのマスの属する10kmブロックも描く');

    // 非表示域（zoom 5 以下）では新しく何も描かない
    map.state.bounds = viewportBounds(34.6, 135.6, 5);
    map.state.zoom = 5;
    assert.equal(grid.renderTileForCurrentZoom(grid.getMeshId(latIdx, lngIdx), latIdx, lngIdx), null);
    grid.updateGrids();
    assert.equal(grid.renderedMacroBlocks.size, 0, 'ズームアウト後は10kmブロックも残らない');
});

/* ------------------------------------------------------------------ *
 * 5. 10kmブロックの色（実績の無いブロックはハッシュで決める）
 * ------------------------------------------------------------------ */

test('10kmブロック: 実績マスが1個も無ければ、10km用ハッシュの決定論的な色になる', () => {
    const { grid } = createRealGrid({ zoom: 8 });
    const latMacro = 3800;
    const lngMacro = 12340;
    assert.equal(MACRO_BLOCKS, 10);
    assert.equal(
        grid.resolveMacroTeam(latMacro, lngMacro),
        deterministicMacroTeam(WEEK, latMacro, lngMacro),
        '中の1kmブロック100個は数えない'
    );
    // 何度呼んでも・どの端末でも同じ色
    assert.equal(grid.resolveMacroTeam(latMacro, lngMacro), deterministicMacroTeam(WEEK, latMacro, lngMacro));
    // 週が変わればシャッフルされる
    const nextWeek = createRealGrid({ zoom: 8, weekId: '2026-W48' }).grid;
    let flipped = 0;
    for (let i = 0; i < 40; i += 1) {
        if (nextWeek.resolveMacroTeam(latMacro + i, lngMacro) !== deterministicMacroTeam(WEEK, latMacro + i, lngMacro)) flipped += 1;
    }
    assert.ok(flipped > 10, `週替わりで色が入れ替わる（実際: ${flipped}/40）`);
});

test('10kmブロック: 実績があるブロックは、中の1kmブロック100個の多数決で決まる', () => {
    const latMacro = 3800;
    const lngMacro = 12340;
    const latIdx = latMacro * BLOCK_TILES * MACRO_BLOCKS;
    const lngIdx = lngMacro * BLOCK_TILES * MACRO_BLOCKS;
    const { grid } = createRealGrid({ claimed: claimSquare(latIdx, lngIdx, 1), zoom: 8 });

    // 1kmブロックの色を固定して、多数決だけを検証する
    grid.resolveBlockTeamCached = () => 'white';
    assert.equal(grid.resolveMacroTeam(latMacro, lngMacro), 'white', '中のブロックが全部白なら白');

    grid.macroTeamCache.clear();
    grid.resolveBlockTeamCached = () => 'black';
    assert.equal(grid.resolveMacroTeam(latMacro, lngMacro), 'black', '中のブロックが全部黒なら黒');

    // 同数（50:50）は10km用ハッシュ
    grid.macroTeamCache.clear();
    let n = 0;
    grid.resolveBlockTeamCached = () => (n++ % 2 === 0 ? 'white' : 'black');
    assert.equal(
        grid.resolveMacroTeam(latMacro, lngMacro),
        deterministicMacroTeam(WEEK, latMacro, lngMacro),
        '同数はハッシュで決める'
    );
});

test('10kmブロック: 中の1kmブロックの色（＝非表示ピン中立の集計結果）から作る', () => {
    const source = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    const body = source.slice(source.indexOf('    resolveMacroTeam('), source.indexOf('    macroTeamCacheKey('));
    assert.match(body, /resolveBlockTeamCached\(/, '1kmブロックの色（区域の中は中立）を数える');
    assert.doesNotMatch(body, /claimedTilesCache/, '実績マスを直接数えない（非表示ピンの扱いを1kmブロックに任せる）');
});

/* ------------------------------------------------------------------ *
 * 6. スコア・歩行判定との非干渉
 * ------------------------------------------------------------------ */

test('スコア: ブロックを描いても claimedTilesCache（勝敗の集計元）は変わらない', () => {
    const claimed = [['tile_38440_1234560', 'white']];
    const { grid, map } = createRealGrid({ claimed, zoom: 13 });
    map.state.zoom = 13;
    const before = new Map(grid.claimedTilesCache);

    grid.updateGrids();
    assert.ok(grid.renderedBlocks.size > 0);

    assert.equal(grid.claimedTilesCache.size, before.size, 'マスの数は増減しない');
    for (const [id, team] of before) {
        assert.equal(grid.claimedTilesCache.get(id), team, '陣営も書き換えない');
    }
});

test('スコア: ％バーの集計元は全国集計（未取得時は claimedTilesCache）で、描画用の関数を参照しない', () => {
    const source = readAppSource();
    const body = source.slice(source.indexOf('    updateScoreUI()'), source.indexOf('    initDPad()'));

    assert.match(body, /getScoreCounts\(\)/, '集計は getScoreCounts（全国集計→ローカル集計）に集約');
    assert.doesNotMatch(body, /resolveBlockTeam|resolveMacroTeam|renderedBlocks|displayModeForZoom/, '描画用の集計は使わない');

    const counts = source.slice(source.indexOf('    getScoreCounts() {'), source.indexOf('    applyGlobalCountDelta('));
    assert.match(counts, /gridManager\.claimedTilesCache\.values\(\)/, '未取得時は実績マス');
    assert.doesNotMatch(counts, /resolveBlockTeam|resolveMacroTeam|renderedBlocks|displayModeForZoom/, '描画用の集計は使わない');
});

test('歩行判定: 塗る処理は従来どおり実績マスだけを書き換える（区画は表示のみ）', () => {
    const source = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    const blockSection = source.slice(source.indexOf('getBlockIndices('), source.indexOf('initEventListeners()'));
    assert.doesNotMatch(blockSection, /claimedTilesCache\.(set|delete)|enqueueTileSync/, '区画はキャッシュを書き換えない');

    const appSource = readAppSource();
    assert.match(appSource, /renderTileForCurrentZoom\(/, '塗った直後の描画もズームで切り替える');
});

/* ------------------------------------------------------------------ *
 * 7. 実績の索引（ブロック内の実績マス・10kmブロックの有無）
 * ------------------------------------------------------------------ */

test('索引: 実績マスを1回走査して、ブロック内の実績と10kmブロックの有無を作る', () => {
    // 1kmブロックの内側に収まる 3×3 マス（境界をまたがない座標を使う）
    const latIdx = Math.floor(Math.floor(34.6 / LAT_GRID) / BLOCK_TILES) * BLOCK_TILES + 2;
    const lngIdx = Math.floor(Math.floor(135.6 / LNG_GRID) / BLOCK_TILES) * BLOCK_TILES + 2;
    const claimed = claimSquare(latIdx, lngIdx, 3, 'white');
    const { grid } = createRealGrid({ claimed });

    const index = grid.claimIndex();
    const { latBlock, lngBlock } = grid.getBlockIndices(latIdx, lngIdx);
    const { latMacro, lngMacro } = grid.getMacroIndices(latIdx, lngIdx);

    assert.ok(index.blocks.has(grid.getBlockId(latBlock, lngBlock)), 'ブロック内の実績を引ける');
    assert.equal(index.blocks.get(grid.getBlockId(latBlock, lngBlock)).length, 9, '9マス分を持つ');
    assert.ok(index.macros.has(grid.getMacroId(latMacro, lngMacro)), '10kmブロックの有無が分かる');
    assert.equal(index.macros.size, 1);

    // 同じ内容なら作り直さない（参照が同じ）
    assert.equal(grid.claimIndex(), index);
});

test('索引: 陣地が変わったら索引も捨てて作り直す', () => {
    const latIdx = Math.floor(34.6 / LAT_GRID);
    const lngIdx = Math.floor(135.6 / LNG_GRID);
    const { grid } = createRealGrid({ claimed: claimSquare(latIdx, lngIdx, 2, 'white') });
    const before = grid.claimIndex();

    // 1マス塗り足す → 索引と色キャッシュを捨てる
    const newLat = latIdx + 5;
    const newLng = lngIdx + 5;
    const newBlock = grid.getBlockIndices(newLat, newLng);
    const key = grid.blockTeamCacheKey(newBlock.latBlock, newBlock.lngBlock);
    grid.claimedTilesCache.set(grid.getMeshId(newLat, newLng), 'black');
    grid.blockTeamCache.set(key, 'white');
    grid.invalidateBlockTeamAt(newLat, newLng);

    assert.equal(grid.claimIndexCache, null, '索引を捨てる');
    assert.equal(grid.blockTeamCache.has(key), false, '該当ブロックの色も捨てる');
    const after = grid.claimIndex();
    assert.ok(after.blocks.has(grid.getBlockId(newBlock.latBlock, newBlock.lngBlock)), '足したマスが索引に入る');
    assert.notEqual(after, before);
});

/* ------------------------------------------------------------------ *
 * 8. 広域で何も出さないことの担保（privacy の穴を戻さない）
 * ------------------------------------------------------------------ */

test('広域: 実績マスが大量にあっても zoom 5 以下では1枚も描かない', () => {
    const latBase = Math.floor(34.6 / LAT_GRID);
    const lngBase = Math.floor(135.6 / LNG_GRID);
    const claimed = claimSquare(latBase - 3, lngBase - 3, 7, 'white');
    const { grid, map } = createRealGrid({ claimed, zoom: 5 });
    map.state.zoom = 5;
    grid.updateGrids();

    assert.equal(grid.renderedMeshes.size, 0);
    assert.equal(grid.renderedBlocks.size, 0);
    assert.equal(grid.renderedMacroBlocks.size, 0);
    assert.equal(grid.renderedMeshes.size + grid.renderedBlocks.size + grid.renderedMacroBlocks.size, 0, '過疎地でも歩いた場所が浮き上がらない');
});

/* ------------------------------------------------------------------ *
 * 9. 性能（画面が欠けず、フリーズしない）
 * ------------------------------------------------------------------ */

test('性能: zoom 10（1kmブロック約5,000枚）の初回描画は600ms以内、再描画はキャッシュで50ms以内', () => {
    const { grid } = createRealGrid({ zoom: 10 });

    const firstStart = process.hrtime.bigint();
    grid.updateGrids();
    const firstMs = Number(process.hrtime.bigint() - firstStart) / 1e6;

    const cachedStart = process.hrtime.bigint();
    grid.updateGrids();
    const cachedMs = Number(process.hrtime.bigint() - cachedStart) / 1e6;

    assert.ok(grid.renderedBlocks.size >= 4500, `4,500枚以上を描く（実際: ${grid.renderedBlocks.size}）`);
    assert.ok(firstMs < 600, `初回（約49万マスの集計）が600ms以内（実際: ${firstMs.toFixed(1)}ms）`);
    assert.ok(cachedMs < 50, `再描画はキャッシュで50ms以内（実際: ${cachedMs.toFixed(1)}ms）`);
    assert.ok(cachedMs < firstMs, 'キャッシュで必ず軽くなる');
});

test('性能: zoom 6（10kmブロック約12,500枚）の初回描画は300ms以内、再描画は60ms以内', () => {
    const { grid } = createRealGrid({ zoom: 6 });

    const firstStart = process.hrtime.bigint();
    grid.updateGrids();
    const firstMs = Number(process.hrtime.bigint() - firstStart) / 1e6;

    const cachedStart = process.hrtime.bigint();
    grid.updateGrids();
    const cachedMs = Number(process.hrtime.bigint() - cachedStart) / 1e6;

    assert.ok(grid.renderedMacroBlocks.size >= 12000, `12,000枚以上を描く（実際: ${grid.renderedMacroBlocks.size}）`);
    assert.ok(firstMs < 300, `初回が300ms以内（実際: ${firstMs.toFixed(1)}ms）`);
    assert.ok(cachedMs < 60, `再描画が60ms以内（実際: ${cachedMs.toFixed(1)}ms）`);
});

test('性能: zoom 11（県レベル）の初回描画は400ms以内、再描画はキャッシュで30ms以内', () => {
    const { grid } = createRealGrid({ zoom: 11 });

    const firstStart = process.hrtime.bigint();
    grid.updateGrids();
    const firstMs = Number(process.hrtime.bigint() - firstStart) / 1e6;

    const cachedStart = process.hrtime.bigint();
    grid.updateGrids();
    const cachedMs = Number(process.hrtime.bigint() - cachedStart) / 1e6;

    assert.ok(grid.renderedBlocks.size >= 1000, `県レベルでは1,000枚以上のブロック（実際: ${grid.renderedBlocks.size}）`);
    assert.ok(firstMs < 400, `初回（1,300ブロックの集計）が400ms以内（実際: ${firstMs.toFixed(1)}ms）`);
    assert.ok(cachedMs < 30, `再描画はキャッシュで30ms以内（実際: ${cachedMs.toFixed(1)}ms）`);
    assert.ok(cachedMs < firstMs, 'キャッシュで必ず軽くなる');
});

/* ------------------------------------------------------------------ *
 * 10. 文言（今週の戦況詳細の「現在の割合」）
 * ------------------------------------------------------------------ */

test('文言: 今週の戦況詳細の見出しは「現在の割合」（「だから今の割合」は残さない）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /現在の割合/, '見出しは現在の割合');
    assert.doesNotMatch(html, /だから今の割合/, '不自然な「だから今の割合」は残さない');
    // 上2つ（今週の参加人数・今週塗られたマス数）と同じ言い方に揃っている
    assert.match(html, /今週の参加人数/);
    assert.match(html, /今週塗られたマス数/);
});
