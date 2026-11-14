/**
 * TERRITORY WALK - Node tests
 * デバッグモードの追加機能:
 *   1) D-Pad 仮想移動の座標計算（1マス＝グリッド1歩・5桁丸め）
 *   2) 全陣地の白紙リセット（確認ダイアログ必須 / ローカル全消し / 当週サーバー削除 / 遮断）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { DebugTools, DEBUG_RESET_STORAGE_KEYS } = require(path.join(ROOT, 'debug-tools.js'));

const LAT_GRID = 0.0009;
const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);
const WEEK = '2026-W46';

/* ------------------------------------------------------------------ *
 * スタブ（jsdomを使わず、app.js が使う最小限のオブジェクトだけ用意する）
 * ------------------------------------------------------------------ */
function createGrid({ tiles = [] } = {}) {
    const grid = {
        claimedTilesCache: new Map(tiles),
        savedToStorage: null,
        cleared: false,
        saveTilesToStorage() {
            this.savedToStorage = Array.from(this.claimedTilesCache.entries());
            return true;
        },
        clearAllTiles() {
            this.claimedTilesCache.clear();
            this.cleared = true;
            this.saveTilesToStorage();
            return 0;
        },
        updateGrids() {}
    };
    return grid;
}

function createQueue({ pending = [] } = {}) {
    const queue = {
        entries: [...pending],
        notified: 0,
        pendingMeshIds() {
            return new Set(this.entries.map((e) => e.meshId));
        },
        count() {
            return this.entries.length;
        },
        clearAll() {
            const n = this.entries.length;
            this.entries = [];
            return n;
        },
        notify() {
            this.notified += 1;
        },
        isOffline() {
            return false;
        }
    };
    return queue;
}

function createSupabase({ client = {}, result = null } = {}) {
    const calls = [];
    return {
        client,
        calls,
        getCurrentWeekId() {
            return WEEK;
        },
        async deleteTiles(ids, weekId) {
            calls.push({ ids: [...ids], weekId });
            if (result) return result;
            return { success: true, deleted: ids.length };
        }
    };
}

function createApp(overrides = {}) {
    const grid = overrides.gridManager || createGrid({
        tiles: [
            ['tile_100_200', 'white'],
            ['tile_101_200', 'black'],
            ['tile_102_200', 'white']
        ]
    });
    const queue = overrides.syncQueue || createQueue({
        pending: [
            { meshId: 'tile_101_200', weekId: WEEK },
            { meshId: 'tile_199_999', weekId: WEEK }
        ]
    });
    const supabase = overrides.supabaseManager || createSupabase();
    return {
        debugEnabled: overrides.debugEnabled !== undefined ? overrides.debugEnabled : true,
        isDebugMode: overrides.isDebugMode !== undefined ? overrides.isDebugMode : true,
        gridManager: grid,
        syncQueue: queue,
        supabaseManager: supabase,
        currentMeshId: 'tile_102_200',
        lastProcessedLat: 34.6,
        lastProcessedLng: 135.6,
        scoreUpdates: 0,
        updateScoreUI() {
            this.scoreUpdates += 1;
        }
    };
}

/* ------------------------------------------------------------------ *
 * 1. マスタースイッチ（CONFIG.ENABLE_DEBUG_TOOLS）による遮断
 * ------------------------------------------------------------------ */
test('遮断: ENABLE_DEBUG_TOOLS=false では仮想散歩もリセットも無効', async () => {
    const app = createApp({ debugEnabled: false });

    assert.equal(DebugTools.isEnabled(app), false);
    assert.equal(DebugTools.isVirtualWalking(app), false, 'D-PADが有効に見えてはいけない');

    const res = await DebugTools.resetTerritories(app);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'debug-disabled');
    assert.equal(app.gridManager.claimedTilesCache.size, 3, 'ローカル陣地は消さない');
    assert.equal(app.gridManager.cleared, false);
    assert.equal(app.syncQueue.entries.length, 2, 'Outboxも消さない');
    assert.equal(app.supabaseManager.calls.length, 0, 'サーバー削除も呼ばない');
});

test('遮断: DEBUG: OFF のあいだは D-Pad の仮想移動を無効とする', () => {
    const app = createApp({ isDebugMode: false });
    assert.equal(DebugTools.isEnabled(app), true);
    assert.equal(DebugTools.isVirtualWalking(app), false);

    app.isDebugMode = true;
    assert.equal(DebugTools.isVirtualWalking(app), true);
});

/* ------------------------------------------------------------------ *
 * 2. D-Pad 1歩の座標計算（グリッド1マス分＝index が必ず1つ進む）
 * ------------------------------------------------------------------ */
test('D-Pad: 1歩でマスのindexがちょうど1つ進み、緯度経度は5桁に丸まる', () => {
    const start = [34.6662, 135.6276];

    [[LAT_GRID, 0], [-LAT_GRID, 0], [0, LNG_GRID], [0, -LNG_GRID]].forEach(([dLat, dLng]) => {
        const next = DebugTools.stepPosition(start, dLat, dLng);
        assert.equal(next.length, 2);
        next.forEach((v) => {
            assert.equal(Math.round(v * 1e5) / 1e5, v, '5桁精度に丸める');
        });

        const before = {
            lat: Math.floor(start[0] / LAT_GRID),
            lng: Math.floor(start[1] / LNG_GRID)
        };
        const after = {
            lat: Math.floor(next[0] / LAT_GRID),
            lng: Math.floor(next[1] / LNG_GRID)
        };
        const moved = Math.abs(after.lat - before.lat) + Math.abs(after.lng - before.lng);
        assert.equal(moved, 1, `1歩で1マスだけ動く (${JSON.stringify(next)})`);
    });
});

test('D-Pad: 4歩進めても1歩ずつ別マスを塗れる（丸め誤差で同じマスに留まらない）', () => {
    let pos = [34.6662, 135.6276];
    const meshes = new Set();
    const meshId = (p) => `${Math.floor(p[0] / LAT_GRID)}_${Math.floor(p[1] / LNG_GRID)}`;
    meshes.add(meshId(pos));
    for (let i = 0; i < 4; i++) {
        pos = DebugTools.stepPosition(pos, LAT_GRID, 0);
        meshes.add(meshId(pos));
    }
    assert.equal(meshes.size, 5, '開始地点＋4歩＝5マスすべて別ID');
});

/* ------------------------------------------------------------------ *
 * 3. 全陣地リセット（確認ダイアログ・ローカル・サーバー）
 * ------------------------------------------------------------------ */
test('リセット: 確認ダイアログでキャンセルすると何も変更しない', async () => {
    const app = createApp();
    let message = '';
    const res = await DebugTools.resetTerritories(app, {
        confirmFn: (msg) => { message = msg; return false; }
    });

    assert.equal(res.canceled, true);
    assert.equal(res.ok, false);
    assert.equal(app.gridManager.claimedTilesCache.size, 3, 'ローカル陣地は残る');
    assert.equal(app.gridManager.cleared, false);
    assert.equal(app.syncQueue.entries.length, 2, 'Outboxは残る');
    assert.equal(app.supabaseManager.calls.length, 0, 'サーバー削除は呼ばない');
    assert.match(message, /全陣地を白紙リセット/, '確認文言が出る');
    assert.match(message, /元に戻せません/, '取り返しがつかないことを明示');
});

test('リセット: 確認するとローカル全消し・当週サーバー削除・戦績UI更新まで行う', async () => {
    const app = createApp();
    let asked = 0;
    const res = await DebugTools.resetTerritories(app, {
        confirmFn: (msg) => { asked += 1; assert.match(msg, /2026-W46/); return true; }
    });

    assert.equal(asked, 1, '確認は1回だけ');
    assert.equal(res.ok, true);
    assert.equal(res.weekId, WEEK);
    assert.equal(res.localCleared, 3);
    assert.equal(res.outboxCleared, 2);
    assert.equal(app.gridManager.claimedTilesCache.size, 0, '地図の全マスが白紙');
    assert.deepEqual(app.gridManager.savedToStorage, [], '保存データも空');
    assert.equal(app.syncQueue.entries.length, 0, 'Outboxも空');
    assert.equal(app.currentMeshId, null, '現在地点判定をリセット');
    assert.equal(app.lastProcessedLat, null);
    assert.equal(app.scoreUpdates, 1, 'スコアUIを再計算');

    assert.equal(app.supabaseManager.calls.length, 1);
    const call = app.supabaseManager.calls[0];
    assert.equal(call.weekId, WEEK, '当週だけを対象にする');
    assert.deepEqual(
        [...call.ids].sort(),
        ['tile_100_200', 'tile_101_200', 'tile_102_200', 'tile_199_999'],
        'ローカル陣地＋Outboxの和集合を削除対象にする'
    );
    assert.equal(res.serverDeleted, 4);

    // 削除直後の再マージ防止ガードが張られている
    assert.ok(app.territoryReset, 'territoryReset が記録される');
    assert.ok(app.territoryReset.ids.has('tile_100_200'));
});

test('リセット: サーバー削除が失敗してもローカル白紙化は成立し、失敗を結果に残す', async () => {
    const supabase = createSupabase({
        result: { success: false, error: { message: 'permission denied for table territory_tiles' } }
    });
    const app = createApp({ supabaseManager: supabase });

    const res = await DebugTools.resetTerritories(app, { confirmFn: () => true });

    assert.equal(res.ok, true, 'ローカルは成功');
    assert.equal(app.gridManager.claimedTilesCache.size, 0);
    assert.equal(res.serverDeleted, 0);
    assert.match(res.serverError, /permission denied/);
});

test('リセット: オフライン（Supabaseクライアント無し）ではサーバー削除をスキップして明示する', async () => {
    const app = createApp({ supabaseManager: createSupabase({ client: null }) });

    const res = await DebugTools.resetTerritories(app, { confirmFn: () => true });

    assert.equal(res.ok, true);
    assert.equal(res.serverSkipped, true);
    assert.equal(app.supabaseManager.calls.length, 0, 'オフライン時はAPIを叩かない');
    assert.equal(app.gridManager.claimedTilesCache.size, 0);
});

test('リセット: 陣地が0件でも安全に完了する', async () => {
    const app = createApp({
        gridManager: createGrid({ tiles: [] }),
        syncQueue: createQueue({ pending: [] })
    });
    const res = await DebugTools.resetTerritories(app, { confirmFn: () => true });

    assert.equal(res.ok, true);
    assert.equal(res.localCleared, 0);
    assert.equal(res.serverDeleted, 0);
});

test('リセット: localStorageのキー名がOutboxのキューと一致している', () => {
    assert.equal(DEBUG_RESET_STORAGE_KEYS.outbox, 'pending_tile_queue');
    assert.equal(DEBUG_RESET_STORAGE_KEYS.tiles, 'territory_claimed_tiles');
    const outbox = fs.readFileSync(path.join(ROOT, 'outbox.js'), 'utf8');
    assert.match(outbox, /TW_OUTBOX_KEY = 'pending_tile_queue'/);
    const grid = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    assert.match(grid, /localStorage\.getItem\('territory_claimed_tiles'\)/);
});

test('D-Pad: 1マスごとの送信ではトーストを出さず、まとめて再送のときだけ知らせる', () => {
    const { TileSyncQueue } = require(path.join(ROOT, 'outbox.js'));
    const toasts = [];
    const queue = new TileSyncQueue({ showToast: (a, b) => toasts.push([a, b]) });

    queue.afterFlush(1, 0, 'tile-claim');
    assert.equal(toasts.length, 0, 'D-Padの連打・通常歩行では毎回通知しない');

    queue.afterFlush(3, 0, 'startup');
    assert.equal(toasts.length, 1, '起動時のまとめて再送は知らせる');
    assert.match(toasts[0][0], /3 マスを同期/);
});

/* ------------------------------------------------------------------ *
 * 4. 配線の回帰チェック（app.js / index.html / build.js / www）
 * ------------------------------------------------------------------ */
test('配線: app.js が仮想散歩中に実GPSで座標を上書きしない（D-Pad塗りの要）', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    assert.match(app, /isVirtualWalkActive\(\)\s*\{/, '仮想散歩中判定がある');
    assert.match(app, /if \(this\.isVirtualWalkActive\(\)\) \{\s*this\.updateGPSStatus\('GPS: 仮想散歩中'[\s\S]*?return;/, 'handlePositionUpdate が早期リターンする');
    assert.match(app, /DebugTools\.stepPosition\(this\.virtualPos/, 'D-Padはステップ計算を共有する');
    assert.match(app, /await this\.processMeshAndClaim\(this\.virtualPos\[0\], this\.virtualPos\[1\]\)/, 'D-Padは通常歩行と同じ塗りパイプラインを通す');
    assert.match(app, /this\.updateDpadStatus\(/, '1歩ごとの結果を表示する');
});

test('配線: デバッグ操作（D-Pad・リセット）は ENABLE_DEBUG_TOOLS=false で早期リターンする', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    // リセットハンドラとリセット本体の双方にガードがある
    assert.match(app, /btn-debug-reset-territories'\);\s*if \(btnDebugResetTerritories\) \{\s*btnDebugResetTerritories\.addEventListener\('click', \(e\) => \{\s*e\.preventDefault\(\);\s*if \(!this\.debugEnabled\) return;/);
    assert.match(app, /async resetAllTerritories\(\) \{\s*if \(!this\.debugEnabled\) return;/);
    assert.match(app, /const moveVirtual = async \(dLat, dLng\) => \{\s*\/\/ デバッグ無効[^\n]*\n\s*if \(!this\.isVirtualWalkActive\(\)\) return;/);
    assert.match(app, /if \(!this\.debugEnabled\) \{\s*const dpad = document\.getElementById\('dpad-container'\);\s*if \(dpad\) dpad\.classList\.add\('hidden'\);\s*return;/, 'initDPad も遮断する');
});

test('UI: デバッグ欄にリセットボタンとD-Pad状態表示があり、debug-tools.jsを読み込む', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    assert.match(html, /id="btn-debug-reset-territories"/);
    assert.match(html, /全陣地を白紙リセット/);
    assert.match(html, /id="dpad-status"/);
    assert.match(html, /debug-tools\.js\?v=\d{8}v\d+/);

    // リセットボタンはデバッグモード欄（details#debug-mode-section）の中にある
    const section = html.slice(html.indexOf('id="debug-mode-section"'));
    const end = section.indexOf('</details>');
    assert.ok(section.slice(0, end).includes('btn-debug-reset-territories'), 'デバッグ欄の中に配置');
});

test('ビルド: www/ に debug-tools.js が同期されている（iOS側も同じ内容）', () => {
    const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build.js'), 'utf8');
    assert.match(build, /'debug-tools\.js'/, 'ASSETS_TO_COPY に含める');

    const rootFile = fs.readFileSync(path.join(ROOT, 'debug-tools.js'), 'utf8');
    const wwwFile = path.join(ROOT, 'www', 'debug-tools.js');
    assert.ok(fs.existsSync(wwwFile), 'www/debug-tools.js が存在する');
    assert.equal(fs.readFileSync(wwwFile, 'utf8'), rootFile, 'www側と同一内容');
});

test('配線: リセット直後のリモート再マージを grid.js が抑止する', () => {
    const grid = fs.readFileSync(path.join(ROOT, 'grid.js'), 'utf8');
    assert.match(grid, /isRecentlyReset\(tileId\)/, '判定メソッドがある');
    assert.match(grid, /if \(this\.isRecentlyReset\(tile\.tile_id\)\) return;/, 'マージループでスキップする');
    assert.match(grid, /app\.territoryReset/, 'app側の記録を参照する');
});
