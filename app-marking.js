/**
 * TERRITORY WALK - app-marking.js
 * マーキング ON/OFF（一時停止）・省電力モード
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppGeolocation を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppMarking extends TerritoryWalkAppGeolocation {
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
        if (pauseEl.classList && pauseEl.classList.contains('hidden')) {
            // 停止バーが無くても、表示名バナーは警告バナーの下へ積み直す
            if (typeof this.layoutNicknameBanner === 'function') this.layoutNicknameBanner();
            return null;
        }

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
        // 3枚目（表示名バナー）も同じ基準で積み直す
        if (typeof this.layoutNicknameBanner === 'function') this.layoutNicknameBanner();
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
            // 復帰時は間引きを無視して必ず1回送る（Watch が古いまま固まらないように）
            if (reason === 'foreground' && typeof this.watchBridge.onForeground === 'function') {
                this.watchBridge.onForeground();
                return;
            }
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

    /* ================================================================== *
     * 省電力モード（v1.2）
     *   - ON: 測位の更新間隔を 40m → 60m、静止中の再処理しきい値を 5m → 12m
     *   - 選んだ状態は localStorage に保存し、次回起動でも同じ設定で始まる
     *   - 測位中に切り替えたら watcher を張り直す（distanceFilter は
     *     addWatcher の時点で固定され、あとから変えられないため）
     * ================================================================== */

    /** 保存された省電力モードを読む（未設定・読めない時は OFF） */
    readPowerSavePreference() {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return false;
            const raw = localStorage.getItem(POWER_SAVE_STORAGE_KEY);
            return raw === '1' || raw === 'true';
        } catch (e) {
            return false;
        }
    }

    /** 省電力モードを保存する（端末内のみ） */
    savePowerSavePreference(on) {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return false;
            localStorage.setItem(POWER_SAVE_STORAGE_KEY, on ? '1' : '0');
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 省電力モード中か */
    isPowerSaveMode() {
        return this.powerSaveMode === true;
    }

    /** 現在の設定で addWatcher へ渡すオプション */
    getBackgroundGeolocationOptions() {
        return buildBackgroundGeolocationOptions(this.isPowerSaveMode());
    }

    /** 省電力モードのトグル配線（initDOM から1回だけ） */
    initPowerSaveToggle() {
        if (this.powerSaveToggleBound) return false;
        this.powerSaveToggleBound = true;

        const doc = typeof document !== 'undefined' ? document : null;
        const btn = this.btnTogglePowerSave || (doc ? doc.getElementById('btn-toggle-power-save') : null);
        if (btn && typeof btn.addEventListener === 'function') {
            btn.addEventListener('click', (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                this.togglePowerSaveMode();
            });
        }

        this.renderPowerSaveUI();
        return true;
    }

    togglePowerSaveMode() {
        return this.setPowerSaveMode(!this.isPowerSaveMode());
    }

    /**
     * ON / OFF を確定する。
     * @param {boolean} on
     * @param {{ silent?: boolean, restartWatcher?: boolean }} options
     * @returns {boolean} 実際に状態が変わったか
     */
    setPowerSaveMode(on, options = {}) {
        const next = !!on;
        const changed = next !== this.isPowerSaveMode();
        this.powerSaveMode = next;
        this.savePowerSavePreference(next);
        this.renderPowerSaveUI();

        // 測位中なら、新しい distanceFilter で watcher を張り直す
        if (changed && options.restartWatcher !== false) this.restartGeolocationWatcher();

        if (changed && options.silent !== true) {
            this.showToast(
                next ? '省電力モードを ON にしました' : '省電力モードを OFF にしました',
                next
                    ? `測位の更新間隔を ${DISTANCE_FILTER_POWER_SAVE_M}m に広げます`
                    : `測位の更新間隔を ${DISTANCE_FILTER_STANDARD_M}m に戻します`
            );
        }
        return changed;
    }

    /** distanceFilter を反映するために watcher を張り直す（未起動・Web では何もしない） */
    restartGeolocationWatcher() {
        const plugin = this.backgroundGeolocationPlugin || this.getBackgroundGeolocationPlugin();
        if (!plugin || this.backgroundWatcherStarted !== true) return false;
        if (this.isMarkingPaused()) return false;
        this.stopBackgroundGeolocation();
        return this.startBackgroundGeolocation(plugin);
    }

    /** トグルの見た目と説明文を現在の状態に合わせる */
    renderPowerSaveUI() {
        const on = this.isPowerSaveMode();
        const doc = typeof document !== 'undefined' ? document : null;

        const btn = this.btnTogglePowerSave || (doc ? doc.getElementById('btn-toggle-power-save') : null);
        if (btn) {
            if (btn.dataset) btn.dataset.state = on ? 'on' : 'off';
            if (typeof btn.setAttribute === 'function') {
                btn.setAttribute('aria-pressed', on ? 'true' : 'false');
                btn.setAttribute('aria-label', on
                    ? '省電力モード ON（タップで OFF）'
                    : '省電力モード OFF（タップで ON）');
            }
            if (btn.classList) {
                btn.classList.toggle('bg-emerald-500/10', on);
                btn.classList.toggle('border-emerald-500/60', on);
                btn.classList.toggle('text-emerald-300', on);
                btn.classList.toggle('bg-zinc-900', !on);
                btn.classList.toggle('border-zinc-700', !on);
                btn.classList.toggle('text-zinc-400', !on);
            }
            btn.title = on ? '省電力モード: ON（タップで OFF）' : '省電力モード: OFF（タップで ON）';
        }

        const dot = this.powerSaveDot || (doc ? doc.getElementById('power-save-dot') : null);
        if (dot && dot.classList) {
            dot.classList.toggle('bg-emerald-400', on);
            dot.classList.toggle('bg-zinc-600', !on);
        }

        const label = this.powerSaveText || (doc ? doc.getElementById('power-save-text') : null);
        if (label) label.textContent = on ? 'ON' : 'OFF';

        const detail = this.powerSaveDetail || (doc ? doc.getElementById('power-save-detail') : null);
        if (detail) {
            detail.textContent = on
                ? `更新間隔 ${DISTANCE_FILTER_POWER_SAVE_M}m・静止中は ${STATIONARY_SKIP_POWER_SAVE_M}m まで無視`
                : `更新間隔 ${DISTANCE_FILTER_STANDARD_M}m・電池を節約`;
        }

        if (doc && doc.body && doc.body.dataset) {
            doc.body.dataset.powerSave = on ? 'on' : 'off';
        }
        return on;
    }

    /**
     * 測位（バックグラウンド watcher → Web watchPosition）を開始する。
     * マーキング停止中・起動ゲート通過前は開始しない。
     * @returns {boolean} 開始したか
     */
}
