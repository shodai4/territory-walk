/**
 * TERRITORY WALK - coins.js
 * In-game Coin Economy, Ad Reward Simulation & Shop Manager
 * Zero-emoji, strictly minimal and high-contrast dark UI design.
 */

class CoinManager {
    constructor(appInstance, supabaseManager) {
        this.app = appInstance;
        this.supabaseManager = supabaseManager;

        this.STORAGE_KEY_COINS = 'tw_coins';
        this.STORAGE_KEY_UNLOCKED_SKINS = 'tw_unlocked_skins';
        this.STORAGE_KEY_UNLOCKED_PERKS = 'tw_unlocked_perks';
        this.STORAGE_KEY_POSTER_TICKETS = 'tw_poster_tickets';

        this.coins = this.loadCoins();
        this.unlockedSkins = this.loadUnlockedSkins();
        this.unlockedPerks = this.loadUnlockedPerks();

        this.adTimer = null;
        this.adSecondsLeft = 5;

        // 1. Tile & Grid Skins Catalog
        this.SKINS = {
            default: { id: 'default', name: '標準 (Default)', cost: 0, desc: '白黒クラシックオセロカラー', class: 'text-zinc-200' },
            neon: { id: 'neon', name: 'ネオン (Neon)', cost: 100, desc: 'シアンとマゼンタの鮮烈な発光', class: 'text-cyan-400' },
            gold: { id: 'gold', name: 'ゴールド (Gold)', cost: 200, desc: '富と栄光のシャンパンゴールド', class: 'text-amber-400' },
            crimson: { id: 'crimson', name: '紅蓮 (Crimson)', cost: 150, desc: '燃え盛る情熱の炎と深紅', class: 'text-orange-400' },
            sakura: { id: 'sakura', name: 'サクラ (Sakura)', cost: 150, desc: '春風舞う桜ピンクと翡翠ミント', class: 'text-pink-400' },
            pixel: { id: 'pixel', name: 'レトロ (Pixel)', cost: 100, desc: '80sアーケードライムグリーン', class: 'text-lime-400' },
            cyberpunk: { id: 'cyberpunk', name: 'サイバー (Cyber)', cost: 250, desc: '近未来パープルとネオンブルー', class: 'text-purple-400' },
            monochrome: { id: 'monochrome', name: 'モノトーン (Mono)', cost: 150, desc: '氷雪ホワイトと漆黒の高コントラスト', class: 'text-slate-300' }
        };

        // 2. Exclusive Shop Titles Catalog
        this.TITLES = {
            '夜の徘徊者': { name: '夜の徘徊者', cost: 100, desc: '月明かりの街を静寂に歩く者' },
            '地図の魔術師': { name: '地図の魔術師', cost: 150, desc: '幾何学の境界を操る達人' },
            'ストリートファイター': { name: 'ストリートファイター', cost: 200, desc: '幾多の奪還戦を制した猛者' },
            'コイン長者': { name: 'コイン長者', cost: 300, desc: '歩きとリワードで富を築いた者' },
            'ナスカの末裔': { name: 'ナスカの末裔', cost: 400, desc: '大地に壮大な紋様を刻む者' },
            'ウォーキングレジェンド': { name: 'ウォーキングレジェンド', cost: 500, desc: '歩行陣取りの頂点を極めし伝説' }
        };

        // 3. Special Perks Catalog
        this.PERKS = {
            'poster_ticket': { id: 'poster_ticket', name: '週間ポスター書き出し (1回分)', cost: 30, desc: '今週の陣地をA4アートポスターPNG保存' },
            'poster_permanent': { id: 'poster_permanent', name: 'ポスター書き出し無制限パス', cost: 300, desc: 'いつでも何度でもポスター保存が可能に' },
            'pin_neon': { id: 'pin_neon', name: '現在地ピン: シアン光彩パルス', cost: 150, desc: '現在地マーカーに強いネオン発光エフェクト' },
            'pin_gold': { id: 'pin_gold', name: '現在地ピン: 黄金オーラ', cost: 200, desc: '現在地マーカーが黄金の輝きを放つ' }
        };

        // Global callback for external AdSense / AdMob Rewarded Video completion
        window.onRewardedAdCompleted = (amount) => {
            this.addCoins(amount || 50, '外部動画広告リワード');
        };

        this.initDOM();
        this.updateCoinUI();
        this.applySavedPerkEffects();
    }

    loadCoins() {
        const stored = localStorage.getItem(this.STORAGE_KEY_COINS);
        if (stored === null) {
            // Initial Welcome Bonus
            localStorage.setItem(this.STORAGE_KEY_COINS, '100');
            return 100;
        }
        return parseInt(stored || '0', 10);
    }

    loadUnlockedSkins() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY_UNLOCKED_SKINS);
            return raw ? JSON.parse(raw) : ['default'];
        } catch (e) {
            return ['default'];
        }
    }

    loadUnlockedPerks() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY_UNLOCKED_PERKS);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    getCoins() {
        return this.coins;
    }

    addCoins(amount, reason = '') {
        const n = parseInt(amount, 10);
        if (isNaN(n) || n <= 0) return;

        this.coins += n;
        localStorage.setItem(this.STORAGE_KEY_COINS, this.coins.toString());
        this.updateCoinUI();

        if (reason && this.app && this.app.showToast) {
            this.app.showToast(`+${n} COIN 獲得 (${reason})`);
        }

        // Animate coin indicator
        this.animateCoinBadge();
        this.syncCoinsToSupabase();
    }

    spendCoins(amount, itemName = '') {
        const n = parseInt(amount, 10);
        if (isNaN(n) || n <= 0) return false;

        if (this.coins < n) {
            if (this.app && this.app.showToast) {
                this.app.showToast(`コインが不足しています (所持: ${this.coins} COIN / 必要: ${n} COIN)`);
            }
            return false;
        }

        this.coins -= n;
        localStorage.setItem(this.STORAGE_KEY_COINS, this.coins.toString());
        this.updateCoinUI();

        if (itemName && this.app && this.app.showToast) {
            this.app.showToast(`-${n} COIN: ${itemName} を購入しました`);
        }

        this.syncCoinsToSupabase();
        return true;
    }

    animateCoinBadge() {
        const badge = document.getElementById('btn-header-coins');
        if (badge) {
            badge.classList.add('ring-2', 'ring-amber-400', 'scale-105');
            setTimeout(() => {
                badge.classList.remove('ring-2', 'ring-amber-400', 'scale-105');
            }, 600);
        }
    }

    updateCoinUI() {
        const headerCount = document.getElementById('header-coin-count');
        if (headerCount) headerCount.textContent = this.coins.toLocaleString();

        const modalCount = document.getElementById('shop-modal-coin-count');
        if (modalCount) modalCount.textContent = this.coins.toLocaleString();

        const adRewardBalance = document.getElementById('reward-ad-current-coins');
        if (adRewardBalance) adRewardBalance.textContent = this.coins.toLocaleString();

        this.renderShopPanels();
    }

    syncCoinsToSupabase() {
        if (!this.supabaseManager || !this.supabaseManager.client || !this.app || !this.app.statsManager) return;

        try {
            const uid = this.app.statsManager.userId;
            this.supabaseManager.client.from('territory_users').update({
                coins: this.coins,
                updated_at: new Date().toISOString()
            }).eq('user_id', uid).then(({ error }) => {
                if (error && !error.message.includes('column "coins" of relation "territory_users" does not exist')) {
                    console.warn('[Coins] Supabase sync note:', error.message);
                }
            });
        } catch (e) {
            console.warn('[Coins] Supabase sync skipped:', e);
        }
    }

    // --- Skins Management ---
    isSkinUnlocked(skinId) {
        if (skinId === 'default') return true;
        if (this.app && this.app.proManager && this.app.proManager.isPro()) return true;
        return this.unlockedSkins.includes(skinId);
    }

    unlockSkin(skinId) {
        const skin = this.SKINS[skinId];
        if (!skin) return false;

        if (this.isSkinUnlocked(skinId)) {
            this.app.showToast(`${skin.name} はすでに解放済みです`);
            return true;
        }

        if (!this.spendCoins(skin.cost, skin.name)) return false;

        this.unlockedSkins.push(skinId);
        localStorage.setItem(this.STORAGE_KEY_UNLOCKED_SKINS, JSON.stringify(this.unlockedSkins));

        // Immediately apply skin
        document.body.dataset.skin = skinId;
        localStorage.setItem('territory_skin', skinId);
        if (this.app.updateSkinBadge) this.app.updateSkinBadge(skinId);
        if (this.app.updateCycleSkinButtonUI) this.app.updateCycleSkinButtonUI();
        if (this.app.gridManager) this.app.gridManager.redrawTiles();

        this.app.showToast(`テーマ解放＆適用: ${skin.name}`);
        this.renderShopPanels();
        return true;
    }

    promptUnlockSkin(skinId) {
        const skin = this.SKINS[skinId];
        if (!skin) return;

        if (this.coins >= skin.cost) {
            const ok = confirm(`【ショップ】\n「${skin.name}」を ${skin.cost} COIN で解放しますか？\n（現在所持: ${this.coins} COIN）`);
            if (ok) {
                this.unlockSkin(skinId);
            }
        } else {
            const ok = confirm(`【コイン不足】\n「${skin.name}」の解放には ${skin.cost} COIN 必要です。\n（現在所持: ${this.coins} COIN）\n\nショップを開いてリワード広告でコインを獲得しますか？`);
            if (ok) {
                this.openShopModal('earn');
            }
        }
    }

    // --- Titles Management ---
    isTitleUnlocked(titleName) {
        if (!this.app || !this.app.statsManager) return false;
        return this.app.statsManager.unlockedTitles.includes(titleName);
    }

    unlockTitle(titleName) {
        const item = this.TITLES[titleName];
        if (!item) return false;

        if (this.isTitleUnlocked(titleName)) {
            this.app.showToast(`称号 [${titleName}] はすでに獲得済みです`);
            return true;
        }

        if (!this.spendCoins(item.cost, `称号 [${titleName}]`)) return false;

        if (this.app.statsManager) {
            this.app.statsManager.unlockTitle(titleName);
            this.app.statsManager.setActiveTitle(titleName);
        }

        this.app.showToast(`称号獲得＆セット: [${titleName}]`);
        this.renderShopPanels();
        return true;
    }

    // --- Perks Management ---
    isPerkUnlocked(perkId) {
        if (this.app && this.app.proManager && this.app.proManager.isPro()) return true;
        return this.unlockedPerks.includes(perkId);
    }

    canAccessPosterExport() {
        if (this.app && this.app.proManager && this.app.proManager.isPro()) return true;
        if (this.isPerkUnlocked('poster_permanent')) return true;

        const tickets = parseInt(localStorage.getItem(this.STORAGE_KEY_POSTER_TICKETS) || '0', 10);
        if (tickets > 0) {
            localStorage.setItem(this.STORAGE_KEY_POSTER_TICKETS, (tickets - 1).toString());
            this.app.showToast(`ポスターチケットを1枚消費しました (残り: ${tickets - 1}枚)`);
            return true;
        }
        return false;
    }

    unlockPerk(perkId) {
        const perk = this.PERKS[perkId];
        if (!perk) return false;

        if (perkId === 'poster_ticket') {
            // Purchase 1 ticket
            if (!this.spendCoins(perk.cost, perk.name)) return false;
            const current = parseInt(localStorage.getItem(this.STORAGE_KEY_POSTER_TICKETS) || '0', 10);
            localStorage.setItem(this.STORAGE_KEY_POSTER_TICKETS, (current + 1).toString());
            this.app.showToast(`ポスターチケットを購入しました (所持: ${current + 1}枚)`);
            this.renderShopPanels();
            return true;
        }

        if (this.isPerkUnlocked(perkId)) {
            this.app.showToast(`${perk.name} はすでに解放済みです`);
            return true;
        }

        if (!this.spendCoins(perk.cost, perk.name)) return false;

        this.unlockedPerks.push(perkId);
        localStorage.setItem(this.STORAGE_KEY_UNLOCKED_PERKS, JSON.stringify(this.unlockedPerks));

        this.applyPerkEffect(perkId);
        this.renderShopPanels();
        return true;
    }

    applySavedPerkEffects() {
        const savedPin = localStorage.getItem('tw_pin_effect');
        if (savedPin) {
            document.body.setAttribute('data-pin-effect', savedPin);
        }
    }

    applyPerkEffect(perkId) {
        if (perkId === 'pin_neon') {
            document.body.setAttribute('data-pin-effect', 'neon');
            localStorage.setItem('tw_pin_effect', 'neon');
            this.app.showToast('現在地ピン: ネオン光彩パルスを適用しました');
        } else if (perkId === 'pin_gold') {
            document.body.setAttribute('data-pin-effect', 'gold');
            localStorage.setItem('tw_pin_effect', 'gold');
            this.app.showToast('現在地ピン: 黄金オーラを適用しました');
        }
    }

    // --- Tile Walking Hook ---
    onTileClaimed(isReclaimed) {
        const amount = isReclaimed ? 2 : 1;
        this.coins += amount;
        localStorage.setItem(this.STORAGE_KEY_COINS, this.coins.toString());
        this.updateCoinUI();
        this.syncCoinsToSupabase();
    }

    // --- DOM & Modals Initialization ---
    initDOM() {
        // Header coin button
        const headerBtn = document.getElementById('btn-header-coins');
        if (headerBtn) {
            headerBtn.addEventListener('click', () => {
                this.openShopModal('earn');
            });
        }

        // Menu modal SHOP entry button
        const menuShopBtn = document.getElementById('btn-open-shop-from-menu');
        if (menuShopBtn) {
            menuShopBtn.addEventListener('click', () => {
                if (this.app.menuModal) this.app.menuModal.classList.add('hidden');
                this.openShopModal('skins');
            });
        }

        this.initShopModal();
        this.initRewardAdModal();
    }

    initShopModal() {
        const modal = document.getElementById('shop-modal');
        const closeBtn = document.getElementById('btn-close-shop');
        const footerCloseBtn = document.getElementById('btn-shop-footer-close');

        if (closeBtn && modal) {
            closeBtn.addEventListener('click', () => this.closeShopModal());
        }
        if (footerCloseBtn && modal) {
            footerCloseBtn.addEventListener('click', () => this.closeShopModal());
        }
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeShopModal();
            });
        }

        // Shop Tabs
        const tabEarn = document.getElementById('tab-shop-earn');
        const tabSkins = document.getElementById('tab-shop-skins');
        const tabTitles = document.getElementById('tab-shop-titles');
        const tabPerks = document.getElementById('tab-shop-perks');

        const tabs = [
            { btn: tabEarn, key: 'earn' },
            { btn: tabSkins, key: 'skins' },
            { btn: tabTitles, key: 'titles' },
            { btn: tabPerks, key: 'perks' }
        ];

        tabs.forEach(({ btn, key }) => {
            if (btn) {
                btn.addEventListener('click', () => this.switchShopTab(key));
            }
        });

        // Earn Coins Panel action button (Watch Ad)
        const btnWatchAd = document.getElementById('btn-watch-reward-ad');
        if (btnWatchAd) {
            btnWatchAd.addEventListener('click', () => {
                this.startRewardAdSimulation();
            });
        }
    }

    openShopModal(initialTab = 'earn') {
        const modal = document.getElementById('shop-modal');
        if (!modal) return;

        this.updateCoinUI();
        this.switchShopTab(initialTab);
        modal.classList.remove('hidden');
    }

    closeShopModal() {
        const modal = document.getElementById('shop-modal');
        if (modal) modal.classList.add('hidden');
    }

    switchShopTab(tabKey) {
        const tabs = {
            earn: { btn: document.getElementById('tab-shop-earn'), panel: document.getElementById('panel-shop-earn') },
            skins: { btn: document.getElementById('tab-shop-skins'), panel: document.getElementById('panel-shop-skins') },
            titles: { btn: document.getElementById('tab-shop-titles'), panel: document.getElementById('panel-shop-titles') },
            perks: { btn: document.getElementById('tab-shop-perks'), panel: document.getElementById('panel-shop-perks') }
        };

        Object.keys(tabs).forEach(k => {
            const { btn, panel } = tabs[k];
            if (btn) {
                if (k === tabKey) {
                    btn.className = 'shop-tab-btn active flex-1 py-1.5 rounded-lg border-b-2 border-amber-500 font-bold text-center text-amber-400 bg-zinc-900/60';
                } else {
                    btn.className = 'shop-tab-btn flex-1 py-1.5 rounded-lg border-b-2 border-transparent font-medium text-center text-zinc-400 hover:text-white';
                }
            }
            if (panel) {
                if (k === tabKey) panel.classList.remove('hidden');
                else panel.classList.add('hidden');
            }
        });

        this.renderShopPanels();
    }

    renderShopPanels() {
        this.renderSkinsPanel();
        this.renderTitlesPanel();
        this.renderPerksPanel();
    }

    renderSkinsPanel() {
        const container = document.getElementById('container-shop-skins');
        if (!container) return;

        const currentSkin = document.body.dataset.skin || 'default';

        container.innerHTML = Object.values(this.SKINS).map(skin => {
            const isUnlocked = this.isSkinUnlocked(skin.id);
            const isEquipped = currentSkin === skin.id;

            let actionButton = '';
            if (isEquipped) {
                actionButton = `<span class="px-2.5 py-1 rounded bg-zinc-800 text-zinc-400 text-[10px] font-bold font-mono">適用中</span>`;
            } else if (isUnlocked) {
                actionButton = `<button class="btn-equip-skin px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] font-bold font-mono transition-all active:scale-95" data-skin="${skin.id}">適用する</button>`;
            } else {
                const canAfford = this.coins >= skin.cost;
                const btnStyle = canAfford 
                    ? 'bg-amber-600 hover:bg-amber-500 text-white' 
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed';
                actionButton = `<button class="btn-buy-skin px-2.5 py-1 rounded ${btnStyle} text-[10px] font-bold font-mono transition-all active:scale-95" data-skin="${skin.id}" ${canAfford ? '' : 'disabled'}>${skin.cost} COIN</button>`;
            }

            return `
                <div class="bg-zinc-950/80 border border-zinc-800 p-2.5 rounded-xl flex items-center justify-between gap-2">
                    <div>
                        <div class="font-bold text-xs ${skin.class}">${skin.name}</div>
                        <div class="text-[10px] text-zinc-400 leading-tight mt-0.5">${skin.desc}</div>
                    </div>
                    <div class="shrink-0">
                        ${actionButton}
                    </div>
                </div>
            `;
        }).join('');

        // Attach listeners
        container.querySelectorAll('.btn-equip-skin').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const s = e.currentTarget.dataset.skin;
                document.body.dataset.skin = s;
                localStorage.setItem('territory_skin', s);
                if (this.app.updateSkinBadge) this.app.updateSkinBadge(s);
                if (this.app.updateCycleSkinButtonUI) this.app.updateCycleSkinButtonUI();
                if (this.app.gridManager) this.app.gridManager.redrawTiles();
                this.app.showToast(`テーマ適用: ${this.SKINS[s].name}`);
                this.renderSkinsPanel();
            });
        });

        container.querySelectorAll('.btn-buy-skin').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const s = e.currentTarget.dataset.skin;
                this.unlockSkin(s);
            });
        });
    }

    renderTitlesPanel() {
        const container = document.getElementById('container-shop-titles');
        if (!container) return;

        const activeTitle = (this.app.statsManager && this.app.statsManager.activeTitle) || '';

        container.innerHTML = Object.values(this.TITLES).map(title => {
            const isUnlocked = this.isTitleUnlocked(title.name);
            const isEquipped = activeTitle === title.name;

            let actionButton = '';
            if (isEquipped) {
                actionButton = `<span class="px-2.5 py-1 rounded bg-zinc-800 text-amber-400 text-[10px] font-bold font-mono">セット中</span>`;
            } else if (isUnlocked) {
                actionButton = `<button class="btn-equip-title px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] font-bold font-mono transition-all active:scale-95" data-title="${title.name}">セット</button>`;
            } else {
                const canAfford = this.coins >= title.cost;
                const btnStyle = canAfford 
                    ? 'bg-amber-600 hover:bg-amber-500 text-white' 
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed';
                actionButton = `<button class="btn-buy-title px-2.5 py-1 rounded ${btnStyle} text-[10px] font-bold font-mono transition-all active:scale-95" data-title="${title.name}" ${canAfford ? '' : 'disabled'}>${title.cost} COIN</button>`;
            }

            return `
                <div class="bg-zinc-950/80 border border-zinc-800 p-2.5 rounded-xl flex items-center justify-between gap-2">
                    <div>
                        <div class="font-bold text-xs text-amber-300 font-mono">[${title.name}]</div>
                        <div class="text-[10px] text-zinc-400 leading-tight mt-0.5">${title.desc}</div>
                    </div>
                    <div class="shrink-0">
                        ${actionButton}
                    </div>
                </div>
            `;
        }).join('');

        // Attach listeners
        container.querySelectorAll('.btn-equip-title').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const t = e.currentTarget.dataset.title;
                if (this.app.statsManager) {
                    this.app.statsManager.setActiveTitle(t);
                    this.app.showToast(`称号セット: [${t}]`);
                    this.renderTitlesPanel();
                }
            });
        });

        container.querySelectorAll('.btn-buy-title').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const t = e.currentTarget.dataset.title;
                this.unlockTitle(t);
            });
        });
    }

    renderPerksPanel() {
        const container = document.getElementById('container-shop-perks');
        if (!container) return;

        const isPro = this.app && this.app.proManager && this.app.proManager.isPro();
        const tickets = parseInt(localStorage.getItem(this.STORAGE_KEY_POSTER_TICKETS) || '0', 10);
        const savedPin = localStorage.getItem('tw_pin_effect') || 'default';

        container.innerHTML = Object.values(this.PERKS).map(perk => {
            let actionButton = '';

            if (perk.id === 'poster_ticket') {
                const canAfford = this.coins >= perk.cost;
                actionButton = `
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] font-mono text-zinc-400">所持: ${tickets}枚</span>
                        <button class="btn-buy-perk px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-bold font-mono transition-all active:scale-95" data-perk="${perk.id}">購入 (${perk.cost}C)</button>
                    </div>
                `;
            } else if (perk.id === 'poster_permanent') {
                const unlocked = isPro || this.isPerkUnlocked(perk.id);
                if (unlocked) {
                    actionButton = `<span class="px-2.5 py-1 rounded bg-zinc-800 text-amber-400 text-[10px] font-bold font-mono">解放済み</span>`;
                } else {
                    const canAfford = this.coins >= perk.cost;
                    actionButton = `<button class="btn-buy-perk px-2.5 py-1 rounded ${canAfford ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-zinc-800 text-zinc-500'} text-[10px] font-bold font-mono transition-all active:scale-95" data-perk="${perk.id}" ${canAfford ? '' : 'disabled'}>${perk.cost} COIN</button>`;
                }
            } else if (perk.id.startsWith('pin_')) {
                const unlocked = this.isPerkUnlocked(perk.id);
                const isEquipped = (perk.id === 'pin_neon' && savedPin === 'neon') || (perk.id === 'pin_gold' && savedPin === 'gold');

                if (isEquipped) {
                    actionButton = `<span class="px-2.5 py-1 rounded bg-zinc-800 text-amber-400 text-[10px] font-bold font-mono">適用中</span>`;
                } else if (unlocked) {
                    actionButton = `<button class="btn-equip-pin px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] font-bold font-mono transition-all active:scale-95" data-pin="${perk.id === 'pin_neon' ? 'neon' : 'gold'}">適用</button>`;
                } else {
                    const canAfford = this.coins >= perk.cost;
                    actionButton = `<button class="btn-buy-perk px-2.5 py-1 rounded ${canAfford ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-zinc-800 text-zinc-500'} text-[10px] font-bold font-mono transition-all active:scale-95" data-perk="${perk.id}" ${canAfford ? '' : 'disabled'}>${perk.cost} COIN</button>`;
                }
            }

            return `
                <div class="bg-zinc-950/80 border border-zinc-800 p-2.5 rounded-xl flex items-center justify-between gap-2">
                    <div>
                        <div class="font-bold text-xs text-white">${perk.name}</div>
                        <div class="text-[10px] text-zinc-400 leading-tight mt-0.5">${perk.desc}</div>
                    </div>
                    <div class="shrink-0">
                        ${actionButton}
                    </div>
                </div>
            `;
        }).join('');

        // Attach listeners
        container.querySelectorAll('.btn-buy-perk').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const pid = e.currentTarget.dataset.perk;
                this.unlockPerk(pid);
            });
        });

        container.querySelectorAll('.btn-equip-pin').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const pin = e.currentTarget.dataset.pin;
                document.body.setAttribute('data-pin-effect', pin);
                localStorage.setItem('tw_pin_effect', pin);
                this.app.showToast(`現在地エフェクト適用: ${pin}`);
                this.renderPerksPanel();
            });
        });
    }

    // --- Reward Ad Simulation ---
    initRewardAdModal() {
        const modal = document.getElementById('reward-ad-modal');
        const closeBtn = document.getElementById('btn-close-reward-ad');
        const claimBtn = document.getElementById('btn-claim-ad-reward');

        if (closeBtn && modal) {
            closeBtn.addEventListener('click', () => {
                if (this.adTimer) clearInterval(this.adTimer);
                modal.classList.add('hidden');
            });
        }

        if (claimBtn) {
            claimBtn.addEventListener('click', () => {
                this.addCoins(50, '動画広告リワード');
                if (modal) modal.classList.add('hidden');
                this.updateCoinUI();
            });
        }
    }

    startRewardAdSimulation() {
        const modal = document.getElementById('reward-ad-modal');
        const timerText = document.getElementById('reward-ad-timer');
        const progressBar = document.getElementById('reward-ad-progress');
        const claimBtn = document.getElementById('btn-claim-ad-reward');
        const statusText = document.getElementById('reward-ad-status');

        if (!modal) return;

        if (this.adTimer) clearInterval(this.adTimer);

        this.adSecondsLeft = 5;
        if (timerText) timerText.textContent = `リワード付与まで: 5秒`;
        if (progressBar) progressBar.style.width = '0%';
        if (claimBtn) {
            claimBtn.classList.add('hidden');
            claimBtn.disabled = true;
        }
        if (statusText) statusText.textContent = 'スポンサー動画を再生中...';

        modal.classList.remove('hidden');

        const startTime = Date.now();
        const duration = 5000;

        this.adTimer = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(100, (elapsed / duration) * 100);
            const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));

            if (progressBar) progressBar.style.width = `${progress}%`;
            if (timerText) timerText.textContent = remaining > 0 ? `リワード付与まで: ${remaining}秒` : '視聴完了！';

            if (elapsed >= duration) {
                clearInterval(this.adTimer);
                this.adTimer = null;

                if (statusText) statusText.textContent = 'リワードの準備が整いました！';
                if (timerText) timerText.textContent = '視聴完了';
                if (claimBtn) {
                    claimBtn.classList.remove('hidden');
                    claimBtn.disabled = false;
                }
            }
        }, 100);
    }
}
