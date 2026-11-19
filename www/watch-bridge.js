/**
 * TERRITORY WALK - watch-bridge.js
 * iPhone 側から Apple Watch へ「窓データ」を送る小さな窓口（v1.1 Phase 1 コンパニオン版）。
 *
 * 送るもの（Swift: WatchBridgePlugin / WatchSessionManager）
 *   la / lo … 窓の左上マス、n … 一辺、you … 現在地の窓内位置、marking … マーキングON/OFF、g … n*n のマス
 *   g の1文字: '1' = 白、'2' = 黒（初期配置も実績も同じ解決を通すので、Watchで歩いた跡が浮かない）
 *
 * 方針
 *   - WatchBridge プラグインが無い環境（Web・未登録・Watch未対応ビルド）では何もしない。
 *   - Watch のON/OFFは既存の setMarkingPaused を呼ぶだけ（状態の持ち主はiPhone側の1か所）。
 *   - 通信は「最新値勝ち」（updateApplicationContext）。落ちても次の送信で追いつく。
 */

const WATCH_WINDOW_SIDES = { 2: 5, 4: 9, 7: 15 };

/** 送信の最短間隔（ms）。陣地獲得の連打・GPS更新の連続を Watch の電池ごと間引く */
const WATCH_SEND_THROTTLE_MS = { claim: 1000, position: 2000 };

/** プラグインがまだ生えていない・グラフの準備ができていない時の再送（初回だけ） */
const WATCH_INIT_RETRY_MS = [500, 1500, 4000, 9000];

function watchPlugin() {
    if (typeof window === 'undefined') return null;
    const cap = window.Capacitor;
    if (!cap || !cap.Plugins) return null;
    return cap.Plugins.WatchBridge || null;
}

/**
 * 現在地の周りのマスを 1 本の文字列に畳む（純粋関数・テスト対象）。
 * @param {{lat: number, lng: number}} center
 * @param {number} side 一辺（5 / 9 / 15）
 * @param {(latIdx: number, lngIdx: number) => ('white'|'black')} resolveTeam マスの色の解決
 * @param {{ latStep: number, lngStep: number }} grid
 */
function buildWatchWindow(center, side, resolveTeam, grid) {
    const size = Number(side) >= 2 ? Math.min(31, Math.floor(Number(side))) : 9;
    const half = Math.floor(size / 2);
    const latStep = grid.latStep;
    const lngStep = grid.lngStep;
    const latIdx = Math.floor(center.lat / latStep);
    const lngIdx = Math.floor(center.lng / lngStep);
    const la = latIdx - half;
    const lo = lngIdx - half;

    let g = '';
    for (let row = 0; row < size; row += 1) {
        for (let col = 0; col < size; col += 1) {
            const team = resolveTeam(la + row, lo + col);
            g += team === 'white' ? '1' : (team === 'black' ? '2' : '0');
        }
    }
    return { v: 1, la, lo, n: size, you: [half, half], g };
}

class WatchBridgeClient {
    constructor(app) {
        this.app = app || null;
        this.side = 9;
        this.lastSentAt = 0;
        this.pending = null;
        this.timer = null;
        this.started = false;
        this.initRetryIndex = 0;
        this.initRetryTimer = null;
        this.listening = false;
    }

    available() {
        return !!watchPlugin();
    }

    /** 起動時に1回。Watchからの操作・ズーム要求を受け取る */
    init() {
        if (this.started) return false;
        this.started = true;

        this.attachListener();
        if (!this.send('init')) {
            // プラグインがまだ生えていない／地図の準備ができていない: 少しだけ粘る
            this.scheduleInitRetry();
        }
        // 歩いていない間も「今の状態」を保つため、30秒に1回は送る（電池負荷はごく小さい）
        if (!this.timer && typeof setInterval === 'function') {
            this.timer = setInterval(() => {
                if (!this.send('tick')) {
                    // まだグラフの準備ができていない等で送れなかった: もう一度だけ粘る
                    this.initRetryIndex = 0;
                    this.scheduleInitRetry();
                }
                this.flushPending();
            }, 30000);
            // Node（テスト）でプロセスが終わらないようにする。ブラウザでは unref が無いので何もしない
            if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
        }
        this.drainInbox();
        return this.available();
    }

    /** Watch からの command を購読（プラグインが後から生えた場合に備えて再実行できる） */
    attachListener() {
        const plugin = watchPlugin();
        if (!plugin || this.listening || typeof plugin.addListener !== 'function') return false;
        this.listening = true;
        plugin.addListener('command', (message) => this.handleCommand(message));
        return true;
    }

    /** 起動直後に送れなかったときの短い再試行 */
    scheduleInitRetry() {
        if (this.initRetryTimer || typeof setTimeout !== 'function') return false;
        if (this.initRetryIndex >= WATCH_INIT_RETRY_MS.length) return false;
        const wait = WATCH_INIT_RETRY_MS[this.initRetryIndex];
        this.initRetryIndex += 1;
        this.initRetryTimer = setTimeout(() => {
            this.initRetryTimer = null;
            this.attachListener();
            if (this.send('init')) return;
            this.scheduleInitRetry();
        }, wait);
        if (this.initRetryTimer && typeof this.initRetryTimer.unref === 'function') this.initRetryTimer.unref();
        return true;
    }

    /** 画面が戻ってきたとき（iPhone 側のアプリを開いた瞬間に Watch を追いつかせる） */
    onForeground() {
        this.attachListener();
        if (!this.started) this.init();
        this.send('foreground', { force: true });
    }

    handleCommand(message) {
        if (!message || !this.app) return;
        const app = this.app;
        if (message.cmd === 'toggle' && typeof app.setMarkingPaused === 'function') {
            // Watch は「marking（true=マーキングON / false=停止）」を送ってくるが、
            // iPhone 側の setMarkingPaused は「paused（true=停止 / false=ON）」を受ける。
            // そのまま渡すと真逆になり、ON のときに押しても切り替わらないので反転する。
            const nextPaused = typeof message.to === 'boolean' ? !message.to : !app.isMarkingPaused();
            app.setMarkingPaused(nextPaused, { source: 'watch' });
            this.send('toggle', { force: true });
        } else if (message.cmd === 'window') {
            const requested = Number(message.r);
            this.side = WATCH_WINDOW_SIDES[requested] || 9;
            this.send('window', { force: true });
        } else if (message.cmd === 'sync') {
            this.send('sync', { force: true });
        }
    }

    /** 現在地の窓データ（無ければ null） */
    buildPayload() {
        const app = this.app;
        const grid = app ? app.gridManager : null;
        if (!grid) return null;
        const pos = Array.isArray(app.virtualPos) ? app.virtualPos : null;
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return null;

        const center = { lat: pos[0], lng: pos[1] };
        const window = buildWatchWindow(
            center,
            this.side,
            (latIdx, lngIdx) => {
                const meshId = grid.getMeshId(latIdx, lngIdx);
                return grid.resolveTileTeam(meshId, latIdx, lngIdx);
            },
            { latStep: grid.LAT_GRID, lngStep: grid.LNG_GRID }
        );
        window.marking = !(typeof app.isMarkingPaused === 'function' && app.isMarkingPaused());
        return window;
    }

    send(reason, options) {
        const plugin = watchPlugin();
        if (!plugin || !this.app) return false;

        const force = !!(options && options.force === true);
        const now = Date.now();
        const minInterval = WATCH_SEND_THROTTLE_MS[reason] || 0;
        // 陣地獲得が続くとき・歩行中のGPS更新は間引く（Watchの描画と電池を守る）
        if (!force && minInterval > 0 && now - this.lastSentAt < minInterval) {
            this.pending = reason;
            return false;
        }
        this.lastSentAt = now;
        this.pending = null;

        const payload = this.buildPayload();
        if (!payload) return false;
        try {
            Promise.resolve(plugin.updateState(payload)).catch(() => {});
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 間引いて保留した1回分を、次の機会に必ず送る */
    flushPending() {
        if (!this.pending) return false;
        const reason = this.pending;
        this.pending = null;
        return this.send(reason, { force: true });
    }

    onStateChanged(reason) {
        this.send(reason || 'state');
    }

    /** Watch が溜めた記録（Phase 2 の単独記録）を既存の送信キューへ流し込む */
    async drainInbox() {
        const plugin = watchPlugin();
        const app = this.app;
        const queue = app ? (app.syncQueue || app.tileSyncQueue) : null;
        if (!plugin || !queue || typeof plugin.drainInbox !== 'function') return 0;

        try {
            const result = await plugin.drainInbox();
            const items = result && Array.isArray(result.items) ? result.items : [];
            let queued = 0;
            items.forEach((batch) => {
                (Array.isArray(batch) ? batch : []).forEach((tile) => {
                    if (!tile || typeof tile.t !== 'string') return;
                    queue.enqueue({
                        meshId: tile.t,
                        latIdx: Number(tile.la),
                        lngIdx: Number(tile.lo),
                        team: tile.team === 'white' || tile.team === 'black' ? tile.team : (app.currentTeam || 'black'),
                        weekId: tile.w,
                        updatedAt: tile.at
                    });
                    queued += 1;
                });
            });
            if (queued > 0 && typeof queue.flush === 'function') {
                Promise.resolve(queue.flush('watch-inbox')).catch(() => {});
            }
            return queued;
        } catch (e) {
            return 0;
        }
    }

    /** 陣地獲得・奪還の無音通知（Watchでは無音cafで手首に振動／端末では通知センターに残る） */
    notifyCapture(kind, body) {
        const plugin = watchPlugin();
        if (!plugin || typeof plugin.notifyCapture !== 'function') return false;
        try {
            Promise.resolve(plugin.notifyCapture({ kind: kind || 'claim', body: body || '' })).catch(() => {});
            return true;
        } catch (e) {
            return false;
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        WATCH_WINDOW_SIDES,
        WATCH_SEND_THROTTLE_MS,
        WATCH_INIT_RETRY_MS,
        buildWatchWindow,
        WatchBridgeClient
    };
}
