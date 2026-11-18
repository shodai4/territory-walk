/**
 * TERRITORY WALK - Node tests
 * v1.1 要件1: 初期配置ランダム50%（白/黒）＋半透明＋自分の足跡枠線
 *   1) 決定論的ハッシュ: 同じ週・同じ座標なら誰の端末でも同じ色（再現性）
 *   2) 白 / 黒 がほぼ 50%:50% で出る（偏りがない）
 *   3) 週が変わると配置がシャッフルされる
 *   4) 既知の記録（実際に塗ったマス）はその陣営で表示される
 *   5) 塗りは半透明（下の地図が読める濃さ）で、初期配置と実績が同じ濃さ
 *   6) 自分の足跡だけに枠線が付く（サーバーへは送らない・端末内のみ）
 *   7) 非表示ピンの区域の中は、実際に塗られていても初期配置の見た目に戻る
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');

// grid.js の getTileStyle は document.body.dataset.skin を見る（描画スキン）
global.document = { body: { dataset: {} } };

const {
    GridManager,
    tileHash,
    deterministicInitialTeam,
    isoWeekIdJst,
    TILE_FILL_OPACITY,
    FOOTPRINT_STROKE_COLOR,
    FOOTPRINT_STORAGE_KEY
} = require(path.join(ROOT, 'grid.js'));

const LAT_GRID = 0.0009;
const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);
const WEEK = '2026-W47';

// 足跡（端末内保存）は localStorage を使う。テストではメモリ実装を差す。
global.localStorage = createMemoryStorage();

/** map / L を使わずに、描画スタイルの計算だけを試すための最小インスタンス */
function createGrid({ claimed = [], zones = null, weekId = WEEK } = {}) {
    const grid = Object.create(GridManager.prototype);
    grid.LAT_GRID = LAT_GRID;
    grid.LNG_GRID = LNG_GRID;
    grid.claimedTilesCache = new Map(claimed);
    grid.renderedMeshes = new Map();
    grid.weekId = weekId;
    grid.footprintWeek = weekId;
    grid.footprintIds = [];
    grid.footprintSet = new Set();
    grid.app = {
        supabaseManager: { getCurrentWeekId: () => weekId },
        privacyZones: zones ? { containsMesh: (latIdx, lngIdx) => zones(latIdx, lngIdx) } : null
    };
    return grid;
}

/* ------------------------------------------------------------------ *
 * 1〜3: 決定論的ハッシュと 50:50
 * ------------------------------------------------------------------ */

test('初期配置: 同じ週・同じ座標は必ず同じ色（端末に依存しない）', () => {
    const a = deterministicInitialTeam(WEEK, 12345, 67890);
    const b = deterministicInitialTeam(WEEK, 12345, 67890);
    assert.equal(a, b);
    assert.ok(a === 'white' || a === 'black', '色は white / black のどちらか');
    assert.equal(tileHash(WEEK, 12345, 67890), tileHash(WEEK, 12345, 67890));
});

test('初期配置: 白 / 黒 がほぼ 50%:50% で出る', () => {
    let white = 0;
    let black = 0;
    const baseLat = Math.floor(35.65 / LAT_GRID);
    const baseLng = Math.floor(139.70 / LNG_GRID);
    for (let dLat = 0; dLat < 80; dLat += 1) {
        for (let dLng = 0; dLng < 80; dLng += 1) {
            const team = deterministicInitialTeam(WEEK, baseLat + dLat, baseLng + dLng);
            if (team === 'white') white += 1; else if (team === 'black') black += 1;
        }
    }
    const ratio = white / (white + black);
    assert.ok(ratio > 0.47 && ratio < 0.53, `白の割合が 50%±3% に入る（実際: ${(ratio * 100).toFixed(1)}%）`);
});

test('初期配置: 近いマス同士が同じ色に偏らない（隣と独立）', () => {
    const baseLat = Math.floor(35.65 / LAT_GRID);
    const baseLng = Math.floor(139.70 / LNG_GRID);
    let same = 0;
    let pairs = 0;
    for (let dLat = 0; dLat < 40; dLat += 1) {
        for (let dLng = 0; dLng < 40; dLng += 1) {
            const a = deterministicInitialTeam(WEEK, baseLat + dLat, baseLng + dLng);
            const b = deterministicInitialTeam(WEEK, baseLat + dLat, baseLng + dLng + 1);
            if (a === b) same += 1;
            pairs += 1;
        }
    }
    const ratio = same / pairs;
    assert.ok(ratio > 0.43 && ratio < 0.57, `隣接マスの一致率が 50%前後（実際: ${(ratio * 100).toFixed(1)}%）`);
});

test('初期配置: 週が変わると同じ座標でも配置がシャッフルされる', () => {
    const baseLat = Math.floor(35.65 / LAT_GRID);
    const baseLng = Math.floor(139.70 / LNG_GRID);
    let flipped = 0;
    let total = 0;
    for (let dLat = 0; dLat < 40; dLat += 1) {
        for (let dLng = 0; dLng < 40; dLng += 1) {
            const a = deterministicInitialTeam('2026-W47', baseLat + dLat, baseLng + dLng);
            const b = deterministicInitialTeam('2026-W48', baseLat + dLat, baseLng + dLng);
            if (a !== b) flipped += 1;
            total += 1;
        }
    }
    const ratio = flipped / total;
    assert.ok(ratio > 0.4, `週替わりで約半数が入れ替わる（実際: ${(ratio * 100).toFixed(1)}%）`);
});

test('初期配置: 週IDは Asia/Tokyo の ISO 週（月曜リセット）', () => {
    // 2026-11-16 は月曜（JST）
    assert.equal(isoWeekIdJst(new Date('2026-11-16T03:00:00+09:00')), '2026-W47');
    // 同じ週の日曜（2026-11-22）も同じ W47
    assert.equal(isoWeekIdJst(new Date('2026-11-22T23:30:00+09:00')), '2026-W47');
    // 翌週の月曜（2026-11-23）で切り替わる
    assert.equal(isoWeekIdJst(new Date('2026-11-23T00:10:00+09:00')), '2026-W48');
});

/* ------------------------------------------------------------------ *
 * 4: 記録済みマスはその陣営
 * ------------------------------------------------------------------ */

test('描画色: 実際に塗ったマスは陣営色、未登録は初期配置', () => {
    const grid = createGrid({ claimed: [['tile_1_2', 'white']] });
    assert.equal(grid.resolveTileTeam('tile_1_2', 1, 2), 'white');
    assert.equal(grid.resolveTileTeam('tile_9_9', 9, 9), deterministicInitialTeam(WEEK, 9, 9));
    assert.equal(grid.hasClaim('tile_1_2'), true);
    assert.equal(grid.hasClaim('tile_9_9'), false);
});

test('描画色: サーバー由来の陣営が初期配置より優先される', () => {
    const latIdx = 123;
    const lngIdx = 456;
    const initial = deterministicInitialTeam(WEEK, latIdx, lngIdx);
    const opposite = initial === 'white' ? 'black' : 'white';
    const grid = createGrid({ claimed: [[`tile_${latIdx}_${lngIdx}`, opposite]] });
    assert.equal(grid.resolveTileTeam(`tile_${latIdx}_${lngIdx}`, latIdx, lngIdx), opposite);
});

/* ------------------------------------------------------------------ *
 * 5: 半透明
 * ------------------------------------------------------------------ */

test('描画スタイル: 塗りは半透明（初期配置と実績で同じ濃さ）', () => {
    const grid = createGrid();
    const white = grid.getTileStyle('white');
    const black = grid.getTileStyle('black');

    assert.ok(TILE_FILL_OPACITY <= 0.5, '塗りは 50% 以下（下の地図が透ける）');
    assert.ok(TILE_FILL_OPACITY >= 0.3, '塗りが薄すぎて陣地が見えないことはない');
    assert.equal(white.fillOpacity, TILE_FILL_OPACITY);
    assert.equal(black.fillOpacity, TILE_FILL_OPACITY);
    // 実際に塗ったマスと初期配置で塗りの濃さが違うと「歩いた場所」が分かってしまう
    assert.equal(
        grid.getTileStyle('white').fillOpacity,
        grid.getTileStyle(deterministicInitialTeam(WEEK, 0, 0) === 'white' ? 'black' : 'white').fillOpacity
    );
});

/* ------------------------------------------------------------------ *
 * 6: 自分の足跡
 * ------------------------------------------------------------------ */

test('足跡: 自分が塗ったマスだけ枠線が付き、記録は端末内に残る', () => {
    const grid = createGrid();
    const meshId = 'tile_10_20';
    const plain = grid.getTileStyle('white');
    const footprint = grid.getTileStyle('white', { ownFootprint: true });

    assert.equal(grid.isOwnFootprint(meshId), false);
    grid.recordFootprint(meshId);
    assert.equal(grid.isOwnFootprint(meshId), true);
    assert.ok(footprint.weight > plain.weight, '足跡は枠線が太い');
    assert.equal(footprint.color, FOOTPRINT_STROKE_COLOR);
    assert.equal(footprint.fillOpacity, plain.fillOpacity, '足跡でも塗りの濃さは変えない');

    const saved = JSON.parse(global.localStorage.getItem(FOOTPRINT_STORAGE_KEY));
    assert.equal(saved.week, WEEK);
    assert.deepEqual(saved.ids, [meshId]);
});

test('足跡: 週が変わると消える（先週の足跡が残らない）', () => {
    const storage = createMemoryStorage();
    const previous = global.localStorage;
    global.localStorage = storage;
    try {
        const friday = createGrid({ weekId: '2026-W47' });
        friday.recordFootprint('tile_5_5');
        assert.equal(friday.isOwnFootprint('tile_5_5'), true);

        // 翌週のインスタンス（週が変わった直後）
        const nextWeek = createGrid({ weekId: '2026-W48' });
        nextWeek.loadFootprint();
        assert.equal(nextWeek.isOwnFootprint('tile_5_5'), false, '先週の足跡は表示しない');
    } finally {
        global.localStorage = previous;
    }
});

test('足跡: サーバーへ送る経路が無い（送信は claimedTiles の同期だけ）', () => {
    const source = readAppSource();
    const claimBlock = source.slice(source.indexOf('async processMeshAndClaim'), source.indexOf('playClaimSound()'));
    assert.match(claimBlock, /recordFootprint\(/, '足跡はローカル記録のみ');
    assert.doesNotMatch(claimBlock, /recordFootprint[\s\S]{0,200}enqueueTileSync/, '足跡を送信キューに積まない');
});

/* ------------------------------------------------------------------ *
 * 7: 非表示ピンの区域
 * ------------------------------------------------------------------ */

test('非表示ピン: 区域の中は実際に塗られていても初期配置の見た目に戻す', () => {
    const latIdx = 500;
    const lngIdx = 700;
    const meshId = `tile_${latIdx}_${lngIdx}`;
    const inside = (la, lo) => (la === latIdx && lo === lngIdx ? { id: 'z1', label: '自宅', radius: 300 } : null);
    const grid = createGrid({ claimed: [[meshId, 'white']], zones: inside });

    const masked = grid.resolveTileTeam(meshId, latIdx, lngIdx);
    assert.equal(masked, deterministicInitialTeam(WEEK, latIdx, lngIdx), '区域の中は必ず初期配置');
    // 区域の外は通常どおり
    assert.equal(grid.resolveTileTeam(`tile_${latIdx + 5}_${lngIdx + 5}`, latIdx + 5, lngIdx + 5),
        deterministicInitialTeam(WEEK, latIdx + 5, lngIdx + 5));
});

/* ------------------------------------------------------------------ *
 * 補助
 * ------------------------------------------------------------------ */

function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
        clear: () => map.clear()
    };
}

test('初期配置: 差分が小さい座標でもハッシュが偏らない（上下左右の4近傍）', () => {
    const latIdx = 40000;
    const lngIdx = 126000;
    const center = deterministicInitialTeam(WEEK, latIdx, lngIdx);
    const neighbours = [
        deterministicInitialTeam(WEEK, latIdx + 1, lngIdx),
        deterministicInitialTeam(WEEK, latIdx - 1, lngIdx),
        deterministicInitialTeam(WEEK, latIdx, lngIdx + 1),
        deterministicInitialTeam(WEEK, latIdx, lngIdx - 1)
    ];
    assert.ok(neighbours.some((team) => team !== center), '4近傍のどこかは違う色になる');
});
