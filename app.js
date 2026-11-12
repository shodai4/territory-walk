/**
 * TERRITORY WALK - app.js
 * Core Application Controller, Geolocation, Real-time Grid Updates & Supabase Sync
 */

const CONFIG = {
    DEFAULT_CENTER: [34.6662, 135.6276], // 東大阪・近鉄瓢箪山駅〜東花園エリア
    DEFAULT_ZOOM: 17,
    MIN_ZOOM: 10,
    MAX_ZOOM: 20
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

        this.userMarker = null;
        this.watchId = null;
        this.currentMeshId = null;
        this.virtualPos = [...CONFIG.DEFAULT_CENTER];
        this.isMapVisible = true;
        this.isDebugMode = false;

        // Initialize managers
        this.proManager = new ProManager();
        this.posterGenerator = new PosterGenerator(this);
        this.supabaseManager = new SupabaseManager();
        this.statsManager = new StatsManager(this.supabaseManager, this);

        this.initTeam();
        this.initDOM();
        this.initMap();
        this.initGrid();
        this.initSkinSelector();
        this.initStatsModal();
        this.initProModal();
        this.initExportButton();
        this.initGeolocation();
        this.initDPad();
        this.initEvents();
        this.initResetCountdown();
        this.initRealtimeSync();

        // Periodic polling fallback (every 8s) to ensure other players' tiles appear even without map drag
        setInterval(() => {
            this.loadRemoteTiles();
        }, 8000);
    }

    initTeam() {
        let savedTeam = localStorage.getItem('player_team');
        if (!savedTeam || (savedTeam !== 'white' && savedTeam !== 'black')) {
            savedTeam = Math.random() < 0.5 ? 'white' : 'black';
            localStorage.setItem('player_team', savedTeam);
        }
        this.currentTeam = savedTeam;
        this.applyTheme();
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
        this.btnSwapTeam = document.getElementById('btn-swap-team');
        this.swapTeamIcon = document.getElementById('swap-team-icon');
        this.swapTeamText = document.getElementById('swap-team-text');

        this.initRulesModal();
        this.initMenuModal();
    }

    renderTeamBadge() {
        if (!this.teamBadgeContainer) return;

        const isPro = this.proManager && this.proManager.isPro();
        const supporterBadge = isPro ? this.proManager.getSupporterBadgeHtml() : '';

        if (this.currentTeam === 'white') {
            this.teamBadgeContainer.innerHTML = `
                ${supporterBadge}
                <span class="w-2.5 h-2.5 rounded-full bg-white border border-zinc-300"></span>
                <span class="text-zinc-100 font-bold">White</span>
            `;
            if (this.menuTeamText) this.menuTeamText.textContent = 'White Team';
        } else {
            this.teamBadgeContainer.innerHTML = `
                ${supporterBadge}
                <span class="w-2.5 h-2.5 rounded-full bg-black border border-zinc-500 shadow-sm"></span>
                <span class="text-zinc-100 font-bold">Black</span>
            `;
            if (this.menuTeamText) this.menuTeamText.textContent = 'Black Team';
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
        this.map = L.map('map', {
            center: CONFIG.DEFAULT_CENTER,
            zoom: CONFIG.DEFAULT_ZOOM,
            minZoom: CONFIG.MIN_ZOOM,
            maxZoom: CONFIG.MAX_ZOOM,
            zoomControl: true,
            attributionControl: false
        });

        // Dark-inverted OpenStreetMap tile layer (100% free, no API key required)
        this.tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(this.map);

        const mapContainer = document.getElementById('map');
        if (this.isMapVisible) {
            if (mapContainer) mapContainer.classList.remove('map-tiles-hidden');
        } else {
            if (mapContainer) mapContainer.classList.add('map-tiles-hidden');
        }

        this.updateMapVisibilityUI();
        this.updatePlayerMarker(CONFIG.DEFAULT_CENTER);

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

                // Non-default skins require Pro unless in Debug Mode
                if (targetSkin !== 'default' && !this.isDebugMode && !this.checkProAccess('限定スキン')) {
                    return;
                }

                document.body.dataset.skin = targetSkin;
                localStorage.setItem('territory_skin', targetSkin);
                this.updateSkinBadge(targetSkin);
                this.updateCycleSkinButtonUI();

                if (this.gridManager) {
                    this.gridManager.redrawTiles();
                }
            });
        });
    }

    cycleSkin() {
        const skins = ['default', 'neon', 'gold', 'pixel'];
        const current = document.body.dataset.skin || 'default';
        const nextIdx = (skins.indexOf(current) + 1) % skins.length;
        const nextSkin = skins[nextIdx];

        document.body.dataset.skin = nextSkin;
        localStorage.setItem('territory_skin', nextSkin);
        this.updateSkinBadge(nextSkin);
        this.updateCycleSkinButtonUI();

        if (this.gridManager) {
            this.gridManager.redrawTiles();
        }
    }

    updateCycleSkinButtonUI() {
        const textEl = document.getElementById('cycle-skin-text');
        if (!textEl) return;
        const skin = document.body.dataset.skin || 'default';
        const labels = {
            default: 'SKIN: 標準',
            neon: 'SKIN: ネオン',
            gold: 'SKIN: ゴールド',
            pixel: 'SKIN: レトロ'
        };
        textEl.textContent = labels[skin] || 'SKIN: ' + skin;
    }

    updateSkinBadge(skin) {
        const badge = document.getElementById('current-skin-badge');
        if (!badge) return;
        const labels = {
            default: '標準 (Default)',
            neon: 'ネオン (Neon)',
            gold: 'ゴールド (Gold)',
            pixel: 'レトロ (Pixel)'
        };
        badge.textContent = labels[skin] || skin;
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

        // Tab buttons
        const tabs = ['my-stats', 'weekly-rank', 'lifetime-rank'];
        tabs.forEach(tabKey => {
            const btn = document.getElementById(`tab-${tabKey}`);
            if (btn) {
                btn.addEventListener('click', () => this.switchStatsTab(tabKey));
            }
        });

        // Save Nickname
        const saveNickBtn = document.getElementById('btn-save-nickname');
        if (saveNickBtn) {
            saveNickBtn.addEventListener('click', () => {
                const input = document.getElementById('input-nickname');
                if (input && this.statsManager) {
                    this.statsManager.setNickname(input.value);
                    alert('ニックネームを保存しました！');
                    this.updateStatsDisplay();
                }
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
        if (nickInput) nickInput.value = this.statsManager.nickname;

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
    }

    async loadWeeklyRankings() {
        const listEl = document.getElementById('list-weekly-rank');
        if (!listEl || !this.statsManager || !this.supabaseManager) return;

        listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">読み込み中...</li>';
        const weekId = this.supabaseManager.getCurrentWeekId();
        const data = await this.statsManager.getWeeklyLeaderboard(weekId);

        if (!data || data.length === 0 || data[0].message) {
            listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">今週の記録はまだありません</li>';
            return;
        }

        listEl.innerHTML = data.map((item, idx) => `
            <li class="flex items-center justify-between py-1 border-b border-zinc-800">
                <span class="font-bold ${idx < 3 ? 'text-amber-400' : 'text-zinc-300'}">${idx + 1}. ${item.nickname}</span>
                <span class="font-mono text-zinc-400">${item.tiles_count} マス</span>
            </li>
        `).join('');
    }

    async loadLifetimeRankings() {
        const listEl = document.getElementById('list-lifetime-rank');
        if (!listEl || !this.statsManager) return;

        listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">読み込み中...</li>';
        const data = await this.statsManager.getLifetimeLeaderboard();

        if (!data || data.length === 0 || data[0].message) {
            listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">記録がありません</li>';
            return;
        }

        listEl.innerHTML = data.map((item, idx) => `
            <li class="flex items-center justify-between py-1 border-b border-zinc-800">
                <span class="font-bold ${idx < 3 ? 'text-amber-400' : 'text-zinc-300'}">${idx + 1}. ${item.nickname}</span>
                <span class="font-mono text-zinc-400">${item.lifetime_tiles} マス</span>
            </li>
        `).join('');
    }

    initProModal() {
        const modal = document.getElementById('pro-modal');
        const openBtn = document.getElementById('btn-open-pro-modal');
        const closeBtn = document.getElementById('btn-close-pro');
        const activateBtn = document.getElementById('btn-activate-pro');

        if (openBtn) {
            openBtn.addEventListener('click', () => {
                if (this.menuModal) this.menuModal.classList.add('hidden');
                modal.classList.remove('hidden');
            });
        }

        const closeModal = () => modal.classList.add('hidden');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);

        if (activateBtn) {
            activateBtn.addEventListener('click', () => {
                const input = document.getElementById('input-pro-code');
                const code = input ? input.value : '';
                if (this.proManager && this.proManager.activateCode(code)) {
                    alert('🎉 Proサポーター機能が有効になりました！限定スキンとポスター出力をご利用いただけます。');
                    modal.classList.add('hidden');
                    this.renderTeamBadge();
                    this.updateStatsDisplay();
                } else {
                    alert('無効なコードです。正しいアクティベーションコードを入力してください。');
                }
            });
        }
    }

    checkProAccess(actionName) {
        if (this.isDebugMode) {
            console.log(`[Debug Mode] Pro restriction bypassed for: ${actionName}`);
            return true;
        }

        if (!this.proManager || !this.proManager.isPro()) {
            alert(`${actionName}を利用するには、Proサポーターへのアップグレードが必要です！`);
            const modal = document.getElementById('pro-modal');
            if (modal) modal.classList.remove('hidden');
            return false;
        }
        return true;
    }

    initExportButton() {
        const exportBtn = document.getElementById('btn-export-poster');
        if (!exportBtn) return;

        exportBtn.addEventListener('click', async () => {
            if (!this.checkProAccess('ポスター保存')) return;

            const originalHtml = exportBtn.innerHTML;
            exportBtn.innerHTML = '<span>⏳ ポスター生成中...</span>';
            exportBtn.disabled = true;

            try {
                const weekId = this.supabaseManager.getCurrentWeekId();
                await this.posterGenerator.exportWeeklyPoster(
                    this.gridManager.claimedTilesCache,
                    this.currentTeam,
                    this.statsManager.nickname,
                    weekId
                );
            } catch (err) {
                console.error('Poster export failed:', err);
                alert('ポスターの書き出しに失敗しました。');
            } finally {
                exportBtn.innerHTML = originalHtml;
                exportBtn.disabled = false;
            }
        });
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

    toggleDebugMode() {
        this.isDebugMode = !this.isDebugMode;
        this.updateDebugModeUI();
    }

    updateDebugModeUI() {
        if (!this.btnToggleDebug || !this.debugToggleDot || !this.debugToggleText || !this.dpadContainer) return;

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
            this.btnCloseRules.addEventListener('click', () => {
                if (this.rulesModal) {
                    this.rulesModal.classList.add('hidden');
                    localStorage.setItem('territory_rules_seen_v1', 'true');
                    this.resetViewportScroll();
                }
            });
        }
    }

    initMenuModal() {
        if (!this.menuModal) return;

        const openModal = () => {
            this.menuModal.classList.remove('hidden');
            this.resetViewportScroll();
        };

        const closeModal = () => {
            this.menuModal.classList.add('hidden');
            this.resetViewportScroll();
        };

        if (this.btnMenu) this.btnMenu.addEventListener('click', openModal);
        if (this.btnCloseMenu) this.btnCloseMenu.addEventListener('click', closeModal);
        if (this.btnModalCloseIcon) this.btnModalCloseIcon.addEventListener('click', closeModal);

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
        if (!('geolocation' in navigator)) {
            this.updateGPSStatus('GPS: 非対応', 'bg-red-500', 'text-red-400');
            return;
        }

        this.updateGPSStatus('GPS: 測位中...', 'bg-amber-400', 'text-amber-400');

        const options = {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        };

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
    }

    handlePositionUpdate(position, isFirst = false) {
        const { latitude, longitude } = position.coords;
        this.virtualPos = [latitude, longitude];

        this.updateGPSStatus('GPS: 測位中', 'bg-emerald-400', 'text-emerald-400');
        this.updatePlayerMarker([latitude, longitude]);

        if (isFirst && this.map) {
            this.map.setView([latitude, longitude], CONFIG.DEFAULT_ZOOM);
        }

        this.processMeshAndClaim(latitude, longitude);
    }

    handlePositionError(error) {
        console.warn('Geolocation error:', error);
        switch (error.code) {
            case error.PERMISSION_DENIED:
                this.updateGPSStatus('GPS: 拒否', 'bg-red-500', 'text-red-400');
                break;
            case error.POSITION_UNAVAILABLE:
                this.updateGPSStatus('GPS: 圏外', 'bg-amber-500', 'text-amber-400');
                break;
            case error.TIMEOUT:
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

    async processMeshAndClaim(lat, lng) {
        if (!this.gridManager) return;

        const { meshId, latIdx, lngIdx } = this.gridManager.getMeshIdFromLatLng(lat, lng);
        const cachedTeam = this.gridManager.claimedTilesCache.get(meshId);

        if (this.currentMeshId !== meshId || cachedTeam !== this.currentTeam) {
            const isReclaimed = cachedTeam && cachedTeam !== this.currentTeam;
            this.currentMeshId = meshId;

            // 1. Immediate local UI update
            this.gridManager.claimedTilesCache.set(meshId, this.currentTeam);
            this.gridManager.saveTilesToStorage();

            if (this.gridManager.renderedMeshes.has(meshId)) {
                this.gridManager.renderedMeshes.get(meshId).setStyle(this.gridManager.getTileStyle(this.currentTeam));
            } else {
                this.gridManager.renderSingleTile(meshId, latIdx, lngIdx, this.currentTeam);
            }

            this.updateScoreUI();
            this.playClaimSound();
            this.triggerHaptic();

            // 2. Stats logging
            if (this.statsManager) {
                this.statsManager.recordTileClaimed(isReclaimed);
            }

            // 3. Supabase online sync
            if (this.supabaseManager) {
                try {
                    await this.supabaseManager.claimTile(meshId, latIdx, lngIdx, this.currentTeam);
                } catch (e) {
                    console.warn('Supabase claimTile sync failed:', e);
                }
            }
        }
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
        if ('vibrate' in navigator) {
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

        this.scoreBlackEl.textContent = `${blackPct}%`;
        this.scoreWhiteEl.textContent = `${whitePct}%`;

        this.barBlackEl.style.width = `${blackPct}%`;
        this.barWhiteEl.style.width = `${whitePct}%`;
    }

    initDPad() {
        const stepLat = 0.0009; // 1 mesh north/south
        const stepLng = this.gridManager ? this.gridManager.LNG_GRID : 0.00109868; // 1 mesh east/west

        const moveVirtual = (dLat, dLng) => {
            this.virtualPos[0] += dLat;
            this.virtualPos[1] += dLng;

            this.updatePlayerMarker(this.virtualPos);
            if (this.map) {
                this.map.panTo(this.virtualPos, { animate: true, duration: 0.2 });
            }
            this.processMeshAndClaim(this.virtualPos[0], this.virtualPos[1]);
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
        if (this.btnRecenter) {
            this.btnRecenter.addEventListener('click', () => {
                if (this.map && this.virtualPos) {
                    this.map.setView(this.virtualPos, CONFIG.DEFAULT_ZOOM, { animate: true });
                }
            });
        }

        window.addEventListener('resize', () => this.resetViewportScroll());
        window.addEventListener('orientationchange', () => this.resetViewportScroll());
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
