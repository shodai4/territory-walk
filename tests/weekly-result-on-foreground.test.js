/**
 * TERRITORY WALK - Node tests
 * 週明けの「先週の最終結果」モーダルを取りこぼさない。
 *
 *   1) 月曜0時をまたいだあと、バックグラウンドから戻ってきたら結果表を出す
 *      （起動時に1回だけ呼ばれていたため、復帰では発火しなかった件の修正）
 *   2) 同じ週で何度呼ばれてもモーダルは1枚だけ（重ねない）
 *   3) tw_last_seen_week が未設定でも、前週に対戦データがあれば出す
 *      （引き継ぎ・再インストール。ただし初回インストールのルール説明中は出さない）
 *   4) 週が変わっていない・前週に記録が無いときは出さない
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
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CURRENT_WEEK = '2026-W48';
const PREVIOUS_WEEK = '2026-W47';

function createStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; }
    };
}

function createClassList(initial = []) {
    const set = new Set(initial);
    return {
        set,
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        contains: (name) => set.has(name),
        toggle: (name, force) => {
            const on = typeof force === 'boolean' ? force : !set.has(name);
            if (on) set.add(name); else set.delete(name);
            return on;
        }
    };
}

function createElement(initialClasses = []) {
    return {
        textContent: '',
        innerHTML: '',
        style: {},
        dataset: {},
        classList: createClassList(initialClasses),
        addEventListener() {},
        setAttribute() {},
        getAttribute() { return null; }
    };
}

/**
 * アプリ本体を vm で読み、「週明けの結果表」だけを見られる状態にする。
 * showWeeklyResultModal は呼ばれた内容を記録するスタブに差し替える。
 */
function createApp(options = {}) {
    const storage = createStorage(options.storage || {});
    const elements = {
        'weekly-result-modal': createElement(options.modalOpen ? [] : ['hidden'])
    };
    const calls = [];
    const timers = [];

    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: {
            getElementById: (id) => elements[id] || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            visibilityState: 'visible'
        },
        window: {},
        localStorage: storage,
        navigator: {},
        screen: {},
        setTimeout: (fn) => { timers.push(fn); return 0; },
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        Date,
        JSON,
        Number,
        Math,
        String,
        Array,
        Object,
        Promise
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    APP_SOURCE_FILES.forEach((file) => {
        vm.runInContext(readAppFile(file), context, { filename: file });
    });

    const app = vm.runInContext('Object.create(TerritoryWalkApp.prototype)', context);
    app.showWeeklyResultModal = (isManual, targetWeek) => calls.push({ isManual, targetWeek });
    app.supabaseManager = { getCurrentWeekId: () => options.currentWeek || CURRENT_WEEK };
    app.statsManager = {
        getPreviousWeekResult: options.getPreviousWeekResult || (async () => null)
    };
    app.startupGate = { hasSeenRules: () => options.rulesSeen !== false };

    const flushTimers = () => {
        while (timers.length > 0) timers.shift()();
    };

    return { app, storage, calls, flushTimers };
}

/* ------------------------------------------------------------------ *
 * 1. 週跨ぎ（起動・復帰）
 * ------------------------------------------------------------------ */

test('週跨ぎ: 先週を見たまま今週になっていれば、先週の結果表を出す', async () => {
    const { app, calls, flushTimers } = createApp({ storage: { tw_last_seen_week: PREVIOUS_WEEK } });

    await app.checkWeeklyResetResult();
    flushTimers();

    assert.deepEqual(calls, [{ isManual: false, targetWeek: PREVIOUS_WEEK }]);
});

test('週跨ぎ: 同じ週で何度呼んでも結果表は1枚だけ（復帰のたびに重ねない）', async () => {
    const { app, calls, flushTimers } = createApp({ storage: { tw_last_seen_week: PREVIOUS_WEEK } });

    await app.checkWeeklyResetResult();
    await app.checkWeeklyResetResult();
    await app.checkWeeklyResetResult();
    flushTimers();

    assert.equal(calls.length, 1);
});

test('週跨ぎでない: 同じ週なら何もしない', async () => {
    const { app, calls, flushTimers } = createApp({ storage: { tw_last_seen_week: CURRENT_WEEK } });

    await app.checkWeeklyResetResult();
    flushTimers();

    assert.deepEqual(calls, []);
});

test('週跨ぎ: 結果表がすでに開いていたら重ねない', async () => {
    const { app, calls, flushTimers } = createApp({
        storage: { tw_last_seen_week: PREVIOUS_WEEK },
        modalOpen: true
    });

    await app.checkWeeklyResetResult();
    flushTimers();

    assert.deepEqual(calls, []);
});

/* ------------------------------------------------------------------ *
 * 2. tw_last_seen_week が未設定（引き継ぎ・再インストール）
 * ------------------------------------------------------------------ */

test('未設定: 前週に対戦データがあれば、その週の結果表を出す', async () => {
    const { app, calls, flushTimers } = createApp({
        storage: { territory_rules_seen_v1: 'true' },
        getPreviousWeekResult: async (week) => ({ weekId: week, blackTotal: 120, whiteTotal: 80 })
    });

    await app.checkWeeklyResetResult();
    flushTimers();

    assert.deepEqual(calls, [{ isManual: false, targetWeek: PREVIOUS_WEEK }]);
});

test('未設定: 前週に記録が無ければ出さず、今週を見たものとして控える', async () => {
    const { app, storage, calls, flushTimers } = createApp({
        storage: { territory_rules_seen_v1: 'true' },
        getPreviousWeekResult: async (week) => ({ weekId: week, blackTotal: 0, whiteTotal: 0 })
    });

    await app.checkWeeklyResetResult();
    flushTimers();

    assert.deepEqual(calls, []);
    assert.equal(storage.data.tw_last_seen_week, CURRENT_WEEK);
});

test('未設定: 初回インストール（ルール未読）ではルール説明の上に出さない', async () => {
    const { app, storage, calls, flushTimers } = createApp({
        rulesSeen: false,
        getPreviousWeekResult: async (week) => ({ weekId: week, blackTotal: 120, whiteTotal: 80 })
    });

    await app.checkWeeklyResetResult();
    flushTimers();

    assert.deepEqual(calls, []);
    assert.equal(storage.data.tw_last_seen_week, CURRENT_WEEK);
});

test('未設定: 前週の取得に失敗しても落ちず、今週を見たものとして控える', async () => {
    const { app, storage, calls, flushTimers } = createApp({
        storage: { territory_rules_seen_v1: 'true' },
        getPreviousWeekResult: async () => { throw new Error('offline'); }
    });

    await app.checkWeeklyResetResult();
    flushTimers();

    assert.deepEqual(calls, []);
    assert.equal(storage.data.tw_last_seen_week, CURRENT_WEEK);
});

/* ------------------------------------------------------------------ *
 * 3. 配線（起動・復帰・週跨ぎのカウントダウン）
 * ------------------------------------------------------------------ */

test('配線: 起動時・フォアグラウンド復帰・週跨ぎのカウントダウンから確認される', () => {
    assert.match(readAppFile('app-core.js'), /this\.checkWeeklyResetResult\(\);/, '起動時に確認する');

    const tracking = readAppFile('app-tracking.js');
    const visibilityBlock = tracking.slice(tracking.indexOf("document.addEventListener('visibilitychange'"));
    assert.match(visibilityBlock.slice(0, 2500), /checkWeeklyResetResult\(\)/, '復帰時に確認する');
    assert.ok(
        (tracking.match(/checkWeeklyResetResult\(\)/g) || []).length >= 2,
        'appStateChange（ネイティブ復帰）でも確認する'
    );

    const gameplay = readAppFile('app-gameplay.js');
    assert.match(gameplay, /countdownWeekId/, 'カウントダウンで週の切り替わりを見る');
    assert.match(gameplay, /checkWeeklyResetResult\(\)/, '週が変わったら結果表を確認する');
});

test('配線: 結果表モーダルは0時またぎの表示に使う要素が揃っている', () => {
    ['weekly-result-modal', 'btn-close-weekly-result', 'result-week-id', 'result-winner-banner']
        .forEach((id) => assert.match(INDEX_HTML, new RegExp(`id="${id}"`), `${id} がある`));
});
