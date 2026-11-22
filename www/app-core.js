/**
 * TERRITORY WALK - app-core.js
 * 起動・トースト通知・陣営（チーム）・テーマ・DOM初期化
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは全体の土台（コンストラクタと共通UI）を持つ。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppCore {
    constructor() {
        this.map = null;
        this.currentTeam = 'black'; // 'white' or 'black'
        this.gridManager = null;
        this.supabaseManager = null;
        this.statsManager = null;
        this.proManager = null;
        this.posterGenerator = null;

        // v1.1: 非表示ピン / 月曜の結果通知 / Apple Watch 連携（未定義の環境では null のまま）
        this.privacyZones = null;
        this.weeklyNotifier = null;
        this.watchBridge = null;

        this.userMarker = null;
        this.watchId = null;
        // Web 測位の状態（高精度 → 低精度フォールバックの管理）
        this.webGeolocationMode = 'precise';
        this.webGeolocationAttempt = 0;
        this.webCoarseFallbackNotified = false;
        this.webCoarseAccuracyNotified = false;
        this.webUnavailableNotified = false;
        this.currentMeshId = null;
        this.virtualPos = [...CONFIG.DEFAULT_CENTER];
        // v1.1: 前回の現在地が保存されているなら、そちらを初期位置にする。
        // （毎回渋谷から始まらない。初回だけは渋谷を広域表示のフォールバックに使う）
        this.savedPosition = this.loadSavedPosition();
        if (this.savedPosition) this.virtualPos = [...this.savedPosition];
        // 実GPSの最新座標（デバッグの仮想散歩を終えたときに戻す先）
        this.lastRealPosition = null;
        // デバッグの白紙リセット直後の再マージ防止（grid.js が参照）
        this.territoryReset = null;
        // 全国（サーバー全体）の黒・白マス数。上部％バーは「この端末が読んだ範囲」ではなく
        // 「日本全体で実際に塗られたマス」を表示する（未取得・オフライン時はローカル集計へ戻す）。
        this.globalTeamCounts = { black: 0, white: 0, loaded: false, weekId: null, fetchedAt: 0 };
        this.globalCountsRequest = null;      // 取得中の Promise（多重リクエスト防止）
        this.globalCountsLastRequestAt = 0;   // 最後に要求した時刻（スロットル用）
        this.isMapVisible = true;
        this.isDebugMode = false;
        this.debugEnabled = CONFIG.ENABLE_DEBUG_TOOLS !== false;

        // 陣地マーキング（自動塗り）の ON/OFF。既定は ON（= false）。
        // 起動ゲート通過（startDeferredServices）より前に復元しておき、
        // 停止中なら位置情報ウォッチャーを最初から張らない。
        this.markingPaused = this.readMarkingPausePreference();
        // 省電力モード（v1.2）。distanceFilter と静止中の再処理しきい値を切り替える。
        // 既定は OFF（40m）。トグルは MENU の中（initPowerSaveToggle）。
        this.powerSaveMode = this.readPowerSavePreference();
        // 測位ウォッチャーを開始済みか（停止→再開で二重起動しないためのフラグ）
        this.geolocationStarted = false;
        // 画面表示中だけ動く定期処理のタイマー ID（非表示中は null）
        this.remoteTilesPollTimer = null;
        this.resetCountdownTimer = null;
        // リセットまでのカウントダウンを即時更新する関数（initResetCountdown が差し込む）
        this.updateResetCountdown = null;
        // 週明けの結果表を出した週（同じ週で何度も重ねないためのガード）
        this.weeklyResultShownWeek = null;
        // 復帰時の陣地取り直しを連打で重ねないための最終実行時刻
        this.lastForegroundRefreshAt = 0;

        // Background location & iOS optimization state
        // ネイティブのバックグラウンド位置情報（watcher は常に1本だけ）
        this.backgroundGeolocationPlugin = null;
        this.backgroundWatcherId = null;
        this.backgroundWatcherStarted = false;
        // ネイティブの Capacitor Geolocation プラグイン（Web では常に null）
        this.nativeGeolocationPlugin = null;
        this.nativeWatchId = null;
        this.nativeGeolocationAttempt = 0;
        this.lastProcessedLat = null;
        this.lastProcessedLng = null;
        this.backgroundClaimCount = 0;
        this.isAppInBackground = false;

        // 起動ゲート（初回はルール説明の「ゲームをはじめる」まで位置情報・ATTを待機）
        this.startupGate = null;
        this.servicesStarted = false;
        this.servicesStartedBy = null;

        // Initialize managers
        this.proManager = new ProManager();
        this.posterGenerator = new PosterGenerator(this);
        this.supabaseManager = new SupabaseManager();
        this.statsManager = new StatsManager(this.supabaseManager, this);
        this.coinManager = new CoinManager(this, this.supabaseManager);
        this.searchManager = new SearchManager(this);
        this.adMobManager = new AdMobManager(this, { deferInit: true });
        this.iapManager = new IAPManager(this);

        // オフライン陣地の一時保存キュー（送信失敗分もここに退避される）
        if (typeof TileSyncQueue !== 'undefined') {
            this.syncQueue = new TileSyncQueue(this);
            this.syncQueue.onChange = (count, offline, flushing) => this.updateSyncQueueBadge(count, offline, flushing);
        }

        this.initToastSystem();
        // iOS Keychain から匿名IDを復元した場合は一度だけ知らせる
        if (typeof window !== 'undefined' && window.__twIdentityBootstrap && window.__twIdentityBootstrap.restored) {
            setTimeout(() => {
                this.showToast('前回のデータを復元しました', 'アプリを削除しても同じユーザーIDで続けられます');
            }, 1600);
        }
        this.initTeam();
        this.initDOM();
        this.initMap();
        this.initGrid();
        this.initPrivacyZones();
        this.initSkinSelector();
        this.initMapThemeSelector();
        this.initStatsModal();
        // 画面上部の％バー（#battle-bar-container）タップで「今週の戦況詳細」を開く
        this.initWeeklyBattleDetail();
        this.initWeeklyResultModal();
        this.initWeeklyResultNotifier();
        this.initProModal();
        this.initExportButton();
        // 初回起動はルール説明の「ゲームをはじめる」まで位置情報・ATTの許可要求を待たせる
        this.initStartupGate();
        this.initLifecycleListeners();
        this.applyDebugToolsVisibility();
        this.initDPad();
        this.initEvents();
        this.initResetCountdown();
        this.initRealtimeSync();

        // Check Daily Login Bonus
        const bonus = this.statsManager.checkDailyLoginBonus();
        if (bonus.isNew) {
            if (this.coinManager) {
                const bonusCoins = Math.min(500, 200 + (bonus.streak - 1) * 50);
                this.coinManager.addCoins(bonusCoins, `連続ログイン ${bonus.streak}日目ボーナス`);
            }
            setTimeout(() => {
                this.showToast(`DAILY BONUS: 連続ログイン ${bonus.streak}日目達成！`);
            }, 1200);
        }

        // Check Season / Weekly Reset Result
        this.checkWeeklyResetResult();

        // 他プレイヤーの陣地のポーリング（画面が見えている間だけ動く）
        this.startRemoteTilesPolling();

        // 前回オフライン中に溜まった未送信分を起動時に再送
        setTimeout(() => {
            if (this.syncQueue) {
                this.syncQueue.notify();
                this.syncQueue.flush('startup');
            }
        }, 2000);
    }

    updateSyncQueueBadge(count, offline, flushing) {
        const badge = document.getElementById('sync-queue-badge');
        const labelEl = document.getElementById('sync-queue-count');
        const dot = document.getElementById('sync-queue-dot');
        if (!badge || !labelEl) return;

        let label = '';
        if (offline) {
            label = count > 0 ? `オフライン ${count}マス未送信` : 'オフライン';
        } else if (count > 0) {
            label = flushing ? `同期中 ${count}マス` : `${count}マス同期待ち`;
        }

        if (label) {
            labelEl.textContent = label;
            badge.classList.remove('hidden');
            badge.classList.add('flex');
            if (dot) {
                dot.className = offline
                    ? 'w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse'
                    : 'w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse';
            }
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('flex');
        }
    }

    enqueueTileSync(meshId, latIdx, lngIdx, team) {
        if (!this.syncQueue) return;
        const weekId = this.supabaseManager ? this.supabaseManager.getCurrentWeekId() : '';
        this.syncQueue.enqueue({ meshId, latIdx, lngIdx, team, weekId });
        if (!this.syncQueue.isOffline()) {
            // 送信中に積まれた分（D-Padの連打等）は次回リトライで確実に送る
            Promise.resolve(this.syncQueue.flush('tile-claim'))
                .then((res) => {
                    if (res && res.skipped && typeof this.syncQueue.scheduleRetry === 'function') {
                        this.syncQueue.scheduleRetry();
                    }
                })
                .catch(() => {});
        }
    }

    initToastSystem() {
        this.toastQueue = [];
        this.toastTimer = null;
        this.setupModalObservers();
    }

    isAnyModalOpen() {
        const modalIds = [
            'shop-modal',
            'menu-modal',
            'privacy-modal',
            'rules-modal',
            'stats-modal',
            'weekly-result-modal',
            'team-reset-modal',
            'team-decision-modal',
            'pro-modal',
            'reward-ad-modal'
        ];
        for (const id of modalIds) {
            const el = document.getElementById(id);
            if (el && !el.classList.contains('hidden')) {
                return true;
            }
        }
        return false;
    }

    setupModalObservers() {
        const modalIds = [
            'shop-modal',
            'menu-modal',
            'privacy-modal',
            'rules-modal',
            'stats-modal',
            'weekly-result-modal',
            'team-reset-modal',
            'team-decision-modal',
            'pro-modal',
            'reward-ad-modal'
        ];
        modalIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                const observer = new MutationObserver(() => {
                    if (el.classList.contains('hidden')) {
                        // モーダルが閉じられたら少し間を置いて溜まっていたキューを順次表示
                        setTimeout(() => {
                            if (!this.isAnyModalOpen()) this.flushToastQueue();
                        }, 250);
                    } else {
                        // メニューを優先: モーダルが開いたら表示中のトーストを退ける
                        this.clearToasts();
                    }
                });
                observer.observe(el, { attributes: true, attributeFilter: ['class'] });
            }
        });
    }

    /** 表示中のトーストを即座に消す（モーダル優先のため） */
    clearToasts() {
        if (this.toastTimer) {
            clearTimeout(this.toastTimer);
            this.toastTimer = null;
        }
        const container = document.getElementById('toast-container');
        if (container) container.innerHTML = '';
    }

    showToast(message, subtitle = null) {
        if (!message) return;

        // モーダル表示中の場合は画面に出さずキューに蓄積（同一内容の重複は抑止）
        if (this.isAnyModalOpen()) {
            const isDup = this.toastQueue.some(t => t.message === message && t.subtitle === subtitle);
            if (!isDup) {
                this.toastQueue.push({ message, subtitle });
            }
            return;
        }

        this.renderToast(message, subtitle);
    }

    renderToast(message, subtitle = null) {
        // メニュー優先: モーダル表示中はトーストを出さない
        if (this.isAnyModalOpen()) return;

        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'fixed left-1/2 -translate-x-1/2 z-[1500] flex flex-col items-center gap-2 pointer-events-none max-w-[92vw] w-max';
            document.body.appendChild(container);
        }

        // ヘッダー（検索バー含む）の直下に配置し、被りを防止
        this.positionToastContainer(container);

        // 連続スタック防止: 常に最新1件のみ表示
        container.innerHTML = '';
        if (this.toastTimer) {
            clearTimeout(this.toastTimer);
            this.toastTimer = null;
        }

        const toast = document.createElement('div');
        toast.className = 'bg-zinc-950/95 border border-amber-500/80 text-amber-300 text-xs font-mono px-4 py-2 rounded-xl shadow-2xl backdrop-blur-md pointer-events-none text-center flex flex-col items-center transition-all duration-300 max-w-[92vw] box-border';
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';

        // 文言は innerHTML ではなく textContent で入れる（商品名などに HTML が
        // 混ざってもタグとして解釈させない）。`\n` は pre-line で改行として描画する。
        if (subtitle) {
            toast.appendChild(this.createToastLine(message, 'font-bold text-xs text-white leading-tight break-keep max-w-full'));
            toast.appendChild(this.createToastLine(subtitle, 'text-[11px] text-amber-400 mt-0.5 leading-tight break-keep max-w-full'));
        } else {
            toast.appendChild(this.createToastLine(message, 'font-bold text-xs text-amber-300 leading-tight break-keep max-w-full'));
        }

        container.appendChild(toast);

        // 3.5秒後にフェードアウト＆DOM削除
        this.toastTimer = setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-10px)';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 350);
        }, 3500);
    }

    /**
     * トーストの1行分を組み立てる。
     * 文字列は必ず textContent で入れる（XSS 安全）。`\n` は white-space:
     * pre-line で改行として描画されるので、呼び出し側が改行位置を決められる。
     * break-keep（word-break: keep-all）で日本語を語の途中で折らない。
     */
    createToastLine(text, className) {
        const line = document.createElement('div');
        line.className = className;
        line.style.whiteSpace = 'pre-line';
        line.textContent = text == null ? '' : String(text);
        return line;
    }

    /**
     * トーストをヘッダー（検索バー）直下に配置する。
     * セーフエリアや回転でヘッダー高さが変わっても被らないよう実測する。
     */
    positionToastContainer(container) {
        if (!container) return;
        let top = 160;
        try {
            const header = document.querySelector('header');
            if (header) {
                const rect = header.getBoundingClientRect();
                top = Math.round(rect.bottom + 12);
            }
            // 位置情報拒否バナーが表示中なら、その下にトーストを回す（重なり防止）
            const banner = document.getElementById('location-permission-banner');
            if (banner && !banner.classList.contains('hidden')) {
                const bannerRect = banner.getBoundingClientRect();
                if (bannerRect && bannerRect.height > 0) {
                    top = Math.max(top, Math.round(bannerRect.bottom + 10));
                }
            }
            // マーキング一時停止バーも同じく考慮する（バーの直下に出す）
            const markingBanner = document.getElementById('marking-paused-banner');
            if (markingBanner && !markingBanner.classList.contains('hidden')) {
                const markingRect = markingBanner.getBoundingClientRect();
                if (markingRect && markingRect.height > 0) {
                    top = Math.max(top, Math.round(markingRect.bottom + 10));
                }
            }
            // 表示名（ニックネーム）バナーも同じ場所に並ぶので、その下へ回す
            const nicknameBanner = document.getElementById('nickname-banner');
            if (nicknameBanner && !nicknameBanner.classList.contains('hidden')) {
                const nicknameRect = nicknameBanner.getBoundingClientRect();
                if (nicknameRect && nicknameRect.height > 0) {
                    top = Math.max(top, Math.round(nicknameRect.bottom + 10));
                }
            }
        } catch (e) { /* fallback */ }
        container.style.top = `${Math.max(top, 96)}px`;
    }

    /** バナー表示・非表示の切替時にトースト位置を追従させる */
    repositionToastContainer() {
        const container = document.getElementById('toast-container');
        if (container) this.positionToastContainer(container);
    }

    flushToastQueue() {
        if (!this.toastQueue || this.toastQueue.length === 0) return;
        if (this.isAnyModalOpen()) return;

        // 最新1件のみを表示（積み重なり防止）
        const latest = this.toastQueue[this.toastQueue.length - 1];
        this.toastQueue = [];
        setTimeout(() => {
            if (!this.isAnyModalOpen()) {
                this.renderToast(latest.message, latest.subtitle);
            } else {
                this.toastQueue.push(latest);
            }
        }, 120);
    }

    async initTeam() {
        let savedTeam = localStorage.getItem('player_team');
        if (!savedTeam || (savedTeam !== 'white' && savedTeam !== 'black')) {
            // 初回起動（新規ユーザー）: 人数の少ないチームへ自動配属。
            // 同数・オフライン・集計失敗は 50% ランダムにフォールバックする。
            savedTeam = await this.decideInitialTeam();
            localStorage.setItem('player_team', savedTeam);
        }
        this.currentTeam = savedTeam;
        this.applyTheme();
        this.updateTeamStatusUI();
        // チーム決定画面が既に開いている場合（初回起動で通信を待たずに進んだ場合）は描き直す
        if (this.teamDecisionModalShown && this.teamDecisionModal) {
            this.showTeamDecisionModal();
        }
        // 匿名ID・チームを Keychain（Web は localStorage）へ控える
        this.persistIdentity();
        // 初回起動でも territory_users に行を作り、引き継ぎコードを登録できるようにする
        if (this.statsManager && typeof this.statsManager.syncUserProfileImmediate === 'function') {
            Promise.resolve(this.statsManager.syncUserProfileImmediate()).catch(() => {});
        }
    }

    /**
     * 初回起動時のチーム決定。
     *   1. URL の ?team=black|white を優先（デバッグ・共有リンク）
     *   2. territory_users の黒・白の人数を比べ、少ない方へ配属
     *   3. 同数・オフライン・集計失敗は 50% ランダム
     * @returns {Promise<'black'|'white'>}
     */
    async decideInitialTeam() {
        this.teamAssignedByBalance = false;

        try {
            const urlParams = new URLSearchParams(window.location.search);
            const teamParam = urlParams.get('team');
            if (teamParam === 'white' || teamParam === 'black') return teamParam;
        } catch (e) { /* URL が読めない環境では無視 */ }

        try {
            const counts = this.supabaseManager && typeof this.supabaseManager.fetchUserTeamCounts === 'function'
                ? await this.supabaseManager.fetchUserTeamCounts()
                : null;
            const balanced = typeof chooseBalancedTeam === 'function'
                ? chooseBalancedTeam(counts)
                : TerritoryWalkApp.chooseBalancedTeam(counts);
            if (balanced === 'black' || balanced === 'white') {
                this.teamAssignedByBalance = true;
                this.teamBalanceCounts = counts;
                return balanced;
            }
        } catch (e) {
            console.warn('[Team] Balanced assignment skipped:', e);
        }

        return Math.random() < 0.5 ? 'white' : 'black';
    }

    /** 人数の少ないチームを選ぶ（supabase.js 未読込時のための同内容フォールバック） */
    static chooseBalancedTeam(counts) {
        if (!counts || typeof counts !== 'object') return null;
        const black = Number(counts.black);
        const white = Number(counts.white);
        if (!Number.isFinite(black) || !Number.isFinite(white) || black < 0 || white < 0) return null;
        if (black === white) return null;
        return black < white ? 'black' : 'white';
    }

    /** identity.js 未読込でも落ちないようにするためのストレージキー定義 */
    static identityKeys() {
        if (typeof TW_IDENTITY_STORAGE_KEYS !== 'undefined' && TW_IDENTITY_STORAGE_KEYS) {
            return TW_IDENTITY_STORAGE_KEYS;
        }
        return {
            userId: 'tw_user_id',
            team: 'player_team',
            nickname: 'tw_nickname',
            transferCode: 'tw_transfer_code'
        };
    }

    /**
     * 匿名ID・チーム・表示名・引き継ぎコードを Keychain（Web は localStorage）へ保存する。
     * 失敗してもゲーム進行は止めない。
     */
    persistIdentity() {
        if (typeof TWIdentity === 'undefined' || !TWIdentity || typeof TWIdentity.persistCurrent !== 'function') return;
        try {
            const storage = (typeof localStorage !== 'undefined') ? localStorage : null;
            TWIdentity.persistCurrent({
                userId: this.statsManager ? this.statsManager.userId : (storage ? storage.getItem('tw_user_id') : null),
                team: this.currentTeam,
                nickname: storage ? storage.getItem('tw_nickname') : null,
                transferCode: this.statsManager && typeof this.statsManager.getOrCreateTransferCode === 'function'
                    ? this.statsManager.getOrCreateTransferCode()
                    : (storage ? storage.getItem('tw_transfer_code') : null)
            });
        } catch (e) {
            console.warn('[Identity] persist skipped:', e);
        }
    }

    isUnderdogTeam() {
        // 劣勢判定も上部％バーと同じ数字（全国集計）で行う。未取得時はローカル集計。
        let blackCount = 0;
        let whiteCount = 0;
        if (!this.gridManager && !(this.globalTeamCounts && this.globalTeamCounts.loaded)) return false;
        const counts = this.getScoreCounts();
        blackCount = counts.black;
        whiteCount = counts.white;
        const total = blackCount + whiteCount;
        if (total === 0) return false;
        const myCount = this.currentTeam === 'black' ? blackCount : whiteCount;
        const myPct = Math.round((myCount / total) * 100);
        return myPct <= 40;
    }

    updateTeamStatusUI() {
        const teamInfoEl = document.getElementById('menu-current-team-info');
        if (teamInfoEl) {
            const teamName = this.currentTeam === 'black' ? 'Black (黒)' : 'White (白)';
            teamInfoEl.textContent = teamName;
        }
        const underdogEl = document.getElementById('menu-underdog-status');
        if (underdogEl) {
            const isUnderdog = this.isUnderdogTeam();
            underdogEl.textContent = isUnderdog ? '劣勢逆転ボーナス発動中 (コイン2倍)' : '通常 (陣地40%以下で2倍発動)';
            underdogEl.className = isUnderdog ? 'text-amber-400 font-bold' : 'text-zinc-400';
        }
    }

    updateAutoBalanceUI() {
        this.updateTeamStatusUI();
    }

    applyTheme() {
        document.body.dataset.theme = this.currentTeam;
        this.renderTeamBadge();
        this.updateSwapButtonUI();
    }

    initDOM() {
        this.scoreBlackEl = document.getElementById('score-black');
        this.scoreWhiteEl = document.getElementById('score-white');
        this.barBlackEl = document.getElementById('bar-black');
        this.barWhiteEl = document.getElementById('bar-white');
        this.gpsDot = document.getElementById('gps-dot');
        this.teamBadgeContainer = document.getElementById('team-badge');
        this.menuTeamText = document.getElementById('menu-team-text');

        this.rulesModal = document.getElementById('rules-modal');
        this.menuModal = document.getElementById('menu-modal');
        this.btnOpenRules = document.getElementById('btn-open-rules');
        this.btnCloseRules = document.getElementById('btn-close-rules');
        this.teamDecisionModal = document.getElementById('team-decision-modal');
        this.teamDecisionBadge = document.getElementById('team-decision-badge');
        this.teamDecisionSymbol = document.getElementById('team-decision-symbol');
        this.teamDecisionName = document.getElementById('team-decision-name');
        this.teamDecisionDescription = document.getElementById('team-decision-description');
        this.btnStartGame = document.getElementById('btn-start-game');
        this.btnMenu = document.getElementById('btn-menu');
        this.btnCloseMenu = document.getElementById('btn-close-menu');
        this.btnModalCloseIcon = document.getElementById('btn-modal-close-icon');

        this.btnToggleMap = document.getElementById('btn-toggle-map');
        this.mapToggleDot = document.getElementById('map-toggle-dot');
        this.mapToggleText = document.getElementById('map-toggle-text');

        this.btnToggleDebug = document.getElementById('btn-toggle-debug');
        this.debugToggleDot = document.getElementById('debug-toggle-dot');
        this.debugToggleText = document.getElementById('debug-toggle-text');
        this.dpadContainer = document.getElementById('dpad-container');

        this.btnRecenter = document.getElementById('btn-recenter');
        this.btnMarkingToggle = document.getElementById('btn-marking-toggle');
        this.markingPausedBanner = document.getElementById('marking-paused-banner');
        this.btnMarkingResume = document.getElementById('btn-marking-resume');
        this.markingToggleLabel = document.getElementById('marking-toggle-label');
        this.btnTogglePowerSave = document.getElementById('btn-toggle-power-save');
        this.powerSaveDot = document.getElementById('power-save-dot');
        this.powerSaveText = document.getElementById('power-save-text');
        this.powerSaveDetail = document.getElementById('power-save-detail');
        this.btnSwapTeam = document.getElementById('btn-swap-team');
        this.swapTeamIcon = document.getElementById('swap-team-icon');
        this.swapTeamText = document.getElementById('swap-team-text');

        this.initRulesModal();
        this.initTeamDecisionModal();
        this.initMenuModal();
        // 引き継ぎコード（機種変更・再インストール対策）の表示と入力
        this.initTransferCodeUI();
        // マーキング ON/OFF トグル（前回状態の復元 → UI反映 → 操作の配線）
        this.initMarkingToggle();
        // 省電力モードのトグル（v1.2・前回状態の復元 → UI反映 → 操作の配線）
        this.initPowerSaveToggle();
    }

    renderTeamBadge() {
        const isPro = this.isProActive();
        const supporterBadge = isPro ? this.proManager.getSupporterBadgeHtml() : '';

        // 対戦バー上部の「YOU」インジケーターを左上に完全固定 ＆ 対戦バーの自陣営「左側」固定
        const youIndicator = document.getElementById('you-indicator');
        const barContainer = document.getElementById('battle-bar-container');
        // v1.1: PRO SUPPORTER は2段目の右端（MENU の下の空き）へ右寄せで置く。
        //       非表示のときも YOU が左端に残るよう、別の入れ物に入れる。
        const proBadgeSlot = document.getElementById('pro-badge-slot');

        if (this.currentTeam === 'white') {
            if (youIndicator) {
                youIndicator.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-[9px] tracking-wider font-mono">YOU (白陣営)</span>`;
            }
            if (barContainer) {
                barContainer.className = 'w-full h-7 bg-zinc-950 rounded-xl overflow-hidden flex flex-row-reverse border border-zinc-700 shadow-inner relative';
            }
            if (this.barWhiteEl) {
                this.barWhiteEl.className = 'bg-white border-r border-zinc-400 transition-all duration-500 flex items-center justify-center overflow-hidden shrink-0';
            }
            if (this.barBlackEl) {
                this.barBlackEl.className = 'bg-black transition-all duration-500 flex items-center justify-center overflow-hidden shrink-0';
            }
            if (this.menuTeamText) this.menuTeamText.textContent = 'White Team';
        } else {
            if (youIndicator) {
                youIndicator.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-[9px] tracking-wider font-mono">YOU (黒陣営)</span>`;
            }
            if (barContainer) {
                barContainer.className = 'w-full h-7 bg-zinc-950 rounded-xl overflow-hidden flex flex-row border border-zinc-700 shadow-inner relative';
            }
            if (this.barBlackEl) {
                this.barBlackEl.className = 'bg-black border-r border-zinc-600 transition-all duration-500 flex items-center justify-center overflow-hidden shrink-0';
            }
            if (this.barWhiteEl) {
                this.barWhiteEl.className = 'bg-white transition-all duration-500 flex items-center justify-center overflow-hidden shrink-0';
            }
            if (this.menuTeamText) this.menuTeamText.textContent = 'Black Team';
        }

        if (proBadgeSlot) {
            proBadgeSlot.innerHTML = supporterBadge;
        }

        if (this.teamBadgeContainer) {
            if (this.currentTeam === 'white') {
                this.teamBadgeContainer.innerHTML = `
                    ${supporterBadge}
                    <span class="w-2.5 h-2.5 rounded-full bg-white border border-zinc-300"></span>
                    <span class="text-zinc-100 font-bold">White</span>
                `;
            } else {
                this.teamBadgeContainer.innerHTML = `
                    ${supporterBadge}
                    <span class="w-2.5 h-2.5 rounded-full bg-black border border-zinc-500 shadow-sm"></span>
                    <span class="text-zinc-100 font-bold">Black</span>
                `;
            }
        }
    }

    updateSwapButtonUI() {
        if (!this.swapTeamIcon || !this.swapTeamText) return;

        if (this.currentTeam === 'black') {
            this.swapTeamIcon.className = 'w-2 h-2 rounded-full bg-white';
            this.swapTeamText.textContent = 'SWAP: Whiteへ切替';
        } else {
            this.swapTeamIcon.className = 'w-2 h-2 rounded-full bg-black border border-zinc-300';
            this.swapTeamText.textContent = 'SWAP: Blackへ切替';
        }
    }
}
