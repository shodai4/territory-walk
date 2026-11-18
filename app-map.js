/**
 * TERRITORY WALK - app-map.js
 * 地図・グリッド・プライバシーゾーン・他プレイヤーの陣地同期・見た目（スキン／地図テーマ）
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppCore を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppMap extends TerritoryWalkAppCore {
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
            // v1.2: マス・ブロック・プライバシー円などのベクター描画を Canvas に統一する
            // （SVG の数だけDOMノードを作らないので、タップ・ズームの引っかかりとメモリを抑える）
            preferCanvas: true,
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
        // 上部％バーの全国集計もここで一緒に更新する（10秒スロットル）
        this.refreshGlobalTeamCounts();
        if (!this.gridManager) return;
        await this.gridManager.fetchAndSyncTiles();
        this.updateScoreUI();
    }

    /**
     * 全国（サーバー全体）の黒・白マス数を取得して上部％バーへ反映する。
     *   - 連続呼び出し（地図移動・8秒ポーリング）は 10 秒スロットルで間引く
     *   - force: true で即時取得（画面復帰・通信復帰・デバッグリセット後）
     *   - 通信エラー時は前回値を保持し、一度も取れていなければローカル集計のまま
     */
    async refreshGlobalTeamCounts(options = {}) {
        const force = !!(options && options.force);
        if (!this.supabaseManager || typeof this.supabaseManager.fetchGlobalTeamCounts !== 'function') return null;
        if (!this.globalTeamCounts) {
            this.globalTeamCounts = { black: 0, white: 0, loaded: false, weekId: null, fetchedAt: 0 };
        }

        const weekId = (typeof this.supabaseManager.getCurrentWeekId === 'function')
            ? this.supabaseManager.getCurrentWeekId()
            : null;

        // 週が変わった（月曜リセット）ら前週の数字を引きずらない
        const knownWeek = this.globalTeamCounts.weekId;
        if (this.globalTeamCounts.loaded && knownWeek && weekId && knownWeek !== weekId) {
            this.globalTeamCounts = { black: 0, white: 0, loaded: false, weekId: null, fetchedAt: 0 };
            this.updateScoreUI();
        }

        if (this.globalCountsRequest) return this.globalCountsRequest;

        const GLOBAL_COUNTS_MIN_INTERVAL_MS = 10000;
        const now = Date.now();
        if (!force && (now - (this.globalCountsLastRequestAt || 0)) < GLOBAL_COUNTS_MIN_INTERVAL_MS) {
            return null;
        }
        if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return null;

        this.globalCountsLastRequestAt = now;
        this.globalCountsRequest = Promise.resolve()
            .then(() => this.supabaseManager.fetchGlobalTeamCounts(weekId))
            .then((counts) => {
                this.globalCountsRequest = null;
                if (!counts || typeof counts.black !== 'number' || typeof counts.white !== 'number') {
                    return null;
                }
                this.globalTeamCounts = {
                    black: counts.black,
                    white: counts.white,
                    loaded: true,
                    weekId: counts.weekId || weekId || null,
                    fetchedAt: Date.now()
                };
                this.updateScoreUI();
                return counts;
            })
            .catch(() => {
                this.globalCountsRequest = null;
                return null;
            });
        return this.globalCountsRequest;
    }

    /**
     * 上部％バーの元になる黒・白のマス数を返す。
     * 全国集計が取れていればそれを使い、未取得・オフライン時は従来どおり
     * この端末が読み込んだ範囲（claimedTilesCache）で計算する。
     */
    getScoreCounts() {
        const global = this.globalTeamCounts;
        if (global && global.loaded) {
            return { black: global.black, white: global.white, source: 'global' };
        }
        let black = 0;
        let white = 0;
        if (this.gridManager && this.gridManager.claimedTilesCache) {
            for (const team of this.gridManager.claimedTilesCache.values()) {
                if (team === 'black') black++;
                else if (team === 'white') white++;
            }
        }
        return { black, white, source: 'local' };
    }

    /**
     * 自分の塗り（新規は +1、相手からの奪取は自分 +1 / 相手 -1）を全国集計へ即時反映する。
     * 数字は次のサーバー取得（10秒間隔）で正しい値に補正される。
     */
    applyGlobalCountDelta(team, delta) {
        if (!this.globalTeamCounts || !this.globalTeamCounts.loaded) return;
        if (team !== 'black' && team !== 'white') return;
        const next = Math.max(0, (this.globalTeamCounts[team] || 0) + Number(delta || 0));
        this.globalTeamCounts[team] = next;
    }

    /** Realtime で受けた他プレイヤーの塗りを全国集計へ反映する（前チーム -1 / 後チーム +1） */
    applyRealtimeGlobalDelta(previousTeam, nextTeam) {
        if (!this.globalTeamCounts || !this.globalTeamCounts.loaded) return;
        if (previousTeam && previousTeam !== nextTeam) this.applyGlobalCountDelta(previousTeam, -1);
        if (nextTeam) this.applyGlobalCountDelta(nextTeam, 1);
        this.updateScoreUI();
    }

    /** デバッグの白紙リセット時：全国集計も空に戻し、すぐ取り直す */
    resetGlobalTeamCounts() {
        this.globalTeamCounts = { black: 0, white: 0, loaded: false, weekId: null, fetchedAt: 0 };
        this.globalCountsRequest = null;
        this.globalCountsLastRequestAt = 0;
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
}
