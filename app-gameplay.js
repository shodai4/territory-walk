/**
 * TERRITORY WALK - app-gameplay.js
 * 歩行判定・陣地の獲得・スコア表示・イベント配線・リセット・Realtime同期
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppTracking を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppGameplay extends TerritoryWalkAppTracking {
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

    handlePositionUpdate(position, isFirst = false, options = {}) {
        // 位置情報が取得できた＝許可されている。拒否バナーは自動で消す
        if (this.locationBanner) this.locationBanner.handlePermissionGranted();

        const rawLat = position.coords.latitude;
        const rawLng = position.coords.longitude;
        const latitude = parseFloat(rawLat.toFixed(5));
        const longitude = parseFloat(rawLng.toFixed(5));
        // 実GPSの最新座標は常に保持（デバッグ終了時にここへ戻す）
        this.lastRealPosition = [latitude, longitude];
        // 次回起動の初期表示用に端末へ保存（サーバー送信なし）
        // 誤差がkm単位の低精度測位は初期位置に使わない
        if (options.skipSave !== true) this.saveLastPosition(latitude, longitude);

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
            this.notifyWatchState('position');
            return;
        }

        this.virtualPos = [latitude, longitude];

        // 【v1.2】同じマスに留まっている間の GPS 誤差更新を捨てる。
        //   同じ latIdx/lngIdx・そこはもう自陣・移動が誤差レベルのときだけ、
        //   再描画 / Supabase 送信 / Watch への重複送信をまとめて省く。
        //   初回取得・チーム変更・未取得マス・明示的な再取得(force)は落とさない。
        const mesh = (this.gridManager && typeof this.gridManager.getMeshIdFromLatLng === 'function')
            ? this.gridManager.getMeshIdFromLatLng(latitude, longitude)
            : null;
        const distanceMoved = (this.lastProcessedLat != null && this.lastProcessedLng != null)
            ? this.calculateDistanceMeters(this.lastProcessedLat, this.lastProcessedLng, latitude, longitude)
            : Infinity;
        const cellTeam = (mesh && this.gridManager && this.gridManager.claimedTilesCache)
            ? this.gridManager.claimedTilesCache.get(mesh.meshId)
            : null;
        const skipStationary = shouldSkipStationaryUpdate({
            isFirst,
            force: options.force === true,
            skipClaim: options.skipClaim === true,
            distanceMeters: distanceMoved,
            sameMesh: !!(mesh && mesh.meshId === this.currentMeshId),
            cellAlreadyMine: !!(mesh && cellTeam === this.currentTeam && cellTeam != null),
            thresholdMeters: resolveStationarySkipDistance(this.isPowerSaveMode())
        });

        this.updateGPSStatus('GPS: 測位中', 'bg-emerald-400', 'text-emerald-400');

        if (skipStationary) {
            // 位置は同じマスの中で揺れているだけ。地図・通信・Watch を触らない
            this.lastSkippedPositionAt = Date.now();
            return { skipped: true, meshId: mesh.meshId, latIdx: mesh.latIdx, lngIdx: mesh.lngIdx };
        }

        // 現在地が動いたら Watch の地図も追いつかせる（2秒に1回へ間引きは WatchBridgeClient 側）
        this.notifyWatchState('position');

        // Battery / Noise Filter: 同じマスにいる間の誤差レベルの揺れは捨てる
        // （マスが変わった/チームが変わった場合は必ず処理する）
        const shouldProcessMesh = !(mesh && mesh.meshId === this.currentMeshId && cellTeam === this.currentTeam && cellTeam != null);

        if (shouldProcessMesh && options.skipClaim !== true) {
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

        // 【v1.2 省電力】陣営が変わっていない限りアイコンは作り直さない（DOM再生成の節約）
        if (!this.playerMarkerIcon || this.playerMarkerIconTeam !== this.currentTeam) {
            this.playerMarkerIcon = L.divIcon({
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
            this.playerMarkerIconTeam = this.currentTeam;
        }
        const customIcon = this.playerMarkerIcon;

        if (!this.userMarker) {
            this.userMarker = L.marker(latlng, { icon: customIcon, zIndexOffset: 1000 }).addTo(this.map);
        } else {
            this.userMarker.setLatLng(latlng);
            if (this.userMarkerIconTeam !== this.currentTeam) {
                this.userMarker.setIcon(customIcon);
                this.userMarkerIconTeam = this.currentTeam;
            }
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
        this.userMarkerIconTeam = null;
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
            // 1kmブロックの色キャッシュは「このマスが属するブロック」分だけ捨てる
            if (typeof this.gridManager.invalidateBlockTeamAt === 'function') {
                this.gridManager.invalidateBlockTeamAt(latIdx, lngIdx);
            }
            this.gridManager.saveTilesToStorage();
            // 全国集計（上部％バー）へも即時反映する（新規 +1、奪取は相手 -1）
            this.applyGlobalCountDelta(this.currentTeam, 1);
            if (isReclaimed) this.applyGlobalCountDelta(cachedTeam, -1);
            // 自分が今週踏んだマス（自分の画面だけの枠線用・サーバーには送らない）
            if (typeof this.gridManager.recordFootprint === 'function') {
                this.gridManager.recordFootprint(meshId);
            }

            if (!this.isAppInBackground) {
                // ズームに合った形で描く（近距離=100mマス / 中距離=1kmブロック / 広域=10kmブロック / zoom 5以下=描かない）
                if (typeof this.gridManager.renderTileForCurrentZoom === 'function') {
                    this.gridManager.renderTileForCurrentZoom(meshId, latIdx, lngIdx);
                } else {
                    this.gridManager.renderSingleTile(meshId, latIdx, lngIdx);
                }
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
                // 自分の塗りをサーバー側の全国集計にも反映させる（10秒スロットル）
                this.refreshGlobalTeamCounts();
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

        // 全国集計（サーバーの territory_tiles 全体）があればそれを使う。
        // 未取得・オフライン時は、従来どおりこの端末が読み込んだ範囲で計算する。
        const counts = this.getScoreCounts();
        const blackCount = counts.black;
        const whiteCount = counts.white;

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
        // 全国集計も白紙に戻し、サーバーから取り直す
        this.resetGlobalTeamCounts();
        this.updateScoreUI();
        this.refreshGlobalTeamCounts({ force: true });
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
            const weekId = this.supabaseManager ? this.supabaseManager.getCurrentWeekId() : null;
            if (seasonBadge && weekId) {
                seasonBadge.textContent = weekId;
            }

            // 月曜0時をまたいだら（アプリを閉じずに跨いだ場合も）先週の結果表を出す。
            // カウントダウンは1秒ごとなので、週が変わった瞬間だけ確認する。
            if (weekId && this.countdownWeekId && this.countdownWeekId !== weekId
                && typeof this.checkWeeklyResetResult === 'function') {
                Promise.resolve(this.checkWeeklyResetResult()).catch(() => {});
            }
            if (weekId) this.countdownWeekId = weekId;

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
        // 画面が見えている間だけ1秒ごとに刻む（非表示中は止める）
        this.updateResetCountdown = updateTimer;
        this.startResetCountdown();
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
                            // キャッシュと違う＝この端末にとって新しい変化。自分の塗りや再受信は二重に数えない
                            if (current !== tile.team) {
                                console.log('[Realtime Sync] Remote tile claimed:', tile.tile_id, tile.team);
                                this.applyRealtimeGlobalDelta(payload.old ? payload.old.team : null, tile.team);
                                this.gridManager.claimedTilesCache.set(tile.tile_id, tile.team);
                                // ブロック集計のキャッシュも、そのマスのブロック分だけ捨てる
                                if (typeof this.gridManager.invalidateBlockTeamAt === 'function'
                                    && tile.lat_idx != null && tile.lng_idx != null) {
                                    this.gridManager.invalidateBlockTeamAt(Number(tile.lat_idx), Number(tile.lng_idx));
                                }
                                this.gridManager.saveTilesToStorage();
                                this.gridManager.updateGrids();
                                this.updateScoreUI();
                            }
                        } else if (payload.new === null && payload.old && payload.old.team) {
                            // 削除（白紙リセット等）も全国集計から差し引く
                            this.applyRealtimeGlobalDelta(payload.old.team, null);
                        }
                        // 正確な数はサーバー取得で補正する（10秒スロットル）
                        this.refreshGlobalTeamCounts();
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
