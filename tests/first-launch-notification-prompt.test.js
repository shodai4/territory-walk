/**
 * TERRITORY WALK - Node tests
 * はじめての起動時の通知許可（5点改修の 4）
 *   1) 初回だけ尋ねる（tw_notification_prompted で2回目以降は出さない）
 *   2) 許可されたら「月曜の結果通知（無音）」を自動でONにして次の月曜09:00を予約する
 *   3) 拒否されたら OFF のまま（後から MENU のトグルでONにできる）
 *   4) Web・未対応環境では尋ねない（記録も残さない）
 *   5) 位置情報・ATT のダイアログと重ならないよう、ゲーム開始から数秒待ってから出す
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
    WEEKLY_NOTIFY_PROMPT_KEY,
    FIRST_LAUNCH_NOTIFY_PROMPT_DELAY_MS,
    wasNotificationPrompted,
    markNotificationPrompted,
    isWeeklyResultNotifyEnabled,
    setWeeklyResultNotifyEnabled,
    WeeklyResultNotifier
} = require(path.join(ROOT, 'notifications.js'));

const APP_SOURCE = readAppSource();
const NOTIFICATIONS_SOURCE = fs.readFileSync(path.join(ROOT, 'notifications.js'), 'utf8');

function createMemoryStorage() {
    const map = new Map();
    return {
        map,
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key)
    };
}

/** Capacitor LocalNotifications のスタブ（呼ばれた順番を記録する） */
function installPlugin(options = {}) {
    const calls = [];
    const plugin = {
        checkPermissions: async () => {
            calls.push('check');
            return { display: options.current || 'prompt' };
        },
        requestPermissions: async () => {
            calls.push('request');
            return { display: options.answer || 'granted' };
        },
        schedule: async () => { calls.push('schedule'); },
        cancel: async () => { calls.push('cancel'); }
    };
    global.window = { Capacitor: { Plugins: { LocalNotifications: plugin } } };
    global.localStorage = createMemoryStorage();
    return { calls, plugin };
}

function cleanup() {
    delete global.window;
    delete global.localStorage;
}

/* ------------------------------------------------------------------ *
 * 1. 初回だけ尋ねる
 * ------------------------------------------------------------------ */

test('初回: 許可されたら通知をONにし、次の月曜09:00を予約して記録する', async () => {
    const { calls } = installPlugin({ answer: 'granted' });
    setWeeklyResultNotifyEnabled(false);
    try {
        const toasts = [];
        const notifier = new WeeklyResultNotifier({ showToast: (m) => toasts.push(m) });

        const ok = await notifier.promptOnFirstLaunch();
        assert.equal(ok, true);
        assert.equal(isWeeklyResultNotifyEnabled(global.localStorage), true, '自動でON（保存もする）');
        assert.deepEqual(calls, ['check', 'request', 'cancel', 'schedule'], '許可→予約');
        assert.equal(global.localStorage.getItem(WEEKLY_NOTIFY_PROMPT_KEY), '1');
        assert.match(toasts.join(' '), /毎週月曜9時/);

        // 2回目（次の起動）は尋ねない
        const again = await notifier.promptOnFirstLaunch();
        assert.equal(again, false);
        assert.deepEqual(calls, ['check', 'request', 'cancel', 'schedule'], '権限ダイアログを再表示しない');
    } finally {
        cleanup();
    }
});

test('初回: 拒否されたら OFF のまま（記録はして2回目以降は尋ねない）', async () => {
    const { calls } = installPlugin({ answer: 'denied' });
    setWeeklyResultNotifyEnabled(false);
    try {
        const notifier = new WeeklyResultNotifier({ showToast: () => {} });
        const ok = await notifier.promptOnFirstLaunch();
        assert.equal(ok, false);
        assert.equal(isWeeklyResultNotifyEnabled(global.localStorage), false, 'OFFのまま');
        assert.deepEqual(calls, ['check', 'request'], '予約しない');
        assert.equal(global.localStorage.getItem(WEEKLY_NOTIFY_PROMPT_KEY), '1');
        assert.equal(notifier.enabled, false);

        await notifier.promptOnFirstLaunch();
        assert.deepEqual(calls, ['check', 'request'], '2回目は尋ねない');
    } finally {
        cleanup();
    }
});

test('初回: すでに許可済みならダイアログを出さずにONへ（予約だけする）', async () => {
    const { calls } = installPlugin({ current: 'granted' });
    setWeeklyResultNotifyEnabled(false);
    try {
        const notifier = new WeeklyResultNotifier({ showToast: () => {} });
        assert.equal(await notifier.promptOnFirstLaunch(), true);
        assert.deepEqual(calls, ['check', 'cancel', 'schedule']);
        assert.equal(isWeeklyResultNotifyEnabled(global.localStorage), true);
    } finally {
        cleanup();
    }
});

test('初回: Web・未対応環境では尋ねない（記録を残さない＝ネイティブで後から尋ねられる）', async () => {
    global.localStorage = createMemoryStorage();
    try {
        const notifier = new WeeklyResultNotifier({ showToast: () => {} });
        assert.equal(await notifier.promptOnFirstLaunch(), false);
        assert.equal(global.localStorage.getItem(WEEKLY_NOTIFY_PROMPT_KEY), null);
    } finally {
        cleanup();
    }
});

/* ------------------------------------------------------------------ *
 * 2. 記録の読み書き
 * ------------------------------------------------------------------ */

test('記録: tw_notification_prompted=1 が立っていたら尋ねない', () => {
    const storage = createMemoryStorage();
    assert.equal(wasNotificationPrompted(storage), false);
    assert.equal(markNotificationPrompted(storage), true);
    assert.equal(storage.getItem('tw_notification_prompted'), '1');
    assert.equal(WEEKLY_NOTIFY_PROMPT_KEY, 'tw_notification_prompted');
    assert.equal(wasNotificationPrompted(storage), true);
});

/* ------------------------------------------------------------------ *
 * 3. 配線（起動タイミング）
 * ------------------------------------------------------------------ */

test('配線: ゲーム開始（startDeferredServices）から数秒待って初回プロンプトを予約する', () => {
    assert.ok(FIRST_LAUNCH_NOTIFY_PROMPT_DELAY_MS >= 3000, '位置情報・ATT と重ならないだけ待つ');
    assert.match(APP_SOURCE, /this\.scheduleFirstLaunchNotificationPrompt\(\);/, 'startDeferredServices から呼ぶ');
    assert.match(APP_SOURCE, /^    scheduleFirstLaunchNotificationPrompt\(\) \{/m, '予約メソッドを持つ');
    assert.match(APP_SOURCE, /FIRST_LAUNCH_NOTIFY_PROMPT_DELAY_MS/, '待ち時間は notifications.js の定数を使う');
    assert.match(APP_SOURCE, /promptOnFirstLaunch\(\)/, '権限要求は WeeklyResultNotifier 側');

    // 起動直後（startDeferredServices より前）には権限要求を呼ばない
    const beforeServices = APP_SOURCE.slice(0, APP_SOURCE.indexOf('startDeferredServices(trigger'));
    assert.doesNotMatch(beforeServices, /promptOnFirstLaunch/, '起動ゲート通過前にダイアログを出さない');
});

test('配線: 方針コメント（初回1回だけ・位置情報/ATT と重ねない）が残っている', () => {
    assert.match(NOTIFICATIONS_SOURCE, /はじめてゲームを開始した直後に1回/, '設計意図を残す');
    assert.match(NOTIFICATIONS_SOURCE, /位置情報・ATT/, '重ならないタイミングであることを残す');
});
