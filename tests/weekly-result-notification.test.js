/**
 * TERRITORY WALK - Node tests
 * v1.1 要件3: 月曜リセット後の結果発表・無音通知（まずこの1種類のみ）
 *   1) 「次の月曜 09:00」を正しく出す（月曜の朝・夜、日曜、平日）
 *   2) 通知は無音（sound を指定しない）。置換IDで通知センターに溜めない
 *   3) 既定は OFF。通知権限を要求するのは「ONにした瞬間」と「初回起動で1回だけ」
 *      （初回の自動プロンプトは first-launch-notification-prompt.test.js が見る）
 *   4) ネイティブ通知が無い環境（Web）では落ちずに何もしない
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');
const {
    WEEKLY_RESULT_NOTIFICATION_ID,
    WEEKLY_RESULT_NOTIFY_KEY,
    WEEKLY_RESULT_HOUR,
    WEEKLY_RESULT_MINUTE,
    nextWeeklyResultTime,
    buildWeeklyResultNotification,
    isWeeklyResultNotifyEnabled,
    setWeeklyResultNotifyEnabled,
    WeeklyResultNotifier
} = require(path.join(ROOT, 'notifications.js'));

const APP_SOURCE = readAppSource();
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
        clear: () => map.clear()
    };
}

/** 月曜=1 … 日曜=0（ローカル時刻） */
function localDate(text) {
    // 端末のローカル時刻で組み立てる（実行環境の TZ に依存しない）
    const [y, m, d, hh, mm] = text.split(/[-T:]/).map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/* ------------------------------------------------------------------ *
 * 1: 次の月曜 09:00
 * ------------------------------------------------------------------ */

test('予約時刻: 平日（水曜）なら次の月曜09:00', () => {
    const next = nextWeeklyResultTime(localDate('2026-11-18T12:00')); // 水曜
    assert.equal(next.getDay(), 1, '月曜');
    assert.equal(next.getDate(), 23);
    assert.equal(next.getHours(), WEEKLY_RESULT_HOUR);
    assert.equal(next.getMinutes(), WEEKLY_RESULT_MINUTE);
});

test('予約時刻: 月曜の朝（09:00前）なら当日09:00', () => {
    const next = nextWeeklyResultTime(localDate('2026-11-16T07:30'));
    assert.equal(next.getDay(), 1);
    assert.equal(next.getDate(), 16);
    assert.equal(next.getHours(), 9);
});

test('予約時刻: 月曜の09:00を過ぎていたら翌週', () => {
    const next = nextWeeklyResultTime(localDate('2026-11-16T10:00'));
    assert.equal(next.getDay(), 1);
    assert.equal(next.getDate(), 23);
    assert.equal(next.getHours(), 9);
});

test('予約時刻: 日曜なら翌日（月曜）', () => {
    const next = nextWeeklyResultTime(localDate('2026-11-22T22:00'));
    assert.equal(next.getDay(), 1);
    assert.equal(next.getDate(), 23);
});

test('予約時刻: 予約時刻は必ず未来になる', () => {
    for (let i = 0; i < 24 * 8; i += 1) {
        const now = new Date(2026, 10, 16, 0, 0, 0, 0);
        now.setHours(now.getHours() + i);
        const next = nextWeeklyResultTime(now);
        assert.ok(next.getTime() > now.getTime(), `未来の時刻（${now.toString()}）`);
        assert.equal(next.getDay(), 1);
        assert.equal(next.getHours(), 9);
    }
});

/* ------------------------------------------------------------------ *
 * 2: 無音・置換ID
 * ------------------------------------------------------------------ */

test('通知内容: 無音（sound を指定しない）で、同じIDの1件だけ', () => {
    const payload = buildWeeklyResultNotification('2026-W47', localDate('2026-11-18T12:00'));
    assert.equal(payload.id, WEEKLY_RESULT_NOTIFICATION_ID);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'sound'), false,
        'sound を持たせない＝iOSは無音で通知センターに入れる');
    assert.equal(payload.schedule.repeats, false);
    assert.equal(payload.silent, true, 'アプリを開いている間は重ねて出さない');
    assert.equal(payload.title, '先週のシーズン結果');
    assert.ok(payload.body.includes('2026-W47'), 'どの週の結果かが分かる');
    assert.equal(payload.extra.kind, 'weekly-result');
});

test('通知内容: 週IDが無くても文面が壊れない', () => {
    const payload = buildWeeklyResultNotification(null);
    assert.ok(payload.body.includes('先週'));
    assert.equal(payload.extra.weekId, '');
});

test('通知の予約は同一IDを cancel してから貼り直す（溜めない）', async () => {
    const calls = [];
    const plugin = {
        checkPermissions: async () => ({ display: 'granted' }),
        requestPermissions: async () => ({ display: 'granted' }),
        schedule: async (options) => { calls.push({ type: 'schedule', options }); },
        cancel: async (options) => { calls.push({ type: 'cancel', options }); }
    };
    global.window = { Capacitor: { Plugins: { LocalNotifications: plugin } } };
    try {
        const notifier = new WeeklyResultNotifier({ supabaseManager: { getCurrentWeekId: () => '2026-W47' } });
        notifier.enabled = true;
        const ok = await notifier.schedule();
        assert.equal(ok, true);
        assert.equal(calls[0].type, 'cancel');
        assert.equal(calls[1].type, 'schedule');
        assert.equal(calls[1].options.notifications.length, 1);
        assert.equal(calls[1].options.notifications[0].id, WEEKLY_RESULT_NOTIFICATION_ID);
    } finally {
        delete global.window;
    }
});

/* ------------------------------------------------------------------ *
 * 3: 既定OFF・ONの瞬間だけ権限要求
 * ------------------------------------------------------------------ */

test('設定: 既定は OFF、切り替えは端末内に保存', () => {
    const storage = createMemoryStorage();
    assert.equal(isWeeklyResultNotifyEnabled(storage), false, '既定はOFF');
    setWeeklyResultNotifyEnabled(true, storage);
    assert.equal(storage.getItem(WEEKLY_RESULT_NOTIFY_KEY), 'on');
    assert.equal(isWeeklyResultNotifyEnabled(storage), true);
    setWeeklyResultNotifyEnabled(false, storage);
    assert.equal(isWeeklyResultNotifyEnabled(storage), false);
});

test('権限: 起動時は要求しない（init は checkPermissions だけ）', async () => {
    const calls = [];
    const plugin = {
        checkPermissions: async () => { calls.push('check'); return { display: 'denied' }; },
        requestPermissions: async () => { calls.push('request'); return { display: 'denied' }; },
        schedule: async () => { calls.push('schedule'); },
        cancel: async () => { calls.push('cancel'); }
    };
    global.window = { Capacitor: { Plugins: { LocalNotifications: plugin } } };
    global.localStorage = createMemoryStorage();
    setWeeklyResultNotifyEnabled(true, global.localStorage);
    try {
        const notifier = new WeeklyResultNotifier(null);
        await notifier.init();
        assert.deepEqual(calls, ['check'], '許可ダイアログは出さない（起動時に干渉しない）');
    } finally {
        delete global.window;
    }
});

test('権限: ONにした瞬間に要求し、許可されたら予約する', async () => {
    const calls = [];
    const plugin = {
        checkPermissions: async () => { calls.push('check'); return { display: 'prompt' }; },
        requestPermissions: async () => { calls.push('request'); return { display: 'granted' }; },
        schedule: async () => { calls.push('schedule'); },
        cancel: async () => { calls.push('cancel'); }
    };
    global.window = { Capacitor: { Plugins: { LocalNotifications: plugin } } };
    global.localStorage = createMemoryStorage();
    try {
        const notifier = new WeeklyResultNotifier({ showToast: () => {} });
        const ok = await notifier.setEnabled(true);
        assert.equal(ok, true);
        assert.deepEqual(calls, ['check', 'request', 'cancel', 'schedule']);
        assert.equal(isWeeklyResultNotifyEnabled(global.localStorage), true);
    } finally {
        delete global.window;
    }
});

test('権限: 拒否されたらOFFのまま・予約もしない', async () => {
    const calls = [];
    const plugin = {
        checkPermissions: async () => ({ display: 'prompt' }),
        requestPermissions: async () => { calls.push('request'); return { display: 'denied' }; },
        schedule: async () => { calls.push('schedule'); },
        cancel: async () => {}
    };
    global.window = { Capacitor: { Plugins: { LocalNotifications: plugin } } };
    global.localStorage = createMemoryStorage();
    try {
        const notifier = new WeeklyResultNotifier({ showToast: () => {} });
        const ok = await notifier.setEnabled(true);
        assert.equal(ok, false);
        assert.deepEqual(calls, ['request'], '拒否されたら予約しない');
        assert.equal(isWeeklyResultNotifyEnabled(global.localStorage), false);
    } finally {
        delete global.window;
    }
});

test('OFFにしたら予約を取り消す', async () => {
    const calls = [];
    const plugin = {
        checkPermissions: async () => ({ display: 'granted' }),
        requestPermissions: async () => ({ display: 'granted' }),
        schedule: async () => { calls.push('schedule'); },
        cancel: async () => { calls.push('cancel'); }
    };
    global.window = { Capacitor: { Plugins: { LocalNotifications: plugin } } };
    global.localStorage = createMemoryStorage();
    setWeeklyResultNotifyEnabled(true, global.localStorage);
    try {
        const notifier = new WeeklyResultNotifier({ showToast: () => {} });
        notifier.enabled = true;
        await notifier.setEnabled(false);
        assert.deepEqual(calls, ['cancel']);
        assert.equal(isWeeklyResultNotifyEnabled(global.localStorage), false);
    } finally {
        delete global.window;
    }
});

/* ------------------------------------------------------------------ *
 * 4: ネイティブ無し環境
 * ------------------------------------------------------------------ */

test('未対応環境: プラグインが無ければ落ちずに何もしない', async () => {
    global.localStorage = createMemoryStorage();
    const notifier = new WeeklyResultNotifier({ showToast: () => {} });
    assert.equal(notifier.available(), false);
    assert.equal(await notifier.schedule(), false);
    assert.equal(await notifier.cancel(), false);
    assert.equal(await notifier.setEnabled(true), false);
    assert.equal(notifier.enabled, false);
});

test('配線: 設定トグルと配線（init は予約の貼り直しだけで権限を要求しない）', () => {
    assert.match(INDEX_HTML, /id="btn-toggle-weekly-notify"/);
    assert.match(INDEX_HTML, /id="weekly-notify-text"/);
    assert.match(INDEX_HTML, /月曜の結果通知（無音）/);
    assert.match(INDEX_HTML, /notifications\.js\?v=/, 'notifications.js を読み込む');
    assert.match(APP_SOURCE, /initWeeklyResultNotifier\(\)/);
    assert.match(APP_SOURCE, /this\.weeklyNotifier\.init\(\)/, '起動時は init（予約の貼り直し）');
    const notificationsSource = fs.readFileSync(path.join(ROOT, 'notifications.js'), 'utf8');
    assert.match(notificationsSource, /promptOnFirstLaunch/, '初回だけ尋ねる処理を持つ');
});

test('プラグイン: Capacitor 6 系の @capacitor/local-notifications を依存に持つ', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.match(pkg.dependencies['@capacitor/local-notifications'] || '', /^\^?6\./);
});
