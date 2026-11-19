/**
 * TERRITORY WALK - Node tests
 * 週次バトルの見える化（5点改修の 1〜3）
 *   1) 画面上部％バー（#battle-bar-container）はタップ可能で、専用モーダルを開く
 *   2) 「今週の戦況詳細」は当週の territory_weekly_rankings から参加人数を集計する
 *   3) 過去週のバトル履歴（#container-battle-history）を週ごとに描画する
 *   4) 通算戦績はサーバーの過去週実績から算出し、ローカル加算の二重計上を防ぐ
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { APP_SOURCE_FILES, readAppFile } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');
const STATS_SOURCE = fs.readFileSync(path.join(ROOT, 'stats.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const WWW_HTML = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');

const ME = 'user-me';

/* ------------------------------------------------------------------ *
 * localStorage / vm のスタブ
 * ------------------------------------------------------------------ */
function createStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; }
    };
}

function createStats(initial = {}) {
    const storage = createStorage(initial);
    const sandbox = {
        localStorage: storage,
        crypto: { randomUUID: () => ME },
        setInterval: () => 0,
        clearInterval: () => {},
        console: { log() {}, warn() {}, error() {} }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(`${STATS_SOURCE}\n;globalThis.__StatsManager = StatsManager;`, context, { filename: 'stats.js' });
    const StatsManager = context.__StatsManager;
    const manager = new StatsManager(null, null);
    return { StatsManager, manager, storage };
}

/** vm 越しの値を素のオブジェクトにする（deepEqual 用） */
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * Supabase クライアントの最小スタブ（フィルタを適用して行を返す）
 * ------------------------------------------------------------------ */
function createClient(tables = {}) {
    const calls = [];
    const applyFilters = (rows, filters) => rows.filter((row) => filters.every(([op, col, value]) => {
        const current = row[col];
        if (op === 'eq') return current === value;
        if (op === 'gt') return Number(current) > Number(value);
        if (op === 'lt') return String(current) < String(value);
        if (op === 'in') return value.includes(current);
        return true;
    }));

    const from = (table) => {
        const state = { table, filters: [], limit: null };
        const query = {
            select() { return query; },
            eq(col, value) { state.filters.push(['eq', col, value]); return query; },
            gt(col, value) { state.filters.push(['gt', col, value]); return query; },
            lt(col, value) { state.filters.push(['lt', col, value]); return query; },
            in(col, values) { state.filters.push(['in', col, values]); return query; },
            order() { return query; },
            limit(rows) { state.limit = Number(rows) || null; return query; },
            then(resolve, reject) {
                try {
                    calls.push({ table, filters: state.filters.map((f) => [...f]) });
                    let rows = applyFilters(tables[table] || [], state.filters);
                    if (state.limit) rows = rows.slice(0, state.limit);
                    resolve({ data: plain(rows), error: null });
                } catch (e) {
                    if (reject) reject(e);
                }
            }
        };
        return query;
    };
    return { client: { from }, calls };
}

const CURRENT_WEEK = '2026-W47';

function createManagerWithClient(tables, options = {}) {
    const { StatsManager, manager, storage } = createStats();
    const { client, calls } = createClient(tables);
    manager.supabaseManager = {
        client,
        getCurrentWeekId: () => CURRENT_WEEK
    };
    manager.userId = options.userId || ME;
    return { StatsManager, manager, storage, calls };
}

/* ------------------------------------------------------------------ *
 * 1. 純関数: 週ID・週の集計
 * ------------------------------------------------------------------ */

test('週ID: 1週前を返す（年またぎは前年W52）', () => {
    const { StatsManager } = createStats();
    assert.equal(StatsManager.previousWeekId('2026-W47'), '2026-W46');
    assert.equal(StatsManager.previousWeekId('2026-W01'), '2025-W52');
    assert.equal(StatsManager.previousWeekId('bad'), null);
});

test('週ID: 当週より前の週を新しい順に必要数だけ並べる', () => {
    const { StatsManager } = createStats();
    assert.deepEqual(
        plain(StatsManager.weekIdsBefore('2026-W47', 3)),
        ['2026-W46', '2026-W45', '2026-W44']
    );
    assert.deepEqual(
        plain(StatsManager.weekIdsBefore('2026-W02', 3)),
        ['2026-W01', '2025-W52', '2025-W51']
    );
});

test('集計: 黒白の合計マス・実参加人数・自分の勝敗を1週分にまとめる', () => {
    const { StatsManager } = createStats();
    const week = StatsManager.summarizeBattleWeek('2026-W46', [
        { user_id: 'a', team: 'black', tiles_count: 300 },
        { user_id: 'b', team: 'black', tiles_count: 100 },
        { user_id: ME, team: 'black', tiles_count: 50 },
        { user_id: 'c', team: 'white', tiles_count: 200 },
        { user_id: 'd', team: 'white', tiles_count: 0 }
    ], ME);

    assert.equal(week.blackTotal, 450);
    assert.equal(week.whiteTotal, 200);
    assert.equal(week.blackPlayers, 3, 'tiles_count > 0 の実参加者だけ数える');
    assert.equal(week.whitePlayers, 1, '0マスの行は参加人数に入れない');
    assert.equal(week.playerTotal, 4);
    assert.equal(week.blackPct, 69);
    assert.equal(week.whitePct, 31);
    assert.equal(week.winnerTeam, 'black');
    assert.equal(week.myTiles, 50);
    assert.equal(week.myTeam, 'black');
    assert.equal(week.participated, true);
    assert.equal(week.outcome, 'win');
});

test('集計: 引き分け・未参加・敗北の判定', () => {
    const { StatsManager } = createStats();
    const draw = StatsManager.summarizeBattleWeek('2026-W45', [
        { user_id: ME, team: 'white', tiles_count: 10 },
        { user_id: 'x', team: 'black', tiles_count: 10 }
    ], ME);
    assert.equal(draw.winnerTeam, 'draw');
    assert.equal(draw.outcome, 'draw');

    const lose = StatsManager.summarizeBattleWeek('2026-W44', [
        { user_id: ME, team: 'white', tiles_count: 10 },
        { user_id: 'x', team: 'black', tiles_count: 90 }
    ], ME);
    assert.equal(lose.outcome, 'lose');

    const absent = StatsManager.summarizeBattleWeek('2026-W43', [
        { user_id: 'x', team: 'black', tiles_count: 90 },
        { user_id: 'y', team: 'white', tiles_count: 10 }
    ], ME);
    assert.equal(absent.participated, false);
    assert.equal(absent.outcome, 'none');
});

/* ------------------------------------------------------------------ *
 * 2. 今週の戦況詳細（参加人数）
 * ------------------------------------------------------------------ */

test('今週詳細: 当週の実参加者を黒白で数える（0マスは除く）', async () => {
    const { manager, calls } = createManagerWithClient({
        territory_weekly_rankings: [
            { week_id: CURRENT_WEEK, user_id: 'a', team: 'black', tiles_count: 12 },
            { week_id: CURRENT_WEEK, user_id: 'b', team: 'black', tiles_count: 3 },
            { week_id: CURRENT_WEEK, user_id: 'c', team: 'white', tiles_count: 7 },
            { week_id: CURRENT_WEEK, user_id: 'd', team: 'white', tiles_count: 0 },
            { week_id: '2026-W46', user_id: 'e', team: 'black', tiles_count: 99 }
        ]
    });

    const summary = await manager.getWeeklyBattleSummary(CURRENT_WEEK);
    assert.equal(summary.ok, true);
    assert.equal(summary.blackPlayers, 2);
    assert.equal(summary.whitePlayers, 1);
    assert.equal(summary.playerTotal, 3);
    assert.equal(summary.participantTiles, 22, '参加者の塗りマス合計（AI・自動分は含まない）');
    assert.equal(calls[0].table, 'territory_weekly_rankings');
    assert.ok(calls[0].filters.some(([op, col, value]) => op === 'eq' && col === 'week_id' && value === CURRENT_WEEK));
    assert.ok(calls[0].filters.some(([op, col]) => op === 'gt' && col === 'tiles_count'));
});

test('今週詳細: クライアントが無い・エラーのときは ok:false（画面はローカル集計へフォールバック）', async () => {
    const { manager } = createStats();
    assert.equal((await manager.getWeeklyBattleSummary(CURRENT_WEEK)).ok, false);

    const { manager: withClient } = createManagerWithClient({});
    withClient.supabaseManager.client = {
        from: () => ({
            select() { return this; },
            eq() { return this; },
            gt() { return this; },
            then(resolve) { resolve({ data: null, error: { message: 'boom' } }); }
        })
    };
    const failed = await withClient.getWeeklyBattleSummary(CURRENT_WEEK);
    assert.equal(failed.ok, false);
});

/* ------------------------------------------------------------------ *
 * 3. 過去週のバトル履歴と通算戦績
 * ------------------------------------------------------------------ */

test('履歴: 直近10週＋自分の参加週を週ごとに集計し、新しい順に返す', async () => {
    const { manager } = createManagerWithClient({
        territory_weekly_rankings: [
            { week_id: '2026-W46', user_id: ME, team: 'black', tiles_count: 120 },
            { week_id: '2026-W46', user_id: 'x', team: 'white', tiles_count: 80 },
            { week_id: '2026-W45', user_id: 'x', team: 'black', tiles_count: 50 },
            { week_id: '2026-W45', user_id: 'y', team: 'white', tiles_count: 50 },
            { week_id: '2026-W44', user_id: ME, team: 'white', tiles_count: 30 },
            { week_id: '2026-W44', user_id: 'x', team: 'black', tiles_count: 70 },
            { week_id: CURRENT_WEEK, user_id: ME, team: 'black', tiles_count: 5 }
        ]
    });

    const history = await manager.getBattleHistory({ weeks: 10 });
    assert.equal(history.ok, true);
    assert.deepEqual(plain(history.weeks.map((w) => w.weekId)), ['2026-W46', '2026-W45', '2026-W44'], '当週は含めない');
    assert.equal(history.weeks[0].winnerTeam, 'black');
    assert.equal(history.weeks[0].outcome, 'win');
    assert.equal(history.weeks[1].outcome, 'none', '参加していない週は未参加');
    assert.equal(history.weeks[2].outcome, 'lose');
    assert.deepEqual(plain(history.record), { won: 1, lost: 1, drawn: 0, played: 2 });
});

test('履歴: 表示は直近10週でも、通算戦績は自分が参加した全期間から数える', async () => {
    const rows = [];
    // 30週前まで、毎週 自分=黒 60 / 相手=白 40（＝全勝）で参加
    let week = '2026-W46';
    for (let i = 0; i < 30; i += 1) {
        rows.push({ week_id: week, user_id: ME, team: 'black', tiles_count: 60 });
        rows.push({ week_id: week, user_id: `rival-${i}`, team: 'white', tiles_count: 40 });
        const year = Number(week.slice(0, 4));
        const num = Number(week.slice(6));
        week = num > 1 ? `${year}-W${String(num - 1).padStart(2, '0')}` : `${year - 1}-W52`;
    }
    const { manager } = createManagerWithClient({ territory_weekly_rankings: rows });

    const history = await manager.getBattleHistory({ weeks: 10 });
    assert.equal(history.weeks.length, 10, '表示は直近10週まで');
    assert.equal(history.record.played, 30, '通算は全期間');
    assert.equal(history.record.won, 30);
});

test('履歴: 1リクエストの上限（1000行）に当たったら週ごとに取り直して集計する', async () => {
    const rows = [];
    ['2026-W46', '2026-W45'].forEach((week) => {
        for (let i = 0; i < 700; i += 1) {
            rows.push({ week_id: week, user_id: i === 0 ? ME : `p-${week}-${i}`, team: i === 0 ? 'black' : 'white', tiles_count: 1 });
        }
    });
    const { manager, calls } = createManagerWithClient({ territory_weekly_rankings: rows });

    const history = await manager.getBattleHistory({ weeks: 10 });
    assert.equal(history.ok, true);
    assert.deepEqual(plain(history.weeks.map((w) => [w.weekId, w.playerTotal])).sort().reverse(),
        [['2026-W46', 700], ['2026-W45', 700]], '週ごとに全行を数える（1000行で切れない）');
    assert.ok(calls.length >= 3, '上限に当たったら週ごとに追加の問い合わせをする');
});

test('履歴: 記録が無い週だけなら空配列（画面は「まだありません」）', async () => {
    const { manager } = createManagerWithClient({ territory_weekly_rankings: [] });
    const history = await manager.getBattleHistory({ weeks: 10 });
    assert.equal(history.ok, true);
    assert.deepEqual(plain(history.weeks), []);
    assert.equal(history.record.played, 0);
});

/* ------------------------------------------------------------------ *
 * 4. 通算戦績の同期と二重計上防止
 * ------------------------------------------------------------------ */

test('通算: サーバー実績を反映し、その後のローカル加算はしない', () => {
    const { manager, storage } = createStats({ tw_user_stats: JSON.stringify({ battles_won: 1, battles_lost: 0 }) });

    assert.equal(manager.applyBattleRecordFromServer({ won: 4, lost: 2, drawn: 1, played: 7 }), true);
    assert.equal(manager.stats.battles_won, 4);
    assert.equal(manager.stats.battles_lost, 2);
    assert.equal(manager.stats.battles_drawn, 1);
    assert.equal(JSON.parse(storage.data.tw_user_stats).battles_won, 4, '端末にも保存する');

    assert.equal(manager.recordBattleOutcome(true), false, 'サーバー集計済みなら加算しない（二重計上防止）');
    assert.equal(manager.stats.battles_won, 4);
});

test('通算: サーバーに参加記録が無いときはローカル値を消さない', () => {
    const { manager } = createStats({ tw_user_stats: JSON.stringify({ battles_won: 2, battles_lost: 1 }) });
    assert.equal(manager.applyBattleRecordFromServer({ won: 0, lost: 0, drawn: 0, played: 0 }), false);
    assert.equal(manager.stats.battles_won, 2);
    assert.equal(manager.stats.battles_lost, 1);
});

test('通算: サーバー実績が未取得のうちは従来どおりローカル加算する', () => {
    const { manager } = createStats();
    assert.equal(manager.recordBattleOutcome(true), true);
    assert.equal(manager.stats.battles_won, 1);
    assert.equal(manager.recordBattleOutcome(false), true);
    assert.equal(manager.stats.battles_lost, 1);
});

/* ------------------------------------------------------------------ *
 * 5. 画面（DOM 描画）
 * ------------------------------------------------------------------ */

function createElementStub() {
    return {
        _innerHTML: '',
        textContent: '',
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        setAttribute() {},
        getAttribute() { return null; },
        get innerHTML() { return this._innerHTML; },
        set innerHTML(value) { this._innerHTML = String(value); }
    };
}

function loadAppWithDom() {
    const elements = {
        'container-battle-history': createElementStub(),
        'stat-battles-record': createElementStub(),
        'battle-bar-container': createElementStub()
    };
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: {
            addEventListener() {},
            getElementById: (id) => elements[id] || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            visibilityState: 'visible'
        },
        window: {},
        localStorage: createStorage(),
        navigator: {},
        screen: {},
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    APP_SOURCE_FILES.forEach((file) => {
        vm.runInContext(readAppFile(file), context, { filename: file });
    });
    const app = vm.runInContext('Object.create(TerritoryWalkApp.prototype)', context);
    return { app, elements };
}

test('描画: 履歴カードに週・勝敗・黒白％・自分の結果が出る', () => {
    const { app, elements } = loadAppWithDom();
    app.renderBattleHistory({
        ok: true,
        weeks: [{
            weekId: '2026-W46', blackTotal: 560, whiteTotal: 440, blackPct: 56, whitePct: 44,
            winnerTeam: 'black', participated: true, myTeam: 'black', myTiles: 120, outcome: 'win'
        }]
    });
    const html = elements['container-battle-history'].innerHTML;
    assert.match(html, /2026-W46/);
    assert.match(html, /黒 勝利/);
    assert.match(html, /黒56% \/ 白44%/);
    assert.match(html, /黒 560 \/ 白 440 マス/);
    assert.match(html, /自分 黒 120マス・勝利/);
});

test('描画: 履歴が無ければ「過去のバトル履歴はまだありません」', () => {
    const { app, elements } = loadAppWithDom();
    app.renderBattleHistory({ ok: true, weeks: [] });
    assert.match(elements['container-battle-history'].innerHTML, /過去のバトル履歴はまだありません/);
});

test('描画: 取得できなかったときは案内文（落ちない）', () => {
    const { app, elements } = loadAppWithDom();
    app.renderBattleHistory(null);
    assert.match(elements['container-battle-history'].innerHTML, /取得できませんでした/);
});

test('描画: 通算戦績は引き分けがあるときだけ「○分」を添える', () => {
    const { app, elements } = loadAppWithDom();
    app.statsManager = { stats: { battles_won: 3, battles_lost: 2, battles_drawn: 0 } };
    app.renderBattleRecord();
    assert.equal(elements['stat-battles-record'].textContent, '3勝 2敗');

    app.statsManager.stats.battles_drawn = 4;
    app.renderBattleRecord();
    assert.equal(elements['stat-battles-record'].textContent, '3勝 2敗 4分');
});

/* ------------------------------------------------------------------ *
 * 6. 配線（HTML・モジュール）
 * ------------------------------------------------------------------ */

test('配線: 上部％バーはタップ可能（role/tabindex/cursor-pointer）', () => {
    const bar = /<div id="battle-bar-container"[^>]*>/.exec(HTML);
    assert.ok(bar, '％バーがある');
    assert.match(bar[0], /role="button"/);
    assert.match(bar[0], /tabindex="0"/);
    assert.match(bar[0], /cursor-pointer/);
    assert.match(bar[0], /aria-label="今週の戦況詳細を開く"/);
    assert.match(WWW_HTML, /<div id="battle-bar-container"[^>]*cursor-pointer/, 'www/ にも反映');
});

test('配線: 今週の戦況詳細モーダルの要素が揃っている', () => {
    [
        'weekly-battle-modal', 'battle-detail-week', 'battle-detail-loading', 'battle-detail-content',
        'battle-detail-players-total', 'battle-detail-players-black', 'battle-detail-players-white',
        'battle-detail-tiles-total', 'battle-detail-tiles-black', 'battle-detail-tiles-white',
        'battle-detail-pct-black', 'battle-detail-pct-white', 'battle-detail-formula',
        'battle-detail-empty', 'btn-close-weekly-battle', 'btn-battle-detail-footer-close'
    ].forEach((id) => {
        assert.match(HTML, new RegExp(`id="${id}"`), `${id} がある`);
    });
    assert.match(HTML, /集計中\.\.\./, '読み込み中の表示');
    assert.match(HTML, /黒マス|黒 \d+マス ÷ 合計/, '計算式がひと目でわかる');
});

test('配線: ％バーのタップと戦績表示は app-battle.js が受け持つ', () => {
    const battle = readAppFile('app-battle.js');
    assert.match(battle, /^class TerritoryWalkAppBattle extends TerritoryWalkAppStats \{/m);
    ['initWeeklyBattleDetail', 'openWeeklyBattleDetail', 'renderWeeklyBattleDetail', 'loadBattleHistory', 'renderBattleHistory', 'renderBattleRecord']
        .forEach((name) => assert.match(battle, new RegExp(`^    (async )?${name}\\(`, 'm'), `${name} がある`));
    assert.match(readAppFile('app-core.js'), /this\.initWeeklyBattleDetail\(\);/, '起動時に配線する');
    assert.match(readAppFile('app-stats.js'), /this\.loadBattleHistory\(\);/, '戦績モーダルを開いたら履歴を読み直す');
    assert.match(readAppFile('app-battle.js'), /からタップ|openWeeklyBattleDetail/, '％バーのクリックで詳細を開く');
});
