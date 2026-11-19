/**
 * TERRITORY WALK - Node tests
 * v1.1 Phase 1: Apple Watch（コンパニオン）連携のJS側
 *   1) 窓データの組み立て（一辺 n / 現在地の位置 / n*n のマス文字列）
 *   2) マスの色は iPhone と同じ解決（初期配置も実績も同じ）＝ Watchで歩いた跡が浮かない
 *   3) Watchからのマーキング ON/OFF は既存の setMarkingPaused を呼ぶだけ
 *      （Watch の marking と iPhone の paused は真逆なので反転して渡す・2026-11-19 修正）
 *   4) プラグインが無い環境（Web・未対応ビルド）では落ちずに何もしない
 *   5) 陣地獲得の連打は1秒に1回へ間引く
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
    WATCH_WINDOW_SIDES,
    WATCH_SEND_THROTTLE_MS,
    WATCH_INIT_RETRY_MS,
    buildWatchWindow,
    WatchBridgeClient
} = require(path.join(ROOT, 'watch-bridge.js'));

const LAT_GRID = 0.0009;
const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);

/** 指定座標の窓を作る（resolveTeam は常に white） */
function constantResolver(team) {
    return () => team;
}

test('窓データ: 一辺5 / 9 / 15 と現在地の位置が決まる', () => {
    const grid = { latStep: LAT_GRID, lngStep: LNG_GRID };
    const center = { lat: 35.65, lng: 139.70 };
    [5, 9, 15].forEach((side) => {
        const window = buildWatchWindow(center, side, constantResolver('white'), grid);
        assert.equal(window.n, side);
        assert.equal(window.g.length, side * side);
        assert.equal(window.you.length, 2);
        assert.equal(window.you[0], Math.floor(side / 2));
        assert.equal(window.you[1], Math.floor(side / 2));

        // 現在地のマスが窓の中央に来る
        const latIdx = Math.floor(center.lat / LAT_GRID);
        const lngIdx = Math.floor(center.lng / LNG_GRID);
        assert.equal(window.la + window.you[0], latIdx);
        assert.equal(window.lo + window.you[1], lngIdx);
    });
});

test('窓データ: マスの色は 1=白 / 2=黒 の1文字で並ぶ', () => {
    const grid = { latStep: LAT_GRID, lngStep: LNG_GRID };
    const center = { lat: 35.65, lng: 139.70 };
    const window = buildWatchWindow(center, 5, constantResolver('black'), grid);
    assert.equal(window.g, '2'.repeat(25));
    const white = buildWatchWindow(center, 5, constantResolver('white'), grid);
    assert.equal(white.g, '1'.repeat(25));
});

test('窓データ: 幅の指定が壊れていても 9x9 に落ちる', () => {
    const grid = { latStep: LAT_GRID, lngStep: LNG_GRID };
    const center = { lat: 35.65, lng: 139.70 };
    assert.equal(buildWatchWindow(center, 0, constantResolver('white'), grid).n, 9);
    assert.equal(buildWatchWindow(center, 'x', constantResolver('white'), grid).n, 9);
    assert.equal(WATCH_WINDOW_SIDES[2], 5);
    assert.equal(WATCH_WINDOW_SIDES[4], 9);
    assert.equal(WATCH_WINDOW_SIDES[7], 15);
});

function createAppStub() {
    const grid = {
        LAT_GRID,
        LNG_GRID,
        getMeshId: (latIdx, lngIdx) => `tile_${latIdx}_${lngIdx}`,
        resolveTileTeam: (meshId, latIdx, lngIdx) => (latIdx === 2 && lngIdx === 2 ? 'white' : 'black')
    };
    const app = {
        gridManager: grid,
        virtualPos: [2.5 * LAT_GRID, 2.5 * LNG_GRID],
        currentTeam: 'black',
        markingPaused: false,
        calls: [],
        isMarkingPaused() { return this.markingPaused === true; },
        setMarkingPaused(next) { this.calls.push(next); this.markingPaused = next; return true; },
        syncQueue: {
            entries: [],
            enqueue(entry) { this.entries.push(entry); },
            flush() { this.flushes = (this.flushes || 0) + 1; return Promise.resolve({}); }
        }
    };
    return app;
}

test('送信内容: iPhoneと同じ解決でマスの色を作る', () => {
    const app = createAppStub();
    const client = new WatchBridgeClient(app);
    const payload = client.buildPayload();
    assert.ok(payload);
    assert.equal(payload.n, 9);
    assert.equal(payload.marking, true);
    // 中央のマス（現在地）だけ白、ほかは黒
    const centerIndex = 4 * 9 + 4;
    assert.equal(payload.g[centerIndex], '1');
    assert.equal(payload.g[0], '2');
    assert.equal(payload.v, 1);
});

test('送信内容: マーキング停止中は marking=false', () => {
    const app = createAppStub();
    app.markingPaused = true;
    const client = new WatchBridgeClient(app);
    assert.equal(client.buildPayload().marking, false);
});

test('Watch操作: ON/OFF は既存の setMarkingPaused に委ねる（Watchの marking と iPhoneの paused は真逆）', () => {
    const app = createAppStub();
    const client = new WatchBridgeClient(app);
    // 停止中に Watch で ON を押す: to=true（マーキングON）→ paused=false（再開）
    app.markingPaused = true;
    client.handleCommand({ cmd: 'toggle', to: true });
    assert.deepEqual(app.calls, [false], 'ON は paused=false で渡す');
    assert.equal(app.markingPaused, false, '押したとおり ON になる');

    // ON のときに Watch で停止を押す: to=false（停止）→ paused=true（停止）
    client.handleCommand({ cmd: 'toggle', to: false });
    assert.deepEqual(app.calls, [false, true], '停止は paused=true で渡す');
    assert.equal(app.markingPaused, true, '押したとおり停止になる');
});

test('Watch操作: ON を押すと Watch に戻る marking も ON になる（真逆にならない）', () => {
    const app = createAppStub();
    const client = new WatchBridgeClient(app);
    app.markingPaused = true;                       // 停止中
    client.handleCommand({ cmd: 'toggle', to: true }); // ON を押す
    assert.equal(app.markingPaused, false);
    assert.equal(client.buildPayload().marking, true, 'Watch に ON が返る');

    client.handleCommand({ cmd: 'toggle', to: false }); // もう一度押して停止
    assert.equal(app.markingPaused, true);
    assert.equal(client.buildPayload().marking, false, 'Watch に停止が返る');
});

test('Watch操作: to が無いときは現在の状態を反転する', () => {
    const app = createAppStub();
    const client = new WatchBridgeClient(app);
    client.handleCommand({ cmd: 'toggle' });
    assert.deepEqual(app.calls, [true], 'ON のまま → 停止');
    client.handleCommand({ cmd: 'toggle' });
    assert.deepEqual(app.calls, [true, false], '停止 → ON');
});

test('Watch操作: ズーム要求で窓の一辺が変わる', () => {
    const app = createAppStub();
    const client = new WatchBridgeClient(app);
    client.handleCommand({ cmd: 'window', r: 2 });
    assert.equal(client.side, 5);
    client.handleCommand({ cmd: 'window', r: 7 });
    assert.equal(client.side, 15);
});

test('未対応環境: プラグインが無ければ send / init は false で落ちない', () => {
    const app = createAppStub();
    const client = new WatchBridgeClient(app);
    assert.equal(client.available(), false);
    assert.equal(client.init(), false);
    assert.equal(client.send('init'), false);
    assert.equal(client.notifyCapture('claim'), false);
});

test('プラグインあり: init で状態を1回送り、command を購読する', () => {
    const sent = [];
    let listener = null;
    const plugin = {
        updateState: async (payload) => { sent.push(payload); },
        addListener: (name, handler) => { if (name === 'command') listener = handler; },
        drainInbox: async () => ({ items: [] })
    };
    global.window = { Capacitor: { Plugins: { WatchBridge: plugin } } };
    try {
        const app = createAppStub();
        const client = new WatchBridgeClient(app);
        assert.equal(client.init(), true);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].n, 9);

        // WatchからのON/OFFがJSまで届く（to=true＝ON → paused=false）
        assert.equal(typeof listener, 'function');
        listener({ cmd: 'toggle', to: true });
        assert.deepEqual(app.calls, [false]);
        assert.equal(app.markingPaused, false);
    } finally {
        delete global.window;
    }
});

test('送信: 陣地獲得の連打は1秒に1回へ間引く', () => {
    const sent = [];
    const plugin = { updateState: async (payload) => { sent.push(payload); } };
    global.window = { Capacitor: { Plugins: { WatchBridge: plugin } } };
    try {
        const app = createAppStub();
        const client = new WatchBridgeClient(app);
        assert.equal(client.send('claim'), true);
        assert.equal(client.send('claim'), false, '1秒以内の2回目は送らない');
        assert.equal(sent.length, 1);
    } finally {
        delete global.window;
    }
});

test('受信: Watchの記録を既存の送信キューへ流し込む', async () => {
    const plugin = {
        drainInbox: async () => ({
            items: [[
                { t: 'tile_1_1', la: 1, lo: 1, w: '2026-W47', at: 1 },
                { t: 'tile_1_2', la: 1, lo: 2, w: '2026-W47', at: 2 }
            ]]
        })
    };
    global.window = { Capacitor: { Plugins: { WatchBridge: plugin } } };
    try {
        const app = createAppStub();
        const client = new WatchBridgeClient(app);
        const queued = await client.drainInbox();
        assert.equal(queued, 2);
        assert.deepEqual(app.syncQueue.entries.map((e) => e.meshId), ['tile_1_1', 'tile_1_2']);
        assert.equal(app.syncQueue.flushes, 1);
    } finally {
        delete global.window;
    }
});

test('送信: sync / foreground は間引きを無視して必ず送る（Watchが古いまま固まらない）', () => {
    const sent = [];
    const plugin = { updateState: async (payload) => { sent.push(payload); } };
    global.window = { Capacitor: { Plugins: { WatchBridge: plugin } } };
    try {
        const app = createAppStub();
        const client = new WatchBridgeClient(app);
        assert.equal(client.send('claim'), true);
        // 直後でも force なら通る
        assert.equal(client.send('sync', { force: true }), true);
        assert.equal(client.send('foreground', { force: true }), true);
        assert.equal(sent.length, 3);
    } finally {
        delete global.window;
    }
});

test('送信: 歩行中の位置更新は2秒に1回へ間引く', () => {
    const sent = [];
    const plugin = { updateState: async (payload) => { sent.push(payload); } };
    global.window = { Capacitor: { Plugins: { WatchBridge: plugin } } };
    try {
        const app = createAppStub();
        const client = new WatchBridgeClient(app);
        assert.equal(client.send('position'), true);
        assert.equal(client.send('position'), false, '2秒以内の2回目は送らない');
        assert.equal(client.pending, 'position', '保留分は次の送信で送る');
        assert.equal(client.flushPending(), true);
        assert.equal(sent.length, 2);
    } finally {
        delete global.window;
    }
});

test('Watch操作: sync 要求（cmd=sync）で即座に状態を送り直す', () => {
    const sent = [];
    let listener = null;
    const plugin = {
        updateState: async (payload) => { sent.push(payload); },
        addListener: (name, handler) => { if (name === 'command') listener = handler; },
        drainInbox: async () => ({ items: [] })
    };
    global.window = { Capacitor: { Plugins: { WatchBridge: plugin } } };
    try {
        const app = createAppStub();
        const client = new WatchBridgeClient(app);
        client.init();
        assert.equal(sent.length, 1);
        listener({ cmd: 'sync' });
        assert.equal(sent.length, 2, '1秒以内でも sync は必ず返す');
    } finally {
        delete global.window;
    }
});

test('復帰: onForeground は購読を張り直して強制送信する', () => {
    const sent = [];
    const plugin = { updateState: async (payload) => { sent.push(payload); } };
    global.window = { Capacitor: { Plugins: { WatchBridge: plugin } } };
    try {
        const app = createAppStub();
        const client = new WatchBridgeClient(app);
        client.onForeground();
        assert.equal(client.started, true, '未初期化でも初期化される');
        assert.equal(sent.length >= 1, true);
    } finally {
        delete global.window;
    }
});

test('未対応環境: プラグインが後から生えても取りこぼさない（init は再試行を予約する）', () => {
    const app = createAppStub();
    const client = new WatchBridgeClient(app);
    assert.equal(client.init(), false);
    assert.equal(client.started, true);
    const scheduled = client.initRetryTimer != null || client.initRetryIndex > 0;
    assert.equal(scheduled, true, 'プラグイン未登録でも初期化をあきらめない');
    if (client.initRetryTimer) clearTimeout(client.initRetryTimer);
    if (client.timer) clearInterval(client.timer);
    assert.ok(WATCH_SEND_THROTTLE_MS.position > WATCH_SEND_THROTTLE_MS.claim, '位置は陣地より緩く間引く');
    assert.ok(WATCH_INIT_RETRY_MS.length >= 2);
});

test('配線: index.html と build.js が watch-bridge.js を配布物に含める', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /watch-bridge\.js\?v=/, 'index.html で読み込む');
    const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build.js'), 'utf8');
    assert.match(build, /'watch-bridge\.js'/, 'www/ へコピーする');
});
