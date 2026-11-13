/**
 * TERRITORY WALK - coins.js
 * In-game Coin Economy, Ad Reward Simulation, Shop Manager & Viral Growth
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

        // 1. Tile & Grid Skins Catalog (Rebalanced Price Hierarchy)
        this.SKINS = {
            default: { id: 'default', name: '標準', cost: 0, desc: '白黒クラシックオセロカラー', class: 'text-zinc-200' },
            pixel: { id: 'pixel', name: 'レトロ', cost: 100, desc: '80sアーケードライムグリーン', class: 'text-lime-400' },
            sakura: { id: 'sakura', name: 'サクラ', cost: 150, desc: '春風舞う桜ピンクと翡翠ミント', class: 'text-pink-400' },
            monochrome: { id: 'monochrome', name: 'モノトーン', cost: 150, desc: '氷雪ホワイトと漆黒の高コントラスト', class: 'text-slate-300' },
            crimson: { id: 'crimson', name: '紅蓮', cost: 200, desc: '燃え盛る情熱の炎と深紅', class: 'text-orange-400' },
            neon: { id: 'neon', name: 'ネオン', cost: 250, desc: 'シアンとマゼンタの鮮烈な発光', class: 'text-cyan-400' },
            gold: { id: 'gold', name: 'ゴールド', cost: 500, desc: '富と栄光のシャンパンゴールド（プレミアム）', class: 'text-amber-400' },
            cyberpunk: { id: 'cyberpunk', name: 'サイバー', cost: 800, desc: '近未来パープルとネオンブルー（ハイエンド）', class: 'text-purple-400' }
        };

        // 2. Exclusive Shop Titles Catalog (Rebalanced Price Hierarchy)
        this.TITLES = {
            '夜の徘徊者': { name: '夜の徘徊者', cost: 150, desc: '月明かりの街を静寂に歩く者' },
            '地図の魔術師': { name: '地図の魔術師', cost: 200, desc: '幾何学の境界を操る達人' },
            'ストリートファイター': { name: 'ストリートファイター', cost: 300, desc: '幾多の奪還戦を制した猛者' },
            'コイン長者': { name: 'コイン長者', cost: 400, desc: '歩きとリワードで富を築いた者' },
            'ナスカの末裔': { name: 'ナスカの末裔', cost: 500, desc: '大地に壮大な紋様を刻む者' },
            'ウォーキングレジェンド': { name: 'ウォーキングレジェンド', cost: 800, desc: '歩行陣取りの頂点を極めし伝説' }
        };

        // 3. Special Perks Catalog (Rebalanced Price Hierarchy)
        this.PERKS = {
            'poster_ticket': { id: 'poster_ticket', name: '週間ポスター書き出し (1回分)', cost: 50, desc: '今週の陣地をA4アートポスターPNG保存' },
            'pin_neon': { id: 'pin_neon', name: '現在地ピン: シアン光彩パルス', cost: 300, desc: '現在地マーカーに強いネオン発光エフェクト' },
            'pin_gold': { id: 'pin_gold', name: '現在地ピン: 黄金オーラ', cost: 500, desc: '現在地マーカーが黄金の輝きを放つ' },
            'poster_permanent': { id: 'poster_permanent', name: 'ポスター書き出し無制限パス', cost: 800, desc: 'いつでも何度でもポスター保存が可能に' }
        };

        // 4. In-App Purchase Coin Packs Catalog (Dramatically Increased Rates & Value)
        this.PACKS = {
            'beginner': { id: 'beginner', name: 'ビギナーパック', yen: 120, coins: 300, bonus: '+150%増量', desc: 'テーマや称号を手軽にアンロック' },
            'standard': { id: 'standard', name: 'スタンダードパック', yen: 300, coins: 900, bonus: '+157%増量', desc: '人気スキンや限定称号をしっかり解放' },
            'premium': { id: 'premium', name: 'プレミアムパック', yen: 600, coins: 2200, bonus: '+193%増量 (1番人気)', desc: 'ゴールドスキンや無制限パスに最適' },
            'ultimate': { id: 'ultimate', name: 'アルティメットパック', yen: 1200, coins: 5000, bonus: '+212%増量 (最大お得)', desc: '全コンテンツを一気に揃える超特大セット' }
        };

        // 5. Ad-Free Permanent Pass
        this.AD_FREE_PERK = {
            id: 'ad_free',
            name: '広告完全非表示パス (Ad-Free Pro)',
            yen: 480,
            desc: '画面下部バナー広告を完全消去 & 動画リワードを待ち時間なし即時受け取り可能'
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
            const ok = confirm(`【コイン不足】\n「${skin.name}」の解放には ${skin.cost} COIN 必要です。\n（現在所持: ${this.coins} COIN）\n\nショップを開いてリワード広告やコイン購入で獲得しますか？`);
            if (ok) {
                this.openShopModal('packs');
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

    // --- Ad-Free Management ---
    isAdFree() {
        if (this.app && this.app.proManager && this.app.proManager.isPro()) return true;
        return localStorage.getItem('tw_is_ad_free') === 'true';
    }

    setAdFree(enabled = true) {
        localStorage.setItem('tw_is_ad_free', enabled ? 'true' : 'false');
        document.body.setAttribute('data-ad-free', enabled ? 'true' : 'false');
        const banner = document.getElementById('banner-ad-container');
        if (banner) {
            if (enabled) {
                banner.classList.add('hidden');
            } else {
                banner.classList.remove('hidden');
            }
        }
        if (this.app && this.app.adMobManager) {
            this.app.adMobManager.updateAdFreeState(enabled);
        }
    }

    purchaseAdFreePass() {
        if (this.app && this.app.iapManager && this.app.iapManager.isNative) {
            this.app.iapManager.purchasePack('ad-free');
            return;
        }

        this.setAdFree(true);
        if (this.app && this.app.showToast) {
            this.app.showToast('【購入完了】広告完全非表示パス', '下部バナー広告を消去し動画スキップを適用しました');
        }
        this.renderShopPanels();
    }

    // --- Step-Up Walking Bonus System ---
    getStepUpBonusInfo() {
        const todayStr = new Date().toISOString().split('T')[0];
        const lastDate = localStorage.getItem('tw_stepup_date');
        let todayCount = parseInt(localStorage.getItem('tw_today_claimed_count') || '0', 10);

        if (lastDate !== todayStr) {
            todayCount = 0;
            localStorage.setItem('tw_stepup_date', todayStr);
            localStorage.setItem('tw_today_claimed_count', '0');
        }

        // Tier definition:
        // 0-9: Step 1 (Normal) +0C
        // 10-29: Step 2 (Boost) +1C
        // 30-49: Step 3 (Master) +2C
        // 50+: Step 4 (Legend) +3C
        let tier = 1;
        let bonusCoins = 0;
        let tierName = '通常ステップ';
        let nextTarget = 10;

        if (todayCount >= 50) {
            tier = 4;
            bonusCoins = 3;
            tierName = '歩行レジェンド (+3C)';
            nextTarget = null;
        } else if (todayCount >= 30) {
            tier = 3;
            bonusCoins = 2;
            tierName = '散歩マスター (+2C)';
            nextTarget = 50;
        } else if (todayCount >= 10) {
            tier = 2;
            bonusCoins = 1;
            tierName = '歩行ブースト (+1C)';
            nextTarget = 30;
        }

        return { todayCount, tier, bonusCoins, tierName, nextTarget };
    }

    incrementTodayClaimCount() {
        const todayStr = new Date().toISOString().split('T')[0];
        const lastDate = localStorage.getItem('tw_stepup_date');
        let todayCount = parseInt(localStorage.getItem('tw_today_claimed_count') || '0', 10);

        if (lastDate !== todayStr) {
            todayCount = 0;
            localStorage.setItem('tw_stepup_date', todayStr);
        }

        const prevTier = this.getStepUpBonusInfo().tier;
        todayCount += 1;
        localStorage.setItem('tw_today_claimed_count', todayCount.toString());

        const newInfo = this.getStepUpBonusInfo();
        if (newInfo.tier > prevTier && this.app && this.app.showToast) {
            this.app.showToast(
                `ステップアップ達成！${newInfo.tierName}`,
                `本日の開拓 ${todayCount}マス突破！獲得コインが永久加算！`
            );
        }

        return newInfo;
    }

    // --- Tile Walking Hook with Underdog Comeback & Step-Up Bonus ---
    onTileClaimed(isReclaimed) {
        const stepInfo = this.incrementTodayClaimCount();
        const stepBonus = stepInfo.bonusCoins; // +0, +1, +2, +3

        let base = isReclaimed ? 2 : 1;
        let isComeback = false;

        // Comeback Bonus: Tile reclaiming when user is underdog (<= 40% territory)
        if (isReclaimed && this.app && this.app.isUnderdogTeam && this.app.isUnderdogTeam()) {
            base = 4; // 2x double coin bonus
            isComeback = true;
        }

        const totalEarned = base + stepBonus;
        this.coins += totalEarned;
        localStorage.setItem(this.STORAGE_KEY_COINS, this.coins.toString());
        this.updateCoinUI();
        this.syncCoinsToSupabase();

        if (this.app && this.app.showToast) {
            if (isComeback) {
                const sub = stepBonus > 0 ? `劣勢2倍 (+4C) ＋ 歩行ブースト (+${stepBonus}C)` : '獲得コイン2倍 (+4 COIN)';
                this.app.showToast('劣勢逆転ボーナス発動！', sub);
            } else if (stepBonus > 0) {
                this.app.showToast(
                    `マス開拓ボーナス (+${totalEarned} COIN)`,
                    `${stepInfo.tierName} 適用中 (本日: ${stepInfo.todayCount}マス)`
                );
            }
        }
    }

    // --- Coin Packs (IAP / Stripe / Web Simulation) ---
    purchaseCoinPack(packId) {
        const pack = this.PACKS[packId];
        if (!pack) return;

        // Native Capacitor StoreKit / In-App Purchase hook
        if (this.app && this.app.iapManager && this.app.iapManager.isNative) {
            this.app.iapManager.purchasePack(`pack-${pack.yen}`);
            return;
        }

        // Web simulation / Stripe fallback
        this.addCoins(pack.coins, `${pack.name} 購入`);
        if (this.app && this.app.showToast) {
            this.app.showToast(`【購入完了】+${pack.coins.toLocaleString()} COIN を獲得しました (${pack.name})`);
        }

        if (window.onCoinPackPurchased) {
            window.onCoinPackPurchased(packId, pack.coins, pack.yen);
        }

        this.renderShopPanels();
    }

    // --- Viral Sharing: X (Twitter) Daily Share Bonus (+30 COIN) ---
    canShareToXToday() {
        const today = new Date().toISOString().split('T')[0];
        const lastShare = localStorage.getItem('tw_last_x_share_date');
        return lastShare !== today;
    }

    shareToX() {
        const today = new Date().toISOString().split('T')[0];
        const canEarn = this.canShareToXToday();
        
        const tiles = (this.app && this.app.statsManager && this.app.statsManager.stats) 
            ? this.app.statsManager.stats.lifetime_tiles 
            : 0;
        const myTeam = this.app ? (this.app.currentTeam === 'black' ? 'Black (黒)' : 'White (白)') : 'Black';
        const code = (this.app && this.app.statsManager) ? this.app.statsManager.getOrCreateReferralCode() : 'WALK';

        const tweetText = `歩行陣取り #テリトリーウォーク で現在 ${tiles} マス開拓中！今週は【${myTeam}】陣営で白熱バトル！一緒に歩いて陣地を奪い合おう！\n招待コード: ${code}\n#TerritoryWalk`;
        const tweetUrl = 'https://shodai4.github.io/territory-walk/';
        const xUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(tweetUrl)}`;

        window.open(xUrl, '_blank');

        if (canEarn) {
            localStorage.setItem('tw_last_x_share_date', today);
            this.addCoins(30, 'Xシェアボーナス');
            this.renderEarnPanel();
            if (this.app && this.app.updateStatsXShareButton) {
                this.app.updateStatsXShareButton();
            }
        } else {
            if (this.app && this.app.showToast) {
                this.app.showToast('Xシェア画面を開きました (本日のボーナスは獲得済みです)');
            }
        }
    }

    // --- Viral Sharing: Friend Referral (+150 COIN) ---
    copyReferralCode() {
        const code = this.app && this.app.statsManager ? this.app.statsManager.getOrCreateReferralCode() : '';
        if (!code) return;

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(() => {
                if (this.app && this.app.showToast) {
                    this.app.showToast(`招待コード [${code}] をコピーしました`);
                }
            }).catch(() => {
                prompt('招待コードをコピーしてください:', code);
            });
        } else {
            prompt('招待コードをコピーしてください:', code);
        }
    }

    shareReferralNative() {
        const code = this.app && this.app.statsManager ? this.app.statsManager.getOrCreateReferralCode() : '';
        const url = 'https://shodai4.github.io/territory-walk/';
        const text = `リアル歩行陣取り「テリトリーウォーク」で白黒の陣地を奪い合おう！\n招待コード【${code}】を入力すると +150 COIN プレゼント！\n`;

        if (navigator.share) {
            navigator.share({
                title: 'TERRITORY WALK - 白黒歩行オセロ陣取り',
                text: text,
                url: url
            }).catch((err) => {
                if (err && err.name !== 'AbortError') {
                    this.copyReferralCode();
                }
            });
        } else {
            this.copyReferralCode();
        }
    }

    async submitReferralCode(inputEl) {
        if (!inputEl) return;
        const val = inputEl.value;
        if (!this.app || !this.app.statsManager) return;

        const res = await this.app.statsManager.applyReferralCode(val);
        if (this.app.showToast) {
            this.app.showToast(res.message);
        }
        if (res.success) {
            inputEl.value = '';
            this.renderEarnPanel();
        }
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
                this.openShopModal('packs');
            });
        }

        // Bottom banner ad-free prompt button
        const btnAdFreePrompt = document.getElementById('btn-ad-free-prompt');
        if (btnAdFreePrompt) {
            btnAdFreePrompt.addEventListener('click', () => {
                this.openShopModal('packs');
            });
        }

        // Apply saved ad-free state to UI
        if (this.isAdFree()) {
            this.setAdFree(true);
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

        // Shop Tabs (5 Tabs: earn, packs, skins, titles, perks)
        const tabs = [
            { btn: document.getElementById('tab-shop-earn'), key: 'earn' },
            { btn: document.getElementById('tab-shop-packs'), key: 'packs' },
            { btn: document.getElementById('tab-shop-skins'), key: 'skins' },
            { btn: document.getElementById('tab-shop-titles'), key: 'titles' },
            { btn: document.getElementById('tab-shop-perks'), key: 'perks' }
        ];

        tabs.forEach(({ btn, key }) => {
            if (btn) {
                btn.addEventListener('click', () => this.switchShopTab(key));
            }
        });

        // Earn Coins Panel action buttons
        const btnWatchAd = document.getElementById('btn-watch-reward-ad');
        if (btnWatchAd) {
            btnWatchAd.addEventListener('click', () => {
                if (this.isAdFree()) {
                    this.addCoins(50, '動画リワード (Ad-Free スキップ)');
                    this.updateCoinUI();
                    if (this.app && this.app.showToast) {
                        this.app.showToast('【Ad-Free特典】動画スキップ！', '+50 COIN を即時獲得しました');
                    }
                    return;
                }
                if (this.app && this.app.adMobManager && this.app.adMobManager.isNative) {
                    this.app.adMobManager.showRewardVideo(() => {
                        this.addCoins(50, 'AdMob動画リワード');
                        this.updateCoinUI();
                        if (this.app && this.app.showToast) {
                            this.app.showToast('動画リワード獲得！', '+50 COIN を獲得しました');
                        }
                    });
                } else {
                    this.startRewardAdSimulation();
                }
            });
        }

        const btnXShare = document.getElementById('btn-x-share-shop');
        if (btnXShare) {
            btnXShare.addEventListener('click', () => {
                this.shareToX();
            });
        }

        const btnCopyReferral = document.getElementById('btn-copy-my-referral');
        if (btnCopyReferral) {
            btnCopyReferral.addEventListener('click', () => {
                this.copyReferralCode();
            });
        }

        const btnShareReferral = document.getElementById('btn-share-my-referral');
        if (btnShareReferral) {
            btnShareReferral.addEventListener('click', () => {
                this.shareReferralNative();
            });
        }

        const btnApplyReferral = document.getElementById('btn-apply-friend-referral');
        const inputReferral = document.getElementById('input-friend-referral');
        if (btnApplyReferral && inputReferral) {
            btnApplyReferral.addEventListener('click', () => {
                this.submitReferralCode(inputReferral);
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
            packs: { btn: document.getElementById('tab-shop-packs'), panel: document.getElementById('panel-shop-packs') },
            skins: { btn: document.getElementById('tab-shop-skins'), panel: document.getElementById('panel-shop-skins') },
            titles: { btn: document.getElementById('tab-shop-titles'), panel: document.getElementById('panel-shop-titles') },
            perks: { btn: document.getElementById('tab-shop-perks'), panel: document.getElementById('panel-shop-perks') }
        };

        Object.keys(tabs).forEach(k => {
            const { btn, panel } = tabs[k];
            if (btn) {
                if (k === tabKey) {
                    btn.className = 'shop-tab-btn active flex-1 py-1.5 px-2 rounded-lg border-b-2 border-amber-500 font-bold text-center text-amber-400 bg-zinc-900/60 shrink-0';
                } else {
                    btn.className = 'shop-tab-btn flex-1 py-1.5 px-2 rounded-lg border-b-2 border-transparent font-medium text-center text-zinc-400 hover:text-white shrink-0';
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
        this.renderEarnPanel();
        this.renderPacksPanel();
        this.renderSkinsPanel();
        this.renderTitlesPanel();
        this.renderPerksPanel();
    }

    renderEarnPanel() {
        // Update X Share Button
        const btnXShare = document.getElementById('btn-x-share-shop');
        const canShareX = this.canShareToXToday();
        if (btnXShare) {
            if (canShareX) {
                btnXShare.disabled = false;
                btnXShare.className = 'w-full py-2 bg-zinc-100 hover:bg-white text-black font-bold font-mono text-xs rounded-lg shadow transition-all active:scale-95 flex items-center justify-center gap-1.5';
                btnXShare.innerHTML = `
                    <svg class="w-3.5 h-3.5 text-black" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    <span>Xで戦績をシェアして +30 COIN 獲得</span>
                `;
            } else {
                btnXShare.disabled = true;
                btnXShare.className = 'w-full py-2 bg-zinc-800 text-zinc-500 font-bold font-mono text-xs rounded-lg cursor-not-allowed flex items-center justify-center gap-1.5';
                btnXShare.innerHTML = `
                    <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                    <span>本日獲得済み (明日またシェアできます)</span>
                `;
            }
        }

        // Update Referral Code Display
        const code = (this.app && this.app.statsManager) ? this.app.statsManager.getOrCreateReferralCode() : '';
        const codeEl = document.getElementById('display-my-referral-code');
        if (codeEl) codeEl.textContent = code;

        // Update Referral Input Status
        const used = localStorage.getItem('tw_referred_used');
        const referralInputContainer = document.getElementById('friend-referral-input-container');
        if (referralInputContainer) {
            if (used) {
                referralInputContainer.innerHTML = `
                    <div class="bg-zinc-900 border border-zinc-800 p-2.5 rounded-lg text-center font-mono text-xs text-zinc-400">
                        <span class="text-emerald-400 font-bold">招待特典適用済み</span> [コード: ${used}]
                    </div>
                `;
            }
        }
    }

    renderPacksPanel() {
        const container = document.getElementById('container-shop-packs');
        if (!container) return;

        const isAdFree = this.isAdFree();
        const adFreeCard = `
            <div class="bg-gradient-to-br from-zinc-950 to-zinc-900 border ${isAdFree ? 'border-emerald-500/80' : 'border-amber-500/80 ring-1 ring-amber-500/50'} p-3 rounded-xl flex items-center justify-between gap-2">
                <div>
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-bold text-xs text-white">広告完全非表示パス (Ad-Free Pro)</span>
                        <span class="px-1.5 py-0.5 rounded ${isAdFree ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'} text-[9px] font-mono font-bold">${isAdFree ? '有効化済み' : '買い切りパス'}</span>
                    </div>
                    <div class="text-[10px] text-zinc-400 leading-tight mt-0.5 break-keep">画面下部バナー広告を完全消去 ＆ 動画リワード待ち時間なし即時受取</div>
                    <div class="text-amber-400 font-mono text-xs font-bold mt-1">永久Ad-Free特典</div>
                </div>
                <div class="shrink-0">
                    ${isAdFree ? `
                        <button disabled class="px-3 py-1.5 rounded bg-zinc-800 text-zinc-500 text-xs font-bold font-mono cursor-not-allowed">
                            適用中
                        </button>
                    ` : `
                        <button id="btn-buy-ad-free" class="px-3 py-1.5 rounded bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-black text-xs font-bold font-mono transition-all active:scale-95 shadow">
                            ¥480
                        </button>
                    `}
                </div>
            </div>
        `;

        const packsCards = Object.values(this.PACKS).map(pack => {
            return `
                <div class="bg-zinc-950/80 border ${pack.id === 'premium' ? 'border-amber-500/80 ring-1 ring-amber-500/50' : 'border-zinc-800'} p-3 rounded-xl flex items-center justify-between gap-2">
                    <div>
                        <div class="flex items-center gap-1.5">
                            <span class="font-bold text-xs text-white">${pack.name}</span>
                            ${pack.bonus ? `<span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[9px] font-mono font-bold">${pack.bonus}</span>` : ''}
                        </div>
                        <div class="text-[10px] text-zinc-400 leading-tight mt-0.5">${pack.desc}</div>
                        <div class="text-amber-400 font-mono text-xs font-bold mt-1">+${pack.coins.toLocaleString()} COIN</div>
                    </div>
                    <div class="shrink-0">
                        <button class="btn-buy-pack px-3 py-1.5 rounded bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-black text-xs font-bold font-mono transition-all active:scale-95 shadow" data-pack="${pack.id}">
                            ¥${pack.yen.toLocaleString()}
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = adFreeCard + packsCards;

        const buyAdFreeBtn = container.querySelector('#btn-buy-ad-free');
        if (buyAdFreeBtn) {
            buyAdFreeBtn.addEventListener('click', () => {
                this.purchaseAdFreePass();
            });
        }

        container.querySelectorAll('.btn-buy-pack').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const pid = e.currentTarget.dataset.pack;
                this.purchaseCoinPack(pid);
            });
        });

        // App Store Guidelines: Restore Purchases Button & Legal Links
        const footerEl = document.createElement('div');
        footerEl.className = 'pt-3 border-t border-zinc-800 space-y-2';
        footerEl.innerHTML = `
            <button id="btn-restore-purchases" class="w-full py-2 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white font-mono text-[11px] font-bold rounded-xl transition-all active:scale-95 flex items-center justify-center gap-1.5 shadow">
                <svg class="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                <span>購入の復元 (Restore Purchases)</span>
            </button>
            <div class="flex items-center justify-center gap-3 text-[10px] text-zinc-500 font-mono">
                <a href="terms.html" target="_blank" class="hover:text-zinc-300 underline">利用規約</a>
                <span>•</span>
                <a href="privacy.html" target="_blank" class="hover:text-zinc-300 underline">プライバシーポリシー</a>
                <span>•</span>
                <a href="support.html" target="_blank" class="hover:text-zinc-300 underline">サポート</a>
            </div>
        `;
        container.appendChild(footerEl);

        const btnRestore = footerEl.querySelector('#btn-restore-purchases');
        if (btnRestore) {
            btnRestore.addEventListener('click', (e) => {
                e.preventDefault();
                if (this.app && this.app.iapManager) {
                    this.app.iapManager.restorePurchases();
                } else {
                    if (this.app) this.app.showToast('購入の復元が完了しました (最新状態)');
                }
            });
        }
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

        const hasPosterAccess = isPro || this.isPerkUnlocked('poster_permanent') || tickets > 0;
        if (hasPosterAccess) {
            container.innerHTML += `
                <div class="pt-1">
                    <button id="btn-export-poster-from-shop" class="w-full py-2 bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-black font-bold font-mono text-xs rounded-xl shadow transition-all active:scale-95 flex items-center justify-center gap-1.5">
                        <svg class="w-3.5 h-3.5 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                        <span>今すぐ週間陣地ポスターを書き出し</span>
                    </button>
                </div>
            `;
        }

        container.innerHTML += `
            <div class="bg-gradient-to-r from-zinc-950 to-zinc-900 border border-amber-500/50 p-3 rounded-xl flex items-center justify-between gap-2 mt-2">
                <div>
                    <div class="font-bold text-xs text-amber-400 flex items-center gap-1.5">
                        <span>Proサポーター</span>
                        <span class="px-1.5 py-0.5 rounded ${isPro ? 'bg-amber-400 text-black font-bold' : 'bg-zinc-800 text-zinc-400'} text-[9px] font-mono">${isPro ? '有効' : '未登録'}</span>
                    </div>
                    <div class="text-[10px] text-zinc-400 leading-tight mt-0.5">全スキン解放・無制限ポスター保存・限定サポーターバッジ</div>
                </div>
                <button id="btn-open-pro-from-shop" class="shrink-0 px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white text-[10px] font-bold font-mono transition-all active:scale-95">
                    ${isPro ? '確認' : 'コード入力'}
                </button>
            </div>
        `;

        const exportFromShopBtn = container.querySelector('#btn-export-poster-from-shop');
        if (exportFromShopBtn) {
            exportFromShopBtn.addEventListener('click', () => {
                const shopModal = document.getElementById('shop-modal');
                if (shopModal) shopModal.classList.add('hidden');
                if (this.app && this.app.exportPosterAction) {
                    this.app.exportPosterAction();
                }
            });
        }

        const proFromShopBtn = container.querySelector('#btn-open-pro-from-shop');
        if (proFromShopBtn) {
            proFromShopBtn.addEventListener('click', () => {
                const shopModal = document.getElementById('shop-modal');
                if (shopModal) shopModal.classList.add('hidden');
                const proModal = document.getElementById('pro-modal');
                if (proModal) proModal.classList.remove('hidden');
            });
        }

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
        if (timerText) timerText.textContent = 'リワード付与まで: 5秒';
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
