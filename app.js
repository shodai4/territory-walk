/**
 * TERRITORY WALK - app.js (Part 1)
 */
const CONFIG = {
    DEFAULT_CENTER: [34.6654, 135.6268],
    DEFAULT_ZOOM: 16,
    TILE_URL: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    TILE_OPTIONS: {
        maxZoom: 19,
        subdomains: 'abcd',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
};

class TerritoryWalkApp {
    constructor() {
        this.map = null;
        this.gridManager = null;
        this.supabaseManager = null;
        this.playerMarker = null;
        this.currentPosition = [...CONFIG.DEFAULT_CENTER];
        this.watchId = null;
        this.isFollowingUser = true;
        this.currentTeam = 'black';
        this.currentMeshId = null;
        this.audioCtx = null;

        this.initTeam();
        this.initDOM();
        this.initMap();
        this.initSupabase();
        this.initGrid();
        this.initGeolocation();
        this.initTeam();
        this.initDOM();
        this.initMap();
        this.initSupabase();
        this.initGrid();
        this.initGeolocation();
        this.initEvents();
        this.initDPad();
        this.initResetCountdown();
        this.initEvents();
        this.initDPad();
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
        this.teamBadgeContainer = document.getElementById('team-badge-container');

        this.renderTeamBadge();
    }

    renderTeamBadge() {
        if (!this.teamBadgeContainer) return;
        if (this.currentTeam === 'white') {
            this.teamBadgeContainer.innerHTML = `
                <span class="inline-block w-3 h-3 rounded-full bg-white border border-zinc-400 shadow-[0_0_8px_rgba(255,255,255,0.8)]"></span>
                <span class="text-white">TEAM: WHITE</span>
            `;
        } else {
            this.teamBadgeContainer.innerHTML = `
                <span class="inline-block w-3 h-3 rounded-full bg-black border-2 border-white shadow-[0_0_8px_rgba(0,0,0,0.9)]"></span>
                <span class="text-white">TEAM: BLACK</span>
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

        this.latValEl.textContent = lat.toFixed(4);
        this.lngValEl.textContent = lng.toFixed(4);

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

    initMap() {
        this.map = L.map('map', {
            zoomControl: false,
            attributionControl: true
        }).setView(CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);

        L.control.zoom({ position: 'topright' }).addTo(this.map);
    async processMeshAndClaim(lat, lng) {
        if (!this.gridManager) return;

        const { meshId, latIdx, lngIdx } = this.gridManager.getMeshIdFromLatLng(lat, lng);
        const cachedTeam = this.gridManager.claimedTilesCache.get(meshId);

        if (this.currentMeshId !== meshId || cachedTeam !== this.currentTeam) {
            this.currentMeshId = meshId;

            this.gridManager.claimedTilesCache.set(meshId, this.currentTeam);
            if (this.gridManager.renderedMeshes.has(meshId)) {
                this.gridManager.renderedMeshes.get(meshId).setStyle(this.gridManager.getTileStyle(this.currentTeam));
            }

            this.playClaimSound();
            this.triggerHaptic();

            if (this.supabaseManager) {
                await this.supabaseManager.claimTile(meshId, latIdx, lngIdx, this.currentTeam);
            }
        }
    }

    playClaimSound() {
        try {
            if (!this.audioCtx) {
        this.updateScoreUI();

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

            this.latValEl.textContent = this.currentPosition[0].toFixed(4);
            this.lngValEl.textContent = this.currentPosition[1].toFixed(4);

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
    }

    initEvents() {
        if (this.btnRecenter) {
            this.btnRecenter.addEventListener('click', () => {
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

    initResetCountdown() {
        const countdownEl = document.getElementById('reset-countdown-text');
        if (!countdownEl) return;

        const updateTimer = () => {
            const now = new Date();
            const jstString = now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
            const jstDate = new Date(jstString);

            const dayOfWeek = jstDate.getDay();
            const daysUntilMonday = (1 + 7 - dayOfWeek) % 7;
            
            const nextMonday = new Date(jstDate);
            nextMonday.setDate(jstDate.getDate() + (daysUntilMonday === 0 ? 7 : daysUntilMonday));
            nextMonday.setHours(0, 0, 0, 0);

            const diffMs = nextMonday - jstDate;
            if (diffMs <= 0) {
                countdownEl.textContent = 'リセット中...';
                return;
            }

            const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

            if (days > 0) {
                countdownEl.textContent = `リセットまで: あと${days}日${hours}時間`;
            } else {
                countdownEl.textContent = `リセットまで: あと${hours}時間${minutes}分`;
            }
        };

        updateTimer();
        setInterval(updateTimer, 60000);
    }

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

        L.tileLayer(CONFIG.TILE_URL, CONFIG.TILE_OPTIONS).addTo(this.map);

        this.updatePlayerMarker(CONFIG.DEFAULT_CENTER);

        this.map.on('dragstart', () => {
            this.isFollowingUser = false;
        });
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

            `;
        }
    }
