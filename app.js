/**
 * TERRITORY WALK - app.js
 * Core Application Controller, Geolocation, Real-time Grid Updates & Supabase Sync
 */

const CONFIG = {
    DEFAULT_CENTER: [35.658034, 139.701636], // 渋谷（フォールバック座標。前回の現在地が無い初回起動で使う）
    DEFAULT_ZOOM: 17,
    // 前回の現在地が無い初回起動の初期倍率（日本全体が見える広域表示で測位を待つ）
    WIDE_ZOOM: 5,
    MIN_ZOOM: 2,
    MAX_ZOOM: 20,
    // 広域表示（低ズーム）時のDB取得・描画を抑制するしきい値
    REMOTE_FETCH_MIN_ZOOM: 12,
    TILE_RENDER_MIN_ZOOM: 5,
    MAX_TILES_PER_RENDER: 1200,
    // デバッグ機能（D-PAD・コイン操作・プレビュー・チーム切替等）のマスタースイッチ
    // App Store 提出ビルドのため false（UIごと非表示になり、AdMob も本番IDへ自動切替）
    ENABLE_DEBUG_TOOLS: false
};

// 画面消灯・ロック中も測位を続けるネイティブプラグイン（Capacitor 6 互換）
// 陣地マーキング（自動塗り）の ON/OFF を保存するキー。
// 停止中にアプリを終了→再起動したときに、一瞬でも塗ってしまわないよう起動前に読む。
const MARKING_PAUSE_STORAGE_KEY = 'tw_marking_paused';
const BACKGROUND_GEOLOCATION_PLUGIN_NAME = 'BackgroundGeolocation';
const BACKGROUND_GEOLOCATION_OPTIONS = {
    // backgroundMessage を定義すると、画面消灯・バックグラウンド中も位置更新が届く
    backgroundMessage: '画面を消灯しても陣地を塗り続けます',
    backgroundTitle: 'テリトリーウォーク',
    requestPermissions: true,
    // 古い測位結果で別のマスを塗らないようにする
    stale: false,
    // 100mマスを取りこぼさず、電池消費も抑える距離フィルタ（m）
    distanceFilter: 20
};

class TerritoryWalkApp {
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
        this.isMapVisible = true;
        this.isDebugMode = false;
        this.debugEnabled = CONFIG.ENABLE_DEBUG_TOOLS !== false;

        // 陣地マーキング（自動塗り）の ON/OFF。既定は ON（= false）。
        // 起動ゲート通過（startDeferredServices）より前に復元しておき、
        // 停止中なら位置情報ウォッチャーを最初から張らない。
        this.markingPaused = this.readMarkingPausePreference();
        // 測位ウォッチャーを開始済みか（停止→再開で二重起動しないためのフラグ）
        this.geolocationStarted = false;

        // Background location & iOS optimization state
        // ネイティブのバックグラウンド位置情報（watcher は常に1本だけ）
        this.backgroundGeolocationPlugin = null;
        this.backgroundWatcherId = null;
        this.backgroundWatcherStarted = false;
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
        this.initTeam();
        this.initDOM();
        this.initMap();
        this.initGrid();
        this.initPrivacyZones();
        this.initSkinSelector();
        this.initMapThemeSelector();
        this.initStatsModal();
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

        // Periodic polling fallback (every 8s) to ensure other players' tiles appear even without map drag
        setInterval(() => {
            this.loadRemoteTiles();
        }, 8000);

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
            const urlParams = new URLSearchParams(window.location.search);
            const teamParam = urlParams.get('team');
            if (teamParam === 'white' || teamParam === 'black') {
                savedTeam = teamParam;
            } else {
                savedTeam = Math.random() < 0.5 ? 'white' : 'black';
            }
            localStorage.setItem('player_team', savedTeam);
        }
        this.currentTeam = savedTeam;
        this.applyTheme();
        this.updateTeamStatusUI();
    }

    isUnderdogTeam() {
        if (!this.gridManager) return false;
        let blackCount = 0;
        let whiteCount = 0;
        for (const team of this.gridManager.claimedTilesCache.values()) {
            if (team === 'black') blackCount++;
            else if (team === 'white') whiteCount++;
        }
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
        this.btnSwapTeam = document.getElementById('btn-swap-team');
        this.swapTeamIcon = document.getElementById('swap-team-icon');
        this.swapTeamText = document.getElementById('swap-team-text');

        this.initRulesModal();
        this.initTeamDecisionModal();
        this.initMenuModal();
        // マーキング ON/OFF トグル（前回状態の復元 → UI反映 → 操作の配線）
        this.initMarkingToggle();
    }

    renderTeamBadge() {
        const isPro = this.isProActive();
        const supporterBadge = isPro ? this.proManager.getSupporterBadgeHtml() : '';

        // 対戦バー上部の「YOU」インジケーターを左上に完全固定 ＆ 対戦バーの自陣営「左側」固定
        const youIndicator = document.getElementById('you-indicator');
        const barContainer = document.getElementById('battle-bar-container');

        if (this.currentTeam === 'white') {
            if (youIndicator) {
                youIndicator.innerHTML = `${supporterBadge}<span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-[9px] tracking-wider font-mono">YOU (白陣営)</span>`;
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
                youIndicator.innerHTML = `${supporterBadge}<span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-[9px] tracking-wider font-mono">YOU (黒陣営)</span>`;
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

    initMap() {
        // 前回の現在地があればそこを中心に開く。無ければ広域表示で測位を待つ。
        const startCenter = this.savedPosition || CONFIG.DEFAULT_CENTER;
        const startZoom = this.savedPosition ? CONFIG.DEFAULT_ZOOM : CONFIG.WIDE_ZOOM;
        this.map = L.map('map', {
            center: startCenter,
            zoom: startZoom,
            minZoom: CONFIG.MIN_ZOOM,
            maxZoom: CONFIG.MAX_ZOOM,
            zoomControl: false,
            attributionControl: false,
            // ズームアウト時に世界地図が横方向に繰り返さないように1枚で収める
            worldCopyJump: false,
            maxBounds: [[-85, -180], [85, 180]],
            maxBoundsViscosity: 1.0,
            bounceAtZoomLimits: false
        });

        // Dark-inverted OpenStreetMap tile layer (100% free, no API key required)
        this.tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            noWrap: true,
            bounds: [[-85, -180], [85, 180]],
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(this.map);

        const savedMapTheme = localStorage.getItem('tw_map_theme') || 'dark';
        const mapContainer = document.getElementById('map');
        if (savedMapTheme === 'none') {
            if (mapContainer) mapContainer.classList.add('map-tiles-hidden');
            this.isMapVisible = false;
        } else {
            if (mapContainer) mapContainer.classList.remove('map-tiles-hidden');
            this.isMapVisible = true;
        }

        this.updateMapVisibilityUI();
        if (this.savedPosition) {
            // 前回の現在地にピン（測位が取れたら handlePositionUpdate が更新する）
            this.updatePlayerMarker(this.savedPosition);
        } else {
            // 初回起動: 渋谷に自分のピンを刺さず、測位が取れてから現在地へ飛ぶ
            this.updatePlayerMarker(CONFIG.DEFAULT_CENTER);
            this.hidePlayerMarker();
        }

        // Sync tiles on map pan/zoom
        this.map.on('moveend', () => {
            this.loadRemoteTiles();
        });
    }

    initGrid() {
        if (typeof GridManager !== 'undefined') {
            this.gridManager = new GridManager(this.map, this);
            this.loadRemoteTiles();
        } else {
            console.warn('GridManager is not defined.');
        }
    }

    /**
     * v1.1: 非表示ピン（プライバシーゾーン）。
     * 端末内（localStorage）だけで完結し、サーバーには何も送らない。
     */
    initPrivacyZones() {
        if (typeof PrivacyZoneManager === 'undefined') return;
        try {
            this.privacyZones = new PrivacyZoneManager(this);
            this.privacyZones.initUI();
            this.renderPrivacySummary();
        } catch (e) {
            console.warn('Failed to initialize privacy zones:', e);
            this.privacyZones = null;
        }
    }

    /** メニュー内の「非表示ピン」の件数表示 */
    renderPrivacySummary() {
        const el = document.getElementById('privacy-summary-text');
        if (!el || !this.privacyZones) return;
        const count = this.privacyZones.getZones().length;
        el.textContent = count > 0 ? `${count}件登録中（端末内のみ）` : '未登録';
    }

    /** 地図タップで中心を指定するときに、開いている画面を閉じる */
    closeModalsForPrivacyPick() {
        ['menu-modal', 'privacy-modal'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
    }

    /** v1.1: 月曜リセット後の結果発表を、音を出さずに知らせるローカル通知 */
    initWeeklyResultNotifier() {
        if (typeof WeeklyResultNotifier === 'undefined') return;
        try {
            this.weeklyNotifier = new WeeklyResultNotifier(this);
            this.weeklyNotifier.bindUI();
            this.weeklyNotifier.renderUI();
        } catch (e) {
            console.warn('Failed to initialize weekly notifier:', e);
            this.weeklyNotifier = null;
        }
    }

    /** v1.1: Apple Watch（コンパニオン）への状態送出。プラグインが無い環境では何もしない */
    initWatchBridge() {
        if (this.watchBridge || typeof WatchBridgeClient === 'undefined') return;
        try {
            this.watchBridge = new WatchBridgeClient(this);
            this.watchBridge.init();
        } catch (e) {
            console.warn('Failed to initialize watch bridge:', e);
            this.watchBridge = null;
        }
    }

    async loadRemoteTiles() {
        if (!this.gridManager) return;
        await this.gridManager.fetchAndSyncTiles();
        this.updateScoreUI();
    }

    initSkinSelector() {
        const savedSkin = localStorage.getItem('territory_skin') || 'default';
        document.body.dataset.skin = savedSkin;
        this.updateSkinBadge(savedSkin);

        const skinButtons = document.querySelectorAll('.skin-btn');
        skinButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetSkin = e.currentTarget.dataset.skin;

                if (this.coinManager && !this.coinManager.isSkinUnlocked(targetSkin)) {
                    this.coinManager.promptUnlockSkin(targetSkin);
                    return;
                }

                document.body.dataset.skin = targetSkin;
                localStorage.setItem('territory_skin', targetSkin);
                this.updateSkinBadge(targetSkin);
                this.updateCycleSkinButtonUI();

                if (this.gridManager) {
                    this.gridManager.redrawTiles();
                }
                this.showToast(`テーマを変更しました`);
                if (this.coinManager) this.coinManager.updateSkinButtonsUI();
            });
        });

        if (this.coinManager) this.coinManager.updateSkinButtonsUI();
    }

    cycleSkin() {
        const allSkins = ['default', 'neon', 'gold', 'crimson', 'sakura', 'pixel', 'cyberpunk', 'monochrome'];
        const unlocked = allSkins.filter(s => !this.coinManager || this.coinManager.isSkinUnlocked(s));
        const current = document.body.dataset.skin || 'default';
        const nextIdx = (unlocked.indexOf(current) + 1) % unlocked.length;
        const nextSkin = unlocked[nextIdx] || 'default';

        document.body.dataset.skin = nextSkin;
        localStorage.setItem('territory_skin', nextSkin);
        this.updateSkinBadge(nextSkin);
        this.updateCycleSkinButtonUI();

        if (this.gridManager) {
            this.gridManager.redrawTiles();
        }
        if (this.coinManager) this.coinManager.updateSkinButtonsUI();
    }

    updateCycleSkinButtonUI() {
        const textEl = document.getElementById('cycle-skin-text');
        if (!textEl) return;
        const skin = document.body.dataset.skin || 'default';
        const labels = {
            default: 'SKIN: 標準',
            neon: 'SKIN: ネオン',
            gold: 'SKIN: ゴールド',
            crimson: 'SKIN: クリムゾン',
            sakura: 'SKIN: サクラ',
            pixel: 'SKIN: レトロ',
            cyberpunk: 'SKIN: サイバー',
            monochrome: 'SKIN: モノトーン'
        };
        textEl.textContent = labels[skin] || 'SKIN: ' + skin;
    }

    /**
     * 選択中スキンの状態をボタンへ印す。
     * 見た目（枠色・バッジ）は CoinManager.updateSkinButtonsUI が一元で描くので、
     * ここではレイアウト用のクラスを壊さず、選択状態の属性だけを更新する。
     */
    updateSkinBadge(skin) {
        const skinButtons = document.querySelectorAll('.skin-btn');
        skinButtons.forEach(btn => {
            const isSelected = btn.dataset.skin === skin;
            btn.dataset.selected = isSelected ? 'true' : 'false';
            if (typeof btn.setAttribute === 'function') {
                btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
            }
        });
    }

    initMapThemeSelector() {
        // 既存ユーザーの選択中の地図を引き継ぎ、未所持の初期状態を回避
        if (this.coinManager && this.coinManager.ensureMapThemeState) {
            this.coinManager.ensureMapThemeState();
        }
        const savedTheme = localStorage.getItem('tw_map_theme') || 'mono';
        this.setMapTheme(savedTheme, false);
        if (this.coinManager && this.coinManager.renderMapThemesPanel) {
            this.coinManager.renderMapThemesPanel();
        }
    }

    setupSwipeUpToClose(modalId, closeFn) {
        // 廃止: モーダル内スクロール時の誤作動や引っかかりを根絶するため、スワイプ終了ジェスチャーは完全撤廃
    }

    setMapTheme(theme, notify = false) {
        // 未購入の背景地図は購入導線へ（購入後に自動適用）
        if (this.coinManager && this.coinManager.isMapThemeUnlocked && !this.coinManager.isMapThemeUnlocked(theme)) {
            this.coinManager.selectMapTheme(theme);
            return false;
        }

        const mapContainer = document.getElementById('map');
        const tilePanes = document.querySelectorAll('.leaflet-tile-pane');

        if (theme === 'none') {
            document.body.setAttribute('data-map-theme', 'none');
            localStorage.setItem('tw_map_theme', 'none');
            if (mapContainer) mapContainer.classList.add('map-tiles-hidden');
            tilePanes.forEach(p => {
                p.style.display = 'none';
                p.style.opacity = '0';
                p.style.visibility = 'hidden';
            });
            this.isMapVisible = false;
        } else {
            document.body.setAttribute('data-map-theme', theme);
            localStorage.setItem('tw_map_theme', theme);
            if (mapContainer) mapContainer.classList.remove('map-tiles-hidden');
            tilePanes.forEach(p => {
                p.style.display = '';
                p.style.opacity = '1';
                p.style.visibility = 'visible';
            });
            this.isMapVisible = true;
        }

        this.updateMapThemeBadge(theme);
        if (notify) {
            const labels = {
                dark: 'ダーク',
                mono: 'モノクロ',
                street: 'ストリート',
                sepia: 'セピア',
                none: '地図非表示'
            };
            this.showToast(`背景地図設定: ${labels[theme] || theme}`);
        }
    }

    updateMapThemeBadge(theme) {
        // 並び順・状態3色（選択中 / 所持済み / 未購入）を含めて一覧を描画し直す
        if (this.coinManager && this.coinManager.renderMapThemesPanel) {
            this.coinManager.renderMapThemesPanel();
            return;
        }
        const themeButtons = document.querySelectorAll('.map-theme-btn');
        themeButtons.forEach(btn => {
            const isSelected = btn.dataset.mapTheme === theme;
            if (isSelected) {
                btn.className = 'map-theme-btn bg-white text-black font-bold border-2 border-white p-2 rounded-lg text-[11px] shadow-xl transition-all active:scale-95 flex items-center justify-center';
            } else {
                btn.className = 'map-theme-btn bg-zinc-900 border border-zinc-700 p-2 rounded-lg text-[11px] hover:border-white transition-all active:scale-95 text-zinc-300 flex items-center justify-center';
            }
        });
    }

    updateThemeMapBadge() {
        // UI見出し横のテキスト補足は全廃（ボタン自体のハイライト色で識別）
    }

    initStatsModal() {
        const modal = document.getElementById('stats-modal');
        const openBtn = document.getElementById('btn-open-stats');
        const closeBtn = document.getElementById('btn-close-stats');
        const footerCloseBtn = document.getElementById('btn-stats-footer-close');

        if (openBtn) {
            openBtn.addEventListener('click', () => {
                if (this.menuModal) this.menuModal.classList.add('hidden');
                modal.classList.remove('hidden');
                this.updateStatsDisplay();
                this.switchStatsTab('my-stats');
            });
        }

        const closeModal = () => modal.classList.add('hidden');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (footerCloseBtn) footerCloseBtn.addEventListener('click', closeModal);
        this.setupSwipeUpToClose('stats-modal', closeModal);

        // Close on backdrop overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // Tab buttons
        const tabs = ['my-stats', 'weekly-rank', 'lifetime-rank'];
        tabs.forEach(tabKey => {
            const btn = document.getElementById(`tab-${tabKey}`);
            if (btn) {
                btn.addEventListener('click', () => this.switchStatsTab(tabKey));
            }
        });

        // Save Nickname (表示名)
        const saveNickBtn = document.getElementById('btn-save-nickname');
        if (saveNickBtn) {
            saveNickBtn.addEventListener('click', async () => {
                const input = document.getElementById('input-nickname');
                if (input && this.statsManager) {
                    saveNickBtn.disabled = true;
                    saveNickBtn.textContent = '保存中...';
                    await this.statsManager.setNickname(input.value);
                    saveNickBtn.textContent = '保存完了';
                    this.showToast('表示名を更新しました');
                    setTimeout(() => {
                        saveNickBtn.textContent = '保存';
                        saveNickBtn.disabled = false;
                    }, 1200);
                    this.updateStatsDisplay();
                }
            });
        }

        // Title Select
        const titleSelect = document.getElementById('select-active-title');
        if (titleSelect) {
            titleSelect.addEventListener('change', (e) => {
                if (this.statsManager) {
                    this.statsManager.setActiveTitle(e.target.value);
                    this.showToast(e.target.value ? `称号を [${e.target.value}] にセットしました` : '称号を解除しました');
                    this.updateStatsDisplay();
                }
            });
        }

        // X Share Button in Stats Modal
        const btnStatsXShare = document.getElementById('btn-stats-x-share');
        if (btnStatsXShare) {
            btnStatsXShare.addEventListener('click', () => {
                if (this.coinManager) this.coinManager.shareToX();
            });
        }

        // Copy Referral in Stats Modal
        const btnStatsCopyRef = document.getElementById('btn-stats-copy-referral');
        if (btnStatsCopyRef) {
            btnStatsCopyRef.addEventListener('click', () => {
                if (this.coinManager) this.coinManager.copyReferralCode();
            });
        }
    }

    async switchStatsTab(tabKey) {
        const tabs = ['my-stats', 'weekly-rank', 'lifetime-rank'];
        tabs.forEach(k => {
            const btn = document.getElementById(`tab-${k}`);
            const panel = document.getElementById(`panel-${k}`);
            if (btn) {
                if (k === tabKey) {
                    btn.className = 'tab-btn active flex-1 py-1.5 rounded-lg border-b-2 border-amber-500 font-medium text-center text-amber-400';
                } else {
                    btn.className = 'tab-btn flex-1 py-1.5 rounded-lg border-b-2 border-transparent font-medium text-center text-zinc-400 hover:text-white';
                }
            }
            if (panel) {
                if (k === tabKey) panel.classList.remove('hidden');
                else panel.classList.add('hidden');
            }
        });

        if (tabKey === 'weekly-rank') {
            await this.loadWeeklyRankings();
        } else if (tabKey === 'lifetime-rank') {
            await this.loadLifetimeRankings();
        }
    }

    updateStatsDisplay() {
        if (!this.statsManager) return;
        const stats = this.statsManager.stats;
        const nickInput = document.getElementById('input-nickname');
        if (nickInput) {
            // 入力欄には「ユーザーが自分で設定した名前」だけを出す。
            // 未設定のときは空欄にし、実際の表示（ユーザーID）はプレースホルダーで示す。
            const savedName = typeof this.statsManager.getSavedNickname === 'function'
                ? this.statsManager.getSavedNickname()
                : '';
            nickInput.value = savedName;
            nickInput.placeholder = '未設定時はユーザーIDで表示';
        }

        const titleSelect = document.getElementById('select-active-title');
        if (titleSelect && this.statsManager.unlockedTitles) {
            const currentTitle = this.statsManager.activeTitle || '';
            titleSelect.innerHTML = '<option value="">(称号なし)</option>' +
                this.statsManager.unlockedTitles.map(t => 
                    `<option value="${t}" ${t === currentTitle ? 'selected' : ''}>[${t}]</option>`
                ).join('');
        }

        const streakEl = document.getElementById('stat-login-streak');
        if (streakEl) {
            const streak = localStorage.getItem('tw_login_streak') || '1';
            streakEl.textContent = `${streak}日目`;
        }

        const totalLoginEl = document.getElementById('stat-total-login-days');
        if (totalLoginEl) {
            const totalDays = localStorage.getItem('tw_total_login_days') || '1';
            totalLoginEl.textContent = `${totalDays}日`;
        }

        const tileEl = document.getElementById('stat-lifetime-tiles');
        if (tileEl) tileEl.textContent = stats.lifetime_tiles.toLocaleString();

        const areaEl = document.getElementById('stat-lifetime-area');
        if (areaEl) {
            const areaM2 = stats.lifetime_tiles * 10000;
            areaEl.textContent = `${areaM2.toLocaleString()} m² (東京ドーム約 ${(areaM2 / 46755).toFixed(2)}個分)`;
        }

        const reclaimedEl = document.getElementById('stat-reclaimed-tiles');
        if (reclaimedEl) reclaimedEl.textContent = stats.lifetime_reclaimed.toLocaleString();

        const battleEl = document.getElementById('stat-battles-record');
        if (battleEl) battleEl.textContent = `${stats.battles_won}勝 ${stats.battles_lost}敗`;

        const referralCodeDisplay = document.getElementById('stats-referral-code-display');
        if (referralCodeDisplay && this.statsManager) {
            referralCodeDisplay.textContent = this.statsManager.getOrCreateReferralCode();
        }

        this.updateStatsXShareButton();
    }

    updateStatsXShareButton() {
        const btn = document.getElementById('btn-stats-x-share');
        if (!btn || !this.coinManager) return;
        const canShare = this.coinManager.canShareToXToday();
        if (canShare) {
            btn.disabled = false;
            btn.className = 'w-full py-2 bg-zinc-100 hover:bg-white text-black font-bold font-mono text-xs rounded-lg shadow transition-all active:scale-95 flex items-center justify-center gap-1.5';
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5 text-black" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                <span>Xで現在の戦績をシェア (+30 COIN)</span>
            `;
        } else {
            btn.disabled = true;
            btn.className = 'w-full py-2 bg-zinc-800 text-zinc-500 font-bold font-mono text-xs rounded-lg cursor-not-allowed flex items-center justify-center gap-1.5';
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                <span>本日獲得済み (明日またシェアできます)</span>
            `;
        }
    }

    parseNicknameAndTitle(raw, fallbackName = '') {
        return typeof StatsManager !== 'undefined' && typeof StatsManager.parseFormattedName === 'function'
            ? StatsManager.parseFormattedName(raw, fallbackName)
            : { title: '', name: String(raw || fallbackName || '') };
    }

    async loadWeeklyRankings() {
        const listEl = document.getElementById('list-weekly-rank');
        const myRankEl = document.getElementById('my-weekly-rank');
        if (!listEl || !this.statsManager || !this.supabaseManager) return;

        if (myRankEl) {
            myRankEl.innerHTML = `
                <span class="text-zinc-400">あなたの順位:</span>
                <span id="my-weekly-rank-value" class="font-bold text-zinc-400 font-mono">集計中...</span>
            `;
        }

        listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">読み込み中...</li>';
        const weekId = this.supabaseManager.getCurrentWeekId();
        const data = await this.statsManager.getWeeklyLeaderboard(weekId);

        // 自分の順位判定・DOM反映
        let myRankText = '未参加 (0マス)';
        let myRankColor = 'text-zinc-400';

        if (data && Array.isArray(data) && data.length > 0 && !data[0].message) {
            const myIdx = data.findIndex(item => item.user_id === this.statsManager.userId || item.nickname === this.statsManager.nickname);
            if (myIdx !== -1) {
                const rank = myIdx + 1;
                const tiles = data[myIdx].tiles_count || 0;
                myRankText = `${rank}位 (${tiles}マス)`;
                myRankColor = 'text-amber-400';
            } else if (typeof this.statsManager.getMyWeeklyRank === 'function') {
                const myRankInfo = await this.statsManager.getMyWeeklyRank(weekId);
                if (myRankInfo) {
                    myRankText = myRankInfo.text || '未参加 (0マス)';
                    myRankColor = myRankInfo.tilesCount > 0 ? 'text-amber-400' : 'text-zinc-400';
                }
            }
        } else if (typeof this.statsManager.getMyWeeklyRank === 'function') {
            const myRankInfo = await this.statsManager.getMyWeeklyRank(weekId);
            if (myRankInfo) {
                myRankText = myRankInfo.text || '未参加 (0マス)';
                myRankColor = myRankInfo.tilesCount > 0 ? 'text-amber-400' : 'text-zinc-400';
            }
        }

        if (myRankEl) {
            myRankEl.innerHTML = `
                <span class="text-zinc-400">あなたの順位:</span>
                <span id="my-weekly-rank-value" class="font-bold font-mono ${myRankColor}">${myRankText}</span>
            `;
        }

        if (!data || data.length === 0 || data[0].message) {
            listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">今週の記録はまだありません</li>';
            return;
        }

        listEl.innerHTML = data.map((item, idx) => {
            const isMe = item.user_id === this.statsManager.userId || item.nickname === this.statsManager.nickname;
            const parsed = this.parseNicknameAndTitle(item.nickname, item.user_id);
            return `
            <li class="flex items-center justify-between py-2 px-2.5 rounded-lg border-b border-zinc-800/80 ${isMe ? 'bg-amber-500/10 border-amber-500/30' : 'hover:bg-zinc-800/40'} text-xs">
                <div class="flex items-center gap-2 min-w-0 pr-2">
                    <span class="font-bold font-mono text-xs ${idx < 3 ? 'text-amber-400' : 'text-zinc-400'} shrink-0 w-4 text-right">${idx + 1}</span>
                    <span class="truncate font-medium text-zinc-200">${parsed.name}</span>
                    ${parsed.title ? `<span class="text-[9px] px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-amber-400 rounded shrink-0 font-mono font-normal">${parsed.title}</span>` : ''}
                    ${isMe ? '<span class="text-[9px] bg-amber-400 text-black px-1.5 py-0.5 rounded font-bold shrink-0 font-mono">YOU</span>' : ''}
                </div>
                <span class="font-mono text-zinc-300 font-bold shrink-0 text-right">${item.tiles_count || 0} <span class="text-[10px] text-zinc-500 font-normal">マス</span></span>
            </li>`;
        }).join('');
    }

    async loadLifetimeRankings() {
        const listEl = document.getElementById('list-lifetime-rank');
        const reclaimListEl = document.getElementById('list-reclaim-rank');
        if (!this.statsManager) return;

        if (listEl) {
            listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">読み込み中...</li>';
            const data = await this.statsManager.getLifetimeLeaderboard();

            if (!data || data.length === 0 || data[0].message) {
                listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">記録がありません</li>';
            } else {
                listEl.innerHTML = data.map((item, idx) => {
                    const isMe = item.user_id === this.statsManager.userId || item.nickname === this.statsManager.nickname;
                    const parsed = this.parseNicknameAndTitle(item.nickname, item.user_id);
                    return `
                    <li class="flex items-center justify-between py-2 px-2.5 rounded-lg border-b border-zinc-800/80 ${isMe ? 'bg-amber-500/10 border-amber-500/30' : 'hover:bg-zinc-800/40'} text-xs">
                        <div class="flex items-center gap-2 min-w-0 pr-2">
                            <span class="font-bold font-mono text-xs ${idx < 3 ? 'text-amber-400' : 'text-zinc-400'} shrink-0 w-4 text-right">${idx + 1}</span>
                            <span class="truncate font-medium text-zinc-200">${parsed.name}</span>
                            ${parsed.title ? `<span class="text-[9px] px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-amber-400 rounded shrink-0 font-mono font-normal">${parsed.title}</span>` : ''}
                            ${isMe ? '<span class="text-[9px] bg-amber-400 text-black px-1.5 py-0.5 rounded font-bold shrink-0 font-mono">YOU</span>' : ''}
                        </div>
                        <span class="font-mono text-zinc-300 font-bold shrink-0 text-right">${item.lifetime_tiles || 0} <span class="text-[10px] text-zinc-500 font-normal">マス</span></span>
                    </li>`;
                }).join('');
            }
        }

        if (reclaimListEl) {
            reclaimListEl.innerHTML = '<li class="text-zinc-500 text-center py-2">読み込み中...</li>';
            const reclaimData = await this.statsManager.getLifetimeReclaimedLeaderboard();

            if (!reclaimData || reclaimData.length === 0) {
                reclaimListEl.innerHTML = '<li class="text-zinc-500 text-center py-2">記録がありません</li>';
            } else {
                reclaimListEl.innerHTML = reclaimData.map((item, idx) => {
                    const isMe = item.user_id === this.statsManager.userId || item.nickname === this.statsManager.nickname;
                    const parsed = this.parseNicknameAndTitle(item.nickname, item.user_id);
                    return `
                    <li class="flex items-center justify-between py-2 px-2.5 rounded-lg border-b border-zinc-800/80 ${isMe ? 'bg-amber-500/10 border-amber-500/30' : 'hover:bg-zinc-800/40'} text-xs">
                        <div class="flex items-center gap-2 min-w-0 pr-2">
                            <span class="font-bold font-mono text-xs ${idx < 3 ? 'text-emerald-400' : 'text-zinc-400'} shrink-0 w-4 text-right">${idx + 1}</span>
                            <span class="truncate font-medium text-zinc-200">${parsed.name}</span>
                            ${parsed.title ? `<span class="text-[9px] px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-amber-400 rounded shrink-0 font-mono font-normal">${parsed.title}</span>` : ''}
                            ${isMe ? '<span class="text-[9px] bg-amber-400 text-black px-1.5 py-0.5 rounded font-bold shrink-0 font-mono">YOU</span>' : ''}
                        </div>
                        <span class="font-mono text-emerald-400 font-bold shrink-0 text-right">${item.lifetime_reclaimed || 0} <span class="text-[10px] text-zinc-500 font-normal">マス</span></span>
                    </li>`;
                }).join('');
            }
        }
    }

    initWeeklyResultModal() {
        const modal = document.getElementById('weekly-result-modal');
        const closeBtn = document.getElementById('btn-close-weekly-result');
        const closeIconBtn = document.getElementById('btn-close-weekly-result-icon');
        const shareBtn = document.getElementById('btn-share-weekly-result');
        const openFromMenuBtn = document.getElementById('btn-open-weekly-result');

        const closeModal = () => {
            if (!modal) return;
            modal.classList.add('hidden');
            const currentWeek = this.supabaseManager ? this.supabaseManager.getCurrentWeekId() : 'current';
            localStorage.setItem('tw_last_seen_week', currentWeek);
        };

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (closeIconBtn) closeIconBtn.addEventListener('click', closeModal);
        this.setupSwipeUpToClose('weekly-result-modal', closeModal);

        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal();
            });
        }

        if (shareBtn) {
            shareBtn.addEventListener('click', () => {
                const res = this.lastResultData || {};
                const outcomeText = res.isWin ? '勝利陣営！' : (res.isDraw ? '引き分け！' : '敗北陣営...');
                const teamName = (res.myTeam || this.currentTeam || 'black').toUpperCase();
                const blackPct = res.blackPct || 50;
                const whitePct = res.whitePct || 50;
                const tiles = res.myTiles || 0;
                const inviteCode = (this.coinManager && this.coinManager.getInviteCode()) || '';

                // シェア文言（末尾のハッシュタグ #テリウォーク 等）は coins.js の共通定義に一本化
                const shareText = CoinManager.buildWeeklyResultShareText({
                    teamName,
                    outcomeText,
                    blackPct,
                    whitePct,
                    tiles,
                    inviteCode
                });
                const shareUrl = 'https://shodai4.com/territory-walk/';

                if (navigator.share) {
                    navigator.share({
                        title: 'TERRITORY WALK シーズン結果',
                        text: shareText,
                        url: shareUrl
                    }).catch(() => {
                        window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText + '\n' + shareUrl)}`, '_blank');
                    });
                } else {
                    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText + '\n' + shareUrl)}`, '_blank');
                }
            });
        }

        if (openFromMenuBtn) {
            openFromMenuBtn.addEventListener('click', () => {
                if (this.menuModal) this.menuModal.classList.add('hidden');
                this.showWeeklyResultModal(true);
            });
        }
    }

    async checkWeeklyResetResult() {
        if (!this.supabaseManager || !this.statsManager) return;
        const currentWeek = this.supabaseManager.getCurrentWeekId();
        const lastSeen = localStorage.getItem('tw_last_seen_week');

        // If first time ever on this device, just mark current week
        if (!lastSeen) {
            localStorage.setItem('tw_last_seen_week', currentWeek);
            return;
        }

        if (lastSeen !== currentWeek) {
            // New week has arrived!
            setTimeout(() => {
                this.showWeeklyResultModal(false, lastSeen);
            }, 1000);
        }
    }

    async showWeeklyResultModal(isManual = false, targetWeek = null) {
        const modal = document.getElementById('weekly-result-modal');
        if (!modal) return;

        const currentWeek = this.supabaseManager ? this.supabaseManager.getCurrentWeekId() : '2026-W46';
        const weekToShow = targetWeek || (isManual ? currentWeek : this.getPreviousWeekId(currentWeek));

        document.getElementById('result-week-id').textContent = isManual ? `${currentWeek} (現在)` : weekToShow;
        document.getElementById('result-winner-banner').textContent = '集計中...';
        modal.classList.remove('hidden');

        let result = null;
        if (isManual) {
            // デバッグプレビュー時は現在のリアルタイム実データを動的に取得
            if (this.statsManager && this.statsManager.getCurrentWeekLiveResult) {
                result = await this.statsManager.getCurrentWeekLiveResult();
            }
            if (!result) {
                let bCount = 0;
                let wCount = 0;
                if (this.gridManager) {
                    for (const team of this.gridManager.claimedTilesCache.values()) {
                        if (team === 'black') bCount++;
                        else if (team === 'white') wCount++;
                    }
                }
                const tot = bCount + wCount;
                const bPct = tot > 0 ? Math.round((bCount / tot) * 100) : 50;
                const wPct = tot > 0 ? 100 - bPct : 50;
                const myT = this.currentTeam || 'black';
                let winT = 'draw';
                if (bCount > wCount) winT = 'black';
                else if (wCount > bCount) winT = 'white';

                result = {
                    weekId: currentWeek,
                    blackTotal: bCount,
                    whiteTotal: wCount,
                    blackPct: bPct,
                    whitePct: wPct,
                    winnerTeam: winT,
                    isDraw: (winT === 'draw'),
                    myTeam: myT,
                    myTiles: (this.statsManager && this.statsManager.stats) ? (this.statsManager.stats.lifetime_tiles || 0) : 0,
                    isWin: (winT === myT)
                };
            }
        } else {
            result = this.statsManager ? await this.statsManager.getPreviousWeekResult(weekToShow) : null;
        }

        const banner = document.getElementById('result-winner-banner');
        const outcome = document.getElementById('result-battle-outcome');
        const barBlack = document.getElementById('result-bar-black');
        const barWhite = document.getElementById('result-bar-white');

        if (!result) {
            banner.textContent = '記録なし';
            document.getElementById('result-winner-subtitle').textContent = `${weekToShow} の対戦データはありません`;
            document.getElementById('result-score-black').textContent = '-';
            document.getElementById('result-score-white').textContent = '-';
            const blackTiles = document.getElementById('result-black-tiles');
            const whiteTiles = document.getElementById('result-white-tiles');
            if (blackTiles) blackTiles.textContent = '-';
            if (whiteTiles) whiteTiles.textContent = '-';
            if (barBlack) barBlack.style.width = '50%';
            if (barWhite) barWhite.style.width = '50%';
            document.getElementById('result-my-team').textContent = this.currentTeam === 'black' ? 'Black' : 'White';
            document.getElementById('result-my-tiles').textContent = '0 マス';
            document.getElementById('result-battle-outcome').textContent = '対戦なし';
            return;
        }

        if (isManual) {
            document.getElementById('result-winner-subtitle').textContent = '今シーズン終了時のリアルタイム判定シミュレーション';
        } else {
            document.getElementById('result-winner-subtitle').textContent = '前週のシーズン対戦が決着しました';
        }

        if (result.winnerTeam === 'black') {
            banner.innerHTML = '<span class="text-zinc-100 font-bold">BLACK TEAM WIN</span>';
        } else if (result.winnerTeam === 'white') {
            banner.innerHTML = '<span class="text-zinc-100 font-bold">WHITE TEAM WIN</span>';
        } else {
            banner.innerHTML = '<span class="text-amber-400 font-bold">DRAW (引き分け)</span>';
        }

        document.getElementById('result-score-black').innerHTML = `<span class="text-white font-bold">${result.blackPct}%</span>`;
        document.getElementById('result-score-white').innerHTML = `<span class="text-white font-bold">${result.whitePct}%</span>`;

        // 獲得総マス数は勢力ゲージではなく下の詳細テーブルに表示（文字溢れ防止）
        const blackTiles = document.getElementById('result-black-tiles');
        const whiteTiles = document.getElementById('result-white-tiles');
        if (blackTiles) blackTiles.textContent = `${Number(result.blackTotal || 0).toLocaleString()} マス`;
        if (whiteTiles) whiteTiles.textContent = `${Number(result.whiteTotal || 0).toLocaleString()} マス`;

        // 対戦比率ゲージバーの更新（アニメーション伸縮）
        if (barBlack) barBlack.style.width = `${Math.max(5, Math.min(95, result.blackPct))}%`;
        if (barWhite) barWhite.style.width = `${Math.max(5, Math.min(95, result.whitePct))}%`;

        document.getElementById('result-my-team').textContent = result.myTeam === 'black' ? 'Black' : 'White';
        document.getElementById('result-my-tiles').textContent = `${result.myTiles.toLocaleString()} マス`;

        if (result.isDraw) {
            outcome.innerHTML = '<span class="text-zinc-400">引き分け</span>';
        } else if (result.isWin) {
            outcome.innerHTML = '<span class="text-amber-400 font-bold">VICTORY (勝利陣営)</span>';
            if (!isManual && this.statsManager) {
                this.statsManager.stats.battles_won += 1;
                this.statsManager.saveLocalStats();
            }
        } else {
            outcome.innerHTML = '<span class="text-zinc-400">DEFEAT (敗北陣営)</span>';
            if (!isManual && this.statsManager) {
                this.statsManager.stats.battles_lost += 1;
                this.statsManager.saveLocalStats();
            }
        }

        this.lastResultData = result;
    }

    getPreviousWeekId(currentWeekId) {
        // e.g., '2026-W46' -> '2026-W45'
        const parts = currentWeekId.split('-W');
        if (parts.length === 2) {
            const year = parseInt(parts[0], 10);
            const week = parseInt(parts[1], 10);
            if (week > 1) {
                return `${year}-W${String(week - 1).padStart(2, '0')}`;
            } else {
                return `${year - 1}-W52`;
            }
        }
        return currentWeekId;
    }

    initProModal() {
        if (this.proManager && typeof this.proManager.initModal === 'function') {
            this.proManager.initModal(this);
        }
    }

    /**
     * Pro状態を安全に読む。
     * 過去バージョンが `proManager.isPro = false` とメソッドを上書きした端末では
     * `isPro()` が TypeError になり、ショップやバッジ描画が巻き添えで落ちていた。
     */
    isProActive() {
        const pm = this.proManager;
        if (!pm) return false;
        if (typeof pm.isPro === 'function') {
            try {
                return !!pm.isPro();
            } catch (e) {
                console.warn('[App] Pro check failed:', e);
                return false;
            }
        }
        return pm.isPro === true;
    }

    checkProAccess(actionName) {
        if (this.debugEnabled && this.isDebugMode) {
            console.log(`[Debug Mode] Pro restriction bypassed for: ${actionName}`);
            return true;
        }

        if (!this.isProActive()) {
            alert(`${actionName}を利用するには、Proサポーターへのアップグレードが必要です！`);
            const modal = document.getElementById('pro-modal');
            if (modal) modal.classList.remove('hidden');
            return false;
        }
        return true;
    }

    async exportPosterAction() {
        const hasAccess = this.isProActive() ||
                          (this.coinManager && this.coinManager.canAccessPosterExport());
        if (!hasAccess) {
            const ok = confirm('【ポスター保存】\n週間陣地ポスターの書き出しはPro機能またはチケット（30 COIN）が必要です。\nショップでチケットを入手しますか？');
            if (ok && this.coinManager) {
                if (this.menuModal) this.menuModal.classList.add('hidden');
                this.coinManager.openShopModal('perks');
            }
            return;
        }

        try {
            this.showToast('ポスターを生成中...');
            const weekId = this.supabaseManager.getCurrentWeekId();
            await this.posterGenerator.exportWeeklyPoster(
                this.gridManager.claimedTilesCache,
                this.currentTeam,
                this.statsManager.nickname,
                weekId
            );
            this.showToast('ポスターの書き出しが完了しました');
        } catch (err) {
            console.error('Poster export failed:', err);
            alert('ポスターの書き出しに失敗しました。');
        }
    }

    initExportButton() {
        const exportBtn = document.getElementById('btn-export-poster');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportPosterAction());
        }
    }

    toggleMapVisibility() {
        this.isMapVisible = !this.isMapVisible;
        const mapContainer = document.getElementById('map');
        if (this.isMapVisible) {
            if (mapContainer) mapContainer.classList.remove('map-tiles-hidden');
        } else {
            if (mapContainer) mapContainer.classList.add('map-tiles-hidden');
        }
        this.updateMapVisibilityUI();
    }

    updateMapVisibilityUI() {
        if (!this.btnToggleMap || !this.mapToggleDot || !this.mapToggleText) return;

        if (this.isMapVisible) {
            this.mapToggleDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
            this.mapToggleText.textContent = 'MAP: ON';
            this.btnToggleMap.className = 'px-3 py-1.5 rounded-lg border text-xs font-mono font-bold flex items-center gap-1.5 transition-all active:scale-95 bg-zinc-800 border-zinc-600 text-white';
        } else {
            this.mapToggleDot.className = 'w-2 h-2 rounded-full bg-zinc-600';
            this.mapToggleText.textContent = 'MAP: OFF';
            this.btnToggleMap.className = 'px-3 py-1.5 rounded-lg border text-xs font-mono font-bold flex items-center gap-1.5 transition-all active:scale-95 bg-zinc-900 border-zinc-700 text-zinc-400';
        }
    }

    initDebugMode() {
        this.isDebugMode = false;
        this.updateDebugModeUI();
    }

    /**
     * デバッグ機能のマスタースイッチ。
     * CONFIG.ENABLE_DEBUG_TOOLS = false で、MENUのデバッグ欄・D-PAD・全デバッグ操作が
     * UIから消え、各ハンドラも早期リターンで無効化される。
     */
    applyDebugToolsVisibility() {
        const enabled = this.debugEnabled !== false;
        const section = document.getElementById('debug-mode-section');
        if (section) section.classList.toggle('hidden', !enabled);
        const dpad = document.getElementById('dpad-container');
        if (dpad && !enabled) dpad.classList.add('hidden');
    }

    /** デバッグの仮想散歩中か（マスタースイッチON かつ DEBUG: ON） */
    isVirtualWalkActive() {
        return !!(this.debugEnabled && this.isDebugMode);
    }

    toggleDebugMode() {
        if (!this.debugEnabled) return;
        this.isDebugMode = !this.isDebugMode;
        this.updateDebugModeUI();

        if (this.isDebugMode) {
            this.updateDpadStatus(`仮想散歩 ON / ${this.currentTeam === 'white' ? 'WHITE' : 'BLACK'}`);
        } else {
            this.updateDpadStatus('仮想散歩 OFF');
            this.restoreRealPosition();
        }
    }

    /** 仮想散歩を終えたとき、実GPSの最新位置（あれば）にマーカーを戻す */
    restoreRealPosition() {
        if (!this.lastRealPosition) return;
        this.virtualPos = [...this.lastRealPosition];
        this.currentMeshId = null;
        this.lastProcessedLat = null;
        this.lastProcessedLng = null;
        this.updatePlayerMarker(this.virtualPos);
        if (this.map) this.map.setView(this.virtualPos, this.map.getZoom(), { animate: true });
        this.updateGPSStatus('GPS: 測位中', 'bg-emerald-400', 'text-emerald-400');
    }

    /**
     * 「現在地」ボタン（v1.1）。
     * 以前は virtualPos を setView するだけだったため、virtualPos がまだフォールバック
     * （渋谷）のままだと「押しても渋谷のまま」になっていた。
     * 今は必ず GPS を取り直し、その結果へ地図とピンを移す。
     */
    recenterToCurrentPosition() {
        if (this.searchManager) {
            this.searchManager.clearSearchMarker();
            this.searchManager.closeSearchBar();
        }

        // デバッグの仮想散歩中は仮想座標が正（GPSで取り消さない）
        if (this.isVirtualWalkActive()) {
            this.moveToCurrentPositionView(this.virtualPos);
            this.showToast('仮想散歩中の位置に戻りました');
            return;
        }

        // すでに分かっている位置があれば先に寄せる（測位を待たせない）
        const known = this.lastRealPosition || this.savedPosition || null;
        if (known) this.moveToCurrentPositionView(known);

        // その上で必ず測位を取り直す（押すたびに最新の現在地へ）
        this.requestFreshPosition()
            .then((pos) => {
                if (!pos) return;
                this.moveToCurrentPositionView(pos);
                this.showToast('現在地に戻りました');
            })
            .catch(() => {
                if (known) {
                    this.showToast('最新の現在地を取得できませんでした', '最後に分かっている位置に戻しました');
                } else {
                    this.showToast('現在地を取得できませんでした', '位置情報の許可をご確認ください');
                }
            });
    }

    /** 地図・ピンを指定座標へ移す（現在地ボタン用。倍率は通常表示） */
    moveToCurrentPositionView(pos) {
        if (!pos) return;
        const lat = Number(pos[0]);
        const lng = Number(pos[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const center = [lat, lng];
        this.virtualPos = [...center];
        this.updatePlayerMarker(center);
        if (this.map) this.map.setView(center, CONFIG.DEFAULT_ZOOM, { animate: true });
    }

    /**
     * 最新の現在地を1回だけ取得する（現在地ボタン用）。
     * ネイティブの Geolocation プラグイン → Web の getCurrentPosition の順。
     * @returns {Promise<[number, number]|null>}
     */
    requestFreshPosition() {
        const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

        const toLatLng = (position) => {
            if (!position || !position.coords) return null;
            this.handlePositionUpdate(position, false);
            const lat = Number(position.coords.latitude);
            const lng = Number(position.coords.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return [lat, lng];
        };

        return new Promise((resolve, reject) => {
            const nativeGeo = this.getNativeGeolocation();
            if (nativeGeo) {
                Promise.resolve(nativeGeo.getCurrentPosition(options))
                    .then((position) => resolve(toLatLng(position)))
                    .catch(reject);
                return;
            }

            if (typeof navigator === 'undefined' || !navigator.geolocation) {
                reject(new Error('geolocation unavailable'));
                return;
            }

            navigator.geolocation.getCurrentPosition(
                (position) => resolve(toLatLng(position)),
                (error) => reject(error),
                options
            );
        });
    }

    /** D-Pad 下部の状態表示（塗れたマス・送信待ち件数） */
    updateDpadStatus(text) {
        this.dpadStatusText = text;
        const el = document.getElementById('dpad-status');
        if (el) el.textContent = text;
    }

    updateDebugModeUI() {
        if (!this.btnToggleDebug || !this.debugToggleDot || !this.debugToggleText || !this.dpadContainer) return;

        if (!this.debugEnabled) {
            this.isDebugMode = false;
            this.dpadContainer.classList.add('hidden');
            return;
        }
        if (this.isDebugMode) {
            this.debugToggleDot.className = 'w-2 h-2 rounded-full bg-amber-400';
            this.debugToggleText.textContent = 'DEBUG: ON';
            this.btnToggleDebug.className = 'px-3 py-1.5 rounded-lg border text-xs font-mono font-bold flex items-center gap-1.5 transition-all active:scale-95 bg-zinc-800 border-amber-500/80 text-amber-400';
            this.dpadContainer.classList.remove('hidden');
        } else {
            this.debugToggleDot.className = 'w-2 h-2 rounded-full bg-zinc-600';
            this.debugToggleText.textContent = 'DEBUG: OFF';
            this.btnToggleDebug.className = 'px-3 py-1.5 rounded-lg border text-xs font-mono font-bold flex items-center gap-1.5 transition-all active:scale-95 bg-zinc-900 border-zinc-700 text-zinc-400';
            this.dpadContainer.classList.add('hidden');
        }
    }

    swapTeam() {
        const nextTeam = this.currentTeam === 'black' ? 'white' : 'black';
        this.currentTeam = nextTeam;
        localStorage.setItem('player_team', nextTeam);
        this.applyTheme();
        this.updateScoreUI();
    }

    resetViewportScroll() {
        if (window.scrollX !== 0 || window.scrollY !== 0) {
            window.scrollTo(0, 0);
        }
        if (this.map) {
            this.map.invalidateSize();
        }
    }

    initRulesModal() {
        const hasSeenRules = localStorage.getItem('territory_rules_seen_v1');
        if (!hasSeenRules && this.rulesModal) {
            this.rulesModal.classList.remove('hidden');
            this.resetViewportScroll();
        }

        if (this.btnCloseRules) {
            this.btnCloseRules.addEventListener('click', () => this.dismissRulesModal());
        }
        this.setupSwipeUpToClose('rules-modal', () => this.dismissRulesModal());
    }

    /**
     * ルール説明モーダルを閉じる（初回の「ゲームをはじめる」もここ）。
     * 初回起動はここでチーム決定画面へ進み、そこで「ゲーム開始」を押すまで
     * 位置情報と AdMob/ATT の許可要求は出さない。
     */
    dismissRulesModal() {
        const needsTeamDecision = this.startupGate ? this.startupGate.needsTeamDecision() : false;

        if (this.rulesModal) {
            this.rulesModal.classList.add('hidden');
            this.resetViewportScroll();
        }

        if (needsTeamDecision) {
            this.showTeamDecisionModal();
            return;
        }

        if (this.startupGate) return;

        // startup-gate.js が読まれていない場合のフォールバック（従来の即時開始）
        try {
            localStorage.setItem('territory_rules_seen_v1', 'true');
        } catch (e) { /* ignore */ }
        this.startDeferredServices('rules-dismissed');
    }

    /** チーム決定画面のボタン配線（初回起動の許可要求より前に使う） */
    initTeamDecisionModal() {
        if (this.btnStartGame) {
            this.btnStartGame.addEventListener('click', () => this.confirmTeamDecision());
        }
    }

    /** 決定した陣営（Black / White）を描き込んでチーム決定画面を開く */
    showTeamDecisionModal() {
        const isWhite = this.currentTeam === 'white';

        if (this.teamDecisionBadge) {
            this.teamDecisionBadge.className = isWhite
                ? 'w-28 h-28 rounded-full flex items-center justify-center border-4 border-white bg-white shadow-2xl transition-all'
                : 'w-28 h-28 rounded-full flex items-center justify-center border-4 border-zinc-500 bg-black shadow-2xl transition-all';
        }
        if (this.teamDecisionSymbol) {
            this.teamDecisionSymbol.textContent = isWhite ? 'WHITE' : 'BLACK';
            this.teamDecisionSymbol.className = isWhite
                ? 'font-mono font-bold text-2xl tracking-wider text-black'
                : 'font-mono font-bold text-2xl tracking-wider text-white';
        }
        if (this.teamDecisionName) {
            this.teamDecisionName.textContent = isWhite ? 'WHITE（白）陣営' : 'BLACK（黒）陣営';
        }
        if (this.teamDecisionDescription) {
            // 単語の途中で折り返さないよう、読点と文末で明示的に改行する（375px幅でも各行が収まる長さに分割）
            this.teamDecisionDescription.innerHTML = isWhite
                ? 'オートバランサーにより、<br>あなたは白陣営に配属されました。<br>街を歩いた場所が白の陣地になります。'
                : 'オートバランサーにより、<br>あなたは黒陣営に配属されました。<br>街を歩いた場所が黒の陣地になります。';
        }
        if (this.teamDecisionModal) {
            this.teamDecisionModal.classList.remove('hidden');
            this.resetViewportScroll();
        }
    }

    /**
     * チーム決定画面の「ゲーム開始」。既読を確定し、位置情報と AdMob/ATT を開始する。
     */
    confirmTeamDecision() {
        if (this.teamDecisionModal) {
            this.teamDecisionModal.classList.add('hidden');
            this.resetViewportScroll();
        }

        if (this.startupGate) {
            this.startupGate.confirmTeamSelection(this.currentTeam);
            return;
        }

        try {
            localStorage.setItem('territory_rules_seen_v1', 'true');
        } catch (e) { /* ignore */ }
        this.startDeferredServices('team-decision');
    }

    /**
     * 起動ゲート。初回起動はルール説明 → チーム決定画面を経て開始し、
     * 2回目以降の起動はこれまでどおり起動直後に開始する。
     */
    initStartupGate() {
        if (typeof StartupGate === 'undefined') {
            // モジュール未読込でも機能を止めない（従来どおり即時開始）
            this.startDeferredServices('fallback');
            return;
        }

        this.startupGate = new StartupGate({
            onStart: (trigger) => this.startDeferredServices(trigger)
        });

        // true なら2回目以降の起動で、ここで開始済み。初回はルール説明を閉じるまで待機。
        this.startupGate.begin();
    }

    /**
     * 位置情報の取得と AdMob（ATT 許可要求を含む）の初期化を開始する。
     * 初回起動ではチーム決定画面の「ゲーム開始」で1回だけ、2回目以降は起動直後に一度だけ走る。
     */
    startDeferredServices(trigger = 'manual') {
        if (this.servicesStarted) return false;
        this.servicesStarted = true;
        this.servicesStartedBy = trigger;

        // マーキング停止中に起動した場合は測位を始めない（起動直後の一瞬塗り防止）。
        // 再開操作（setMarkingPaused(false)）で初めて startLocationTracking() が走る。
        if (this.markingPaused === true) {
            this.updateGPSStatus('GPS: マーキング停止中', 'bg-sky-400', 'text-sky-300');
            this.renderMarkingPauseUI();
        } else {
            this.startLocationTracking();
        }

        if (this.adMobManager && typeof this.adMobManager.init === 'function') {
            this.adMobManager.init();
        }

        // 歩き始めてから Watch 連携と通知の予約を始める（起動直後の許可要求を増やさない）
        this.initWatchBridge();
        if (this.weeklyNotifier && typeof this.weeklyNotifier.init === 'function') {
            Promise.resolve(this.weeklyNotifier.init()).catch(() => {});
        }
        return true;
    }

    initMenuModal() {
        if (!this.menuModal) return;

        const openModal = () => {
            this.menuModal.classList.remove('hidden');
            this.updateAutoBalanceUI();
            this.renderPrivacySummary();
            this.resetViewportScroll();
        };

        const closeModal = () => {
            this.menuModal.classList.add('hidden');
            this.resetViewportScroll();
        };

        if (this.btnMenu) this.btnMenu.addEventListener('click', openModal);
        if (this.btnCloseMenu) this.btnCloseMenu.addEventListener('click', closeModal);
        if (this.btnModalCloseIcon) this.btnModalCloseIcon.addEventListener('click', closeModal);
        this.setupSwipeUpToClose('menu-modal', closeModal);

        if (this.btnOpenRules) {
            this.btnOpenRules.addEventListener('click', () => {
                closeModal();
                if (this.rulesModal) {
                    this.rulesModal.classList.remove('hidden');
                    this.resetViewportScroll();
                }
            });
        }

        if (this.btnToggleMap) {
            this.btnToggleMap.addEventListener('click', () => this.toggleMapVisibility());
        }

        if (this.btnToggleDebug) {
            this.btnToggleDebug.addEventListener('click', () => this.toggleDebugMode());
        }
    }

    initGeolocation() {
        // マーキング停止中は位置情報ウォッチャーを張らない（二重ガード）
        if (this.markingPaused === true) {
            this.updateGPSStatus('GPS: マーキング停止中', 'bg-sky-400', 'text-sky-300');
            return false;
        }

        // 位置情報拒否時の常設案内バナー（×で一時非表示／許可されたら自動で消える）
        // 停止→再開で initGeolocation が再度呼ばれても、バナーと「再確認」の配線は1つだけにする
        if (typeof LocationPermissionBanner !== 'undefined' && !this.locationBanner) {
            this.locationBanner = new LocationPermissionBanner(document, {
                onChange: () => {
                    // 拒否バナーとマーキング停止バーが重ならないよう上下を積み直す
                    this.layoutTopNotices();
                    this.repositionToastContainer();
                },
                retryHandler: () => this.recheckLocationPermission()
            });
        }

        this.updateGPSStatus('GPS: 測位中...', 'bg-amber-400', 'text-amber-400');

        // ネイティブのバックグラウンド位置情報を最優先する。
        // 画面消灯・ロック中も addWatcher のコールバックが届き、そのまま
        // handlePositionUpdate → processMeshAndClaim（ローカル保存＋Outbox同期）へ流れる。
        const backgroundPlugin = this.getBackgroundGeolocationPlugin();
        if (backgroundPlugin && this.startBackgroundGeolocation(backgroundPlugin)) {
            return;
        }

        this.startWebGeolocation();
    }

    /**
     * Web（navigator.geolocation）での測位。ネイティブのバックグラウンド測位が
     * 使えない場合のフォールバックで、二重起動は watchId で防ぐ。
     * @returns {boolean} 測位を開始できたか
     */
    startWebGeolocation() {
        if (this.markingPaused === true) return false;
        if (this.watchId != null) return true;
        if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
            this.updateGPSStatus('GPS: 非対応', 'bg-red-500', 'text-red-400');
            return false;
        }

        // 起動時点ですでに拒否済みなら、最初のエラーを待たずにバナーを出す
        if (this.locationBanner) this.locationBanner.refreshPermissionState();

        const options = {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        };

        // ネイティブ（Capacitor Geolocation）が使える場合はそちらを優先し、
        // 権限拒否は同じ handlePositionError で一元処理する
        const nativeGeo = this.getNativeGeolocation();
        if (nativeGeo && this.startNativeGeolocation(nativeGeo, options)) return true;

        navigator.geolocation.getCurrentPosition(
            (position) => this.handlePositionUpdate(position, true),
            (error) => this.handlePositionError(error),
            options
        );

        this.watchId = navigator.geolocation.watchPosition(
            (position) => this.handlePositionUpdate(position, false),
            (error) => this.handlePositionError(error),
            options
        );

        return true;
    }

    /**
     * ネイティブのバックグラウンド位置情報プラグインを取得する（Webでは null）。
     * バンドルを持たない <script> 読み込み構成なので、window.Capacitor だけを頼りにし、
     * 未登録のときは registerPlugin('BackgroundGeolocation') でプロキシを作る。
     */
    getBackgroundGeolocationPlugin() {
        if (this.backgroundGeolocationPlugin) return this.backgroundGeolocationPlugin;
        try {
            const cap = typeof window !== 'undefined' ? window.Capacitor : null;
            if (!cap) return null;
            // ブラウザ実行（Web）ではネイティブ測位を使わない
            if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return null;
            // cap sync 前やプラグイン未組込のビルドでは PluginHeaders が無いので使わない
            if (typeof cap.isPluginAvailable === 'function'
                && !cap.isPluginAvailable(BACKGROUND_GEOLOCATION_PLUGIN_NAME)) {
                return null;
            }

            let plugin = cap.Plugins ? cap.Plugins[BACKGROUND_GEOLOCATION_PLUGIN_NAME] : null;
            if (!plugin && typeof cap.registerPlugin === 'function') {
                plugin = cap.registerPlugin(BACKGROUND_GEOLOCATION_PLUGIN_NAME);
            }
            if (!plugin || typeof plugin.addWatcher !== 'function') return null;

            this.backgroundGeolocationPlugin = plugin;
            return plugin;
        } catch (e) {
            console.warn('BackgroundGeolocation unavailable, using Web API:', e);
            return null;
        }
    }

    /**
     * バックグラウンド測位を開始する（watcher の二重起動を防ぐ）。
     * @returns {boolean} ネイティブ経路で開始できたか（false なら Web フォールバックへ）
     */
    startBackgroundGeolocation(plugin) {
        if (this.backgroundWatcherStarted) return true;
        if (!plugin || typeof plugin.addWatcher !== 'function') return false;

        this.backgroundWatcherStarted = true;

        let watching;
        try {
            watching = plugin.addWatcher(BACKGROUND_GEOLOCATION_OPTIONS, (location, error) => {
                if (error) {
                    // NOT_AUTHORIZED 等の拒否も handlePositionError でバナーへ繋ぐ
                    this.handlePositionError(error);
                    return;
                }
                if (location) this.handleBackgroundLocation(location);
            });
        } catch (e) {
            console.warn('BackgroundGeolocation addWatcher failed, falling back to Web API:', e);
            this.backgroundWatcherStarted = false;
            return false;
        }

        // addWatcher は watcher ID を返す Promise（removeWatcher 用に保持する）
        if (watching && typeof watching.then === 'function') {
            watching
                .then((watcherId) => {
                    this.backgroundWatcherId = watcherId;
                    // 開始直後にマーキングを停止した場合、解決後に届いた watcher をここで止める
                    // （停止指示が watcher ID 取得より先に来ると removeWatcher が空振りするため）
                    if (this.markingPaused === true && this.backgroundWatcherStarted === false) {
                        this.stopBackgroundGeolocation();
                    }
                })
                .catch((error) => {
                    console.warn('BackgroundGeolocation watcher unavailable:', error);
                    this.backgroundWatcherStarted = false;
                    this.handlePositionError(error);
                    // ネイティブが使えないビルドでも遊べるよう Web 測位へ戻す
                    this.startWebGeolocation();
                });
        } else if (watching != null) {
            this.backgroundWatcherId = watching;
        }

        return true;
    }

    /** バックグラウンド測位を停止する（watcher の残留・二重起動の防止） */
    stopBackgroundGeolocation() {
        const plugin = this.backgroundGeolocationPlugin;
        const watcherId = this.backgroundWatcherId;

        this.backgroundWatcherStarted = false;
        this.backgroundWatcherId = null;

        if (!plugin || watcherId == null || typeof plugin.removeWatcher !== 'function') return false;
        try {
            Promise.resolve(plugin.removeWatcher({ id: watcherId })).catch(() => {});
            return true;
        } catch (e) {
            return false;
        }
    }

    /* ================================================================== *
     * 陣地マーキング（歩いた場所の自動塗り）ON / OFF
     *   - ワンタップで一時停止／再開できる。停止中は「歩いても陣地は増えない」。
     *   - 停止中は位置情報のウォッチャー自体を張らない・止めるので電池も減らない。
     *   - 状態は localStorage に保存し、再起動直後の「一瞬塗り」も防ぐ。
     *   - バックグラウンド位置情報の停止は startDeferredServices / initGeolocation /
     *     processMeshAndClaim / handlePositionUpdate の4か所で二重にガードする。
     * ================================================================== */

    /** localStorage から前回の ON/OFF を読む（未設定・読めない時は ON） */
    readMarkingPausePreference() {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return false;
            const raw = localStorage.getItem(MARKING_PAUSE_STORAGE_KEY);
            return raw === '1' || raw === 'true';
        } catch (e) {
            return false;
        }
    }

    /** ON/OFF を localStorage に保存する（再起動時の引き継ぎ） */
    saveMarkingPausePreference(paused) {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return false;
            localStorage.setItem(MARKING_PAUSE_STORAGE_KEY, paused ? '1' : '0');
            return true;
        } catch (e) {
            return false;
        }
    }

    /** マーキング停止中か */
    isMarkingPaused() {
        return this.markingPaused === true;
    }

    /** トグルボタン・一時停止バーの配線（initDOM から1回だけ） */
    initMarkingToggle() {
        if (this.markingToggleBound) return false;
        this.markingToggleBound = true;

        const doc = typeof document !== 'undefined' ? document : null;
        const toggleBtn = this.btnMarkingToggle || (doc ? doc.getElementById('btn-marking-toggle') : null);
        if (toggleBtn && typeof toggleBtn.addEventListener === 'function') {
            toggleBtn.addEventListener('click', (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                this.toggleMarkingPaused();
            });
        }
        const resumeBtn = this.btnMarkingResume || (doc ? doc.getElementById('btn-marking-resume') : null);
        if (resumeBtn && typeof resumeBtn.addEventListener === 'function') {
            resumeBtn.addEventListener('click', (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                // バッジタップでもワンタップ再開
                this.setMarkingPaused(false, { source: 'banner' });
            });
        }

        this.renderMarkingPauseUI();
        return true;
    }

    /** 現在の状態を UI（トグルボタン・一時停止バー・GPS表示）に反映する */
    renderMarkingPauseUI() {
        const paused = this.isMarkingPaused();
        const doc = typeof document !== 'undefined' ? document : null;

        const btn = this.btnMarkingToggle || (doc ? doc.getElementById('btn-marking-toggle') : null);
        if (btn) {
            if (btn.dataset) btn.dataset.state = paused ? 'paused' : 'active';
            if (typeof btn.setAttribute === 'function') {
                btn.setAttribute('aria-pressed', paused ? 'false' : 'true');
                btn.setAttribute('aria-label', paused
                    ? 'マーキング停止中（タップで再開）'
                    : 'マーキング ON（タップで一時停止）');
            }
            btn.title = paused ? 'マーキング: 停止中（タップで再開）' : 'マーキング: ON（タップで一時停止）';
        }

        const label = this.markingToggleLabel || (doc ? doc.getElementById('marking-toggle-label') : null);
        if (label) label.textContent = paused ? '停止中' : 'ON';

        const banner = this.markingPausedBanner || (doc ? doc.getElementById('marking-paused-banner') : null);
        if (banner && banner.classList) {
            if (paused) banner.classList.remove('hidden');
            else banner.classList.add('hidden');
        }

        this.layoutTopNotices();
        this.repositionToastContainer();

        if (doc && doc.body && doc.body.dataset) {
            doc.body.dataset.marking = paused ? 'paused' : 'active';
        }
        return paused;
    }

    /** 一時停止バーをヘッダー直下に置く（位置情報オフの警告バナーが出ていればその下） */
    layoutTopNotices() {
        if (typeof document === 'undefined') return null;
        const pauseEl = document.getElementById('marking-paused-banner');
        if (!pauseEl || !pauseEl.style) return null;
        if (pauseEl.classList && pauseEl.classList.contains('hidden')) return null;

        let top = 168;
        try {
            const header = document.querySelector('header');
            if (header && typeof header.getBoundingClientRect === 'function') {
                const rect = header.getBoundingClientRect();
                if (rect && rect.height > 0) top = Math.round(rect.bottom + 8);
            }
            // 位置情報オフの警告バナーが先に出ているなら、その下に積んで重なりを防ぐ
            const permission = document.getElementById('location-permission-banner');
            if (permission && permission.classList && !permission.classList.contains('hidden')
                && typeof permission.getBoundingClientRect === 'function') {
                const rect = permission.getBoundingClientRect();
                if (rect && rect.height > 0) top = Math.max(top, Math.round(rect.bottom + 8));
            }
        } catch (e) { /* fallback */ }

        pauseEl.style.top = `${Math.max(top, 64)}px`;
        return pauseEl.style.top;
    }

    /** ワンタップで ON / OFF を切り替える */
    toggleMarkingPaused() {
        return this.setMarkingPaused(!this.isMarkingPaused());
    }

    /**
     * Watch（コンパニオン）へ状態を知らせる。
     * 未定義・プラグイン未登録・Watch未ペアリングのいずれでも黙って何もしない。
     */
    notifyWatchState(reason) {
        if (!this.watchBridge) return;
        try {
            this.watchBridge.onStateChanged(reason);
        } catch (e) {
            console.warn('[Watch] state push failed:', e);
        }
    }

    /**
     * ON / OFF を確定する。
     * @param {boolean} paused true で停止、false で再開
     * @param {{ silent?: boolean, source?: string }} options
     * @returns {boolean} 実際に状態が変わったか
     */
    setMarkingPaused(paused, options = {}) {
        const next = !!paused;
        const changed = next !== this.isMarkingPaused();

        this.markingPaused = next;
        this.saveMarkingPausePreference(next);

        if (next) {
            // 稼働中に停止した瞬間：watcher / フォアグラウンド測位を止めて電池消費も止める
            this.stopLocationTracking();
            this.updateGPSStatus('GPS: マーキング停止中', 'bg-sky-400', 'text-sky-300');
        } else {
            // 再開した瞬間：バッジを消してから測位を張り直す
            // （OS権限が拒否中なら既存の位置情報バナー導線がそのまま働く）
            this.renderMarkingPauseUI();
            const started = this.startLocationTracking();
            if (!started && this.geolocationStarted !== true) {
                this.updateGPSStatus('GPS: マーキング待機', 'bg-amber-400', 'text-amber-400');
            }
        }

        this.renderMarkingPauseUI();
        // WatchのON/OFF表示を合わせる（Watch側の操作で変わった場合もここで同期）
        this.notifyWatchState('marking');

        if (changed && options.silent !== true) {
            this.showToast(next ? 'マーキングを一時停止しました' : 'マーキングを再開しました');
        }
        return changed;
    }

    /**
     * 測位（バックグラウンド watcher → Web watchPosition）を開始する。
     * マーキング停止中・起動ゲート通過前は開始しない。
     * @returns {boolean} 開始したか
     */
    startLocationTracking() {
        if (this.isMarkingPaused()) return false;
        if (this.geolocationStarted === true) return false;
        // 初回のルール説明中（起動ゲート前）は許可要求も測位も始めない
        if (this.servicesStarted !== true) return false;

        this.geolocationStarted = true;
        this.initGeolocation();
        return true;
    }

    /**
     * 測位を止める（バックグラウンド watcher・Web watchPosition・ネイティブ watchPosition）。
     * @returns {boolean} 何かを止めたか
     */
    stopLocationTracking() {
        let stopped = false;

        if (this.backgroundWatcherStarted || this.backgroundWatcherId != null) {
            stopped = this.stopBackgroundGeolocation() || stopped;
        }

        if (this.watchId != null) {
            try {
                if (typeof navigator !== 'undefined' && navigator.geolocation
                    && typeof navigator.geolocation.clearWatch === 'function') {
                    navigator.geolocation.clearWatch(this.watchId);
                }
            } catch (e) { /* ignore */ }
            this.watchId = null;
            stopped = true;
        }

        if (this.nativeWatchId != null) {
            try {
                const nativeGeo = typeof this.getNativeGeolocation === 'function' ? this.getNativeGeolocation() : null;
                if (nativeGeo && typeof nativeGeo.clearWatch === 'function') {
                    Promise.resolve(nativeGeo.clearWatch({ id: this.nativeWatchId })).catch(() => {});
                }
            } catch (e) { /* ignore */ }
            this.nativeWatchId = null;
            stopped = true;
        }

        this.geolocationStarted = false;
        return stopped;
    }

    /**
     * バックグラウンドプラグインの位置（{latitude, longitude, ...}）を
     * navigator.geolocation と同じ形に直し、通常の測位処理へ流す。
     * 仮想散歩中（D-Pad）は handlePositionUpdate 側が実GPSで上書きしない。
     */
    handleBackgroundLocation(location) {
        const latitude = Number(location.latitude);
        const longitude = Number(location.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

        this.handlePositionUpdate({
            coords: {
                latitude,
                longitude,
                accuracy: typeof location.accuracy === 'number' ? location.accuracy : null,
                altitude: typeof location.altitude === 'number' ? location.altitude : null,
                heading: typeof location.bearing === 'number' ? location.bearing : null,
                speed: typeof location.speed === 'number' ? location.speed : null
            },
            timestamp: typeof location.time === 'number' ? location.time : Date.now()
        }, false);

        return true;
    }

    /** Capacitor Geolocation プラグインがネイティブで利用可能か（Webでは null） */
    getNativeGeolocation() {
        try {
            const cap = window.Capacitor;
            if (!cap || !cap.Plugins || !cap.Plugins.Geolocation) return null;
            if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return null;
            return cap.Plugins.Geolocation;
        } catch (e) {
            return null;
        }
    }

    startNativeGeolocation(plugin, options) {
        try {
            Promise.resolve(plugin.getCurrentPosition(options))
                .then((position) => this.handlePositionUpdate(position, true))
                .catch((error) => this.handlePositionError(error));

            const watching = plugin.watchPosition(options, (position, error) => {
                if (error) {
                    this.handlePositionError(error);
                    return;
                }
                if (position) this.handlePositionUpdate(position, false);
            });
            if (watching && typeof watching.then === 'function') {
                watching
                    .then((id) => { this.nativeWatchId = id; })
                    .catch((error) => this.handlePositionError(error));
            }
            return true;
        } catch (e) {
            console.warn('Capacitor Geolocation unavailable, falling back to Web API:', e);
            return false;
        }
    }

    /** バナーの「再確認」：拒否が解消されていればバナーが自動で消える */
    recheckLocationPermission() {
        // ネイティブのバックグラウンド測位中なら watcher を張り直して測位を再開する
        const backgroundPlugin = this.getBackgroundGeolocationPlugin();
        if (backgroundPlugin && this.backgroundWatcherStarted) {
            this.stopBackgroundGeolocation();
            this.startBackgroundGeolocation(backgroundPlugin);
            return;
        }

        if (!('geolocation' in navigator)) return;
        navigator.geolocation.getCurrentPosition(
            (position) => this.handlePositionUpdate(position, false),
            (error) => this.handlePositionError(error),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
        if (this.locationBanner) this.locationBanner.refreshPermissionState();
    }

    // --- Lifecycle & Background State Handler for iOS / Screen Sleep ---
    initLifecycleListeners() {
        document.addEventListener('visibilitychange', () => {
            this.isAppInBackground = document.hidden;
            if (!document.hidden) {
                // Return from background / lock screen
                if (this.backgroundClaimCount > 0) {
                    this.showToast(`ポケット歩行で ${this.backgroundClaimCount} マスを開拓しました`);
                    this.backgroundClaimCount = 0;
                }
                if (this.virtualPos && this.map) {
                    this.updatePlayerMarker(this.virtualPos);
                    if (this.gridManager) {
                        this.gridManager.fetchAndRenderTilesInBounds();
                    }
                }
                // 設定アプリで位置情報をオンにして戻ってきた場合にバナーを自動で消す
                if (this.locationBanner) this.locationBanner.refreshPermissionState();
                // フォアグラウンド復帰時に未送信分をまとめて同期
                if (this.syncQueue) this.syncQueue.flush('foreground');
            }
        });

        // 通信状態の復帰・切断（オフラインキューとの連携）
        window.addEventListener('online', () => {
            if (this.syncQueue) this.syncQueue.flush('online');
        });
        window.addEventListener('offline', () => {
            if (this.syncQueue) this.syncQueue.notify();
        });

        // 画面回転・リサイズ時はトースト位置を再調整（検索バー・各バナーとの被り防止）
        window.addEventListener('resize', () => {
            this.layoutTopNotices();
            const container = document.getElementById('toast-container');
            if (container) this.positionToastContainer(container);
        });

        // Capacitor Native AppState listener
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
            try {
                window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
                    this.isAppInBackground = !state.isActive;
                    if (state.isActive && this.syncQueue) this.syncQueue.flush('app-active');
                });
            } catch (e) {}
        }
    }

    calculateDistanceMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    handlePositionUpdate(position, isFirst = false) {
        // 位置情報が取得できた＝許可されている。拒否バナーは自動で消す
        if (this.locationBanner) this.locationBanner.handlePermissionGranted();

        const rawLat = position.coords.latitude;
        const rawLng = position.coords.longitude;
        const latitude = parseFloat(rawLat.toFixed(5));
        const longitude = parseFloat(rawLng.toFixed(5));
        // 実GPSの最新座標は常に保持（デバッグ終了時にここへ戻す）
        this.lastRealPosition = [latitude, longitude];
        // 次回起動の初期表示用に端末へ保存（サーバー送信なし）
        this.saveLastPosition(latitude, longitude);

        // デバッグの仮想散歩中は、実GPSで仮想座標・マーカー・塗りを上書きしない。
        // ここで return しないと D-Pad の1歩が数秒で実際の位置に戻ってしまい、
        // 連続で塗り進められない（これがD-Pad塗りが効かない原因）。
        if (this.isVirtualWalkActive()) {
            this.updateGPSStatus('GPS: 仮想散歩中', 'bg-amber-400', 'text-amber-400');
            return;
        }

        // マーキング停止中：実GPS由来の塗りはここでも止める（processMeshAndClaim と二重ガード）。
        // 停止直後に飛行中のコールバックが届いてもマスを塗らないが、マーカー位置だけは更新する。
        if (this.isMarkingPaused()) {
            this.virtualPos = [latitude, longitude];
            this.updateGPSStatus('GPS: マーキング停止中', 'bg-sky-400', 'text-sky-300');
            if (!this.isAppInBackground) this.updatePlayerMarker([latitude, longitude]);
            return;
        }

        this.virtualPos = [latitude, longitude];

        this.updateGPSStatus('GPS: 測位中', 'bg-emerald-400', 'text-emerald-400');

        // Battery / Noise Filter: Ignore stationary jitter < 5m unless tile index changed
        let shouldProcessMesh = true;
        if (!isFirst && this.lastProcessedLat !== null && this.lastProcessedLng !== null) {
            const dist = this.calculateDistanceMeters(this.lastProcessedLat, this.lastProcessedLng, latitude, longitude);
            if (dist < 5 && this.gridManager) {
                const { meshId } = this.gridManager.getMeshIdFromLatLng(latitude, longitude);
                if (meshId === this.currentMeshId) {
                    shouldProcessMesh = false;
                }
            }
        }

        if (shouldProcessMesh) {
            this.lastProcessedLat = latitude;
            this.lastProcessedLng = longitude;
            this.processMeshAndClaim(latitude, longitude);
        }

        if (!this.isAppInBackground) {
            this.updatePlayerMarker([latitude, longitude]);
            if (isFirst && this.map) {
                this.map.setView([latitude, longitude], CONFIG.DEFAULT_ZOOM);
            }
        }
    }

    handlePositionError(error) {
        console.warn('Geolocation error:', error);

        // Web Geolocation(code=1) と Capacitor Geolocation の双方の拒否を拾う
        const isDenied = (typeof LocationPermissionBanner !== 'undefined'
            && LocationPermissionBanner.isPermissionDeniedError(error))
            || (error && (error.code === 1 || error.code === '1'));

        if (isDenied) {
            this.updateGPSStatus('GPS: 拒否', 'bg-red-500', 'text-red-400');
            if (!this.locationBanner) {
                this.showToast('位置情報の利用が許可されていません（端末の設定をご確認ください）');
                return;
            }
            const becameVisible = this.locationBanner.show();
            // 常設バナーが出ている間はトーストを重ねない（バナーは許可されるまで出たまま）
            if (becameVisible) {
                this.showToast('位置情報がオフになっています');
            }
            return;
        }

        const code = error ? error.code : undefined;
        switch (code) {
            case 2:
            case 'POSITION_UNAVAILABLE':
                this.updateGPSStatus('GPS: 圏外', 'bg-amber-500', 'text-amber-400');
                break;
            case 3:
            case 'TIMEOUT':
                this.updateGPSStatus('GPS: タイムアウト', 'bg-amber-500', 'text-amber-400');
                break;
            default:
                this.updateGPSStatus('GPS: エラー', 'bg-red-500', 'text-red-400');
        }
    }

    updateGPSStatus(label, dotClass, textClass) {
        if (this.gpsDot) {
            this.gpsDot.className = `w-2.5 h-2.5 rounded-full ${dotClass} animate-pulse`;
        }
        const indicator = document.getElementById('gps-status-indicator');
        if (indicator) {
            indicator.title = label;
        }
    }

    updatePlayerMarker(latlng) {
        if (!this.map) return;

        const pulseColor = this.currentTeam === 'white' ? '#ffffff' : '#000000';
        const ringBorder = this.currentTeam === 'white' ? '#000000' : '#ffffff';

        const customIcon = L.divIcon({
            className: 'custom-player-marker',
            html: `
                <div class="relative flex items-center justify-center w-6 h-6">
                    <span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style="background-color: ${pulseColor};"></span>
                    <span class="relative inline-flex rounded-full h-4 w-4 shadow-md" style="background-color: ${pulseColor}; border: 2px solid ${ringBorder};"></span>
                </div>
            `,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        if (!this.userMarker) {
            this.userMarker = L.marker(latlng, { icon: customIcon, zIndexOffset: 1000 }).addTo(this.map);
        } else {
            this.userMarker.setLatLng(latlng);
            this.userMarker.setIcon(customIcon);
        }
    }

    /**
     * プレイヤーピンを地図から外す（v1.1: 初回起動で渋谷にピンを残さないため）。
     * 次の updatePlayerMarker で作り直される。
     */
    hidePlayerMarker() {
        if (this.userMarker && this.map && typeof this.userMarker.remove === 'function') {
            this.userMarker.remove();
        }
        this.userMarker = null;
    }

    // ---------------------------------------------------------------
    // 前回の現在地（v1.1）
    //   初期表示を渋谷固定から「前回いた場所」に変える。保存は端末内のみで、
    //   サーバーには送らない（非表示ピンと同じくプライバシー設計に沿う）。
    // ---------------------------------------------------------------

    /** 保存済みの現在地を読む（無い・壊れている・範囲外なら null） */
    loadSavedPosition() {
        try {
            const raw = localStorage.getItem('tw_last_position');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const lat = Number(parsed && parsed.lat);
            const lng = Number(parsed && parsed.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            if (lat < -85 || lat > 85 || lng < -180 || lng > 180) return null;
            return [lat, lng];
        } catch (e) {
            return null;
        }
    }

    /** 実GPSの座標を端末に保存する（次回起動の初期表示に使う） */
    saveLastPosition(lat, lng) {
        try {
            localStorage.setItem('tw_last_position', JSON.stringify({ lat, lng, at: Date.now() }));
        } catch (e) {
            /* 保存できないだけで、測位・塗りには影響しない */
        }
    }

    async processMeshAndClaim(lat, lng, options = {}) {
        if (!this.gridManager) return { changed: false, meshId: null };

        // マーキング停止中の自動塗りをここで止める（二重ガード）。
        // D-Pad の手動テスト（source: 'debug'）は停止中でも動かせるよう除外する。
        const source = (options && options.source)
            || (this.manualMarkingInProgress === true ? 'debug' : 'gps');
        if (source !== 'debug' && this.isMarkingPaused()) {
            return { changed: false, meshId: null, latIdx: null, lngIdx: null, blocked: true, reason: 'marking-paused' };
        }

        const { meshId, latIdx, lngIdx } = this.gridManager.getMeshIdFromLatLng(lat, lng);
        const cachedTeam = this.gridManager.claimedTilesCache.get(meshId);

        // 【v1.1 非表示ピン】区域の中は「塗らない・送らない・数えない」（設置した本人の画面でも同じ）。
        // 他人の画面でも初期配置のままなので、区域の存在や住まいの位置は見えない。
        const privacyZone = (this.privacyZones && typeof this.gridManager.getPrivacyZone === 'function')
            ? this.gridManager.getPrivacyZone(latIdx, lngIdx)
            : null;
        if (privacyZone) {
            this.lastPrivacyBlockAt = Date.now();
            return {
                changed: false,
                meshId,
                latIdx,
                lngIdx,
                blocked: true,
                reason: 'privacy-zone',
                team: cachedTeam || null,
                isReclaimed: false
            };
        }

        if (this.currentMeshId === meshId && cachedTeam === this.currentTeam) {
            // すでに現在地かつ自陣：塗り直しも送信もしない
            return { changed: false, meshId, latIdx, lngIdx, team: this.currentTeam, isReclaimed: false };
        }

        if (this.currentMeshId !== meshId || cachedTeam !== this.currentTeam) {
            const isReclaimed = cachedTeam && cachedTeam !== this.currentTeam;
            this.currentMeshId = meshId;

            // Track background claims while screen is locked
            if (this.isAppInBackground) {
                this.backgroundClaimCount++;
                console.log(`[Background GPS] Claimed ${meshId} in background. Total: ${this.backgroundClaimCount}`);
            }

            // 1. Immediate local UI update
            this.gridManager.claimedTilesCache.set(meshId, this.currentTeam);
            this.gridManager.saveTilesToStorage();
            // 自分が今週踏んだマス（自分の画面だけの枠線用・サーバーには送らない）
            if (typeof this.gridManager.recordFootprint === 'function') {
                this.gridManager.recordFootprint(meshId);
            }

            if (!this.isAppInBackground) {
                this.gridManager.renderSingleTile(meshId, latIdx, lngIdx);
                this.updateScoreUI();
                this.playClaimSound();
                this.triggerHaptic();
            } else {
                this.updateScoreUI();
            }

            // Watch（コンパニオン）へ今の状態を送る。プラグイン未登録なら何もしない
            this.notifyWatchState('claim');

            // 2. Stats logging
            if (this.statsManager) {
                this.statsManager.recordTileClaimed(isReclaimed);
            }

            // In-game Coin reward
            if (this.coinManager) {
                this.coinManager.onTileClaimed(isReclaimed);
            }

            // 3. Supabase online sync（オフライン時はOutboxに退避し、復帰後に一括再送）
            if (this.supabaseManager) {
                this.enqueueTileSync(meshId, latIdx, lngIdx, this.currentTeam);
            }

            return { changed: true, meshId, latIdx, lngIdx, team: this.currentTeam, isReclaimed: !!isReclaimed };
        }

        return { changed: false, meshId, latIdx, lngIdx, team: cachedTeam || null, isReclaimed: false };
    }

    playClaimSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;

            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.connect(gain);
            gain.connect(ctx.destination);

            if (this.currentTeam === 'white') {
                osc.frequency.setValueAtTime(660, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
            } else {
                osc.frequency.setValueAtTime(330, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
            }

            gain.gain.setValueAtTime(0.08, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

            osc.start();
            osc.stop(ctx.currentTime + 0.12);
        } catch (e) {
            // Audio context policy
        }
    }

    triggerHaptic() {
        if (window.Capacitor && window.Capacitor.isPluginAvailable && window.Capacitor.isPluginAvailable('Haptics')) {
            try {
                window.Capacitor.Plugins.Haptics.impact({ style: 'medium' });
            } catch (e) {}
        } else if ('vibrate' in navigator) {
            navigator.vibrate(15);
        }
    }

    updateScoreUI() {
        if (!this.gridManager || !this.scoreBlackEl || !this.scoreWhiteEl || !this.barBlackEl || !this.barWhiteEl) return;

        let blackCount = 0;
        let whiteCount = 0;

        for (const team of this.gridManager.claimedTilesCache.values()) {
            if (team === 'black') blackCount++;
            else if (team === 'white') whiteCount++;
        }

        const total = blackCount + whiteCount;
        let blackPct = 50;
        let whitePct = 50;

        if (total > 0) {
            blackPct = Math.round((blackCount / total) * 100);
            whitePct = 100 - blackPct;
        }

        this.scoreBlackEl.textContent = blackPct >= 8 ? `${blackPct}%` : '';
        this.scoreWhiteEl.textContent = whitePct >= 8 ? `${whitePct}%` : '';

        this.barBlackEl.style.width = `${blackPct}%`;
        this.barWhiteEl.style.width = `${whitePct}%`;

        this.renderTeamBadge();
        this.updateTeamStatusUI();
    }

    initDPad() {
        // デバッグ無効時は仮想十字キー自体を出さず、操作イベントも縫らない
        if (!this.debugEnabled) {
            const dpad = document.getElementById('dpad-container');
            if (dpad) dpad.classList.add('hidden');
            return;
        }
        const stepLat = 0.0009; // 1 mesh north/south
        const stepLng = this.gridManager ? this.gridManager.LNG_GRID : 0.00109868; // 1 mesh east/west

        const moveVirtual = async (dLat, dLng) => {
            // デバッグ無効（ENABLE_DEBUG_TOOLS=false）または D-PAD: OFF なら何もしない
            if (!this.isVirtualWalkActive()) return;

            const next = (typeof DebugTools !== 'undefined')
                ? DebugTools.stepPosition(this.virtualPos, dLat, dLng)
                : [this.virtualPos[0] + dLat, this.virtualPos[1] + dLng];
            this.virtualPos = next;

            this.updatePlayerMarker(this.virtualPos);
            if (this.map) {
                this.map.panTo(this.virtualPos, { animate: true, duration: 0.2 });
            }

            // 通常歩行と同じ塗り・戦績・コイン・Outbox 同期のパイプラインを通す
            this.lastProcessedLat = this.virtualPos[0];
            this.lastProcessedLng = this.virtualPos[1];
            let result = null;
            // D-Pad は「明示的な手動テスト操作」なので、マーキング停止中でも塗れるよう
            // 自動GPS由来の塗りとは別扱いにする（source: 'debug'）
            this.manualMarkingInProgress = true;
            try {
                result = await this.processMeshAndClaim(this.virtualPos[0], this.virtualPos[1]);
            } catch (e) {
                console.warn('[Debug D-Pad] Claim failed:', e);
            } finally {
                this.manualMarkingInProgress = false;
            }
            this.reportVirtualStep(result);
        };

        // 1歩の結果を D-Pad 下に表示（塗れたのか・送信待ちが何件かを目で確認できる）
        this.reportVirtualStep = (result) => {
            const teamLabel = this.currentTeam === 'white' ? 'WHITE' : 'BLACK';
            if (!result || !result.meshId) {
                this.updateDpadStatus('塗り対象なし');
                return;
            }
            const short = String(result.meshId).replace('tile_', '');
            const render = () => {
                const pending = this.syncQueue ? this.syncQueue.count() : 0;
                if (result.changed) {
                    this.updateDpadStatus(`${teamLabel} ${short} 獲得 / 送信待ち ${pending}`);
                } else {
                    this.updateDpadStatus(`${short} は既に${teamLabel} / 送信待ち ${pending}`);
                }
            };
            render();
            // 送信は非同期なので、少し後に送信待ち件数を更新して実際の残件数を出す
            clearTimeout(this.dpadStatusTimer);
            this.dpadStatusTimer = setTimeout(render, 1200);
        };

        const bindButton = (id, dLat, dLng) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                moveVirtual(dLat, dLng);
            });
        };

        bindButton('dpad-up', stepLat, 0);
        bindButton('dpad-down', -stepLat, 0);
        bindButton('dpad-left', 0, -stepLng);
        bindButton('dpad-right', 0, stepLng);

        if (this.btnSwapTeam) {
            this.btnSwapTeam.addEventListener('click', (e) => {
                e.preventDefault();
                this.swapTeam();
            });
        }

        const btnCycleSkin = document.getElementById('btn-cycle-skin');
        if (btnCycleSkin) {
            btnCycleSkin.addEventListener('click', (e) => {
                e.preventDefault();
                this.cycleSkin();
            });
        }
    }

    jumpToLocation(lat, lng, displayName) {
        if (!this.map) return;

        // 1. スムーズに目標地点へカメラ移動 (ズームレベル 16: 100mマスが最適表示される)
        this.map.flyTo([lat, lng], 16, {
            animate: true,
            duration: 1.2
        });

        // 2. 検索ピンマーカーを設置
        if (this.searchManager) {
            this.searchManager.setSearchMarker(lat, lng, displayName);
        }

        // 3. 移動先エリアのタイルの即時フェッチ＆グリッド更新
        if (this.gridManager) {
            setTimeout(() => {
                this.gridManager.updateGrids();
                this.gridManager.fetchAndSyncTiles();
            }, 300);
        }

        // 4. トースト通知
        this.showToast(`${displayName} の塗り状況を表示中 (右下で現在地へ復帰)`);
    }

    initEvents() {
        // Zoom Controls (Custom Right-Bottom Controls)
        const btnZoomIn = document.getElementById('btn-zoom-in');
        if (btnZoomIn) {
            btnZoomIn.addEventListener('click', (e) => {
                e.preventDefault();
                if (this.map) this.map.zoomIn();
            });
        }

        const btnZoomOut = document.getElementById('btn-zoom-out');
        if (btnZoomOut) {
            btnZoomOut.addEventListener('click', (e) => {
                e.preventDefault();
                if (this.map) this.map.zoomOut();
            });
        }

        if (this.btnRecenter) {
            this.btnRecenter.addEventListener('click', () => {
                this.recenterToCurrentPosition();
            });
        }

        // Debug Preview Buttons (Safe UI Preview without modifying persistent production state)
        const btnDebugResult = document.getElementById('btn-debug-preview-result');
        if (btnDebugResult) {
            btnDebugResult.addEventListener('click', () => {
                if (!this.debugEnabled) return;
                if (this.menuModal) this.menuModal.classList.add('hidden');
                this.showWeeklyResultModal(true);
            });
        }

        const btnDebugTeam = document.getElementById('btn-debug-preview-team');
        if (btnDebugTeam) {
            btnDebugTeam.addEventListener('click', () => {
                if (!this.debugEnabled) return;
                if (this.menuModal) this.menuModal.classList.add('hidden');
                this.showTeamResetPreviewModal();
            });
        }

        const btnCloseTeamResetModal = document.getElementById('btn-close-team-reset-modal');
        if (btnCloseTeamResetModal) {
            btnCloseTeamResetModal.addEventListener('click', () => {
                const modal = document.getElementById('team-reset-modal');
                if (modal) modal.classList.add('hidden');
            });
        }

        // Setup swipe up to close for SHOP modal
        this.setupSwipeUpToClose('shop-modal', () => {
            if (this.coinManager) this.coinManager.closeShopModal();
        });

        // Debug Coin Operations
        const btnDebugResetCoins = document.getElementById('btn-debug-reset-coins');
        if (btnDebugResetCoins) {
            btnDebugResetCoins.addEventListener('click', () => {
                if (!this.debugEnabled) return;
                if (this.coinManager) {
                    this.coinManager.coins = 0;
                    localStorage.setItem(this.coinManager.STORAGE_KEY_COINS, '0');
                    this.coinManager.updateCoinUI();
                    this.coinManager.syncCoinsToSupabase();
                    this.showToast('【デバッグ】コインを 0 C にリセットしました');
                }
            });
        }

        const btnDebugAdd1000 = document.getElementById('btn-debug-add-1000-coins');
        if (btnDebugAdd1000) {
            btnDebugAdd1000.addEventListener('click', () => {
                if (!this.debugEnabled) return;
                if (this.coinManager) {
                    this.coinManager.addCoins(1000, 'デバッグ付与');
                    this.showToast('【デバッグ】+1000 C を付与しました');
                }
            });
        }

        // Debug Team Switch
        const btnDebugSetBlack = document.getElementById('btn-debug-set-black');
        if (btnDebugSetBlack) {
            btnDebugSetBlack.addEventListener('click', () => {
                if (!this.debugEnabled) return;
                this.currentTeam = 'black';
                localStorage.setItem('player_team', 'black');
                this.applyTheme();
                if (this.statsManager) this.statsManager.syncUserProfileImmediate();
                if (this.gridManager) this.gridManager.redrawTiles();
                this.updateScoreUI();
                this.showToast('【デバッグ】Black陣営に変更しました');
            });
        }

        const btnDebugSetWhite = document.getElementById('btn-debug-set-white');
        if (btnDebugSetWhite) {
            btnDebugSetWhite.addEventListener('click', () => {
                if (!this.debugEnabled) return;
                this.currentTeam = 'white';
                localStorage.setItem('player_team', 'white');
                this.applyTheme();
                if (this.statsManager) this.statsManager.syncUserProfileImmediate();
                if (this.gridManager) this.gridManager.redrawTiles();
                this.updateScoreUI();
                this.showToast('【デバッグ】White陣営に変更しました');
            });
        }

        // Debug Reset Purchased Items
        const btnDebugResetPurchases = document.getElementById('btn-debug-reset-purchases');
        if (btnDebugResetPurchases) {
            btnDebugResetPurchases.addEventListener('click', () => {
                if (!this.debugEnabled) return;
                if (this.coinManager && typeof this.coinManager.resetPurchasedItems === 'function') {
                    this.coinManager.resetPurchasedItems();
                }
            });
        }

        // Debug: 全陣地を白紙リセット（ローカル＋当週サーバー）
        const btnDebugResetTerritories = document.getElementById('btn-debug-reset-territories');
        if (btnDebugResetTerritories) {
            btnDebugResetTerritories.addEventListener('click', (e) => {
                e.preventDefault();
                if (!this.debugEnabled) return;
                this.resetAllTerritories();
            });
        }

        window.addEventListener('resize', () => this.resetViewportScroll());
        window.addEventListener('orientationchange', () => this.resetViewportScroll());
    }

    /**
     * デバッグ：全陣地を白紙リセット（確認ダイアログ → ローカル全消し → 当週サーバー削除）
     * ENABLE_DEBUG_TOOLS=false では早期リターンで一切実行しない。
     */
    async resetAllTerritories() {
        if (!this.debugEnabled) return;
        if (typeof DebugTools === 'undefined') {
            this.showToast('デバッグツールが読み込まれていません');
            return;
        }

        let res;
        try {
            res = await DebugTools.resetTerritories(this, {
                confirmFn: (message) => window.confirm(message)
            });
        } catch (e) {
            console.warn('[Debug] Reset failed:', e);
            this.showToast('白紙リセットに失敗しました');
            return;
        }

        if (res.canceled) {
            this.showToast('【デバッグ】白紙リセットをキャンセルしました');
            return;
        }
        if (!res.ok) {
            this.showToast('【デバッグ】白紙リセットは無効化されています');
            return;
        }

        if (this.gridManager) this.gridManager.updateGrids();
        this.updateScoreUI();
        this.updateDpadStatus('全陣地を白紙化しました');

        let detail = 'ローカルの地図・保存データ・未送信キューを空にしました';
        if (res.serverDeleted > 0) {
            detail = `ローカル ${res.localCleared} マス＋サーバー ${res.serverDeleted} 件を削除`;
        } else if (res.serverError) {
            detail = `ローカル ${res.localCleared} マスを削除（サーバー削除は失敗）`;
        } else if (res.serverSkipped) {
            detail = `ローカル ${res.localCleared} マスを削除（サーバーはオフラインで未削除）`;
        } else if (res.localCleared > 0) {
            detail = `ローカル ${res.localCleared} マスを削除`;
        }
        this.showToast('【デバッグ】全陣地を白紙リセット', detail);
        console.log('[Debug] Territory reset result:', res);
    }

    showTeamResetPreviewModal() {
        const modal = document.getElementById('team-reset-modal');
        if (!modal) return;

        const nextTeam = this.currentTeam === 'black' ? 'White (白)' : 'Black (黒)';
        const teamBadge = document.getElementById('reset-preview-team-name');
        if (teamBadge) {
            teamBadge.textContent = nextTeam;
            teamBadge.className = this.currentTeam === 'black' ? 'font-bold text-white font-mono text-sm' : 'font-bold text-zinc-300 font-mono text-sm';
        }

        modal.classList.remove('hidden');
    }

    initResetCountdown() {
        const seasonBadge = document.getElementById('menu-season-badge');
        const countdownEl = document.getElementById('menu-reset-countdown');

        const updateTimer = () => {
            const now = new Date();
            const jstString = now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
            const jst = new Date(jstString);

            // Compute current ISO week
            if (seasonBadge && this.supabaseManager) {
                seasonBadge.textContent = this.supabaseManager.getCurrentWeekId();
            }

            // Next Monday 00:00 JST
            const nextMonday = new Date(jst);
            const day = jst.getDay(); // 0 is Sunday, 1 is Monday
            const daysUntilMonday = ((8 - day) % 7) || 7;
            nextMonday.setDate(jst.getDate() + daysUntilMonday);
            nextMonday.setHours(0, 0, 0, 0);

            const diffMs = nextMonday - jst;
            if (diffMs <= 0) {
                if (countdownEl) countdownEl.textContent = 'リセット中...';
                return;
            }

            const diffHrs = Math.floor(diffMs / 3600000);
            const diffMins = Math.floor((diffMs % 3600000) / 60000);
            const diffSecs = Math.floor((diffMs % 60000) / 1000);

            if (countdownEl) {
                countdownEl.textContent = `リセットまで: ${diffHrs}時間${diffMins}分${diffSecs}秒`;
            }
        };

        updateTimer();
        setInterval(updateTimer, 1000);
    }

    initRealtimeSync() {
        if (!this.supabaseManager || !this.supabaseManager.client) return;

        try {
            this.realtimeChannel = this.supabaseManager.client
                .channel('territory_tiles_live')
                .on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'territory_tiles' },
                    (payload) => {
                        if (payload.new && this.gridManager) {
                            const tile = payload.new;
                            const current = this.gridManager.claimedTilesCache.get(tile.tile_id);
                            if (current !== tile.team) {
                                console.log('[Realtime Sync] Remote tile claimed:', tile.tile_id, tile.team);
                                this.gridManager.claimedTilesCache.set(tile.tile_id, tile.team);
                                this.gridManager.saveTilesToStorage();
                                this.gridManager.updateGrids();
                                this.updateScoreUI();
                            }
                        }
                    }
                )
                .subscribe((status) => {
                    console.log('[Realtime Sync Status]', status);
                });
        } catch (e) {
            console.warn('Supabase Realtime subscription error:', e);
        }
    }
}

// Auto-start on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new TerritoryWalkApp();
});
