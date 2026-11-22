/**
 * TERRITORY WALK - app-tracking.js
 * 測位の開始／停止・画面表示中だけのポーリング・ライフサイクル
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppMarking を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppTracking extends TerritoryWalkAppMarking {
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
            this.clearWebGeolocationWatch();
            stopped = true;
        }

        if (this.nativeWatchId != null) {
            stopped = this.clearNativeGeolocationWatch() || stopped;
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

    /**
     * Capacitor のネイティブアプリ（iOS/Android）上で動いているか。
     * ここが true のときは、どの経路でも WebView の navigator.geolocation を呼ばない。
     * （WKWebView の「"localhost" would like to use your current location.」対策）
     */
    isNativePlatform() {
        try {
            const cap = typeof window !== 'undefined' ? window.Capacitor : null;
            return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
        } catch (e) {
            return false;
        }
    }

    /** Capacitor Geolocation プラグインがネイティブで利用可能か（Webでは null） */
    getNativeGeolocation() {
        if (this.nativeGeolocationPlugin) return this.nativeGeolocationPlugin;
        try {
            // ブラウザ実行（Web）では使わない
            if (!this.isNativePlatform()) return null;

            const cap = window.Capacitor;
            if (!cap) return null;
            // cap sync 前やプラグイン未組込のビルドでは PluginHeaders が無いので使わない
            if (typeof cap.isPluginAvailable === 'function'
                && !cap.isPluginAvailable(NATIVE_GEOLOCATION_PLUGIN_NAME)) {
                return null;
            }

            let plugin = cap.Plugins ? cap.Plugins[NATIVE_GEOLOCATION_PLUGIN_NAME] : null;
            if (!plugin && typeof cap.registerPlugin === 'function') {
                plugin = cap.registerPlugin(NATIVE_GEOLOCATION_PLUGIN_NAME);
            }
            if (!plugin || typeof plugin.getCurrentPosition !== 'function') return null;

            this.nativeGeolocationPlugin = plugin;
            return plugin;
        } catch (e) {
            return null;
        }
    }

    /**
     * ネイティブの Geolocation プラグインで測位を開始する（getCurrentPosition + watchPosition）。
     * 張り直すときは前の watch を止めて重複を防ぐ。
     * watchPosition は解決が遅れるため、世代番号（nativeGeolocationAttempt）で
     * 古いリクエストのコールバックを無視し、遅れて届いた watch はその場で止める。
     */
    startNativeGeolocation(plugin, options) {
        try {
            if (!plugin || typeof plugin.getCurrentPosition !== 'function') return false;

            this.clearNativeGeolocationWatch();

            const attempt = this.nextNativeGeolocationAttempt();
            const isStale = () => attempt !== this.nativeGeolocationAttempt;

            Promise.resolve(plugin.getCurrentPosition(options))
                .then((position) => {
                    if (isStale()) return;
                    this.handlePositionUpdate(position, true);
                })
                .catch((error) => {
                    if (isStale()) return;
                    // 高精度が TIMEOUT / POSITION_UNAVAILABLE なら低精度で張り直す（拒否はバナー導線へ）
                    if (this.isCoarseFallbackError(error) && options === WEB_GEOLOCATION_PRECISE_OPTIONS) {
                        this.startCoarseWebGeolocation();
                        return;
                    }
                    this.handlePositionError(error);
                });

            const watching = plugin.watchPosition(options, (position, error) => {
                if (isStale()) return;
                if (error) {
                    if (this.isCoarseFallbackError(error) && options === WEB_GEOLOCATION_PRECISE_OPTIONS) {
                        this.startCoarseWebGeolocation();
                        return;
                    }
                    this.handlePositionError(error);
                    return;
                }
                if (position) this.handlePositionUpdate(position, false);
            });
            if (watching && typeof watching.then === 'function') {
                watching
                    .then((id) => {
                        // すでに張り直されていれば、この watch はその場で止める
                        if (isStale()) {
                            if (typeof plugin.clearWatch === 'function') {
                                Promise.resolve(plugin.clearWatch({ id })).catch(() => {});
                            }
                            return;
                        }
                        this.nativeWatchId = id;
                    })
                    .catch((error) => {
                        if (isStale()) return;
                        this.handlePositionError(error);
                    });
            }
            return true;
        } catch (e) {
            console.warn('Capacitor Geolocation unavailable:', e);
            return false;
        }
    }

    /** ネイティブ測位の世代番号を進める（張り直す前の遅延コールバックを見分けるため） */
    nextNativeGeolocationAttempt() {
        this.nativeGeolocationAttempt = (this.nativeGeolocationAttempt || 0) + 1;
        return this.nativeGeolocationAttempt;
    }

    /** ネイティブの watchPosition を止める（WebView の clearWatch は呼ばない） */
    clearNativeGeolocationWatch() {
        if (this.nativeWatchId == null) return false;
        const id = this.nativeWatchId;
        this.nativeWatchId = null;
        try {
            const nativeGeo = this.getNativeGeolocation();
            if (nativeGeo && typeof nativeGeo.clearWatch === 'function') {
                Promise.resolve(nativeGeo.clearWatch({ id })).catch(() => {});
            }
        } catch (e) { /* ignore */ }
        return true;
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

        // ネイティブでは WebView の navigator.geolocation を絶対に呼ばない
        if (this.isNativePlatform()) {
            const nativeGeo = this.getNativeGeolocation();
            if (nativeGeo) {
                Promise.resolve(nativeGeo.getCurrentPosition(WEB_GEOLOCATION_PRECISE_OPTIONS))
                    .then((position) => this.handlePositionUpdate(position, false))
                    .catch((error) => {
                        if (this.isCoarseFallbackError(error)) {
                            this.startCoarseWebGeolocation();
                            return;
                        }
                        this.handlePositionError(error);
                    });
            } else if (backgroundPlugin) {
                // 停止中の watcher を起こすだけで再確認する
                this.startBackgroundGeolocation(backgroundPlugin);
            }
            return;
        }

        if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;

        const onSuccess = (position) => this.handlePositionUpdate(position, false);
        const onError = (error) => {
            // タイムアウト・測位不可は高精度では取れていないので、低精度で再試行する
            if (this.isCoarseFallbackError(error)) {
                this.startCoarseWebGeolocation();
                return;
            }
            this.handlePositionError(error);
        };

        navigator.geolocation.getCurrentPosition(onSuccess, onError, WEB_GEOLOCATION_PRECISE_OPTIONS);
        if (this.locationBanner) this.locationBanner.refreshPermissionState();
    }

    /* ================================================================== *
     * v1.2 画面表示中だけ動く定期処理（電池対策）
     *   - document.hidden の間は setInterval 自体を止める（タイマー起床ゼロ）
     *   - 復帰した瞬間にカウントダウンを即更新し、陣地の取得を1回だけやり直す
     *   - 歩行記録用のバックグラウンド測位 watcher は止めない（別物・下の visibilitychange を参照）
     * ================================================================== */

    /** 画面が非表示（バックグラウンド・ロック中）か */
    isScreenHidden() {
        return typeof document !== 'undefined' && document.hidden === true;
    }

    /** 8秒ポーリング（他プレイヤーの陣地の取り込み）を開始する。二重起動しない */
    startRemoteTilesPolling() {
        if (this.remoteTilesPollTimer != null) return false;
        this.remoteTilesPollTimer = setInterval(() => {
            // 非表示に切り替わった直後の1回分も念のためスキップする（二重ガード）
            if (this.isScreenHidden()) return;
            this.loadRemoteTiles();
        }, REMOTE_TILES_POLL_MS);
        return true;
    }

    /** 8秒ポーリングを止める */
    stopRemoteTilesPolling() {
        if (this.remoteTilesPollTimer == null) return false;
        clearInterval(this.remoteTilesPollTimer);
        this.remoteTilesPollTimer = null;
        return true;
    }

    /** リセットまでのカウントダウン（1秒刻み）を開始する。二重起動しない */
    startResetCountdown() {
        if (this.resetCountdownTimer != null) return false;
        if (typeof this.updateResetCountdown !== 'function') return false;
        this.resetCountdownTimer = setInterval(() => {
            if (this.isScreenHidden()) return;
            this.updateResetCountdown();
        }, RESET_COUNTDOWN_TICK_MS);
        return true;
    }

    /** カウントダウンを止める */
    stopResetCountdown() {
        if (this.resetCountdownTimer == null) return false;
        clearInterval(this.resetCountdownTimer);
        this.resetCountdownTimer = null;
        return true;
    }

    /**
     * 画面が見えていない間の処理を止める。
     * 止めるのは「画面表示用」の定期通信とカウントダウンだけで、
     * 歩行記録用のバックグラウンド測位（watcher）はそのまま動かす。
     */
    pauseForegroundUpdates() {
        const polling = this.stopRemoteTilesPolling();
        const countdown = this.stopResetCountdown();
        return polling || countdown;
    }

    /**
     * 画面が戻ってきたときの再開処理。
     *   - カウントダウンは止めていた時間分ずれないよう、即時更新してから刻み直す
     *   - 陣地は1回だけ取り直す（直前の復帰から1秒以内の連続復帰では重ねない）
     * @returns {boolean} 陣地を取り直したか
     */
    resumeForegroundUpdates() {
        this.startRemoteTilesPolling();
        if (typeof this.updateResetCountdown === 'function') this.updateResetCountdown();
        this.startResetCountdown();

        const now = Date.now();
        if (now - (this.lastForegroundRefreshAt || 0) < FOREGROUND_REFRESH_MIN_INTERVAL_MS) {
            return false;
        }
        this.lastForegroundRefreshAt = now;
        this.loadRemoteTiles();
        return true;
    }

    // --- Lifecycle & Background State Handler for iOS / Screen Sleep ---
    initLifecycleListeners() {
        document.addEventListener('visibilitychange', () => {
            this.isAppInBackground = document.hidden;
            if (document.hidden) {
                // 画面が見えない間は表示用の定期通信・カウントダウンを止める（電池対策）
                this.pauseForegroundUpdates();
                return;
            }

            // Return from background / lock screen
            if (this.backgroundClaimCount > 0) {
                this.showToast(`ポケット歩行で ${this.backgroundClaimCount} マスを開拓しました`);
                this.backgroundClaimCount = 0;
            }
            if (this.virtualPos && this.map) {
                this.updatePlayerMarker(this.virtualPos);
            }
            // 設定アプリで位置情報をオンにして戻ってきた場合にバナーを自動で消す
            if (this.locationBanner) this.locationBanner.refreshPermissionState();
            // フォアグラウンド復帰時に未送信分をまとめて同期
            if (this.syncQueue) this.syncQueue.flush('foreground');
            // 全国集計（上部％バー）も最新にする
            this.refreshGlobalTeamCounts({ force: true });
            // 止めていたカウントダウンを即時更新して刻み直し、陣地を1回だけ取り直す
            // （この中で8秒ポーリングも再開する）
            this.resumeForegroundUpdates();
            // バックグラウンドのまま月曜0時をまたいだ場合に、先週の結果表を取りこぼさない
            if (typeof this.checkWeeklyResetResult === 'function') {
                Promise.resolve(this.checkWeeklyResetResult()).catch(() => {});
            }
            // Apple Watch も復帰と同時に追いつかせる
            this.initWatchBridge();
            this.notifyWatchState('foreground');
        });

        // 通信状態の復帰・切断（オフラインキューとの連携）
        window.addEventListener('online', () => {
            if (this.syncQueue) this.syncQueue.flush('online');
            // 通信か復帰したら全国集計をすぐ取り直す（オフライン中はローカル集計で表示）
            this.refreshGlobalTeamCounts({ force: true });
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
                    if (!state.isActive) {
                        // ネイティブ側のアプリ切替でも、表示用の定期処理を止める
                        // （visibilitychange が来ない端末への保険。測定 watcher は止めない）
                        this.pauseForegroundUpdates();
                        return;
                    }
                    if (this.syncQueue) this.syncQueue.flush('app-active');
                    this.refreshGlobalTeamCounts({ force: true });
                    this.resumeForegroundUpdates();
                    // ネイティブの appStateChange 側でも週跨ぎの結果表を確認する（visibilitychange が来ない端末の保険）
                    if (typeof this.checkWeeklyResetResult === 'function') {
                        Promise.resolve(this.checkWeeklyResetResult()).catch(() => {});
                    }
                    this.initWatchBridge();
                    this.notifyWatchState('foreground');
                });
            } catch (e) {}
        }
    }
}
