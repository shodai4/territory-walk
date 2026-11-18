/**
 * TERRITORY WALK - app-geolocation.js
 * 位置情報（Web測位・ネイティブ測位・バックグラウンド測位）
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppMenus を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppGeolocation extends TerritoryWalkAppMenus {
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

        // ネイティブ（iOS/Android アプリ）では WebView の Geolocation API を絶対に呼ばない。
        // WKWebView の "localhost" would like to use your current location. ダイアログの原因になるため、
        // プラグインが使えるならそれだけを使い、無ければ安全に抜ける。
        if (this.isNativePlatform()) {
            if (this.nativeWatchId != null) return true;
            const nativeGeo = this.getNativeGeolocation();
            if (nativeGeo) {
                return this.startNativeGeolocation(nativeGeo, WEB_GEOLOCATION_PRECISE_OPTIONS);
            }
            this.updateGPSStatus('GPS: 測位できません', 'bg-red-500', 'text-red-400');
            return false;
        }

        if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
            this.updateGPSStatus('GPS: 非対応', 'bg-red-500', 'text-red-400');
            return false;
        }

        // 起動時点ですでに拒否済みなら、最初のエラーを待たずにバナーを出す
        if (this.locationBanner) this.locationBanner.refreshPermissionState();

        return this.startWebGeolocationWatch(WEB_GEOLOCATION_PRECISE_OPTIONS, 'precise');
    }

    /**
     * Web 測位の getCurrentPosition / watchPosition を指定オプションで張る。
     * 高精度（衛星測位）が TIMEOUT(3) / POSITION_UNAVAILABLE(2) で失敗したら
     * startCoarseWebGeolocation() が低精度（Wi-Fi・基地局・IP 測位）で張り直す。
     * @param {{enableHighAccuracy: boolean, timeout: number, maximumAge: number}} options
     * @param {'precise'|'coarse'} mode
     * @returns {boolean} 張れたか
     */
    startWebGeolocationWatch(options, mode = 'precise') {
        if (this.markingPaused === true) return false;

        // ネイティブでは navigator.geolocation を一切呼ばない（低精度への切り替えもプラグインで行う）
        if (this.isNativePlatform()) {
            const nativeGeo = this.getNativeGeolocation();
            if (!nativeGeo) return false;
            return this.startNativeGeolocation(nativeGeo, options);
        }

        if (typeof navigator === 'undefined' || !navigator.geolocation) return false;

        // 張り直し前に古い watch を止める（watch が二重に走らないようにする）
        this.clearWebGeolocationWatch();

        this.webGeolocationMode = mode;
        const attempt = this.nextWebGeolocationAttempt();

        let firstFixDelivered = false;
        const onSuccess = (position) => {
            if (this.isStaleWebGeolocationAttempt(attempt)) return;
            const isFirst = !firstFixDelivered;
            firstFixDelivered = true;
            this.webUnavailableNotified = false;

            const accuracy = position && position.coords ? Number(position.coords.accuracy) : NaN;
            const tooCoarse = mode === 'coarse'
                && Number.isFinite(accuracy)
                && accuracy > WEB_GEOLOCATION_MAX_CLAIM_ACCURACY_M;
            if (tooCoarse) this.notifyCoarseAccuracySkip();

            // 誤差がkm単位の測位で陣地を塗ったり、次回起動の初期位置に保存したりしない
            this.handlePositionUpdate(position, isFirst, {
                skipClaim: tooCoarse,
                skipSave: tooCoarse
            });
            if (mode === 'coarse' && !this.isVirtualWalkActive() && !this.isMarkingPaused()) {
                this.updateGPSStatus('GPS: 簡易測位', 'bg-emerald-400', 'text-emerald-400');
            }
        };
        const onError = (error) => {
            if (this.isStaleWebGeolocationAttempt(attempt)) return;
            this.handleWebGeolocationError(error, mode);
        };

        navigator.geolocation.getCurrentPosition(onSuccess, onError, options);
        this.watchId = navigator.geolocation.watchPosition(onSuccess, onError, options);
        return true;
    }

    /** Web の watchPosition を止める（watchId を空にする） */
    clearWebGeolocationWatch() {
        if (this.watchId == null) return false;
        try {
            if (!this.isNativePlatform()
                && typeof navigator !== 'undefined' && navigator.geolocation
                && typeof navigator.geolocation.clearWatch === 'function') {
                navigator.geolocation.clearWatch(this.watchId);
            }
        } catch (e) { /* ignore */ }
        this.watchId = null;
        return true;
    }

    /** Web 測位の試行番号を進める（張り直す前の遅延コールバックを見分けるため） */
    nextWebGeolocationAttempt() {
        this.webGeolocationAttempt = (this.webGeolocationAttempt || 0) + 1;
        return this.webGeolocationAttempt;
    }

    /** すでに張り直された、古い試行のコールバックか */
    isStaleWebGeolocationAttempt(attempt) {
        return attempt !== this.webGeolocationAttempt;
    }

    /**
     * 位置情報エラーが「高精度では取れないが低精度なら取れるかもしれない」ものか。
     * 拒否（code=1 / PERMISSION_DENIED）は対象外（フォールバックせずバナー導線へ回す）。
     */
    isCoarseFallbackError(error) {
        if (!error) return false;
        if (typeof LocationPermissionBanner !== 'undefined'
            && LocationPermissionBanner.isPermissionDeniedError(error)) return false;

        const code = error.code;
        if (code === 1 || code === '1') return false;
        if (code === 2 || code === 3 || code === '2' || code === '3') return true;
        if (typeof code === 'string' && /POSITION_UNAVAILABLE|TIMEOUT/i.test(code)) return true;
        return false;
    }

    /** Web 測位のエラー：高精度がダメなら低精度へ張り直す（拒否は従来どおりバナーへ） */
    handleWebGeolocationError(error, mode = this.webGeolocationMode) {
        if (this.markingPaused === true) return;

        if (mode !== 'coarse' && this.isCoarseFallbackError(error)) {
            this.startCoarseWebGeolocation();
            return;
        }

        this.handlePositionError(error);
        // 低精度でも取れないときは、次に何をすればよいかを一度だけ伝える
        if (mode === 'coarse' && this.isCoarseFallbackError(error)) {
            this.notifyWebGeolocationUnavailable();
        }
    }

    /**
     * 高精度測位が TIMEOUT(3) / POSITION_UNAVAILABLE(2) で失敗したとき、
     * 低精度（Wi-Fi・基地局・IP 測位）で測位を張り直す。
     * 室内やビルの谷間でも「測位できないまま」にならないためのフォールバック。
     * @returns {boolean} 張り直せたか
     */
    startCoarseWebGeolocation() {
        if (this.markingPaused === true) return false;

        // ネイティブでは navigator.geolocation を呼ばず、プラグインの低精度オプションで張り直す
        if (this.isNativePlatform()) {
            const nativeGeo = this.getNativeGeolocation();
            if (!nativeGeo) return false;
            this.updateGPSStatus('GPS: 簡易測位中', 'bg-amber-400', 'text-amber-400');
            return this.startWebGeolocationWatch(WEB_GEOLOCATION_COARSE_OPTIONS, 'coarse');
        }

        if (typeof navigator === 'undefined' || !navigator.geolocation) return false;

        this.updateGPSStatus('GPS: 簡易測位中', 'bg-amber-400', 'text-amber-400');
        if (!this.webCoarseFallbackNotified) {
            this.webCoarseFallbackNotified = true;
            this.showToast('簡易測位に切り替えました', '衛星電波が届かないため、Wi-Fi・基地局から位置を推定します');
        }
        return this.startWebGeolocationWatch(WEB_GEOLOCATION_COARSE_OPTIONS, 'coarse');
    }

    /** 低精度測位でも取れなかったときの案内（一度だけ） */
    notifyWebGeolocationUnavailable() {
        if (this.webUnavailableNotified) return;
        this.webUnavailableNotified = true;
        this.showToast('位置情報を取得できませんでした', '屋外や窓際で「現在地」ボタンを押してみてください');
    }

    /** 低精度測位の誤差が大きすぎて陣地を塗らないときの案内（一度だけ） */
    notifyCoarseAccuracySkip() {
        if (this.webCoarseAccuracyNotified) return;
        this.webCoarseAccuracyNotified = true;
        this.showToast('現在地の精度が低いため陣地は塗りません', 'Wi-Fi につなぐか、屋外で「現在地」ボタンを押してください');
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
        // マーキング停止中はバックグラウンド測位を起こさない（起動時の復元・設定変更・
        // 位置情報バナーの「再確認」など、どの導線から呼ばれてもGPS消費をゼロに保つ）
        if (this.isMarkingPaused()) return false;
        if (this.backgroundWatcherStarted) return true;
        if (!plugin || typeof plugin.addWatcher !== 'function') return false;

        this.backgroundWatcherStarted = true;

        let watching;
        try {
            // 省電力モードの ON/OFF に合わせて distanceFilter を差し替える（v1.2）
            const watcherOptions = buildBackgroundGeolocationOptions(this.isPowerSaveMode());
            watching = plugin.addWatcher(watcherOptions, (location, error) => {
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
}
