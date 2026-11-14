/**
 * TERRITORY WALK - debug-tools.js
 * デバッグモード専用ツール（仮想散歩 D-Pad の位置計算・全陣地の白紙リセット）
 *
 * 設計方針:
 * - すべて CONFIG.ENABLE_DEBUG_TOOLS === false のときは isEnabled() が false を返し、
 *   呼び出し側（app.js）も早期リターンで遮断する。UI も非表示になる。
 * - D-Pad の仮想移動は、通常歩行とまったく同じ processMeshAndClaim（塗り・保存・
 *   戦績・コイン・Outbox 同期）を通す。ここでは座標計算だけを提供する。
 * - 全陣地リセットは「ローカル全白紙化 → 当週サーバー削除」の順で行う。
 *   サーバー削除の対象は、この端末が把握しているマス（ローカルキャッシュ＋未送信
 *   Outbox）＝自分のテスト陣地に限定し、他端末の陣地を巻き込まない。
 *   削除できない場合（RLS 拒否・オフライン等）はローカル白紙化だけを成立させ、
 *   結果に serverError を残して呼び出し側が明示できるようにする。
 */

const DEBUG_RESET_STORAGE_KEYS = {
    tiles: 'territory_claimed_tiles',
    outbox: 'pending_tile_queue'
};

class DebugTools {
    /** デバッグ機能のマスタースイッチ（CONFIG.ENABLE_DEBUG_TOOLS） */
    static isEnabled(app) {
        if (!app) return false;
        if (typeof app.debugEnabled === 'boolean') return app.debugEnabled;
        return !!(typeof CONFIG !== 'undefined' && CONFIG.ENABLE_DEBUG_TOOLS !== false);
    }

    /** 仮想散歩（D-Pad）が有効か：マスタースイッチON かつ DEBUG: ON */
    static isVirtualWalking(app) {
        return DebugTools.isEnabled(app) && !!(app && app.isDebugMode);
    }

    /**
     * 仮想1歩分の座標を返す（緯度経度とも5桁で丸め、GPS と同じ精度に揃える）
     * @returns {number[]} [lat, lng]
     */
    static stepPosition(position, dLat, dLng) {
        const base = Array.isArray(position) ? position : [0, 0];
        const lat = Number(base[0] || 0) + Number(dLat || 0);
        const lng = Number(base[1] || 0) + Number(dLng || 0);
        return [parseFloat(lat.toFixed(5)), parseFloat(lng.toFixed(5))];
    }

    /** リセット確認ダイアログの文言（誤タップ防止のため必ず通す） */
    static resetConfirmMessage({ localCount = 0, outboxCount = 0, weekId = '' } = {}) {
        return [
            '【デバッグ】全陣地を白紙リセットしますか？',
            '',
            `・ローカルの陣地 ${localCount} マス（地図・保存データ）`,
            `・未送信キュー ${outboxCount} 件（Outbox）`,
            `・サーバー（Supabase）の当週 ${weekId || '今週'} のうち、この端末が把握しているマス`,
            '',
            'この端末の陣地は元に戻せません。実行しますか？'
        ].join('\n');
    }

    /** リセット対象（この端末が把握している当週のマスID）を集める */
    static collectResetTargets(app, weekId) {
        const localIds = [];
        const outboxIds = [];
        try {
            if (app && app.gridManager && app.gridManager.claimedTilesCache) {
                for (const id of app.gridManager.claimedTilesCache.keys()) localIds.push(id);
            }
        } catch (e) { /* ignore */ }
        try {
            if (app && app.syncQueue && typeof app.syncQueue.pendingMeshIds === 'function') {
                for (const id of app.syncQueue.pendingMeshIds(weekId)) outboxIds.push(id);
            }
        } catch (e) { /* ignore */ }
        return { localIds, outboxIds };
    }

    /**
     * ローカル＋サーバーの陣地を白紙化する。
     * options.confirmFn が渡された場合は必ず確認を挟み、false なら何も変更しない。
     */
    static async resetTerritories(app, options = {}) {
        if (!DebugTools.isEnabled(app)) {
            return { ok: false, reason: 'debug-disabled' };
        }

        const supabase = app.supabaseManager || null;
        const weekId = (supabase && typeof supabase.getCurrentWeekId === 'function')
            ? supabase.getCurrentWeekId()
            : '';

        const { localIds, outboxIds } = DebugTools.collectResetTargets(app, weekId);
        const targetIds = Array.from(new Set([...localIds, ...outboxIds]));

        const confirmFn = (typeof options.confirmFn === 'function') ? options.confirmFn : null;
        if (confirmFn) {
            const message = DebugTools.resetConfirmMessage({
                localCount: localIds.length,
                outboxCount: outboxIds.length,
                weekId
            });
            const approved = confirmFn(message);
            if (!approved) return { ok: false, reason: 'canceled', canceled: true };
        }

        // --- 1. ローカル白紙化（地図・保存データ・Outbox） ---
        let localCleared = 0;
        let outboxCleared = 0;
        if (app.gridManager) {
            localCleared = DebugTools.clearLocalTiles(app.gridManager);
        }
        if (app.syncQueue) {
            outboxCleared = DebugTools.clearOutbox(app.syncQueue);
        }
        app.currentMeshId = null;
        app.lastProcessedLat = null;
        app.lastProcessedLng = null;
        if (typeof app.updateScoreUI === 'function') app.updateScoreUI();

        // --- 2. サーバー側（当週・この端末が把握しているマスのみ） ---
        let serverDeleted = 0;
        let serverError = null;
        let serverSkipped = false;
        if (targetIds.length > 0 && supabase && typeof supabase.deleteTiles === 'function') {
            if (!supabase.client) {
                serverSkipped = true;
            } else {
                const res = await supabase.deleteTiles(targetIds, weekId);
                if (res && res.success) {
                    serverDeleted = res.deleted || 0;
                } else {
                    serverError = (res && res.error && (res.error.message || res.error.details || res.error.hint))
                        || 'delete-failed';
                }
            }
        } else if (targetIds.length > 0) {
            serverSkipped = true;
        }

        return {
            ok: true,
            weekId,
            localCleared,
            outboxCleared,
            targetCount: targetIds.length,
            serverDeleted,
            serverSkipped,
            serverError
        };
    }

    /** ローカルの陣地キャッシュ・描画・保存データをすべて白紙に戻す */
    static clearLocalTiles(gridManager) {
        let cleared = 0;
        try {
            if (gridManager.claimedTilesCache) {
                cleared = gridManager.claimedTilesCache.size;
                if (typeof gridManager.clearAllTiles === 'function') {
                    gridManager.clearAllTiles();
                    return cleared;
                }
                gridManager.claimedTilesCache.clear();
            }
            if (typeof gridManager.saveTilesToStorage === 'function') gridManager.saveTilesToStorage();
        } catch (e) {
            console.warn('[DebugTools] Failed to clear local tiles:', e);
        }
        return cleared;
    }

    /** 未送信 Outbox キューを空にする */
    static clearOutbox(queue) {
        let cleared = 0;
        try {
            cleared = (typeof queue.count === 'function') ? queue.count() : 0;
            if (typeof queue.clearAll === 'function') {
                queue.clearAll();
            } else if (queue.constructor && typeof queue.constructor.clear === 'function') {
                queue.constructor.clear();
            }
            if (typeof queue.notify === 'function') queue.notify();
        } catch (e) {
            console.warn('[DebugTools] Failed to clear outbox:', e);
        }
        return cleared;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DebugTools, DEBUG_RESET_STORAGE_KEYS };
}
