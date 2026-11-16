/**
 * TERRITORY WALK - notifications.js
 * 月曜リセット後の「結果発表」ローカル通知（まずこの1種類のみ・無音）。
 *
 * 方針
 *   1. 音を鳴らさない（`sound` を指定しない）。iOS は sound 未指定なら無音で通知センターに入る。
 *      → 歩行中でも突然音が鳴らず、Watch にミラーされても静かに残るだけ（v1.1 の意図）。
 *   2. 通知権限は「ユーザーが設定でONにした瞬間」だけ要求する。
 *      起動時には要求しない（アプリ起動の許可ダイアログと干渉させない）。
 *   3. スケジュールは「次の月曜 09:00（端末のローカル時刻）」の1回だけ。起動のたびに貼り直す。
 *   4. ネイティブ（Capacitor LocalNotifications）が無い環境（Web・未登録）では何もしない。
 *
 * 実行: npm test （node --test tests/）
 */

const WEEKLY_RESULT_NOTIFICATION_ID = 4601;
const WEEKLY_RESULT_NOTIFY_KEY = 'tw_weekly_result_notify';
const WEEKLY_RESULT_HOUR = 9;
const WEEKLY_RESULT_MINUTE = 0;
const WEEKLY_RESULT_THREAD = 'territory-weekly-result';

/**
 * 次の「月曜 09:00」を返す（端末のローカル時刻）。
 * 月曜の 09:00 前なら当日、それ以降なら翌週の月曜。
 */
function nextWeeklyResultTime(now = new Date()) {
    const base = new Date(now.getTime());
    const result = new Date(base.getTime());
    result.setHours(WEEKLY_RESULT_HOUR, WEEKLY_RESULT_MINUTE, 0, 0);

    const daysUntilMonday = (8 - result.getDay()) % 7; // 月曜(1) まで何日か（月曜なら 0）
    result.setDate(result.getDate() + daysUntilMonday);

    // 今日が月曜でも 09:00 を過ぎていたら翌週へ
    if (result.getTime() <= base.getTime()) {
        result.setDate(result.getDate() + 7);
    }
    return result;
}

/**
 * 通知ペイロード（Capacitor LocalNotifications のスキーマ）。
 * sound は「あえて入れない」＝無音。テストで sound が無いことを確認している。
 */
function buildWeeklyResultNotification(prevWeekId, now = new Date()) {
    const at = nextWeeklyResultTime(now);
    return {
        id: WEEKLY_RESULT_NOTIFICATION_ID,
        title: '先週のシーズン結果',
        body: prevWeekId
            ? `${prevWeekId} の対戦が決着しました。タップして結果を見る`
            : '先週の対戦が決着しました。タップして結果を見る',
        schedule: { at, repeats: false },
        threadIdentifier: WEEKLY_RESULT_THREAD,
        // アプリを開いている間に重ねて出さない（画面には既存の結果モーダルが出る）
        silent: true,
        extra: { kind: 'weekly-result', weekId: prevWeekId || '' }
    };
}

/** 設定の読み書き（既定は OFF＝勝手に権限を求めない） */
function isWeeklyResultNotifyEnabled(storage) {
    try {
        const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!target) return false;
        return target.getItem(WEEKLY_RESULT_NOTIFY_KEY) === 'on';
    } catch (e) {
        return false;
    }
}

function setWeeklyResultNotifyEnabled(enabled, storage) {
    try {
        const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!target) return false;
        target.setItem(WEEKLY_RESULT_NOTIFY_KEY, enabled ? 'on' : 'off');
        return true;
    } catch (e) {
        return false;
    }
}

class WeeklyResultNotifier {
    constructor(app) {
        this.app = app || null;
        this.enabled = isWeeklyResultNotifyEnabled();
        this.scheduledFor = null;
        this.uiBound = false;
    }

    plugin() {
        if (typeof window === 'undefined') return null;
        const cap = window.Capacitor;
        if (!cap || !cap.Plugins) return null;
        return cap.Plugins.LocalNotifications || null;
    }

    available() {
        return !!this.plugin();
    }

    /** 起動時：設定がONなら貼り直す。権限が未許可なら何もしない（勝手にダイアログを出さない） */
    async init() {
        this.enabled = isWeeklyResultNotifyEnabled();
        this.bindUI();
        this.renderUI();
        if (!this.enabled) return;
        try {
            const plugin = this.plugin();
            if (!plugin) return;
            const status = await plugin.checkPermissions();
            if (!status || status.display !== 'granted') return;
            await this.schedule();
        } catch (e) {
            console.warn('[Notify] init failed:', e);
        }
    }

    /** 通知を1件だけ貼り直す（同じIDを置換するので通知センターに溜まらない） */
    async schedule() {
        const plugin = this.plugin();
        if (!plugin) return false;
        const weekId = this.app && this.app.supabaseManager
            ? this.app.supabaseManager.getCurrentWeekId()
            : null;
        const payload = buildWeeklyResultNotification(weekId);
        try {
            await plugin.cancel({ notifications: [{ id: WEEKLY_RESULT_NOTIFICATION_ID }] });
            await plugin.schedule({ notifications: [payload] });
            this.scheduledFor = payload.schedule.at;
            return true;
        } catch (e) {
            console.warn('[Notify] schedule failed:', e);
            return false;
        }
    }

    async cancel() {
        const plugin = this.plugin();
        if (!plugin) return false;
        try {
            await plugin.cancel({ notifications: [{ id: WEEKLY_RESULT_NOTIFICATION_ID }] });
            this.scheduledFor = null;
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 設定トグル（ONのときだけ権限を要求する） */
    async setEnabled(next) {
        const plugin = this.plugin();
        if (next) {
            if (!plugin) {
                this.enabled = false;
                setWeeklyResultNotifyEnabled(false);
                this.renderUI();
                this.toast('この端末では通知を使えません');
                return false;
            }
            let granted = true;
            try {
                const current = await plugin.checkPermissions();
                if (!current || current.display !== 'granted') {
                    const asked = await plugin.requestPermissions();
                    granted = !!(asked && asked.display === 'granted');
                }
            } catch (e) {
                granted = false;
            }
            if (!granted) {
                this.enabled = false;
                setWeeklyResultNotifyEnabled(false);
                this.renderUI();
                this.toast('通知が許可されていません（端末の設定から許可できます）');
                return false;
            }
            this.enabled = true;
            setWeeklyResultNotifyEnabled(true);
            this.renderUI();
            const ok = await this.schedule();
            this.toast(ok ? '毎週月曜9時に、無音で結果をお知らせします' : '通知の予約に失敗しました');
            return ok;
        }

        this.enabled = false;
        setWeeklyResultNotifyEnabled(false);
        this.renderUI();
        await this.cancel();
        this.toast('月曜の結果通知をオフにしました');
        return true;
    }

    bindUI() {
        if (this.uiBound || typeof document === 'undefined') return;
        const btn = document.getElementById('btn-toggle-weekly-notify');
        if (!btn) return;
        this.uiBound = true;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await this.setEnabled(!this.enabled);
            } finally {
                btn.disabled = false;
            }
        });
    }

    renderUI() {
        if (typeof document === 'undefined') return;
        const btn = document.getElementById('btn-toggle-weekly-notify');
        if (!btn) return;
        const dot = document.getElementById('weekly-notify-dot');
        const label = document.getElementById('weekly-notify-text');
        btn.dataset.state = this.enabled ? 'on' : 'off';
        btn.setAttribute('aria-pressed', this.enabled ? 'true' : 'false');
        if (dot) {
            dot.className = this.enabled
                ? 'w-2 h-2 rounded-full bg-emerald-400'
                : 'w-2 h-2 rounded-full bg-zinc-600';
        }
        if (label) {
            label.textContent = this.enabled ? 'ON（毎週月曜9時・無音）' : 'OFF';
        }
    }

    toast(message) {
        if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast(message);
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        WEEKLY_RESULT_NOTIFICATION_ID,
        WEEKLY_RESULT_NOTIFY_KEY,
        WEEKLY_RESULT_HOUR,
        WEEKLY_RESULT_MINUTE,
        nextWeeklyResultTime,
        buildWeeklyResultNotification,
        isWeeklyResultNotifyEnabled,
        setWeeklyResultNotifyEnabled,
        WeeklyResultNotifier
    };
}
