/**
 * TERRITORY WALK - app-actions.js
 * Pro・ポスター書き出し・デバッグ（D-Pad／仮想散歩）・現在地ボタンの動作
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppStats を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppActions extends TerritoryWalkAppBattle {
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
     * ネイティブ（iOS/Android アプリ）では Capacitor Geolocation プラグインだけを使い、
     * Web ブラウザでは高精度 → 低精度の Web 測位フォールバックを使う。
     * @returns {Promise<[number, number]|null>}
     */
    requestFreshPosition() {
        const toLatLng = (position) => {
            if (!position || !position.coords) return null;
            // 明示的な再取得（現在地ボタン）は stationary skip を通さず必ず反映する
            this.handlePositionUpdate(position, false, { force: true });
            const lat = Number(position.coords.latitude);
            const lng = Number(position.coords.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return [lat, lng];
        };

        const requestOnce = (geo, options) => new Promise((resolve, reject) => {
            try {
                geo.getCurrentPosition(
                    (position) => resolve(toLatLng(position)),
                    (error) => reject(error),
                    options
                );
            } catch (e) {
                reject(e);
            }
        });

        // ネイティブでは WebView の navigator.geolocation を絶対に呼ばない。
        // 呼ぶと WKWebView が「"localhost" would like to use your current location.」を出す。
        // プラグインが使えないビルドでも Web API には落とさず、そのまま失敗させる。
        if (this.isNativePlatform()) {
            const nativeGeo = this.getNativeGeolocation();
            if (!nativeGeo) return Promise.reject(new Error('native geolocation unavailable'));
            return Promise.resolve(nativeGeo.getCurrentPosition(WEB_GEOLOCATION_PRECISE_OPTIONS))
                .then(toLatLng)
                .catch((error) => {
                    // ネイティブでも高精度が TIMEOUT / POSITION_UNAVAILABLE なら低精度で1回だけ取り直す
                    if (!this.isCoarseFallbackError(error)) throw error;
                    return Promise.resolve(nativeGeo.getCurrentPosition(WEB_GEOLOCATION_COARSE_OPTIONS))
                        .then((position) => {
                            const pos = toLatLng(position);
                            if (pos) this.webGeolocationMode = 'coarse';
                            return pos;
                        });
                });
        }

        if (typeof navigator === 'undefined' || !navigator.geolocation) {
            return Promise.reject(new Error('geolocation unavailable'));
        }

        const geo = navigator.geolocation;
        return requestOnce(geo, WEB_GEOLOCATION_PRECISE_OPTIONS).catch((error) => {
            // 高精度で TIMEOUT(3) / POSITION_UNAVAILABLE(2) なら低精度で取り直す。
            // 権限拒否（code=1）はそのまま reject（バナー導線で許可を促す）。
            if (!this.isCoarseFallbackError(error)) throw error;
            return requestOnce(geo, WEB_GEOLOCATION_COARSE_OPTIONS).then((pos) => {
                if (pos) this.webGeolocationMode = 'coarse';
                return pos;
            });
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
}
