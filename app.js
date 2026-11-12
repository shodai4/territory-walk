/**
 * TERRITORY WALK - app.js
 * Main Application Controller
 */

const CONFIG = {
    DEFAULT_CENTER: [34.6654, 135.6268], // 東花園駅周辺（東大阪市）
    DEFAULT_ZOOM: 16,
    TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    TILE_OPTIONS: {
        maxZoom: 19,
        subdomains: 'abcd',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
};

class TerritoryWalkApp {
    constructor() {
        this.map = null;
        this.tileLayer = null;
        this.gridManager = null;
        this.supabaseManager = null;
        this.playerMarker = null;
        this.currentPosition = [...CONFIG.DEFAULT_CENTER];
        this.watchId = null;
        this.isFollowingUser = true;
        this.currentTeam = 'black';
        this.currentMeshId = null;
        this.audioCtx = null;
        this.isMapVisible = true;
        this.isDebugMode = false;

        this.initTeam();
        this.initDOM();
        this.initMap();
        this.initSupabase();
        this.initGrid();
        this.initGeolocation();
        this.initEvents();
        this.initDPad();
        this.initDebugMode();
        this.initResetCountdown();
        this.initRulesModal();
        this.initMenuModal();
        this.updateScoreUI();
    }

    initTeam() {
        let savedTeam = localStorage.getItem('player_team');
        if (!savedTeam || (savedTeam !== 'white' && savedTeam !== 'black')) {
            savedTeam = Math.random() < 0.5 ? 'white' : 'black';
            localStorage.setItem('player_team', savedTeam);
        }
        this.currentTeam = savedTeam;
    }

    initDOM() {
        this.latValEl = document.getElementById('lat-val');
        this.lngValEl = document.getElementById('lng-val');
        this.gpsBadgeEl = document.getElementById('gps-badge');
        this.gpsDotEl = document.getElementById('gps-dot');
        this.gpsTextEl = document.getElementById('gps-text');
        this.btnRecenter = document.getElementById('btn-recenter');
        this.scoreBlackEl = document.getElementById('score-black');
        this.scoreWhiteEl = document.getElementById('score-white');
        this.barBlackEl = document.getElementById('bar-black');
        this.barWhiteEl = document.getElementById('bar-white');
        this.teamBadgeEl = document.getElementById('team-badge');

        // デバッグ & D-Pad要素
        this.dpadContainer = document.getElementById('dpad-container');
        this.btnSwapTeam = document.getElementById('btn-swap-team');
        this.swapTeamIcon = document.getElementById('swap-team-icon');
        this.swapTeamText = document.getElementById('swap-team-text');

        // モーダル関連要素
        this.rulesModal = document.getElementById('rules-modal');
        this.btnCloseRules = document.getElementById('btn-close-rules');
        this.menuModal = document.getElementById('menu-modal');
        this.btnMenu = document.getElementById('btn-menu');
        this.btnCloseMenu = document.getElementById('btn-close-menu');
        this.btnModalCloseIcon = document.getElementById('btn-modal-close-icon');
        this.btnOpenRules = document.getElementById('btn-open-rules');
        this.btnToggleMap = document.getElementById('btn-toggle-map');
        this.mapToggleDot = document.getElementById('map-toggle-dot');
        this.mapToggleText = document.getElementById('map-toggle-text');
        this.btnToggleDebug = document.getElementById('btn-toggle-debug');
        this.debugToggleDot = document.getElementById('debug-toggle-dot');
        this.debugToggleText = document.getElementById('debug-toggle-text');
        this.menuTeamText = document.getElementById('menu-team-text');

        this.renderTeamBadge();
        this.updateSwapButtonUI();
    }

    renderTeamBadge() {
        if (!this.teamBadgeEl) return;
        if (this.currentTeam === 'white') {
            this.teamBadgeEl.innerHTML = `
                <span class="inline-block w-2.5 h-2.5 rounded-full bg-white border border-zinc-400 shadow-[0_0_8px_rgba(255,255,255,0.8)]"></span>
                <span class="text-white font-bold text-xs">White</span>
            `;
        } else {
            this.teamBadgeEl.innerHTML = `
                <span class="inline-block w-2.5 h-2.5 rounded-full bg-black border border-zinc-300 shadow-[0_0_8px_rgba(0,0,0,0.9)]"></span>
                <span class="text-white font-bold text-xs">Black</span>
            `;
        }
        if (this.menuTeamText) {
            this.menuTeamText.textContent = this.currentTeam === 'white' ? 'White' : 'Black';
        }
    }

    updateSwapButtonUI() {
        if (!this.swapTeamIcon || !this.swapTeamText) return;
        if (this.currentTeam === 'black') {
            this.swapTeamIcon.className = 'w-2 h-2 rounded-full bg-white border border-zinc-400';
            this.swapTeamText.textContent = 'SWAP: Whiteへ切替';
        } else {
            this.swapTeamIcon.className = 'w-2 h-2 rounded-full bg-black border border-zinc-300';
            this.swapTeamText.textContent = 'SWAP: Blackへ切替';
        }
    }

    initMap() {
        this.map = L.map('map', {
            zoomControl: false,
            attributionControl: true,
            doubleClickZoom: false
        }).setView(CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);

        L.control.zoom({ position: 'topright' }).addTo(this.map);

        this.tileLayer = L.tileLayer(CONFIG.TILE_URL, CONFIG.TILE_OPTIONS);

        // 地図表示設定の復元（デフォルトON）
        this.isMapVisible = localStorage.getItem('territory_map_visible') !== 'false';
        const mapContainer = document.getElementById('map');

        if (this.isMapVisible) {
            this.tileLayer.addTo(this.map);
            if (mapContainer) mapContainer.classList.remove('map-tiles-hidden');
        } else {
            if (mapContainer) mapContainer.classList.add('map-tiles-hidden');
        }

        this.updateMapVisibilityUI();
        this.updatePlayerMarker(CONFIG.DEFAULT_CENTER);

        this.map.on('dragstart', () => {
            this.isFollowingUser = false;
        });
    }

    toggleMapVisibility() {
        this.isMapVisible = !this.isMapVisible;
        localStorage.setItem('territory_map_visible', this.isMapVisible ? 'true' : 'false');

        const mapContainer = document.getElementById('map');
        if (this.isMapVisible) {
            if (!this.map.hasLayer(this.tileLayer)) {
                this.tileLayer.addTo(this.map);
            }
            if (mapContainer) mapContainer.classList.remove('map-tiles-hidden');
        } else {
            if (this.map.hasLayer(this.tileLayer)) {
                this.map.removeLayer(this.tileLayer);
            }
            if (mapContainer) mapContainer.classList.add('map-tiles-hidden');
        }

        this.updateMapVisibilityUI();
    }

    updateMapVisibilityUI() {
        if (!this.mapToggleDot || !this.mapToggleText || !this.btnToggleMap) return;

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
        // デバッグモード初期状態（デフォルトOFF）
        this.isDebugMode = localStorage.getItem('territory_debug_mode') === 'true';
        this.updateDebugModeUI();
    }

    toggleDebugMode() {
        this.isDebugMode = !this.isDebugMode;
        localStorage.setItem('territory_debug_mode', this.isDebugMode ? 'true' : 'false');
        this.updateDebugModeUI();
    }

    updateDebugModeUI() {
        if (!this.debugToggleDot || !this.debugToggleText || !this.btnToggleDebug) return;

        if (this.isDebugMode) {
            if (this.dpadContainer) this.dpadContainer.classList.remove('hidden');
            this.debugToggleDot.className = 'w-2 h-2 rounded-full bg-amber-400';
            this.debugToggleText.textContent = 'DEBUG: ON';
            this.btnToggleDebug.className = 'px-3 py-1.5 rounded-lg border text-xs font-mono font-bold flex items-center gap-1.5 transition-all active:scale-95 bg-zinc-800 border-zinc-600 text-amber-300';
        } else {
            if (this.dpadContainer) this.dpadContainer.classList.add('hidden');
            this.debugToggleDot.className = 'w-2 h-2 rounded-full bg-zinc-600';
            this.debugToggleText.textContent = 'DEBUG: OFF';
            this.btnToggleDebug.className = 'px-3 py-1.5 rounded-lg border text-xs font-mono font-bold flex items-center gap-1.5 transition-all active:scale-95 bg-zinc-900 border-zinc-700 text-zinc-400';
        }
    }

    swapTeam() {
        this.currentTeam = this.currentTeam === 'black' ? 'white' : 'black';
        localStorage.setItem('player_team', this.currentTeam);

        this.renderTeamBadge();
        this.updatePlayerMarker(this.currentPosition);
        this.updateSwapButtonUI();
        this.playClaimSound();
        this.triggerHaptic();
    }

    initRulesModal() {
        const rulesRead = localStorage.getItem('territory_rules_read');
        if (rulesRead !== 'true' && this.rulesModal) {
            this.rulesModal.classList.remove('hidden');
        }

        if (this.btnCloseRules) {
            this.btnCloseRules.addEventListener('click', () => {
                localStorage.setItem('territory_rules_read', 'true');
                if (this.rulesModal) this.rulesModal.classList.add('hidden');
            });
        }
    }

    initMenuModal() {
        if (this.btnMenu && this.menuModal) {
            this.btnMenu.addEventListener('click', () => {
                this.menuModal.classList.remove('hidden');
            });
        }

        const closeModal = () => {
            if (this.menuModal) this.menuModal.classList.add('hidden');
        };

        if (this.btnCloseMenu) this.btnCloseMenu.addEventListener('click', closeModal);
        if (this.btnModalCloseIcon) this.btnModalCloseIcon.addEventListener('click', closeModal);

        if (this.btnToggleMap) {
            this.btnToggleMap.addEventListener('click', () => {
                this.toggleMapVisibility();
            });
        }

        if (this.btnToggleDebug) {
            this.btnToggleDebug.addEventListener('click', () => {
                this.toggleDebugMode();
            });
        }

        if (this.btnOpenRules) {
            this.btnOpenRules.addEventListener('click', () => {
                closeModal();
                if (this.rulesModal) this.rulesModal.classList.remove('hidden');
            });
        }
    }

    initSupabase() {
        if (typeof SupabaseManager !== 'undefined') {
            this.supabaseManager = new SupabaseManager();
        } else {
            console.warn('SupabaseManager is not defined.');
        }
    }

    initGrid() {
        if (typeof GridManager !== 'undefined') {
            this.gridManager = new GridManager(this.map, this);
        } else {
            console.warn('GridManager is not defined.');
        }
    }

    initGeolocation() {
        if (!navigator.geolocation) {
            this.updateGPSStatus('UNSUPPORTED', 'bg-red-500', 'text-red-400');
            return;
        }

        this.updateGPSStatus('GPS: 測位中...', 'bg-amber-400', 'text-amber-400');

        const options = {
            enableHighAccuracy: true,
            timeout: 15000,
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

    handlePositionUpdate(position, isInitial = false) {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        this.currentPosition = [lat, lng];

        if (this.latValEl) this.latValEl.textContent = lat.toFixed(4);
        if (this.lngValEl) this.lngValEl.textContent = lng.toFixed(4);

        this.updateGPSStatus('GPS ACTIVE', 'bg-emerald-400', 'text-emerald-400');
        this.updatePlayerMarker(this.currentPosition);

        if (isInitial || this.isFollowingUser) {
            this.map.setView(this.currentPosition, Math.max(this.map.getZoom(), 16), { animate: true });
        }

        this.processMeshAndClaim(lat, lng);
    }

    handlePositionError(error) {
        let errorMsg = 'GPS ERROR';
        switch (error.code) {
            case error.PERMISSION_DENIED:
                errorMsg = 'GPS: 許可拒否';
                break;
            case error.POSITION_UNAVAILABLE:
                errorMsg = 'GPS: 位置不明';
                break;
            case error.TIMEOUT:
                errorMsg = 'GPS: タイムアウト';
                break;
        }
        console.warn(`Geolocation error (${error.code}): ${error.message}`);
        this.updateGPSStatus(errorMsg, 'bg-red-500', 'text-red-400');
    }

    updateGPSStatus(text, dotColorClass, textColorClass) {
        if (this.gpsTextEl) this.gpsTextEl.textContent = text;
        if (this.gpsBadgeEl) {
            this.gpsBadgeEl.className = `flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-zinc-800 ${textColorClass} text-[10px] font-bold border border-zinc-700`;
        }
        if (this.gpsDotEl) {
            this.gpsDotEl.className = `w-1.5 h-1.5 rounded-full ${dotColorClass} animate-ping`;
        }
    }

    updatePlayerMarker(latLng) {
        const isWhite = this.currentTeam === 'white';
        const pulseClass = isWhite ? 'player-pulse-white' : 'player-pulse-black';
        const dotClass = isWhite ? 'player-dot-white' : 'player-dot-black';

        const playerIcon = L.divIcon({
            className: 'player-marker-container',
            html: `<div class="${pulseClass}"></div><div class="${dotClass}"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        if (this.playerMarker) {
            this.playerMarker.setLatLng(latLng);
            this.playerMarker.setIcon(playerIcon);
        } else {
            this.playerMarker = L.marker(latLng, { icon: playerIcon }).addTo(this.map);
            this.playerMarker.bindPopup(`<div class="text-black font-bold text-xs uppercase">現在地 (${this.currentTeam} TEAM)</div>`);
        }
    }

    async processMeshAndClaim(lat, lng) {
        if (!this.gridManager) return;
        await this.gridManager.onPlayerStep(lat, lng);
    }

    playClaimSound() {
        try {
            if (!this.audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) {
                    this.audioCtx = new AudioContext();
                }
            }
            if (this.audioCtx) {
                if (this.audioCtx.state === 'suspended') {
                    this.audioCtx.resume();
                }
                const osc = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(587.33, this.audioCtx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(880, this.audioCtx.currentTime + 0.08);

                gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.12);

                osc.connect(gain);
                gain.connect(this.audioCtx.destination);

                osc.start();
                osc.stop(this.audioCtx.currentTime + 0.12);
            }
        } catch (e) {}
    }

    triggerHaptic() {
        try {
            if (navigator.vibrate) {
                navigator.vibrate(30);
            }
        } catch (e) {}
    }

    updateScoreUI() {
        let whiteCount = 0;
        let blackCount = 0;

        if (this.gridManager && this.gridManager.claimedTilesCache) {
            for (const team of this.gridManager.claimedTilesCache.values()) {
                if (team === 'white') whiteCount++;
                else if (team === 'black') blackCount++;
            }
        }

        const total = whiteCount + blackCount;
        let whitePct = 50;
        let blackPct = 50;

        if (total > 0) {
            whitePct = Math.round((whiteCount / total) * 100);
            blackPct = 100 - whitePct;
        }

        if (this.scoreBlackEl) this.scoreBlackEl.textContent = `${blackPct}%`;
        if (this.scoreWhiteEl) this.scoreWhiteEl.textContent = `${whitePct}%`;
        if (this.barBlackEl) this.barBlackEl.style.width = `${blackPct}%`;
        if (this.barWhiteEl) this.barWhiteEl.style.width = `${whitePct}%`;
    }

    initDPad() {
        const btnUp = document.getElementById('dpad-up');
        const btnDown = document.getElementById('dpad-down');
        const btnLeft = document.getElementById('dpad-left');
        const btnRight = document.getElementById('dpad-right');

        const stepLat = 0.0009;

        const movePlayer = (dLat, dLng) => {
            this.isFollowingUser = false;
            this.currentPosition[0] += dLat;
            this.currentPosition[1] += dLng;

            if (this.latValEl) this.latValEl.textContent = this.currentPosition[0].toFixed(4);
            if (this.lngValEl) this.lngValEl.textContent = this.currentPosition[1].toFixed(4);

            this.updatePlayerMarker(this.currentPosition);
            this.map.setView(this.currentPosition, this.map.getZoom(), { animate: true });

            if (this.gridManager) {
                this.gridManager.updateGrids();
            }

            this.processMeshAndClaim(this.currentPosition[0], this.currentPosition[1]);
        };

        if (btnUp) btnUp.addEventListener('click', () => movePlayer(stepLat, 0));
        if (btnDown) btnDown.addEventListener('click', () => movePlayer(-stepLat, 0));
        if (btnLeft) {
            btnLeft.addEventListener('click', () => {
                const stepLng = stepLat / Math.cos(this.currentPosition[0] * Math.PI / 180);
                movePlayer(0, -stepLng);
            });
        }
        if (btnRight) {
            btnRight.addEventListener('click', () => {
                const stepLng = stepLat / Math.cos(this.currentPosition[0] * Math.PI / 180);
                movePlayer(0, stepLng);
            });
        }

        if (this.btnSwapTeam) {
            this.btnSwapTeam.addEventListener('click', () => {
                this.swapTeam();
            });
        }
    }

    initEvents() {
        if (this.btnRecenter) {
            this.btnRecenter.addEventListener('click', () => {
                this.isFollowingUser = true;
                if (this.currentPosition) {
                    this.map.setView(this.currentPosition, Math.max(this.map.getZoom(), 16), { animate: true });
                }
            });
        }

        window.addEventListener('resize', () => {
            if (this.map) {
                this.map.invalidateSize();
            }
        });
    }

    initResetCountdown() {
        const countdownEl = document.getElementById('menu-reset-countdown');
        const badgeEl = document.getElementById('menu-season-badge');
        if (!countdownEl) return;

        const updateTimer = () => {
            const now = new Date();
            const jstString = now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
            const jstDate = new Date(jstString);

            // ISO週番号の算出
            const tempDate = new Date(jstDate.getTime());
            tempDate.setHours(0, 0, 0, 0);
            tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
            const week1 = new Date(tempDate.getFullYear(), 0, 4);
            const weekNum = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
            if (badgeEl) badgeEl.textContent = `Week ${weekNum}`;

            // 次回月曜午前0時（JST）の算出
            const dayOfWeek = jstDate.getDay();
            const daysUntilMonday = (1 + 7 - dayOfWeek) % 7;

            const nextMonday = new Date(jstDate);
            nextMonday.setDate(jstDate.getDate() + (daysUntilMonday === 0 ? 7 : daysUntilMonday));
            nextMonday.setHours(0, 0, 0, 0);

            const diffMs = nextMonday - jstDate;
            if (diffMs <= 0) {
                countdownEl.textContent = 'リセット処理中...';
                return;
            }

            const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

            if (days > 0) {
                countdownEl.textContent = `リセットまで: あと${days}日${hours}時間${minutes}分`;
            } else {
                countdownEl.textContent = `リセットまで: あと${hours}時間${minutes}分`;
            }
        };

        updateTimer();
        setInterval(updateTimer, 60000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.territoryApp = new TerritoryWalkApp();
});

// iOS Safari ダブルタップズーム防止（2本指ピンチ操作は維持）
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
        if (!['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)) {
            e.preventDefault();
        }
    }
    lastTouchEnd = now;
}, { passive: false });
