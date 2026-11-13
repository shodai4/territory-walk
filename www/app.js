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

        // Background location & iOS optimization state
        this.lastProcessedLat = null;
        this.lastProcessedLng = null;
        this.backgroundClaimCount = 0;
        this.isAppInBackground = false;

        // Initialize managers
        this.proManager = new ProManager();
        this.posterGenerator = new PosterGenerator(this);
        this.supabaseManager = new SupabaseManager();
        this.statsManager = new StatsManager(this.supabaseManager, this);
        this.coinManager = new CoinManager(this, this.supabaseManager);
        this.searchManager = new SearchManager(this);
        this.adMobManager = new AdMobManager(this);
        this.iapManager = new IAPManager(this);

        this.initToastSystem();
        this.initTeam();
        this.initDOM();
        this.initMap();
        this.initGrid();
        this.initSkinSelector();
        this.initMapThemeSelector();
        this.initStatsModal();
        this.initWeeklyResultModal();
        this.initProModal();
        this.initExportButton();
        this.initGeolocation();
        this.initLifecycleListeners();
        this.initDPad();
        this.initEvents();
        this.initResetCountdown();
        this.initRealtimeSync();

        // Check Daily Login Bonus
        const bonus = this.statsManager.checkDailyLoginBonus();
        if (bonus.isNew) {
            if (this.coinManager) {
                const bonusCoins = Math.min(50, 20 + (bonus.streak - 1) * 10);
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
    }

    initToastSystem() {
        this.toastQueue = [];
        this.setupModalObservers();
    }

    isAnyModalOpen() {
        const modalIds = [
            'shop-modal',
            'menu-modal',
            'rules-modal',
            'stats-modal',
            'weekly-result-modal',
            'team-reset-modal'
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
            'rules-modal',
            'stats-modal',
            'weekly-result-modal',
            'team-reset-modal'
        ];
        modalIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                const observer = new MutationObserver(() => {
                    if (el.classList.contains('hidden')) {
                        // モーダルが閉じられたら少し間を置いて溜まっていたキューを順次表示
                        setTimeout(() => this.flushToastQueue(), 250);
                    }
                });
                observer.observe(el, { attributes: true, attributeFilter: ['class'] });
            }
        });
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
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'fixed top-[148px] left-1/2 -translate-x-1/2 z-[3000] flex flex-col items-center gap-2 pointer-events-none max-w-[92vw] w-max';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = 'bg-zinc-950/95 border border-amber-500/80 text-amber-300 text-xs font-mono px-4 py-2 rounded-xl shadow-2xl backdrop-blur-md pointer-events-none text-center flex flex-col items-center transition-all duration-300';
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';

        if (subtitle) {
            toast.innerHTML = `<div class="font-bold text-xs text-white leading-tight break-keep whitespace-nowrap">${message}</div><div class="text-[11px] text-amber-400 mt-0.5 leading-tight break-keep whitespace-nowrap">${subtitle}</div>`;
        } else {
            toast.innerHTML = `<div class="font-bold text-xs text-amber-300 leading-tight break-keep whitespace-nowrap">${message}</div>`;
        }

        container.appendChild(toast);

        // 3.5秒後にフェードアウト＆DOM削除
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-10px)';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 350);
        }, 3500);
    }

    flushToastQueue() {
        if (!this.toastQueue || this.toastQueue.length === 0) return;
        if (this.isAnyModalOpen()) return;

        // キューから最大3件まで順次スタック表示
        const items = this.toastQueue.splice(0, 3);
        this.toastQueue = [];

        items.forEach((item, idx) => {
            setTimeout(() => {
                if (!this.isAnyModalOpen()) {
                    this.renderToast(item.message, item.subtitle);
                } else {
                    this.toastQueue.push(item);
                }
            }, idx * 280);
        });
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
        const isPro = this.proManager && this.proManager.isPro();
        const supporterBadge = isPro ? this.proManager.getSupporterBadgeHtml() : '';

        // 対戦バー上部の「YOU」インジケーターを自陣営側のみ点灯表示
        const youBlack = document.getElementById('you-indicator-black');
        const youWhite = document.getElementById('you-indicator-white');

        if (this.currentTeam === 'white') {
            if (youWhite) {
                youWhite.className = 'flex items-center gap-1 text-amber-400 transition-all opacity-100';
                youWhite.innerHTML = `${supporterBadge}<span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-[9px] tracking-wider font-mono">YOU (白陣営)</span>`;
            }
            if (youBlack) {
                youBlack.className = 'flex items-center gap-1 text-zinc-600 transition-all opacity-0 pointer-events-none';
            }
            if (this.menuTeamText) this.menuTeamText.textContent = 'White Team';
        } else {
            if (youBlack) {
                youBlack.className = 'flex items-center gap-1 text-amber-400 transition-all opacity-100';
                youBlack.innerHTML = `${supporterBadge}<span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-[9px] tracking-wider font-mono">YOU (黒陣営)</span>`;
            }
            if (youWhite) {
                youWhite.className = 'flex items-center gap-1 text-zinc-600 transition-all opacity-0 pointer-events-none';
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
        this.map = L.map('map', {
            center: CONFIG.DEFAULT_CENTER,
            zoom: CONFIG.DEFAULT_ZOOM,
            minZoom: CONFIG.MIN_ZOOM,
            maxZoom: CONFIG.MAX_ZOOM,
            zoomControl: false,
            attributionControl: false
        });

        // Dark-inverted OpenStreetMap tile layer (100% free, no API key required)
        this.tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
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
            });
        });
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
    }

    updateCycleSkinButtonUI() {
        const textEl = document.getElementById('cycle-skin-text');
        if (!textEl) return;
        const skin = document.body.dataset.skin || 'default';
        const labels = {
            default: 'SKIN: 標準',
            neon: 'SKIN: ネオン',
            gold: 'SKIN: ゴールド',
            crimson: 'SKIN: 紅蓮',
            sakura: 'SKIN: サクラ',
            pixel: 'SKIN: レトロ',
            cyberpunk: 'SKIN: サイバー',
            monochrome: 'SKIN: モノトーン'
        };
        textEl.textContent = labels[skin] || 'SKIN: ' + skin;
    }

    updateSkinBadge(skin) {
        const skinButtons = document.querySelectorAll('.skin-btn');
        skinButtons.forEach(btn => {
            const isSelected = btn.dataset.skin === skin;
            if (isSelected) {
                btn.className = 'skin-btn bg-white text-black font-bold border-2 border-white p-2 rounded-lg text-[11px] shadow-xl transition-all active:scale-95 flex items-center justify-center';
            } else {
                btn.className = 'skin-btn bg-zinc-900 border border-zinc-700 p-2 rounded-lg text-[11px] hover:border-white transition-all active:scale-95 text-zinc-300 flex items-center justify-center';
            }
        });
    }

    initMapThemeSelector() {
        const savedTheme = localStorage.getItem('tw_map_theme') || 'dark';
        this.setMapTheme(savedTheme, false);

        const themeButtons = document.querySelectorAll('.map-theme-btn');
        themeButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetTheme = e.currentTarget.dataset.mapTheme;
                this.setMapTheme(targetTheme, true);
            });
        });
    }

    setupSwipeUpToClose(modalId, closeFn) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        const card = modal.querySelector('div');
        if (!card) return;

        let startY = 0;
        let startX = 0;
        let startTime = 0;
        let isSwiping = false;

        modal.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            startY = touch.clientY;
            startX = touch.clientX;
            startTime = Date.now();
            isSwiping = false;
        }, { passive: true });

        modal.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const deltaY = touch.clientY - startY;
            const deltaX = touch.clientX - startX;

            const scrollableEl = card.querySelector('.overflow-y-auto') || card;
            const isAtTop = scrollableEl.scrollTop <= 5;

            if (isAtTop && deltaY < -15 && Math.abs(deltaY) > Math.abs(deltaX)) {
                isSwiping = true;
                card.style.transition = 'none';
                card.style.transform = `translateY(${deltaY}px)`;
                card.style.opacity = `${Math.max(0.3, 1 + deltaY / 400)}`;
            }
        }, { passive: true });

        const endHandler = (e) => {
            if (!isSwiping) return;
            isSwiping = false;

            const touch = e.changedTouches ? e.changedTouches[0] : null;
            const deltaY = touch ? touch.clientY - startY : 0;
            const elapsed = Math.max(1, Date.now() - startTime);
            const velocity = Math.abs(deltaY) / elapsed;

            if (deltaY < -60 || (velocity > 0.35 && deltaY < -20)) {
                card.style.transition = 'all 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
                card.style.transform = 'translateY(-120%)';
                card.style.opacity = '0';
                setTimeout(() => {
                    closeFn();
                    card.style.transform = '';
                    card.style.opacity = '';
                    card.style.transition = '';
                }, 220);
            } else {
                card.style.transition = 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
                card.style.transform = 'translateY(0)';
                card.style.opacity = '1';
            }
        };

        modal.addEventListener('touchend', endHandler, { passive: true });
        modal.addEventListener('touchcancel', endHandler, { passive: true });
    }

    setMapTheme(theme, notify = false) {
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
        if (nickInput) nickInput.value = this.statsManager.nickname;

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

    parseNicknameAndTitle(raw) {
        return typeof StatsManager !== 'undefined' && typeof StatsManager.parseFormattedName === 'function'
            ? StatsManager.parseFormattedName(raw)
            : { title: '', name: String(raw || '名もなき歩行者') };
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
            const parsed = this.parseNicknameAndTitle(item.nickname);
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
                    const parsed = this.parseNicknameAndTitle(item.nickname);
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
                    const parsed = this.parseNicknameAndTitle(item.nickname);
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

                const shareText = `【TERRITORY WALK】前週シーズン決着！\n所属: ${teamName}チーム (${outcomeText})\n最終制圧比率: Black ${blackPct}% vs White ${whitePct}%\n個人開拓貢献: ${tiles}マス\n\n街を歩いてオセロ陣地を奪い合おう！\n招待コード: ${inviteCode}\n#テリトリーウォーク #TerritoryWalk`;
                const shareUrl = 'https://shodai4.github.io/territory-walk/';

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
        const weekToShow = targetWeek || this.getPreviousWeekId(currentWeek);

        document.getElementById('result-week-id').textContent = weekToShow;
        document.getElementById('result-winner-banner').textContent = '集計中...';
        modal.classList.remove('hidden');

        let result = this.statsManager ? await this.statsManager.getPreviousWeekResult(weekToShow) : null;

        // デバッグプレビュー時で過去週レコードがない場合は、バーの視覚化が確認できるリアルなシミュレーションデータを表示
        if (!result && isManual) {
            result = {
                weekId: weekToShow,
                blackTotal: 142,
                whiteTotal: 88,
                blackPct: 62,
                whitePct: 38,
                winnerTeam: 'black',
                isDraw: false,
                myTeam: this.currentTeam || 'black',
                myTiles: 18,
                isWin: this.currentTeam === 'black'
            };
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
            if (barBlack) barBlack.style.width = '50%';
            if (barWhite) barWhite.style.width = '50%';
            document.getElementById('result-my-team').textContent = this.currentTeam === 'black' ? 'Black' : 'White';
            document.getElementById('result-my-tiles').textContent = '0 マス';
            document.getElementById('result-battle-outcome').textContent = '対戦なし';
            return;
        }

        if (result.winnerTeam === 'black') {
            banner.innerHTML = '<span class="text-zinc-100 font-bold">BLACK TEAM WIN</span>';
        } else if (result.winnerTeam === 'white') {
            banner.innerHTML = '<span class="text-zinc-100 font-bold">WHITE TEAM WIN</span>';
        } else {
            banner.innerHTML = '<span class="text-amber-400 font-bold">DRAW (引き分け)</span>';
        }

        document.getElementById('result-score-black').textContent = `${result.blackPct}% (${result.blackTotal}マス)`;
        document.getElementById('result-score-white').textContent = `${result.whitePct}% (${result.whiteTotal}マス)`;

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

    async exportPosterAction() {
        const hasAccess = (this.proManager && this.proManager.isPro()) ||
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
        this.setupSwipeUpToClose('rules-modal', () => {
            if (this.rulesModal) {
                this.rulesModal.classList.add('hidden');
                localStorage.setItem('territory_rules_seen_v1', 'true');
            }
        });
    }

    initMenuModal() {
        if (!this.menuModal) return;

        const openModal = () => {
            this.menuModal.classList.remove('hidden');
            this.updateAutoBalanceUI();
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
            }
        });

        // Capacitor Native AppState listener
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
            try {
                window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
                    this.isAppInBackground = !state.isActive;
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
        const rawLat = position.coords.latitude;
        const rawLng = position.coords.longitude;
        const latitude = parseFloat(rawLat.toFixed(5));
        const longitude = parseFloat(rawLng.toFixed(5));
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
        switch (error.code) {
            case error.PERMISSION_DENIED:
                this.updateGPSStatus('GPS: 拒否', 'bg-red-500', 'text-red-400');
                this.showToast('位置情報の利用が許可されていません（端末の設定をご確認ください）');
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

            // Track background claims while screen is locked
            if (this.isAppInBackground) {
                this.backgroundClaimCount++;
                console.log(`[Background GPS] Claimed ${meshId} in background. Total: ${this.backgroundClaimCount}`);
            }

            // 1. Immediate local UI update
            this.gridManager.claimedTilesCache.set(meshId, this.currentTeam);
            this.gridManager.saveTilesToStorage();

            if (!this.isAppInBackground) {
                if (this.gridManager.renderedMeshes.has(meshId)) {
                    this.gridManager.renderedMeshes.get(meshId).setStyle(this.gridManager.getTileStyle(this.currentTeam));
                } else {
                    this.gridManager.renderSingleTile(meshId, latIdx, lngIdx, this.currentTeam);
                }
                this.updateScoreUI();
                this.playClaimSound();
                this.triggerHaptic();
            } else {
                this.updateScoreUI();
            }

            // 2. Stats logging
            if (this.statsManager) {
                this.statsManager.recordTileClaimed(isReclaimed);
            }

            // In-game Coin reward
            if (this.coinManager) {
                this.coinManager.onTileClaimed(isReclaimed);
            }

            // 3. Supabase online sync
            if (this.supabaseManager) {
                this.supabaseManager.upsertTile(meshId, latIdx, lngIdx, this.currentTeam)
                    .catch(err => console.warn('[Supabase Sync] Background tile upsert error:', err));
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
                if (this.map && this.virtualPos) {
                    this.map.setView(this.virtualPos, CONFIG.DEFAULT_ZOOM, { animate: true });
                    if (this.searchManager) {
                        this.searchManager.clearSearchMarker();
                        this.searchManager.closeSearchBar();
                    }
                    this.showToast('現在地に戻りました');
                }
            });
        }

        // Debug Preview Buttons (Safe UI Preview without modifying persistent production state)
        const btnDebugResult = document.getElementById('btn-debug-preview-result');
        if (btnDebugResult) {
            btnDebugResult.addEventListener('click', () => {
                if (this.menuModal) this.menuModal.classList.add('hidden');
                this.showWeeklyResultModal(true);
            });
        }

        const btnDebugTeam = document.getElementById('btn-debug-preview-team');
        if (btnDebugTeam) {
            btnDebugTeam.addEventListener('click', () => {
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
                if (this.coinManager && typeof this.coinManager.resetPurchasedItems === 'function') {
                    this.coinManager.resetPurchasedItems();
                }
            });
        }

        window.addEventListener('resize', () => this.resetViewportScroll());
        window.addEventListener('orientationchange', () => this.resetViewportScroll());
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
