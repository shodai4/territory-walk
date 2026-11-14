/**
 * TERRITORY WALK - iap.js
 * In-App Purchase (StoreKit) integration for iOS via cordova-plugin-purchase
 * (CdvPurchase v13+) running on Capacitor, with a Web simulator fallback.
 *
 * Purchase flow (native):
 *   order -> approved -> verify (App Store receipt validation)
 *           -> verified -> grant content (idempotent per transaction)
 *           -> finish -> finished
 *
 * Safety rules:
 * - On native platforms, content is granted ONLY from a verified receipt.
 *   There is no fallback that grants coins without a completed StoreKit
 *   transaction. If the purchase plugin is missing or the store is not
 *   ready, the purchase is aborted with an error message.
 * - Each transaction is granted at most once: processed transaction IDs
 *   are persisted in localStorage, so an app restart between "grant" and
 *   "finish" cannot double-credit consumable coin packs.
 * - Consumable coin packs cannot be re-delivered on restore (Apple policy).
 *   The Ad-Free entitlement they carry is therefore state-based: it is
 *   persisted locally (tw_is_ad_free / tw_ad_free_source) and, on restore,
 *   re-derived from the App Store receipt history, which still lists the
 *   consumed 500 / 1,500 / 5,000 yen pack transactions.
 * - Standard pack (500 yen) and above automatically unlock the same
 *   Ad-Free entitlement as the 480 yen standalone pass.
 *
 * Receipt validation:
 * - By default the plugin validates the App Store receipt locally.
 * - For server-side validation, set window.TW_IAP_VALIDATOR_URL (or the
 *   localStorage key "tw_iap_validator_url") to an endpoint that accepts
 *   the plugin's receipt JSON via POST and answers { "ok": true }.
 *   It is then assigned to store.validator before initialization.
 *   A Supabase Edge Function is a good fit for this endpoint.
 */

class IAPManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.isNative = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();

        // Canonical product catalog. The `id` values are the App Store
        // Connect product IDs and must be registered there exactly as
        // written here (see README "App Store Connect で必要な登録").
        // type: 'consumable' (coin packs) / 'non-consumable' (ad-free).
        this.products = {
            'pack-120': {
                id: 'com.shodai.territorywalk.coins1000',
                type: 'consumable',
                coins: 1000,
                yen: 120,
                fallbackPrice: '¥120',
                title: 'ビギナーパック'
            },
            'pack-500': {
                id: 'com.shodai.territorywalk.coins4500',
                type: 'consumable',
                coins: 4500,
                yen: 500,
                fallbackPrice: '¥500',
                title: 'スタンダードパック'
            },
            'pack-1500': {
                id: 'com.shodai.territorywalk.coins14000',
                type: 'consumable',
                coins: 14000,
                yen: 1500,
                fallbackPrice: '¥1,500',
                title: 'プレミアムパック'
            },
            'pack-5000': {
                id: 'com.shodai.territorywalk.coins50000',
                type: 'consumable',
                coins: 50000,
                yen: 5000,
                fallbackPrice: '¥5,000',
                title: 'アルティメットパック'
            },
            'ad-free': {
                id: 'com.shodai.territorywalk.adfree',
                type: 'non-consumable',
                coins: 0,
                yen: 480,
                fallbackPrice: '¥480',
                title: '広告完全非表示パス (Ad-Free Pro)'
            }
        };

        // スタンダードパック（500円）以上の購入特典として広告完全非表示を自動解放
        this.AD_FREE_MIN_YEN = 500;

        this.PROCESSED_KEY = 'tw_iap_processed_tx_v1';
        this.store = null;          // CdvPurchase.store (native only)
        this.storeReady = false;    // store.initialize() completed
        this.initStarted = false;
        this.pendingProductId = null; // product id with an order in flight
        this.priceByProductId = {};   // product id -> localized price string

        this.init();
    }

    // ---------------------------------------------------------------
    // Initialization
    // ---------------------------------------------------------------

    init() {
        console.log(`[IAP] IAPManager initialized. Mode: ${this.isNative ? 'Native StoreKit' : 'Web Simulator'}`);

        // The restore button is rendered dynamically by the shop, so this
        // direct binding may not find it; coins.js also wires the button
        // to restorePurchases(). Keep the guarded binding for safety.
        const btnRestore = document.getElementById('btn-restore-purchases');
        if (btnRestore) {
            btnRestore.addEventListener('click', (e) => {
                e.preventDefault();
                this.restorePurchases();
            });
        }

        if (!this.isNative) return;

        // CdvPurchase is injected by the native plugin at startup. It may
        // not exist yet when this script runs, so wait for deviceready
        // and also poll briefly as a fallback.
        const tryInit = () => this.initStore();
        document.addEventListener('deviceready', tryInit, { once: true });

        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (this.initStarted || attempts > 40) {
                clearInterval(timer);
                return;
            }
            if (typeof window.CdvPurchase !== 'undefined') {
                clearInterval(timer);
                tryInit();
            }
        }, 250);
    }

    initStore() {
        if (this.initStarted) return;
        if (typeof window.CdvPurchase === 'undefined' || !window.CdvPurchase.store) {
            // Not ready yet; the poller / deviceready listener will retry.
            return;
        }
        this.initStarted = true;

        const CdvPurchase = window.CdvPurchase;
        const store = CdvPurchase.store;
        this.store = store;

        try {
            store.verbosity = CdvPurchase.LogLevel.WARNING;

            // Optional server-side receipt validation endpoint.
            const validatorUrl = window.TW_IAP_VALIDATOR_URL
                || localStorage.getItem('tw_iap_validator_url')
                || null;
            if (validatorUrl) {
                store.validator = validatorUrl;
                console.log('[IAP] Server-side receipt validation enabled.');
            }

            store.register(Object.values(this.products).map(item => ({
                id: item.id,
                type: item.type === 'consumable'
                    ? CdvPurchase.ProductType.CONSUMABLE
                    : CdvPurchase.ProductType.NON_CONSUMABLE,
                platform: CdvPurchase.Platform.APPLE_APPSTORE
            })));

            store.when()
                .productUpdated(product => this.onProductUpdated(product))
                .approved(transaction => {
                    console.log('[IAP] Transaction approved, verifying receipt...');
                    transaction.verify();
                })
                .verified(receipt => {
                    try {
                        this.handleVerifiedReceipt(receipt);
                    } catch (err) {
                        console.error('[IAP] Failed to grant verified purchase:', err);
                    }
                    receipt.finish();
                })
                .finished(() => {
                    this.pendingProductId = null;
                    this.refreshShopUI();
                });

            store.error(err => this.onStoreError(err));

            store.ready(() => {
                this.storeReady = true;
                console.log('[IAP] Store is ready.');
                // Re-apply the non-consumable entitlement if already owned.
                this.syncEntitlements();
                this.refreshShopUI();
            });

            store.initialize([{
                platform: CdvPurchase.Platform.APPLE_APPSTORE,
                options: { needAppReceipt: true }
            }]);
        } catch (err) {
            this.initStarted = false;
            console.error('[IAP] Store initialization failed:', err);
        }
    }

    onProductUpdated(product) {
        if (!product || !product.id) return;
        const price = this.extractLocalizedPrice(product);
        if (price) {
            this.priceByProductId[product.id] = price;
            this.refreshShopUI();
        }
        // Ownership of the ad-free pass can also arrive as a product update.
        if (product.id === this.products['ad-free'].id && product.owned) {
            this.applyAdFree();
        }
    }

    extractLocalizedPrice(product) {
        try {
            const offer = typeof product.getOffer === 'function' ? product.getOffer() : null;
            const phases = offer && offer.pricingPhases;
            if (phases && phases.length > 0 && phases[0].price) return phases[0].price;
            if (product.price) return product.price;
        } catch (e) { /* fall through */ }
        return null;
    }

    onStoreError(err) {
        if (!err) return;
        const CdvPurchase = window.CdvPurchase;
        if (CdvPurchase && err.code === CdvPurchase.ErrorCode.PAYMENT_CANCELLED) {
            console.log('[IAP] Purchase cancelled by user.');
            this.pendingProductId = null;
            return;
        }
        console.error('[IAP] Store error:', err.code, err.message);
        this.pendingProductId = null;
        this.toast('ストアでエラーが発生しました', '時間をおいてもう一度お試しください');
    }

    // ---------------------------------------------------------------
    // Prices (used by the shop UI; falls back to the catalog price)
    // ---------------------------------------------------------------

    getDisplayPrice(packKey) {
        const item = this.products[packKey];
        if (!item) return null;
        return this.priceByProductId[item.id] || item.fallbackPrice;
    }

    getDisplayPriceForYen(yen) {
        const item = Object.values(this.products).find(p => p.yen === yen);
        if (!item) return null;
        return this.priceByProductId[item.id] || item.fallbackPrice;
    }

    // ---------------------------------------------------------------
    // Purchasing
    // ---------------------------------------------------------------

    async purchasePack(packKey) {
        const item = this.products[packKey];
        if (!item) {
            // Backward compatibility: earlier shop code used pack-300 /
            // pack-600 / pack-1200 keys for the 500 / 1500 / 5000 packs.
            const legacy = { 'pack-300': 'pack-500', 'pack-600': 'pack-1500', 'pack-1200': 'pack-5000' };
            if (legacy[packKey]) return this.purchasePack(legacy[packKey]);
            console.error('[IAP] Unknown pack key:', packKey);
            return;
        }

        if (!this.isNative) {
            // Web simulator (GitHub Pages build). Never used on native.
            console.log(`[IAP] Web Simulator purchase complete: ${item.title} (+${item.coins} COIN)`);
            this.grantItem(item, 1);
            return;
        }

        if (this.pendingProductId) {
            this.toast('購入処理中です', '前の購入が完了するまでお待ちください');
            return;
        }

        this.initStore();
        if (!this.store) {
            // Plugin missing (e.g. `npx cap sync` was not run). Granting
            // anything here would hand out paid content for free, so stop.
            console.error('[IAP] Purchase plugin (CdvPurchase) is not available.');
            this.toast('購入機能を読み込めませんでした', 'アプリを再起動しても直らない場合はサポートへご連絡ください');
            return;
        }

        const CdvPurchase = window.CdvPurchase;
        let product = null;
        try {
            product = this.store.get(item.id, CdvPurchase.Platform.APPLE_APPSTORE)
                || this.store.get(item.id);
        } catch (e) { /* handled below */ }

        if (!product) {
            this.toast('商品情報を読み込み中です', '通信状態のよい場所でもう一度お試しください');
            // Trigger a refresh so a retry can succeed.
            if (typeof this.store.update === 'function') this.store.update();
            return;
        }

        if (item.type === 'non-consumable' && product.owned) {
            this.applyAdFree();
            this.toast('購入済みです', '広告完全非表示パスはすでに有効です');
            return;
        }

        const offer = typeof product.getOffer === 'function' ? product.getOffer() : null;
        if (!offer) {
            this.toast('商品情報を読み込めませんでした', '時間をおいてもう一度お試しください');
            return;
        }

        this.pendingProductId = item.id;
        try {
            await this.store.order(offer);
        } catch (err) {
            this.pendingProductId = null;
            if (CdvPurchase && err && err.code === CdvPurchase.ErrorCode.PAYMENT_CANCELLED) {
                console.log('[IAP] Order cancelled by user.');
                return;
            }
            console.error('[IAP] Order failed:', err);
            this.toast('購入処理に失敗しました', 'App Store の設定をご確認ください');
        }
        // Completion is handled by the approved -> verified -> finished
        // event chain registered in initStore().
    }

    // ---------------------------------------------------------------
    // Verified receipt handling (the only place content is granted)
    // ---------------------------------------------------------------

    handleVerifiedReceipt(receipt) {
        const purchases = (receipt && receipt.collection) || [];
        if (purchases.length === 0) {
            // Some verified events carry no collection (e.g. app receipt
            // refresh). Fall back to an entitlement sync only.
            this.syncEntitlements();
            return;
        }

        for (const purchase of purchases) {
            const productId = purchase.id || purchase.productId;
            const item = Object.values(this.products).find(p => p.id === productId);
            if (!item) continue;

            if (item.type === 'non-consumable') {
                // Entitlements are state-based; applying them is idempotent.
                this.applyAdFree();
                continue;
            }

            // Consumables: grant once per transaction.
            const txKey = this.transactionKey(purchase, receipt);
            if (txKey && this.isProcessed(txKey)) {
                console.log('[IAP] Transaction already granted, skipping:', txKey);
                continue;
            }
            const quantity = parseInt(purchase.quantity, 10) || 1;
            // Mark BEFORE granting/finishing so a crash cannot re-grant.
            if (txKey) this.markProcessed(txKey);
            this.grantItem(item, quantity);
        }
    }

    transactionKey(purchase, receipt) {
        const txId = purchase.transactionId
            || (purchase.id && (purchase.purchaseTime || purchase.expiryDate))
            || (receipt && receipt.transactionId)
            || null;
        if (!txId) return null;
        const productId = purchase.id || purchase.productId || 'unknown';
        return `${productId}:${txId}`;
    }

    loadProcessed() {
        try {
            const raw = localStorage.getItem(this.PROCESSED_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    isProcessed(txKey) {
        return this.loadProcessed().includes(txKey);
    }

    markProcessed(txKey) {
        const arr = this.loadProcessed();
        if (!arr.includes(txKey)) {
            arr.push(txKey);
            // Keep the registry bounded; receipts older than this are
            // finished transactions that will not be delivered again.
            while (arr.length > 500) arr.shift();
            try {
                localStorage.setItem(this.PROCESSED_KEY, JSON.stringify(arr));
            } catch (e) { /* storage full etc. - granting continues */ }
        }
    }

    grantItem(item, quantity = 1) {
        if (!this.app || !this.app.coinManager) return;

        if (item.type === 'non-consumable') {
            this.applyAdFree();
            this.toast('購入完了！広告完全非表示パス', '下部バナー広告を消去し動画スキップを適用しました');
            return;
        }

        const packKey = Object.keys(this.products).find(k => this.products[k] === item);
        const total = item.coins * quantity;
        const unlocksAdFree = this.packUnlocksAdFree(item);
        this.app.coinManager.addCoins(total, `IAP購入: ${item.title}`);
        if (unlocksAdFree) this.applyAdFree(`pack:${packKey}`);
        this.toast(
            `購入完了！ +${total.toLocaleString()} COIN`,
            unlocksAdFree
                ? `${item.title} を獲得。広告完全非表示（Ad-Free）も解放しました`
                : `${item.title} (${this.getDisplayPrice(packKey) || item.fallbackPrice}) を獲得しました`
        );
        this.refreshShopUI();
    }

    /**
     * 500円以上のコインパックは広告完全非表示（Ad-Free）を付帯する。
     */
    packUnlocksAdFree(item) {
        return !!item && item.type === 'consumable' && Number(item.yen) >= this.AD_FREE_MIN_YEN;
    }

    applyAdFree(source = 'ad-free-pass') {
        if (this.app && this.app.coinManager) {
            this.app.coinManager.setAdFree(true, source);
        } else {
            localStorage.setItem('tw_is_ad_free', 'true');
            localStorage.setItem('tw_ad_free_source', source);
        }
    }

    /**
     * 購入履歴（App Storeレシート／検証済みレシート）から、500円以上の
     * コインパック購入歴を探す。消耗型パックは再配布できないが、付帯した
     * Ad-Free 特典は購入履歴がある限り再適用できる。
     */
    findAdFreePackInPurchaseHistory() {
        if (!this.store) return null;
        const qualifying = Object.keys(this.products)
            .filter(k => this.packUnlocksAdFree(this.products[k]))
            .map(k => this.products[k].id);
        if (qualifying.length === 0) return null;

        const found = new Set();
        const collect = (id) => {
            if (id && qualifying.indexOf(id) >= 0) found.add(id);
        };
        const collectTransaction = (tx) => {
            if (!tx || tx.isPending) return;
            const items = tx.products || tx.items || [];
            if (Array.isArray(items)) {
                for (const it of items) collect(it && (it.id || it.productId));
            }
            collect(tx.productId);
            collect(tx.product_id);
        };

        try {
            const txs = Array.isArray(this.store.localTransactions) ? this.store.localTransactions : [];
            txs.forEach(collectTransaction);
        } catch (e) { /* accessor unavailable */ }

        try {
            const receipts = Array.isArray(this.store.localReceipts) ? this.store.localReceipts : [];
            for (const receipt of receipts) {
                const collection = (receipt && receipt.collection) || [];
                if (Array.isArray(collection)) collection.forEach(collectTransaction);
            }
        } catch (e) { /* accessor unavailable */ }

        try {
            const verified = this.store.verifiedPurchases;
            if (Array.isArray(verified)) {
                for (const vp of verified) {
                    if (!vp) continue;
                    collect(vp.id || vp.productId);
                }
            }
        } catch (e) { /* accessor unavailable */ }

        return found.size > 0 ? Array.from(found) : null;
    }

    // ---------------------------------------------------------------
    // Restore & entitlement sync
    // ---------------------------------------------------------------

    syncEntitlements() {
        // Ad-Free is the only restorable (non-consumable) product.
        if (!this.store) return;
        try {
            const CdvPurchase = window.CdvPurchase;
            const adFree = this.products['ad-free'];
            const product = this.store.get(adFree.id, CdvPurchase.Platform.APPLE_APPSTORE)
                || this.store.get(adFree.id);
            let owned = !!(product && product.owned);
            if (!owned && product && typeof this.store.findInVerifiedReceipts === 'function') {
                owned = !!this.store.findInVerifiedReceipts(product);
            }
            if (owned) this.applyAdFree('ad-free-pass');

            // 500円以上のコインパック購入歴からも Ad-Free を復元する
            const packHistory = this.findAdFreePackInPurchaseHistory();
            if (packHistory) {
                this.applyAdFree('pack-history');
            }
        } catch (e) {
            console.warn('[IAP] Entitlement sync skipped:', e);
        }
    }

    async restorePurchases() {
        if (!this.isNative) {
            // Web build: nothing to restore from a store; just re-apply
            // the locally persisted entitlement state.
            if (localStorage.getItem('tw_is_ad_free') === 'true') {
                this.applyAdFree(localStorage.getItem('tw_ad_free_source') || 'local');
            }
            this.toast('購入の復元が完了しました', '保存されている状態を同期しました');
            return;
        }

        this.toast('購入履歴の確認中...');

        this.initStore();
        if (!this.store) {
            this.toast('購入機能を読み込めませんでした', 'アプリを再起動しても直らない場合はサポートへご連絡ください');
            return;
        }

        try {
            if (typeof this.store.restorePurchases === 'function') {
                await this.store.restorePurchases();
            }
            if (typeof this.store.update === 'function') {
                await this.store.update();
            }
        } catch (err) {
            console.error('[IAP] Restore failed:', err);
            this.toast('購入の復元に失敗しました', '通信状態のよい場所でもう一度お試しください');
            return;
        }

        const wasAdFree = localStorage.getItem('tw_is_ad_free') === 'true';
        this.syncEntitlements();
        const isAdFreeNow = localStorage.getItem('tw_is_ad_free') === 'true';
        const adFreeSource = localStorage.getItem('tw_ad_free_source') || '';

        if (isAdFreeNow) {
            const detail = adFreeSource.indexOf('pack') === 0 || adFreeSource === 'pack-history'
                ? 'パック購入特典の広告完全非表示を再適用しました'
                : '広告完全非表示パスを再適用しました';
            this.toast('購入の復元が完了しました', detail);
        } else if (!wasAdFree) {
            this.toast('復元できる購入がありませんでした', 'コインパックは消耗型のため再付与できません');
        } else {
            this.toast('購入の復元が完了しました', '購入状態を同期しました');
        }
        this.refreshShopUI();
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    refreshShopUI() {
        if (this.app && this.app.coinManager
            && typeof this.app.coinManager.renderPacksPanel === 'function'
            && document.getElementById('container-shop-packs')) {
            this.app.coinManager.renderPacksPanel();
        }
    }

    toast(title, subtitle) {
        if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast(title, subtitle);
        } else {
            console.log('[IAP]', title, subtitle || '');
        }
    }
}
