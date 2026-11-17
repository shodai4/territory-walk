/**
 * TERRITORY WALK - Node tests
 * v1.1 ズーム別の描画（3段階）:
 *   1) zoom >= 16 … 100mマス（従来どおり初期配置＋実績＋自分の足跡）
 *   2) 13 <= zoom < 16 … 10×10マス（約1km四方）のブロックに集計して薄く描く
 *   3) zoom < 13 … マスもブロックも一切描かない（広域で居場所が分からない）
 *   4) ブロックの色は白黒の多数決。同数は week_id とブロック座標の決定論的ハッシュ
 *   5) 非表示ピンの中のマスは集計から除外（中立）
 *   6) スコア（％バー）と歩行判定は claimedTilesCache だけを見る（描画と非干渉）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { GridManager, deterministicBlockTeam, displayModeForZoom, BLOCK_TILES, BLOCK_FILL_OPACITY } =
    require(path.join(ROOT, 'grid.js'));

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

/* ------------------------------------------------------------------ *
 * 1. ズームの3段階
 * ------------------------------------------------------------------ */

test('ズーム: 16以上は100mマス、13〜15は1kmブロック、12以下は何も描かない', () => {
    assert.equal(displayModeForZoom(20), 'tiles');
    assert.equal(displayModeForZoom(17), 'tiles');
    assert.equal(displayModeForZoom(16), 'tiles');
    assert.equal(displayModeForZoom(15.9), 'blocks');
    assert.equal(displayModeForZoom(15), 'blocks');
    assert.equal(displayModeForZoom(13), 'blocks');
    assert.equal(displayModeForZoom(12.9), 'none');
    assert.equal(displayModeForZoom(12), 'none');
    assert.equal(displayModeForZoom(5), 'none');
    assert.equal(displayModeForZoom(2), 'none');
});

test('ズーム: しきい値は CONFIG で上書きできる（アプリ側の値と一致させる）', () => {
    const previous = global.CONFIG;
    global.CONFIG = { TILE_DETAIL_MIN_ZOOM: 17, TILE_RENDER_MIN_ZOOM: 14 };
    try {
        assert.equal(displayModeForZoom(17), 'tiles');
        assert.equal(displayModeForZoom(16), 'blocks');
        assert.equal(displayModeForZoom(14), 'blocks');
        assert.equal(displayModeForZoom(13), 'none');
    } finally {
        if (previous === undefined) delete global.CONFIG;
        else global.CONFIG = previous;
    }
});

test('設定: app.js の CONFIG がこの仕様（100m=16以上 / ブロック=13以上 / 取得も13以上）と一致する', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const configBlock = source.slice(source.indexOf('const CONFIG = {'), source.indexOf('};', source.indexOf('const CONFIG = {')));
    assert.match(configBlock, /TILE_DETAIL_MIN_ZOOM:\s*16/);
    assert.match(configBlock, /TILE_RENDER_MIN_ZOOM:\s*13/);
    assert.match(configBlock, /REMOTE_FETCH_MIN_ZOOM:\s*13/);
    // 古い「zoom 5 から描く」記述が残っていない
    assert.doesNotMatch(configBlock, /TILE_RENDER_MIN_ZOOM:\s*5/);
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
 * 3. 描画の切り替え
 * ------------------------------------------------------------------ */

test('描画: zoom 17 では100mマスだけが並び、ブロックは描かない', () => {
    const { grid, map } = createRealGrid({ zoom: 17 });
    map.state.zoom = 17;
    grid.updateGrids();

    assert.ok(grid.renderedMeshes.size > 0, '100mマスを描く');
    assert.equal(grid.renderedBlocks.size, 0, 'ブロックは描かない');
});

test('描画: zoom 14 では1kmブロックだけを描き、100mマスは残さない', () => {
    const { grid, map } = createRealGrid({ zoom: 17 });
    map.state.zoom = 17;
    grid.updateGrids();
    assert.ok(grid.renderedMeshes.size > 0);

    // zoom 15 → 14 へ引く
    map.state.zoom = 14;
    grid.updateGrids();
    assert.equal(grid.renderedMeshes.size, 0, '100mマスはすべて消える');
    assert.ok(grid.renderedBlocks.size > 0, 'ブロックを描く');

    // 375×812 の画面で 200 ブロック以内（描画は軽い）
    assert.ok(grid.renderedBlocks.size <= 200, `画面あたりのブロック数は200以下（実際: ${grid.renderedBlocks.size}）`);
});

test('描画: zoom 11 では何も描かない（マスもブロックも消える）', () => {
    const { grid, map } = createRealGrid({ zoom: 17 });
    map.state.zoom = 14;
    grid.updateGrids();
    assert.ok(grid.renderedBlocks.size > 0);

    map.state.zoom = 12;
    grid.updateGrids();
    assert.equal(grid.renderedMeshes.size, 0);
    assert.equal(grid.renderedBlocks.size, 0, 'zoom 12 でブロックも消える');

    map.state.zoom = 11;
    grid.updateGrids();
    assert.equal(grid.renderedMeshes.size, 0);
    assert.equal(grid.renderedBlocks.size, 0);
});

test('描画: ブロックは薄い半透明で、細かな経路が見えない濃さにする', () => {
    const { grid } = createRealGrid();
    const style = grid.getBlockStyle('white');
    assert.equal(style.fillOpacity, BLOCK_FILL_OPACITY);
    assert.ok(BLOCK_FILL_OPACITY < 0.45, '100mマス（0.45）より薄い');
    assert.ok(BLOCK_FILL_OPACITY >= 0.15, '薄すぎて陣地が見えないことはない');
    assert.ok(style.weight <= 1, '枠線はごく細い');
    assert.ok(style.opacity <= 0.15, '枠線はほぼ透明（ブロックの境界を目立たせない）');
    assert.equal(style.interactive, false);
});

test('描画: 中距離では塗った直後でもマスではなくブロックを更新する', () => {
    const { grid, map } = createRealGrid({ zoom: 14 });
    map.state.zoom = 14;
    const latIdx = Math.floor(34.6 / LAT_GRID);
    const lngIdx = Math.floor(135.6 / LNG_GRID);

    grid.renderTileForCurrentZoom(grid.getMeshId(latIdx, lngIdx), latIdx, lngIdx);
    assert.equal(grid.renderedMeshes.size, 0, '100mマスは描かない');
    assert.equal(grid.renderedBlocks.size, 1, 'そのマスの属するブロックを描く');

    const { latBlock, lngBlock } = grid.getBlockIndices(latIdx, lngIdx);
    assert.ok(grid.renderedBlocks.has(grid.getBlockId(latBlock, lngBlock)));

    // 広域では新しく何も描かない（既存のレイヤーは次の updateGrids で消える）
    map.state.zoom = 11;
    assert.equal(grid.renderTileForCurrentZoom(grid.getMeshId(latIdx, lngIdx), latIdx, lngIdx), null);
    assert.equal(grid.renderedMeshes.size, 0, '100mマスは追加しない');
    assert.equal(grid.renderedBlocks.size, 1, 'ブロックを新たに増やさない');

    grid.updateGrids();
    assert.equal(grid.renderedMeshes.size, 0);
    assert.equal(grid.renderedBlocks.size, 0, 'ズームアウト後はブロックも残らない');
});

/* ------------------------------------------------------------------ *
 * 4. スコア・歩行判定との非干渉
 * ------------------------------------------------------------------ */

test('スコア: ブロックを描いても claimedTilesCache（勝敗の集計元）は変わらない', () => {
    const claimed = [['tile_38440_1234560', 'white']];
    const { grid, map } = createRealGrid({ claimed, zoom: 14 });
    map.state.zoom = 14;
    const before = new Map(grid.claimedTilesCache);

    grid.updateGrids();
    assert.ok(grid.renderedBlocks.size > 0);

    assert.equal(grid.claimedTilesCache.size, before.size, 'マスの数は増減しない');
    for (const [id, team] of before) {
        assert.equal(grid.claimedTilesCache.get(id), team, '陣営も書き換えない');
    }
});

test('スコア: ％バーの集計元は claimedTilesCache だけで、描画用の関数を参照しない', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const body = source.slice(source.indexOf('    updateScoreUI()'), source.indexOf('    initDPad()'));

    assert.match(body, /gridManager\.claimedTilesCache\.values\(\)/, '集計元は実績マス');
    assert.doesNotMatch(body, /resolveBlockTeam|renderedBlocks|displayModeForZoom/, '描画用の集計は使わない');
});

test('歩行判定: 塗る処理は従来どおり実績マスだけを書き換える（ブロックは表示のみ）', () => {
    const source = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    const blockSection = source.slice(source.indexOf('getBlockIndices('), source.indexOf('initEventListeners()'));
    assert.doesNotMatch(blockSection, /claimedTilesCache\.(set|delete)|enqueueTileSync/, 'ブロックはキャッシュを書き換えない');

    const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    assert.match(appSource, /renderTileForCurrentZoom\(/, '塗った直後の描画もズームで切り替える');
});

/* ------------------------------------------------------------------ *
 * 5. 広域で何も出さないことの担保（privacy の穴を戻さない）
 * ------------------------------------------------------------------ */

test('広域: 実績マスが大量にあっても zoom 12 以下では1枚も描かない', () => {
    const claimed = [];
    const latBase = Math.floor(34.6 / LAT_GRID);
    const lngBase = Math.floor(135.6 / LNG_GRID);
    for (let dLat = -3; dLat <= 3; dLat += 1) {
        for (let dLng = -3; dLng <= 3; dLng += 1) {
            claimed.push([`tile_${latBase + dLat}_${lngBase + dLng}`, dLat % 2 === 0 ? 'white' : 'black']);
        }
    }
    const { grid, map } = createRealGrid({ claimed, zoom: 12 });
    map.state.zoom = 12;
    grid.updateGrids();

    assert.equal(grid.renderedMeshes.size, 0);
    assert.equal(grid.renderedBlocks.size, 0);
    assert.equal(grid.renderedMeshes.size + grid.renderedBlocks.size, 0, '過疎地でも歩いた場所が浮き上がらない');
});
