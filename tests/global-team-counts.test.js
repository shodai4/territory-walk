/**
 * TERRITORY WALK - Node tests
 * 全国陣地％集計（上部％バー）:
 *   1) サーバー全体の黒・白マス数を HEAD + `Prefer: count=exact` で数え、
 *      Content-Range（"0-13/14" や "100-199/12345"）から総件数を読む
 *   2) オフライン・通信エラー・ヘッダー欠落は null（既存のローカル集計を壊さない）
 *   3) updateScoreUI は全国集計があればそれを使い、未取得時は claimedTilesCache で計算する
 *   4) 起動・地図移動・自分の塗り・Realtime・画面復帰・通信復帰で更新される（10秒スロットル）
 *   5) 週が変わったら前週の数字を引きずらない（月曜リセット）
 *   6) デバッグの白紙リセットで全国集計もリセットされる
 *   7) www/（Capacitor 配布物）にも同じ内容が反映されている
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readAppSource, readWwwAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = readAppSource();
const SUPABASE_SOURCE = fs.readFileSync(path.join(ROOT, 'supabase.js'), 'utf8');
const { SupabaseManager, parseContentRangeTotal, SUPABASE_URL } =
    require(path.join(ROOT, 'supabase.js'));

const WEEK = '2026-W47';
const TILE_ENDPOINT = `${SUPABASE_URL}/rest/v1/territory_tiles`;

/* ------------------------------------------------------------------ *
 * 1. Content-Range のパース
 * ------------------------------------------------------------------ */

test('Content-Range: 実データ形式（0-13/14）から総件数を読む', () => {
    assert.equal(parseContentRangeTotal('0-13/14'), 14);
    assert.equal(parseContentRangeTotal('*/123'), 123);
    assert.equal(parseContentRangeTotal('0-0/0'), 0);
    assert.equal(parseContentRangeTotal('0-99/12345'), 12345);
});

test('Content-Range: 件数不明・ヘッダー無し・壊れた値は null', () => {
    assert.equal(parseContentRangeTotal('0-0/*'), null);
    assert.equal(parseContentRangeTotal(''), null);
    assert.equal(parseContentRangeTotal(null), null);
    assert.equal(parseContentRangeTotal(undefined), null);
    assert.equal(parseContentRangeTotal('14'), null);
    assert.equal(parseContentRangeTotal('0-0/abc'), null);
});

/* ------------------------------------------------------------------ *
 * 2. SupabaseManager: 全国カウント取得
 * ------------------------------------------------------------------ */

/** fetch のスタブ。URL・メソッド・ヘッダーを記録し、team ごとに件数を返す */
function installFetchStub(options = {}) {
    const calls = [];
    const counts = options.counts || { black: 14, white: 16 };
    const queue = [];

    const respond = (url, request) => {
        if (options.onCall) {
            const custom = options.onCall(url, request);
            if (custom !== undefined) return custom;
        }
        const team = /team=eq\.(black|white)/.exec(url);
        const key = team ? team[1] : 'black';
        if (options.failTeam && options.failTeam === key) {
            return { ok: false, status: 500, headers: headerBag(null) };
        }
        return { ok: true, status: 200, headers: headerBag(`0-0/${counts[key]}`) };
    };

    global.fetch = async (url, request) => {
        calls.push({ url: String(url), request: request || {} });
        const next = respond(String(url), request || {});
        if (next && typeof next.then === 'function') return next;
        return next;
    };
    return { calls, queue };
}

function headerBag(contentRange) {
    return {
        get(name) {
            return String(name).toLowerCase() === 'content-range' ? contentRange : null;
        }
    };
}

function createSupabaseManager() {
    const manager = Object.create(SupabaseManager.prototype);
    manager.client = {};
    return manager;
}

test('全国カウント: 黒・白を HEAD + Prefer: count=exact で並列に取得する', async () => {
    const stub = installFetchStub();
    const manager = createSupabaseManager();

    const counts = await manager.fetchGlobalTeamCounts(WEEK);

    assert.deepEqual({ black: counts.black, white: counts.white }, { black: 14, white: 16 });
    assert.equal(counts.weekId, WEEK);
    assert.equal(stub.calls.length, 2, 'チームごとに1本ずつ（合計2本）');

    const urls = stub.calls.map((call) => call.url).sort();
    assert.ok(urls.some((url) => url.includes('team=eq.black')));
    assert.ok(urls.some((url) => url.includes('team=eq.white')));
    for (const call of stub.calls) {
        assert.equal(call.request.method, 'HEAD', 'HEAD なので行データは転送されない');
        assert.equal(call.request.headers.Prefer, 'count=exact');
        assert.ok(call.request.headers.apikey, 'anon キーを付ける');
        assert.ok(call.url.startsWith(TILE_ENDPOINT));
        assert.ok(call.url.includes(`week_id=eq.${WEEK}`), '当週のマスだけを数える');
    }
});

test('全国カウント: weekId に null を渡すと全期間（週フィルター無し）で数える', async () => {
    const stub = installFetchStub();
    const manager = createSupabaseManager();

    const counts = await manager.fetchGlobalTeamCounts(null);

    assert.equal(counts.weekId, null);
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls.every((call) => !call.url.includes('week_id')), '週の条件を付けない');
});

test('全国カウント: 通信エラー・HTTPエラー・ヘッダー欠落・オフラインは null', async () => {
    const manager = createSupabaseManager();

    global.fetch = async () => { throw new Error('network down'); };
    assert.equal(await manager.fetchGlobalTeamCounts(WEEK), null, 'fetch が例外 → null');

    installFetchStub({ failTeam: 'white' });
    assert.equal(await manager.fetchGlobalTeamCounts(WEEK), null, '片方が 500 → null');

    global.fetch = async () => ({ ok: true, status: 200, headers: headerBag(null) });
    assert.equal(await manager.fetchGlobalTeamCounts(WEEK), null, 'Content-Range が無い → null');

    installFetchStub();
    const offline = createSupabaseManager();
    offline.client = {};
    // Node の global.navigator は getter なので、defineProperty で差し替える
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
    try {
        assert.equal(await offline.fetchGlobalTeamCounts(WEEK), null, 'オフライン → null');
    } finally {
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
    }

    const noClient = Object.create(SupabaseManager.prototype);
    assert.equal(await noClient.fetchGlobalTeamCounts(WEEK), null, 'クライアント未初期化 → null');
});

/* ------------------------------------------------------------------ *
 * app.js を vm 上で動かすための最小スタブ
 * ------------------------------------------------------------------ */

function createStubElement(id) {
    return {
        id,
        textContent: '',
        style: {},
        classList: { add() {}, remove() {}, contains: () => false }
    };
}

function createStubDocument() {
    const elements = {
        'score-black': createStubElement('score-black'),
        'score-white': createStubElement('score-white'),
        'bar-black': createStubElement('bar-black'),
        'bar-white': createStubElement('bar-white')
    };
    return {
        elements,
        body: { dataset: {} },
        addEventListener() {},
        getElementById: (id) => elements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => []
    };
}

function loadApp(options = {}) {
    const doc = options.document || createStubDocument();
    const storage = options.storage || {};
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: doc,
        navigator: options.navigator || {},
        window: options.window || {},
        localStorage: {
            getItem: (key) => (key in storage ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; }
        },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {}
    };
    if (options.DebugTools) sandbox.DebugTools = options.DebugTools;
    const context = vm.createContext(sandbox);
    vm.runInContext(SUPABASE_SOURCE, context, { filename: 'supabase.js' });
    vm.runInContext(APP_SOURCE, context, { filename: 'app.js' });
    return { context, document: doc, storage, TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context) };
}

/** ％バーだけを動かす最小のアプリインスタンス */
function createScoreApp(options = {}) {
    const loaded = loadApp(options);
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    const doc = loaded.document;
    Object.assign(app, {
        currentTeam: 'black',
        debugEnabled: false,
        scoreBlackEl: doc.elements['score-black'],
        scoreWhiteEl: doc.elements['score-white'],
        barBlackEl: doc.elements['bar-black'],
        barWhiteEl: doc.elements['bar-white'],
        gridManager: {
            claimedTilesCache: new Map([
                ['a', 'black'], ['b', 'black'], ['c', 'white']
            ])
        },
        globalTeamCounts: { black: 0, white: 0, loaded: false, weekId: null, fetchedAt: 0 },
        globalCountsRequest: null,
        globalCountsLastRequestAt: 0
    });
    app.renderTeamBadge = () => {};
    app.updateTeamStatusUI = () => {};
    app.showToast = () => {};
    app.updateDpadStatus = () => {};
    return { app, loaded };
}

/* ------------------------------------------------------------------ *
 * 3. updateScoreUI が全国集計を使う
 * ------------------------------------------------------------------ */

test('％バー: 全国集計が取れていれば端末の読み込み範囲ではなく全国の黒・白で計算する', () => {
    const { app } = createScoreApp();
    // 端末は黒2・白1しか読んでいない（従来なら 67% / 33%）が、全国は 700 対 300
    app.globalTeamCounts = { black: 700, white: 300, loaded: true, weekId: WEEK, fetchedAt: 1 };

    app.updateScoreUI();

    assert.equal(app.scoreBlackEl.textContent, '70%');
    assert.equal(app.scoreWhiteEl.textContent, '30%');
    assert.equal(app.barBlackEl.style.width, '70%');
    assert.equal(app.barWhiteEl.style.width, '30%');
});

test('％バー: 全国集計が未取得・オフラインなら従来どおり claimedTilesCache で計算する', () => {
    const { app } = createScoreApp();
    app.globalTeamCounts = { black: 0, white: 0, loaded: false, weekId: null, fetchedAt: 0 };

    app.updateScoreUI();

    assert.equal(app.scoreBlackEl.textContent, '67%');
    assert.equal(app.scoreWhiteEl.textContent, '33%');
});

test('％バー: 片側が8%未満なら数字は出さず、バー幅だけ反映する（従来仕様の維持）', () => {
    const { app } = createScoreApp();
    app.globalTeamCounts = { black: 5, white: 95, loaded: true, weekId: WEEK, fetchedAt: 1 };

    app.updateScoreUI();

    assert.equal(app.scoreBlackEl.textContent, '');
    assert.equal(app.scoreWhiteEl.textContent, '95%');
    assert.equal(app.barBlackEl.style.width, '5%');
    assert.equal(app.barWhiteEl.style.width, '95%');
});

/* ------------------------------------------------------------------ *
 * 4. 取得のタイミング・スロットル・フォールバック
 * ------------------------------------------------------------------ */

test('全国集計の更新: 取得できれば loaded になり、10秒以内の再要求はスロットルで間引く', async () => {
    const { app } = createScoreApp();
    const calls = [];
    app.supabaseManager = {
        getCurrentWeekId: () => WEEK,
        fetchGlobalTeamCounts: async (weekId) => { calls.push(weekId); return { black: 40, white: 60, weekId }; }
    };

    const first = await app.refreshGlobalTeamCounts({ force: true });
    assert.deepEqual({ black: first.black, white: first.white }, { black: 40, white: 60 });
    assert.equal(app.globalTeamCounts.loaded, true);
    assert.equal(app.globalTeamCounts.weekId, WEEK);
    assert.equal(app.scoreBlackEl.textContent, '40%');
    assert.equal(app.scoreWhiteEl.textContent, '60%');

    await app.refreshGlobalTeamCounts();
    assert.equal(calls.length, 1, '10秒以内の連続呼び出しはサーバーを叩かない');

    await app.refreshGlobalTeamCounts({ force: true });
    assert.equal(calls.length, 2, 'force は即時に取り直す');
});

test('全国集計の更新: 通信エラーでは前回の数字を保持し、未取得ならローカル集計のまま', async () => {
    const { app } = createScoreApp();
    app.globalTeamCounts = { black: 70, white: 30, loaded: true, weekId: WEEK, fetchedAt: 1 };
    app.updateScoreUI();
    assert.equal(app.scoreBlackEl.textContent, '70%', '事前状態');
    app.supabaseManager = {
        getCurrentWeekId: () => WEEK,
        fetchGlobalTeamCounts: async () => null
    };

    await app.refreshGlobalTeamCounts({ force: true });

    assert.equal(app.globalTeamCounts.loaded, true, '一時的な失敗でローカル集計へ落として画面を揺らさない');
    assert.equal(app.scoreBlackEl.textContent, '70%');

    const { app: fresh } = createScoreApp();
    fresh.supabaseManager = { getCurrentWeekId: () => WEEK, fetchGlobalTeamCounts: async () => null };
    await fresh.refreshGlobalTeamCounts({ force: true });
    assert.equal(fresh.globalTeamCounts.loaded, false);
    fresh.updateScoreUI();
    assert.equal(fresh.scoreBlackEl.textContent, '67%', '未取得時はローカル集計');
});

test('全国集計の更新: 週が変わったら前週の数字を捨てて取り直す（月曜リセット）', async () => {
    const { app } = createScoreApp();
    let week = '2026-W46';
    app.supabaseManager = {
        getCurrentWeekId: () => week,
        fetchGlobalTeamCounts: async (weekId) => ({ black: 1, white: 1, weekId })
    };
    app.globalTeamCounts = { black: 900, white: 100, loaded: true, weekId: '2026-W46', fetchedAt: 1 };

    week = '2026-W47';
    await app.refreshGlobalTeamCounts({ force: true });

    assert.equal(app.globalTeamCounts.weekId, '2026-W47');
    assert.equal(app.globalTeamCounts.black, 1, '前週の 900 を持ち越さない');
});

test('全国集計の更新: オフライン中はサーバーを叩かず、既存の数字を保持する', async () => {
    const { app } = createScoreApp({ navigator: { onLine: false } });
    const calls = [];
    app.supabaseManager = {
        getCurrentWeekId: () => WEEK,
        fetchGlobalTeamCounts: async (weekId) => { calls.push(weekId); return { black: 1, white: 1, weekId }; }
    };

    const result = await app.refreshGlobalTeamCounts({ force: true });

    assert.equal(result, null);
    assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * 5. 自分の塗り・Realtime の即時反映（二重加算の防止）
 * ------------------------------------------------------------------ */

test('即時反映: 新規1マスは +1、相手からの奪取は自分 +1 / 相手 -1', () => {
    const { app } = createScoreApp();
    app.globalTeamCounts = { black: 100, white: 200, loaded: true, weekId: WEEK, fetchedAt: 1 };

    app.applyGlobalCountDelta('black', 1);
    app.applyGlobalCountDelta('white', 1);      // 奪取
    app.applyGlobalCountDelta('black', -1);

    assert.equal(app.globalTeamCounts.black, 100);
    assert.equal(app.globalTeamCounts.white, 201);
});

test('即時反映: 未取得時は何も変えない・0未満にしない', () => {
    const { app } = createScoreApp();
    app.globalTeamCounts = { black: 0, white: 0, loaded: false, weekId: null, fetchedAt: 0 };
    app.applyGlobalCountDelta('black', 5);
    assert.equal(app.globalTeamCounts.black, 0);

    app.globalTeamCounts = { black: 0, white: 3, loaded: true, weekId: WEEK, fetchedAt: 1 };
    app.applyGlobalCountDelta('black', -1);
    assert.equal(app.globalTeamCounts.black, 0, '0未満にならない');
});

test('Realtime: 他プレイヤーの塗り（前チーム→後チーム）を全国集計へ反映する', () => {
    const { app } = createScoreApp();
    app.globalTeamCounts = { black: 50, white: 50, loaded: true, weekId: WEEK, fetchedAt: 1 };

    app.applyRealtimeGlobalDelta('black', 'white');

    assert.equal(app.globalTeamCounts.black, 49);
    assert.equal(app.globalTeamCounts.white, 51);
});

/* ------------------------------------------------------------------ *
 * 6. デバッグの白紙リセット
 * ------------------------------------------------------------------ */

test('デバッグ白紙リセット: 全国集計も空に戻し、サーバーから取り直す', async () => {
    const refreshCalls = [];
    let resetCalled = 0;
    const loaded = loadApp({
        DebugTools: {
            async resetTerritories() {
                resetCalled += 1;
                return { ok: true, localCleared: 3, serverDeleted: 3 };
            }
        }
    });
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    Object.assign(app, {
        debugEnabled: true,
        currentTeam: 'black',
        gridManager: { updateGrids() {} },
        globalTeamCounts: { black: 500, white: 500, loaded: true, weekId: WEEK, fetchedAt: 1 },
        globalCountsLastRequestAt: Date.now()
    });
    app.showToast = () => {};
    app.updateScoreUI = () => {};
    app.updateDpadStatus = () => {};
    app.refreshGlobalTeamCounts = (options) => {
        refreshCalls.push(options && options.force);
        return Promise.resolve(null);
    };

    await app.resetAllTerritories();

    assert.equal(resetCalled, 1);
    assert.deepEqual(
        { black: app.globalTeamCounts.black, white: app.globalTeamCounts.white, loaded: app.globalTeamCounts.loaded },
        { black: 0, white: 0, loaded: false }
    );
    assert.deepEqual(refreshCalls, [true], 'リセット後は force で取り直す');
});

/* ------------------------------------------------------------------ *
 * 7. 配線（起動・地図移動・画面復帰・通信復帰）と www/ 同期
 * ------------------------------------------------------------------ */

test('配線: 起動/地図移動/自分の塗り/画面復帰/通信復帰で全国集計を更新する', () => {
    const loadRemote = APP_SOURCE.slice(APP_SOURCE.indexOf('async loadRemoteTiles()'));
    assert.match(loadRemote.slice(0, 400), /this\.refreshGlobalTeamCounts\(\)/,
        '起動・8秒ポーリング・地図移動は loadRemoteTiles 経由で更新する');

    assert.match(APP_SOURCE, /this\.refreshGlobalTeamCounts\(\{ force: true \}\)[\s\S]{0,200}?/,
        '画面復帰・通信復帰は force で更新する');
    assert.match(APP_SOURCE, /visibilitychange[\s\S]*?refreshGlobalTeamCounts\(\{ force: true \}\)/,
        'フォアグラウンド復帰で更新する');
    assert.match(APP_SOURCE, /addEventListener\('online'[\s\S]*?refreshGlobalTeamCounts\(\{ force: true \}\)/,
        '通信復帰で更新する');
    assert.match(APP_SOURCE, /applyGlobalCountDelta\(this\.currentTeam, 1\)/,
        '自分の塗りは即時反映する');
    assert.match(APP_SOURCE, /applyRealtimeGlobalDelta\(payload\.old/, 'Realtime 受信でも全国集計を動かす');
});

test('www/ 同期: 配布物にも同じ実装とキャッシュバスターが入っている', () => {
    const wwwApp = readWwwAppSource();
    const wwwSupabase = fs.readFileSync(path.join(ROOT, 'www', 'supabase.js'), 'utf8');
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const wwwIndex = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');

    assert.equal(wwwApp, APP_SOURCE, 'www/ の app 分割モジュールはルートと同一');
    assert.equal(wwwSupabase, SUPABASE_SOURCE, 'www/supabase.js は supabase.js と同一');
    assert.equal(wwwIndex, index, 'www/index.html は index.html と同一');

    const appVersion = /app\.js\?v=(\d{8}v\d+)/.exec(index);
    const supabaseVersion = /supabase\.js\?v=(\d{8}v\d+)/.exec(index);
    assert.ok(appVersion, 'app.js のキャッシュバスターがある');
    assert.ok(supabaseVersion, 'supabase.js のキャッシュバスターがある');
    assert.ok(appVersion[1] >= '20261117v58', 'app.js は今回の変更版に上がっている');
    assert.ok(supabaseVersion[1] >= '20261117v59', 'supabase.js は今回の変更版に上がっている');
});
