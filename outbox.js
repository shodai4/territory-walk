/**
 * TERRITORY WALK - outbox.js
 * オフライン陣地の一時保存（Outbox）とオンライン復帰時の一括同期
 *
 * 通信が切れている間、または Supabase への送信に失敗した陣地（タイル）は
 * localStorage の pending_tile_queue に保存しておき、オンライン復帰時・
 * アプリ起動時・フォアグラウンド復帰時にまとめて再送する。
 *
 * 設計方針:
 * - 同一メッシュ × 同一週の重複は「最新状態で上書きマージ」し、送信量を抑える。
 * - 週をまたいだ未送信分は、保存時の week_id のまま送る（過去週のレコードとして
 *   正しく復元される）。ただし2週以上前のものは再送しても意味がないため破棄する。
 * - フラッシュはロック（isFlushing）で二重実行を防ぎ、成功したアイテムだけを
 *   キューから取り除く。失敗したアイテムは attempts を増やして保持する。
 */

const TW_OUTBOX_KEY = 'pending_tile_queue';
const TW_OUTBOX_MAX_ENTRIES = 3000;
const TW_OUTBOX_BATCH_SIZE = 50;
const TW_OUTBOX_MAX_WEEK_AGE = 2;

class TileSyncQueue {
    constructor(appInstance) {
        this.app = appInstance;
        this.isFlushing = false;
        this.lastFlushAt = 0;
        this.retryTimer = null;
        this.onChange = null;
    }

    // --- Storage ---
    static read() {
        try {
            const raw = localStorage.getItem(TW_OUTBOX_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.warn('[Outbox] Failed to read queue:', e);
            return [];
        }
    }

    static write(list) {
        try {
            localStorage.setItem(TW_OUTBOX_KEY, JSON.stringify(list));
            return true;
        } catch (e) {
            console.warn('[Outbox] Failed to write queue:', e);
            return false;
        }
    }

    static clear() {
        try {
            localStorage.removeItem(TW_OUTBOX_KEY);
        } catch (e) { /* ignore */ }
    }

    keyOf(entry) {
        if (!entry) return '';
        return `${entry.weekId || ''}|${entry.meshId || ''}`;
    }

    count() {
        return TileSyncQueue.read().length;
    }

    /** キューを空にする（デバッグの全陣地リセット用）。戻り値は消した件数。 */
    clearAll() {
        const cleared = this.count();
        TileSyncQueue.clear();
        this.notify();
        return cleared;
    }

    currentWeekId() {
        return (this.app && this.app.supabaseManager)
            ? this.app.supabaseManager.getCurrentWeekId()
            : '';
    }

    /**
     * 未送信タイルをキューへ追加する。同一メッシュ＋同一週は最新状態で上書き。
     */
    enqueue(entry) {
        if (!entry || !entry.meshId) return null;
        const weekId = entry.weekId || this.currentWeekId();
        if (!weekId) return null;

        const now = new Date().toISOString();
        const item = {
            meshId: entry.meshId,
            latIdx: Number(entry.latIdx),
            lngIdx: Number(entry.lngIdx),
            team: entry.team === 'white' ? 'white' : 'black',
            weekId: weekId,
            updatedAt: entry.updatedAt || now,
            attempts: 0
        };

        const list = TileSyncQueue.read();
        const key = this.keyOf(item);
        const idx = list.findIndex(e => this.keyOf(e) === key);
        if (idx >= 0) {
            const prev = list[idx] || {};
            list[idx] = {
                ...prev,
                ...item,
                attempts: 0,
                updatedAt: now
            };
        } else {
            list.push(item);
        }
        while (list.length > TW_OUTBOX_MAX_ENTRIES) list.shift();
        TileSyncQueue.write(list);
        this.notify();
        return item;
    }

    /** 指定週（省略時は全週）で未送信のメッシュID集合。 */
    pendingMeshIds(weekId) {
        const set = new Set();
        for (const e of TileSyncQueue.read()) {
            if (!weekId || e.weekId === weekId) set.add(e.meshId);
        }
        return set;
    }

    weekOrdinal(weekId) {
        const m = /^(\d{4})-W(\d{2})$/.exec(String(weekId || ''));
        if (!m) return null;
        return parseInt(m[1], 10) * 53 + parseInt(m[2], 10);
    }

    /** 2週以上前の未送信分は破棄（再送しても活用されないため）。 */
    pruneExpired() {
        const current = this.weekOrdinal(this.currentWeekId());
        if (current === null) return 0;
        const list = TileSyncQueue.read();
        const kept = [];
        let dropped = 0;
        for (const e of list) {
            const ord = this.weekOrdinal(e.weekId);
            if (ord !== null && current - ord > TW_OUTBOX_MAX_WEEK_AGE) {
                dropped++;
                continue;
            }
            kept.push(e);
        }
        if (dropped > 0) {
            TileSyncQueue.write(kept);
            console.log(`[Outbox] Dropped ${dropped} expired entries.`);
            this.notify();
        }
        return dropped;
    }

    // --- Flush ---
    canFlush() {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
        if (!this.app || !this.app.supabaseManager) return false;
        return !!this.app.supabaseManager.client;
    }

    isOffline() {
        return typeof navigator !== 'undefined' && navigator.onLine === false;
    }

    /**
     * 未送信キューをSupabaseへバッチ再送する。
     * 成功したアイテムだけを削除し、失敗分は次回に持ち越す。
     */
    async flush(reason = 'manual') {
        if (this.isFlushing) return { flushed: 0, skipped: true };
        if (!this.canFlush()) {
            this.notify();
            return { flushed: 0, offline: true };
        }

        const snapshot = TileSyncQueue.read();
        if (snapshot.length === 0) {
            this.notify();
            return { flushed: 0, empty: true };
        }

        this.isFlushing = true;
        this.pruneExpired();

        let flushed = 0;
        const failedKeys = new Set();
        const flushedUpdatedAt = new Map();
        const working = TileSyncQueue.read();

        try {
            for (let i = 0; i < working.length; i += TW_OUTBOX_BATCH_SIZE) {
                const chunk = working.slice(i, i + TW_OUTBOX_BATCH_SIZE);
                const res = await this.app.supabaseManager.upsertTilesBatch(chunk);
                if (res && res.success) {
                    for (const e of chunk) {
                        flushedUpdatedAt.set(this.keyOf(e), e.updatedAt);
                        flushed++;
                    }
                    continue;
                }

                // バッチ失敗時は1件ずつ切り分けて、送れるものは送る
                console.warn('[Outbox] Batch failed, retrying individually:', res && res.error);
                for (const e of chunk) {
                    const one = await this.app.supabaseManager.upsertTilesBatch([e]);
                    if (one && one.success) {
                        flushedUpdatedAt.set(this.keyOf(e), e.updatedAt);
                        flushed++;
                    } else {
                        failedKeys.add(this.keyOf(e));
                    }
                }
            }
        } catch (err) {
            console.warn('[Outbox] Flush error:', err);
            this.isFlushing = false;
            this.notify();
            this.scheduleRetry();
            return { flushed: flushed, error: err };
        }

        // 成功分のみ削除（フラッシュ中に積まれた新しい陣地は残す）
        const now = TileSyncQueue.read();
        const remaining = now.filter(e => {
            const key = this.keyOf(e);
            if (!flushedUpdatedAt.has(key)) {
                if (failedKeys.has(key)) e.attempts = (e.attempts || 0) + 1;
                return true;
            }
            return e.updatedAt > flushedUpdatedAt.get(key);
        });
        TileSyncQueue.write(remaining);

        this.isFlushing = false;
        this.lastFlushAt = Date.now();
        this.notify();

        if (flushed > 0) {
            console.log(`[Outbox] Flushed ${flushed} tiles (${reason}). Remaining: ${remaining.length}`);
            this.afterFlush(flushed, remaining.length);
        } else if (remaining.length > 0) {
            this.scheduleRetry();
        }

        return { flushed: flushed, remaining: remaining.length, reason: reason };
    }

    /** フラッシュ後の整合性同期（戦績・コイン）と控えめな通知。 */
    afterFlush(flushedCount, remainingCount) {
        if (!this.app) return;

        try {
            if (this.app.statsManager && this.app.statsManager.syncUserProfileImmediate) {
                this.app.statsManager.syncUserProfileImmediate();
            }
        } catch (e) {
            console.warn('[Outbox] Stats sync after flush failed:', e);
        }

        try {
            if (this.app.coinManager && this.app.coinManager.syncCoinsToSupabase) {
                this.app.coinManager.syncCoinsToSupabase();
            }
        } catch (e) {
            console.warn('[Outbox] Coin sync after flush failed:', e);
        }

        try {
            if (this.app.showToast) {
                this.app.showToast(
                    `オフライン分 ${flushedCount} マスを同期しました`,
                    remainingCount > 0 ? `残り ${remainingCount} マスは次回再送します` : ''
                );
            }
        } catch (e) { /* ignore */ }

        if (remainingCount > 0) this.scheduleRetry();
    }

    scheduleRetry() {
        if (this.retryTimer) return;
        if (this.isOffline()) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.flush('retry');
        }, 30000);
    }

    /** UIバッジ更新（件数とオフライン状態）。 */
    notify() {
        if (typeof this.onChange === 'function') {
            try {
                this.onChange(this.count(), this.isOffline(), this.isFlushing);
            } catch (e) { /* ignore */ }
        }
    }
}
