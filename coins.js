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
        this.STORAGE_KEY_MAP_THEMES = 'tw_unlocked_map_themes';

        this.coins = this.loadCoins();
        this.unlockedSkins = this.loadUnlockedSkins();
        this.unlockedPerks = this.loadUnlockedPerks();
        this.unlockedMapThemes = this.loadUnlockedMapThemes();

        this.adTimer = null;
        this.adSecondsLeft = 5;

        // 1. Tile & Grid Skins Catalog (Graduated Pricing by Rarity & Vibrant Colors)
        this.SKINS = {
            default: { id: 'default', name: '標準', cost: 0, desc: '白と黒のクラシックカラー', class: 'text-zinc-200' },
            pixel: { id: 'pixel', name: 'レトロ', cost: 1000, desc: 'ライムグリーンとダーク', class: 'text-lime-400' },
            sakura: { id: 'sakura', name: 'サクラ', cost: 2500, desc: '桜ピンクと翡翠ミント', class: 'text-pink-400' },
            monochrome: { id: 'monochrome', name: 'モノトーン', cost: 4500, desc: '完全白黒の濃淡', class: 'text-slate-300' },
            crimson: { id: 'crimson', name: 'クリムゾン', cost: 8000, desc: '深紅とダーク', class: 'text-orange-400' },
            neon: { id: 'neon', name: 'ネオン', cost: 14000, desc: 'シアンとマゼンタ', class: 'text-cyan-400' },
            gold: { id: 'gold', name: 'ゴールド', cost: 28000, desc: 'シャンパンゴールド', class: 'text-amber-400' },
            cyberpunk: { id: 'cyberpunk', name: 'サイバー', cost: 50000, desc: 'パープルとブルー', class: 'text-purple-400' }
        };

        // 1.5 マスの色イメージ（自陣・相手陣のカラーチップ表示用）
        this.SKIN_SWATCHES = {
            default: { own: '#ffffff', enemy: '#09090b' },
            pixel: { own: '#bef264', enemy: '#365314' },
            sakura: { own: '#2dd4bf', enemy: '#f472b6' },
            monochrome: { own: '#f1f5f9', enemy: '#334155' },
            crimson: { own: '#fb923c', enemy: '#ef4444' },
            neon: { own: '#06b6d4', enemy: '#d946ef' },
            gold: { own: '#fef08a', enemy: '#18181b' },
            cyberpunk: { own: '#38bdf8', enemy: '#a855f7' }
        };

        // 1.6 背景地図カラー（コイン購入制）— モノクロと地図非表示は無償・先頭固定
        this.MAP_THEMES = {
            mono: { id: 'mono', name: 'モノクロ', cost: 0, order: 0, swatch: '#8b8b91', desc: '白黒の地図' },
            none: { id: 'none', name: '地図非表示', cost: 0, order: 1, swatch: 'transparent', desc: '地図を隠して陣地に集中' },
            dark: { id: 'dark', name: 'ダーク', cost: 3000, order: 2, swatch: '#1f2430', desc: '落ち着いた暗色の地図' },
            street: { id: 'street', name: 'ストリート', cost: 6000, order: 3, swatch: '#9be15d', desc: '明るい標準地図' },
            sepia: { id: 'sepia', name: 'セピア', cost: 12000, order: 4, swatch: '#b98a56', desc: '古地図風の暖色' }
        };

        // 2. Exclusive Shop Titles Catalog (15 Tiers: 1,000 - 50,000 COIN)
        this.TITLES = {
            '深夜の徘徊者': { name: '深夜の徘徊者', cost: 1000, desc: '月明かりの街を静寂に歩く者' },
            '路地裏の案内人': { name: '路地裏の案内人', cost: 1300, desc: '大通りを外れ、未知の小径を行く者' },
            '朝露のウォーカー': { name: '朝露のウォーカー', cost: 1700, desc: '早朝の澄んだ空気を胸に一歩を踏み出す者' },
            '地図の魔術師': { name: '地図の魔術師', cost: 2200, desc: '幾何学の境界を操る達人' },
            'コンパスの導き手': { name: 'コンパスの導き手', cost: 2800, desc: '羅針盤の示すままに未知のエリアへ踏み出す者' },
            '境界線の支配者': { name: '境界線の支配者', cost: 3500, desc: '隣り合う陣地の狭間を巧みに制する者' },
            'ストリートファイター': { name: 'ストリートファイター', cost: 4300, desc: '幾多の奪還戦を制した猛者' },
            '市街地の戦術家': { name: '市街地の戦術家', cost: 5200, desc: '街の構造を読み解き効率よく陣地を広げる者' },
            '戦術の立案者': { name: '戦術の立案者', cost: 6500, desc: '盤面全体を見渡し最適解を導く頭脳' },
            'コイン長者': { name: 'コイン長者', cost: 8000, desc: '歩きとリワードで莫大な富を築いた者' },
            '孤高の開拓王': { name: '孤高の開拓王', cost: 11000, desc: '誰にも頼らず己の足跡だけで帝国を築く者' },
            'ナスカの末裔': { name: 'ナスカの末裔', cost: 15000, desc: '大地に壮大な紋様を刻む者' },
            '天駆ける旅人': { name: '天駆ける旅人', cost: 22000, desc: '果てなき地平を追い求める永遠の冒険者' },
            'ウォーキングレジェンド': { name: 'ウォーキングレジェンド', cost: 35000, desc: '歩行陣取りの頂点を極めし伝説' },
            'テラ・コンクエスター': { name: 'テラ・コンクエスター', cost: 9999999999, desc: 'すべての大地を塗り替える絶対的覇者（最上位）' }
        };

        // 3. Special Perks Catalog (Rebalanced Price Hierarchy)
        this.PERKS = {
            'poster_ticket': { id: 'poster_ticket', name: '週間ポスター書き出し (1回分)', cost: 500, desc: '今週の陣地をA4アートポスターPNG保存' },
            'pin_neon': { id: 'pin_neon', name: '現在地ピン: シアン光彩パルス', cost: 5000, desc: '現在地マーカーに強いネオン発光エフェクト' },
            'pin_gold': { id: 'pin_gold', name: '現在地ピン: 黄金オーラ', cost: 15000, desc: '現在地マーカーが黄金の輝きを放つ' },
            'poster_permanent': { id: 'poster_permanent', name: 'ポスター書き出し無制限パス', cost: 30000, desc: 'いつでも何度でもポスター保存が可能に' }
        };

        // 4. In-App Purchase Coin Packs Catalog (5,000 Yen = 50,000 COIN Standard)
        this.PACKS = {
            'beginner': { id: 'beginner', name: 'ビギナーパック', yen: 120, coins: 1000, bonus: '8.33 C/円', desc: '入門スキンや入門称号を即座に購入可能' },
            'standard': { id: 'standard', name: 'スタンダードパック', yen: 500, coins: 4500, bonus: '9.00 C/円', desc: 'サクラ・モノトーンスキンや中級称号を購入可能' },
            'premium': { id: 'premium', name: 'プレミアムパック', yen: 1500, coins: 14000, bonus: '9.33 C/円 (1番人気)', desc: 'ネオンスキンや上位称号を一気に獲得可能' },
            'ultimate': { id: 'ultimate', name: 'アルティメットパック', yen: 5000, coins: 50000, bonus: '10.00 C/円 (最高効率)', desc: '最上位サイバーや最高峰称号テラ・コンクエスターを即座に獲得' }
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
            this.addCoins(amount || 500, '外部動画広告リワード');
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

    loadUnlockedMapThemes() {
        let owned = ['mono', 'none'];
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY_MAP_THEMES);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) owned = parsed.filter(id => typeof id === 'string');
            }
        } catch (e) { /* 既定値を使う */ }
        ['mono', 'none'].forEach(id => { if (!owned.includes(id)) owned.push(id); });
        localStorage.setItem(this.STORAGE_KEY_MAP_THEMES, JSON.stringify(owned));
        return owned;
    }

    /**
     * 既存ユーザーの現在の背景地図は無償で引き継ぐ（初期選択が未所持にならないように）。
     */
    ensureMapThemeState() {
        const saved = localStorage.getItem('tw_map_theme');
        if (saved && this.MAP_THEMES[saved] && !this.unlockedMapThemes.includes(saved)) {
            this.unlockedMapThemes.push(saved);
            localStorage.setItem(this.STORAGE_KEY_MAP_THEMES, JSON.stringify(this.unlockedMapThemes));
        }
        if (!saved) {
            localStorage.setItem('tw_map_theme', 'mono');
        }
    }

    isMapThemeUnlocked(themeId) {
        return this.unlockedMapThemes.includes(themeId);
    }

    /** 背景地図テーマの購入→即適用（未所持時は確認ダイアログ） */
    selectMapTheme(themeId) {
        const theme = this.MAP_THEMES[themeId];
        if (!theme) return false;

        if (!this.isMapThemeUnlocked(themeId)) {
            const affordable = this.coins >= theme.cost;
            const message = affordable
                ? `【ショップ】\n背景地図「${theme.name}」を ${theme.cost.toLocaleString()} コインで解放しますか？`
                : `【コイン不足】\nあと ${Math.max(0, theme.cost - this.coins).toLocaleString()} コイン足りません。\n\nショップを開いてコイン購入や動画視聴で獲得しますか？`;
            if (!confirm(message)) return false;
            if (!affordable) {
                this.openShopModal('packs');
                return false;
            }
            this.unlockMapTheme(themeId);
        }

        if (this.app && this.app.setMapTheme) this.app.setMapTheme(themeId, true);
        this.renderMapThemesPanel();
        return true;
    }

    unlockMapTheme(themeId) {
        const theme = this.MAP_THEMES[themeId];
        if (!theme) return false;
        if (this.isMapThemeUnlocked(themeId)) return true;
        if (!this.spendCoins(theme.cost, `背景地図 [${theme.name}]`)) return false;
        this.unlockedMapThemes.push(themeId);
        localStorage.setItem(this.STORAGE_KEY_MAP_THEMES, JSON.stringify(this.unlockedMapThemes));
        if (this.app && this.app.showToast) this.app.showToast(`背景地図を解放: ${theme.name}`);
        this.renderMapThemesPanel();
        return true;
    }

    /**
     * 背景地図カラーの一覧描画。
     * 並び順：モノクロ → 地図非表示 → 価格の安い順（未所持は価格ボタン）。
     * 状態色：選択中（エメラルド） / 所持済み（ジンク） / 未購入（暗く＋価格）。
     */
    renderMapThemesPanel() {
        const container = document.getElementById('map-theme-buttons-container');
        if (!container) return;

        const current = localStorage.getItem('tw_map_theme') || 'mono';
        const themes = Object.values(this.MAP_THEMES).sort((a, b) => {
            const rank = t => (t.cost === 0 ? 0 : 1);
            if (rank(a) !== rank(b)) return rank(a) - rank(b);
            if (a.cost !== b.cost) return a.cost - b.cost;
            return a.order - b.order;
        });

        container.innerHTML = themes.map(theme => {
            const owned = this.isMapThemeUnlocked(theme.id);
            const selected = current === theme.id;

            const stateClass = selected
                ? 'border-emerald-400 bg-emerald-500/10 ring-1 ring-emerald-400/60'
                : owned ? 'border-zinc-600 bg-zinc-900' : 'border-zinc-800 bg-zinc-950';
            const badge = selected
                ? '<span class="px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[8px] font-bold">選択中</span>'
                : owned
                    ? '<span class="px-1 py-0.5 rounded bg-zinc-700/60 text-zinc-300 text-[8px] font-bold">所持</span>'
                    : `<span class="px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[8px] font-bold">${theme.cost.toLocaleString()} C</span>`;
            const swatchStyle = theme.id === 'none'
                ? 'background: repeating-linear-gradient(45deg, #18181b, #18181b 3px, #3f3f46 3px, #3f3f46 6px)'
                : `background: ${theme.swatch}`;
            const nameClass = owned ? 'text-zinc-100' : 'text-zinc-400';

            return `
                <button class="map-theme-btn w-full ${theme.id === 'none' ? 'col-span-2' : ''} border p-2 rounded-lg text-[11px] transition-all active:scale-95 flex items-center justify-between gap-1.5 ${stateClass}" data-map-theme="${theme.id}">
                    <span class="flex items-center gap-1.5 min-w-0">
                        <span class="w-3.5 h-3.5 rounded shrink-0 border border-zinc-600" style="${swatchStyle}"></span>
                        <span class="truncate font-bold ${nameClass}">${theme.name}</span>
                    </span>
                    ${badge}
                </button>
            `;
        }).join('');

        container.querySelectorAll('.map-theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.mapTheme;
                this.selectMapTheme(id);
            });
        });
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
                const shortfall = Math.max(0, n - this.coins);
                this.app.showToast(`あと ${shortfall.toLocaleString()} コイン足りません`, 'コイン購入や動画視聴で獲得できます');
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
            const ok = confirm(`【ショップ】\n「${skin.name}」を ${skin.cost.toLocaleString()} コインで解放しますか？`);
            if (ok) {
                this.unlockSkin(skinId);
            }
        } else {
            const shortfall = Math.max(0, skin.cost - this.coins);
            const ok = confirm(`【コイン不足】\nあと ${shortfall.toLocaleString()} コイン足りません。\n\nショップを開いてコイン購入や動画視聴で獲得しますか？`);
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

    getAdFreeSource() {
        return localStorage.getItem('tw_ad_free_source') || '';
    }

    /**
     * 500円以上のコインパックは広告完全非表示（Ad-Free）を付帯する
     */
    packIncludesAdFree(pack) {
        return !!pack && Number(pack.yen) >= 500;
    }

    unlockAdFreeFromPack(pack) {
        if (!this.packIncludesAdFree(pack)) return false;
        const wasAdFree = this.isAdFree();
        this.setAdFree(true, `pack:${pack.id}`);
        if (!wasAdFree && this.app && this.app.showToast) {
            this.app.showToast('広告非表示を解放しました', `${pack.name}の購入特典としてバナー広告と動画待ちを解除`);
        }
        return !wasAdFree;
    }

    setAdFree(enabled = true, source = '') {
        localStorage.setItem('tw_is_ad_free', enabled ? 'true' : 'false');
        if (enabled) {
            localStorage.setItem('tw_ad_free_source', source || this.getAdFreeSource() || 'manual');
        } else {
            localStorage.removeItem('tw_ad_free_source');
        }
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

        this.setAdFree(true, 'ad-free-pass');
        if (this.app && this.app.showToast) {
            this.app.showToast('【購入完了】広告完全非表示パス', '下部バナー広告を消去し動画スキップを適用しました');
        }
        this.renderShopPanels();
    }

    resetPurchasedItems() {
        // 1. スキン初期化
        this.unlockedSkins = ['default'];
        localStorage.setItem(this.STORAGE_KEY_UNLOCKED_SKINS, JSON.stringify(['default']));
        document.body.dataset.skin = 'default';
        localStorage.setItem('territory_skin', 'default');
        if (this.app.updateSkinBadge) this.app.updateSkinBadge('default');
        if (this.app.updateCycleSkinButtonUI) this.app.updateCycleSkinButtonUI();
        if (this.app.gridManager) this.app.gridManager.redrawTiles();

        // 2. パーク・特別機能初期化
        this.unlockedPerks = [];
        localStorage.setItem(this.STORAGE_KEY_UNLOCKED_PERKS, JSON.stringify([]));
        localStorage.removeItem(this.STORAGE_KEY_POSTER_TICKETS);
        document.body.removeAttribute('data-pin-effect');
        localStorage.removeItem('tw_pin_effect');

        // 3. 広告非表示パス (Ad-Free) 解除
        this.setAdFree(false);

        // 3.5 背景地図カラーの購入状態を初期化（モノクロ・地図非表示のみ所持）
        this.unlockedMapThemes = ['mono', 'none'];
        localStorage.setItem(this.STORAGE_KEY_MAP_THEMES, JSON.stringify(this.unlockedMapThemes));
        localStorage.setItem('tw_map_theme', 'mono');
        if (this.app && this.app.setMapTheme) this.app.setMapTheme('mono', false);
        this.renderMapThemesPanel();

        // 4. Proアンロック情報初期化
        localStorage.removeItem('tw_pro_unlocked');
        if (this.app.proManager) {
            this.app.proManager.isPro = false;
        }

        // 5. 称号初期化
        if (this.app.statsManager) {
            this.app.statsManager.unlockedTitles = ['初陣'];
            this.app.statsManager.activeTitle = '';
            localStorage.setItem('tw_unlocked_titles', JSON.stringify(['初陣']));
            localStorage.setItem('tw_active_title', '');
        }

        // 6. ショップ画面再描画
        this.renderShopPanels();

        if (this.app && this.app.showToast) {
            this.app.showToast('購入アイテムリセット完了', 'テーマ・機能・広告パスを初期化しました');
        }
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
        // 10-29: Step 2 (Boost) +10C
        // 30-49: Step 3 (Master) +20C
        // 50+: Step 4 (Legend) +30C
        let tier = 1;
        let bonusCoins = 0;
        let tierName = '通常ステップ';
        let nextTarget = 10;

        if (todayCount >= 50) {
            tier = 4;
            bonusCoins = 30;
            tierName = '歩行レジェンド (+30C)';
            nextTarget = null;
        } else if (todayCount >= 30) {
            tier = 3;
            bonusCoins = 20;
            tierName = '散歩マスター (+20C)';
            nextTarget = 50;
        } else if (todayCount >= 10) {
            tier = 2;
            bonusCoins = 10;
            tierName = '歩行ブースト (+10C)';
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
        const stepBonus = stepInfo.bonusCoins; // +0, +10, +20, +30

        let base = isReclaimed ? 20 : 10;
        let isComeback = false;

        // Comeback Bonus: Tile reclaiming when user is underdog (<= 40% territory)
        if (isReclaimed && this.app && this.app.isUnderdogTeam && this.app.isUnderdogTeam()) {
            base = 40; // 2x double coin bonus (40 COIN)
            isComeback = true;
        }

        const totalEarned = base + stepBonus;
        this.coins += totalEarned;
        localStorage.setItem(this.STORAGE_KEY_COINS, this.coins.toString());
        this.updateCoinUI();
        this.syncCoinsToSupabase();

        if (this.app && this.app.showToast) {
            if (isComeback) {
                const sub = stepBonus > 0 ? `劣勢2倍 (+40C) ＋ 歩行ブースト (+${stepBonus}C)` : '獲得コイン2倍 (+40 COIN)';
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

        // スタンダードパック（500円）以上は広告完全非表示を自動解放
        this.unlockAdFreeFromPack(pack);

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
            this.addCoins(300, 'Xシェアボーナス');
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
                title: 'TERRITORY WALK - 白黒歩行陣取り',
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
                    this.addCoins(500, '動画リワード (Ad-Free スキップ)');
                    this.updateCoinUI();
                    if (this.app && this.app.showToast) {
                        this.app.showToast('【Ad-Free特典】動画スキップ！', '+500 COIN を即時獲得しました');
                    }
                    return;
                }
                if (this.app && this.app.adMobManager && this.app.adMobManager.isNative) {
                    this.app.adMobManager.showRewardVideo(() => {
                        this.addCoins(500, 'AdMob動画リワード');
                        this.updateCoinUI();
                        if (this.app && this.app.showToast) {
                            this.app.showToast('動画リワード獲得！', '+500 COIN を獲得しました');
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
                    btn.className = 'shop-tab-btn active py-2 px-0.5 rounded-lg border-b-2 border-amber-500 font-bold text-center text-amber-400 bg-zinc-900/60 text-xs transition-all truncate';
                } else {
                    btn.className = 'shop-tab-btn py-2 px-0.5 rounded-lg border-b-2 border-transparent font-medium text-center text-zinc-400 hover:text-white text-xs transition-all truncate';
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
        this.updateSkinButtonsUI();
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
                    <span>Xで戦績をシェアして +300 COIN 獲得</span>
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
        const adFreeSource = this.getAdFreeSource();
        const isPackAdFree = isAdFree && adFreeSource.indexOf('pack') === 0;
        const adFreeBadge = isAdFree ? (isPackAdFree ? 'パック特典で有効' : '有効化済み') : '買い切りパス';
        const adFreeCard = `
            <div class="bg-gradient-to-br from-zinc-950 to-zinc-900 border ${isAdFree ? 'border-emerald-500/80' : 'border-amber-500/80 ring-1 ring-amber-500/50'} p-3 rounded-xl flex items-center justify-between gap-2">
                <div>
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-bold text-xs text-white">広告完全非表示パス (Ad-Free Pro)</span>
                        <span class="px-1.5 py-0.5 rounded ${isAdFree ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'} text-[9px] font-mono font-bold">${adFreeBadge}</span>
                    </div>
                    <div class="text-[10px] text-zinc-400 leading-tight mt-0.5 break-keep">画面下部バナー広告を完全消去 ＆ 動画リワード待ち時間なし即時受取</div>
                    <div class="text-[9px] text-emerald-400/80 leading-tight mt-0.5">スタンダードパック（¥500）以上の購入でも自動付帯</div>
                    <div class="text-amber-400 font-mono text-xs font-bold mt-1">永久Ad-Free特典</div>
                </div>
                <div class="shrink-0">
                    ${isAdFree ? `
                        <button disabled class="px-3 py-1.5 rounded bg-zinc-800 text-zinc-500 text-xs font-bold font-mono cursor-not-allowed">
                            適用中
                        </button>
                    ` : `
                        <button id="btn-buy-ad-free" class="px-3 py-1.5 rounded bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-black text-xs font-bold font-mono transition-all active:scale-95 shadow">
                            ${(this.app && this.app.iapManager && this.app.iapManager.getDisplayPrice('ad-free')) || '¥480'}
                        </button>
                    `}
                </div>
            </div>
        `;

        const packsCards = Object.values(this.PACKS).map(pack => {
            const includesAdFree = this.packIncludesAdFree(pack);
            return `
                <div class="bg-zinc-950/80 border ${pack.id === 'premium' ? 'border-amber-500/80 ring-1 ring-amber-500/50' : 'border-zinc-800'} p-3 rounded-xl flex items-center justify-between gap-2">
                    <div>
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="font-bold text-xs text-white">${pack.name}</span>
                            ${pack.bonus ? `<span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[9px] font-mono font-bold">${pack.bonus}</span>` : ''}
                            ${includesAdFree ? '<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-mono font-bold">＋広告非表示</span>' : ''}
                        </div>
                        <div class="text-[10px] text-zinc-400 leading-tight mt-0.5">${pack.desc}</div>
                        ${includesAdFree ? '<div class="text-[9px] text-emerald-400/80 leading-tight mt-0.5">Ad-Freeパス（単体¥480）と動画スキップ込み</div>' : ''}
                        <div class="text-amber-400 font-mono text-xs font-bold mt-1">+${pack.coins.toLocaleString()} COIN</div>
                    </div>
                    <div class="shrink-0">
                        <button class="btn-buy-pack px-3 py-1.5 rounded bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-black text-xs font-bold font-mono transition-all active:scale-95 shadow" data-pack="${pack.id}">
                            ${(this.app && this.app.iapManager && this.app.iapManager.getDisplayPriceForYen(pack.yen)) || ('¥' + pack.yen.toLocaleString())}
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

    /**
     * MENUのマステーマ早見ボタンに状態（選択中／所持／未購入）を反映する
     */
    updateSkinButtonsUI() {
        const current = document.body.dataset.skin || 'default';
        document.querySelectorAll('.skin-btn').forEach(btn => {
            const skin = this.SKINS[btn.dataset.skin];
            if (!skin) return;
            const owned = this.isSkinUnlocked(skin.id);
            const selected = current === skin.id;
            const base = 'skin-btn border p-2 rounded-lg text-[11px] transition-all active:scale-95 text-center truncate ';
            const state = selected
                ? 'border-emerald-400 bg-emerald-500/10 text-white font-bold'
                : owned ? 'border-zinc-600 bg-zinc-900 text-zinc-200'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-500';
            btn.className = base + state;
            btn.textContent = (!owned && !selected)
                ? `${skin.name}・${skin.cost.toLocaleString()}C`
                : skin.name;
        });
    }

    renderSkinsPanel() {
        const container = document.getElementById('container-shop-skins');
        if (!container) return;

        const currentSkin = document.body.dataset.skin || 'default';
        // 並び順：標準（0C）を先頭に、以降は価格の安い順
        const skins = Object.values(this.SKINS).sort((a, b) => {
            if (a.cost !== b.cost) return a.cost - b.cost;
            return (a.id === 'default' ? -1 : 1);
        });

        container.innerHTML = skins.map(skin => {
            const isUnlocked = this.isSkinUnlocked(skin.id);
            const isEquipped = currentSkin === skin.id;
            const swatch = this.SKIN_SWATCHES[skin.id] || { own: '#ffffff', enemy: '#09090b' };

            // 状態3色：選択中／所持済み／未購入
            const stateClass = isEquipped
                ? 'border-emerald-400 bg-emerald-500/10 ring-1 ring-emerald-400/60'
                : isUnlocked ? 'border-zinc-600 bg-zinc-900' : 'border-zinc-800 bg-zinc-950';
            const badge = isEquipped
                ? '<span class="px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[8px] font-bold">選択中</span>'
                : isUnlocked
                    ? '<span class="px-1 py-0.5 rounded bg-zinc-700/60 text-zinc-300 text-[8px] font-bold">所持</span>'
                    : '';

            // マスの色イメージ（自陣／相手陣のカラーチップ）
            const chips = `
                <span class="flex items-center gap-1 shrink-0">
                    <span class="w-3.5 h-3.5 rounded-sm border border-zinc-600" style="background:${swatch.own}" title="自陣マス"></span>
                    <span class="w-3.5 h-3.5 rounded-sm border border-zinc-600" style="background:${swatch.enemy}" title="相手陣マス"></span>
                </span>
            `;

            let actionButton = '';
            if (isEquipped) {
                actionButton = `<span class="px-2.5 py-1 rounded bg-zinc-800 text-emerald-300 text-[10px] font-bold font-mono">適用中</span>`;
            } else if (isUnlocked) {
                actionButton = `<button class="btn-equip-skin px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] font-bold font-mono transition-all active:scale-95" data-skin="${skin.id}">適用する</button>`;
            } else {
                const canAfford = this.coins >= skin.cost;
                const btnStyle = canAfford
                    ? 'bg-amber-600 hover:bg-amber-500 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700';
                const priceLabel = `${skin.cost.toLocaleString()} COIN`;
                actionButton = `<button class="btn-buy-skin px-2 py-1 rounded ${btnStyle} ${priceLabel.length > 11 ? 'text-[9px]' : 'text-[10px]'} font-bold font-mono transition-all active:scale-95 whitespace-nowrap tabular-nums" data-skin="${skin.id}">${priceLabel}</button>`;
            }

            return `
                <div class="border ${stateClass} p-2.5 rounded-xl flex items-center justify-between gap-2">
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1.5 min-w-0">
                            ${chips}
                            <span class="font-bold text-xs ${skin.class} truncate">${skin.name}</span>
                            ${badge}
                        </div>
                        <div class="text-[10px] text-zinc-400 leading-tight mt-0.5 line-clamp-2">${skin.desc}</div>
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
                this.updateSkinButtonsUI();
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
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700';
                const priceLabel = `${title.cost.toLocaleString()} COIN`;
                const longPrice = priceLabel.length > 11;
                actionButton = `<button class="btn-buy-title px-2 py-1 rounded ${btnStyle} ${longPrice ? 'text-[9px]' : 'text-[10px]'} font-bold font-mono transition-all active:scale-95 whitespace-nowrap tabular-nums" data-title="${title.name}">${priceLabel}</button>`;
            }

            return `
                <div class="bg-zinc-950/80 border border-zinc-800 p-2.5 rounded-xl flex items-center justify-between gap-2">
                    <div class="min-w-0 flex-1">
                        <div class="font-bold text-xs text-amber-300 font-mono truncate">[${title.name}]</div>
                        <div class="text-[10px] text-zinc-400 leading-tight mt-0.5 line-clamp-2">${title.desc}</div>
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
                this.addCoins(500, '動画広告リワード');
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
