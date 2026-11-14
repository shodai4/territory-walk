/**
 * TERRITORY WALK - iap.js
 * In-App Purchase (StoreKit) integration for iOS via cordova-plugin-purchase
 * (CdvPurchase v13+) running on Capacitor, with a Web simulator fallback.
 *
 * Purchase flow (native, validation server NOT configured - the default):
 *   order -> approved -> grant (idempotent per transactionId) -> finish -> finished
 *
 * Purchase flow (native, when store.validator is set):
 *   order -> approved -> verify -> verified -> grant -> finish -> finished
 *
 * Why content is granted on `approved` and not on `verified`:
 *   In CdvPurchase v13 the `.verified()` callback only carries the purchases of
 *   `receipt.collection`, and that collection is filled by the receipt
 *   validation *server*. With no `store.validator` configured the plugin still
 *   runs a "backward compatibility" pass (store.js: runOnReceipt) that reports
 *   the receipt as verified with `{ id, latest_receipt: true }` and *no*
 *   `collection`, so every consumable looked like "nothing was purchased":
 *   the old code saw an empty collection, granted nothing, and then finished
 *   the receipt - the transaction was consumed by StoreKit and the coins were
 *   lost for good. Granting from the `approved` Transaction (which always lists
 *   `products`, `quantity` and `transactionId`) removes that dependency.
 *   Unfinished transactions are re-reported as `approved` at every launch, so a
 *   grant that failed once is retried instead of being dropped.
 *
 * Safety rules:
 * - On native platforms, content is granted ONLY from a transaction StoreKit
 *   reported as approved (or from a validated receipt when a validator is
 *   configured). There is no fallback that grants coins without a completed
 *   StoreKit transaction. If the purchase plugin is missing or the store is not
 *   ready, the purchase is aborted with an error message.
 * - Each transaction is granted at most once: processed transaction IDs are
 *   persisted in localStorage, so an app restart between "grant" and "finish"
 *   cannot double-credit consumable coin packs. A *new* purchase always has a
 *   new transactionId, so buying the same pack again still works.
 * - A transaction is only finished after its content was granted (or was
 *   already granted earlier). If granting throws, the transaction stays
 *   unfinished so StoreKit re-delivers it.
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
        this.PENDING_TIMEOUT_MS = 90000; // 承認待ちなどでUIが固まらないための保険
        this.store = null;          // CdvPurchase.store (native only)
        this.storeReady = false;    // store.initialize() completed
        this.initStarted = false;
        this.pendingProductId = null; // product id with an order in flight
        this.pendingWatchdog = null;
        // ストア（StoreKit）が返すローカライズ価格。**表示には使わない**参照用の記録。
        // サンドボックスでは外貨（ドル）表記で返ることがあるため、ユーザー向けの金額は
        // 常にカタログの円価格（formatYen）で固定する。
        this.storePriceByProductId = {};

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
                .approved(transaction => this.onApprovedTransaction(transaction))
                .verified(receipt => this.onVerifiedReceipt(receipt))
                .unverified(failure => this.onUnverifiedReceipt(failure))
                .finished(transaction => this.onTransactionFinished(transaction));

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
        const storePrice = this.extractLocalizedPrice(product);
        if (storePrice) {
            // 参照用に記録するだけ。$ 表記が来ても画面には一切出さない。
            this.storePriceByProductId[product.id] = storePrice;
            if (/[$]/.test(storePrice)) {
                console.log('[IAP] Store returned a non-yen price; the app always shows yen:', storePrice);
            }
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
            this.releasePendingLock();
            return;
        }
        console.error('[IAP] Store error:', err.code, err.message);
        this.releasePendingLock();
        this.toast('ストアでエラーが発生しました', '時間をおいてもう一度お試しください');
    }

    // ---------------------------------------------------------------
    // Prices
    //   表示は常に日本円（¥）固定。ストアが返すローカライズ価格（サンドボックスの
    //   ドル建て表記など）は参照用に記録するだけで表示には使わない。
    // ---------------------------------------------------------------

    /** 円価格の表示文字列（例: 1500 -> "¥1,500"） */
    formatYen(yen) {
        const n = Number(yen);
        if (!Number.isFinite(n) || n <= 0) return '';
        return `¥${Math.round(n).toLocaleString('ja-JP')}`;
    }

    /** パックの表示価格（常に円。ストア価格は使わない） */
    getDisplayPrice(packKey) {
        const item = this.products[packKey];
        if (!item) return null;
        return this.formatYen(item.yen) || item.fallbackPrice || null;
    }

    /** 円額から表示価格を引く（常に円。ストア価格は使わない） */
    getDisplayPriceForYen(yen) {
        const item = Object.values(this.products).find(p => p.yen === yen);
        return this.formatYen(item ? item.yen : yen) || null;
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
        this.armPendingWatchdog();
        try {
            await this.store.order(offer);
        } catch (err) {
            this.releasePendingLock();
            if (CdvPurchase && err && err.code === CdvPurchase.ErrorCode.PAYMENT_CANCELLED) {
                console.log('[IAP] Order cancelled by user.');
                return;
            }
            console.error('[IAP] Order failed:', err);
            this.toast('購入処理に失敗しました', 'App Store の設定をご確認ください');
        }
        // Completion is handled by the approved -> grant -> finish event
        // chain registered in initStore().
    }

    // ---------------------------------------------------------------
    // Approved transaction handling (the place content is granted)
    // ---------------------------------------------------------------

    /**
     * StoreKit が「支払いが承認された」と伝えるイベント。
     * 未完了のトランザクションは起動のたびに再送されるので、
     * ここで付与と finish を完結させるのが本筋。
     */
    onApprovedTransaction(transaction) {
        if (!transaction) return;

        if (transaction.isPending) {
            // Ask to Buy などで保留中。承認されたら再度 approved が来る。
            console.log('[IAP] Transaction is pending approval.');
            this.releasePendingLock();
            this.toast('購入の承認待ちです', '承認されるとコインが付与されます');
            return;
        }

        // 検証サーバーを設定している場合だけ、検証済みレシートからの付与に任せる。
        if (this.store && this.store.validator) {
            console.log('[IAP] Transaction approved, verifying receipt...');
            try {
                const pending = transaction.verify();
                if (pending && typeof pending.catch === 'function') {
                    pending.catch(err => {
                        console.error('[IAP] verify() failed:', err);
                        this.releasePendingLock();
                    });
                }
            } catch (err) {
                console.error('[IAP] verify() failed:', err);
                this.releasePendingLock();
            }
            return;
        }

        // 検証サーバー無し: StoreKit が返したトランザクション自体を正として付与する。
        return this.deliverAndFinish(transaction);
    }

    /**
     * 付与に成功した（または付与済みだった）トランザクションだけ finish する。
     * 付与できなかった場合は finish しないので、次回起動時に再送されて再試行される。
     */
    async deliverAndFinish(transaction) {
        let delivered = false;
        try {
            delivered = this.deliverTransaction(transaction);
        } catch (err) {
            console.error('[IAP] Failed to grant approved transaction:', err);
            delivered = false;
        }

        if (!delivered) {
            console.warn('[IAP] Nothing was delivered; keeping the transaction unfinished so the store re-delivers it.');
            this.releasePendingLock();
            this.toast('購入の反映に失敗しました', '次回起動時にもう一度自動で反映します');
            return;
        }

        try {
            await transaction.finish();
        } catch (err) {
            console.error('[IAP] Failed to finish transaction:', err);
        }
        this.releasePendingLock();
        this.refreshShopUI();
    }

    /**
     * トランザクションに含まれる商品を付与する（同じトランザクションでは1回だけ）。
     * @returns {boolean} すべての商品を「付与済み or 今回付与」にできたら true
     */
    deliverTransaction(transaction) {
        if (!transaction) return false;

        const products = Array.isArray(transaction.products) ? transaction.products : [];
        if (products.length === 0) {
            console.warn('[IAP] Approved transaction has no products.');
            return false;
        }

        const quantity = this.resolveQuantity(transaction);
        let delivered = false;

        for (const purchased of products) {
            const productId = purchased && (purchased.id || purchased.productId);
            if (!productId) continue;

            const item = this.findProductById(productId);
            if (!item) {
                console.warn('[IAP] Unknown product in transaction:', productId);
                continue;
            }

            if (item.type === 'non-consumable') {
                // 権利は状態ベースなので、何度適用しても結果は同じ。
                this.applyAdFree('ad-free-pass');
                delivered = true;
                continue;
            }

            const txKey = this.buildTransactionKey(productId, transaction);
            if (txKey && this.isProcessed(txKey)) {
                console.log('[IAP] Transaction already granted, skipping:', txKey);
                delivered = true; // 付与済みなので finish してよい
                continue;
            }

            // StoreKit 2 は「finish 済み」のトランザクションを isAcknowledged: true
            // で再送してくる。二重付与しないよう記録だけして終わる。
            if (transaction.isAcknowledged === true) {
                console.log('[IAP] Transaction already acknowledged by the store, recording only:', productId);
                if (txKey) this.markProcessed(txKey);
                delivered = true;
                continue;
            }

            // finish より先に記録する（付与直後のクラッシュでも二重付与しない）
            if (txKey) this.markProcessed(txKey);
            let granted = false;
            try {
                granted = this.grantItem(item, quantity);
            } catch (err) {
                // 付与できなかったので記録を取り消す（次回起動時の再送で再挑戦できる）
                if (txKey) this.unmarkProcessed(txKey);
                throw err;
            }
            if (!granted) {
                // コインマネージャがまだ用意できていない等。finish せず再送に委ねる。
                if (txKey) this.unmarkProcessed(txKey);
                return false;
            }
            delivered = true;
        }

        return delivered;
    }

    resolveQuantity(transaction) {
        const q = parseInt(transaction && transaction.quantity, 10);
        return Number.isFinite(q) && q > 0 ? q : 1;
    }

    findProductById(productId) {
        if (!productId) return null;
        return Object.values(this.products).find(p => p.id === productId) || null;
    }

    /**
     * 同じ購入を二度付与しないためのキー。
     * 購入のたびに StoreKit は新しい transactionId を発行するので、
     * 同じパックの買い直しは別キーになり、きちんと付与される。
     */
    buildTransactionKey(productId, source) {
        const id = productId || 'unknown';
        if (!source) return null;
        const txId = source.transactionId || source.purchaseId;
        if (txId) return `${id}:${txId}`;
        const when = source.purchaseDate;
        if (when instanceof Date && !isNaN(when.getTime())) return `${id}:${when.getTime()}`;
        if (typeof when === 'number' && isFinite(when)) return `${id}:${when}`;
        const time = source.purchaseTime;
        if (typeof time === 'number' && isFinite(time)) return `${id}:${time}`;
        return null;
    }

    // ---------------------------------------------------------------
    // Verified receipt handling (only used with a validation server)
    // ---------------------------------------------------------------

    onVerifiedReceipt(receipt) {
        try {
            this.grantFromVerifiedReceipt(receipt);
        } catch (err) {
            console.error('[IAP] Failed to grant verified purchase:', err);
        }

        // 検証サーバーを設定しているときだけ、検証済みレシートをまとめて finish する。
        // 未設定時は collection が空で付与は approved 側で完了しているため、
        // ここで finish すると付与前のトランザクションまで閉じてしまう危険がある。
        if (this.store && this.store.validator) {
            try {
                const pending = receipt.finish();
                if (pending && typeof pending.catch === 'function') pending.catch(() => {});
            } catch (err) {
                console.error('[IAP] Failed to finish verified receipt:', err);
            }
        }
        this.releasePendingLock();
        this.refreshShopUI();
    }

    grantFromVerifiedReceipt(receipt) {
        const purchases = (receipt && receipt.collection) || [];
        if (purchases.length === 0) {
            // 検証サーバー未設定時のフォールバック検証は collection を返さない。
            // 付与は approved 側で完了しているので、ここでは権利の同期だけ行う。
            this.syncEntitlements();
            return;
        }

        for (const purchase of purchases) {
            const productId = purchase.id || purchase.productId;
            const item = this.findProductById(productId);
            if (!item) continue;

            if (item.type === 'non-consumable') {
                // Entitlements are state-based; applying them is idempotent.
                this.applyAdFree('ad-free-pass');
                continue;
            }

            const txKey = this.buildTransactionKey(productId, purchase);
            if (txKey && this.isProcessed(txKey)) {
                console.log('[IAP] Transaction already granted, skipping:', txKey);
                continue;
            }
            const quantity = this.resolveQuantity(purchase);
            // Mark BEFORE granting/finishing so a crash cannot re-grant.
            if (txKey) this.markProcessed(txKey);
            let granted = false;
            try {
                granted = this.grantItem(item, quantity);
            } catch (err) {
                if (txKey) this.unmarkProcessed(txKey);
                throw err;
            }
            if (!granted && txKey) this.unmarkProcessed(txKey);
        }
    }

    onUnverifiedReceipt(failure) {
        const payload = (failure && failure.payload) || {};
        console.error('[IAP] Receipt validation failed:', payload.code, payload.message);
        // 検証に失敗したトランザクションは finish しない（StoreKit が再送する）。
        this.releasePendingLock();
        this.toast('購入の確認に失敗しました', '通信状態のよい場所でもう一度お試しください');
    }

    onTransactionFinished() {
        this.releasePendingLock();
        this.refreshShopUI();
    }

    // ---------------------------------------------------------------
    // Pending-purchase lock (guards against double taps / stuck UI)
    // ---------------------------------------------------------------

    armPendingWatchdog() {
        this.clearPendingWatchdog();
        this.pendingWatchdog = setTimeout(() => {
            this.pendingWatchdog = null;
            if (this.pendingProductId) {
                console.warn('[IAP] Pending purchase timed out; unlocking the shop UI.');
                this.pendingProductId = null;
                this.refreshShopUI();
            }
        }, this.PENDING_TIMEOUT_MS);
    }

    clearPendingWatchdog() {
        if (this.pendingWatchdog !== null) {
            try { clearTimeout(this.pendingWatchdog); } catch (e) { /* ignore */ }
            this.pendingWatchdog = null;
        }
    }

    releasePendingLock() {
        this.pendingProductId = null;
        this.clearPendingWatchdog();
    }

    // ---------------------------------------------------------------
    // Processed-transaction registry
    // ---------------------------------------------------------------

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

    unmarkProcessed(txKey) {
        if (!txKey) return;
        const arr = this.loadProcessed();
        const index = arr.indexOf(txKey);
        if (index < 0) return;
        arr.splice(index, 1);
        try {
            localStorage.setItem(this.PROCESSED_KEY, JSON.stringify(arr));
        } catch (e) { /* ignore */ }
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

    /**
     * 購入した商品を実際に付与する。
     * @returns {boolean} 付与できたら true。コインマネージャが未準備なら false
     *          （false のときはトランザクションを finish せず、StoreKit の再送に委ねる）。
     */
    grantItem(item, quantity = 1) {
        if (!item) return false;
        if (!this.app || !this.app.coinManager) {
            console.warn('[IAP] CoinManager is not ready; the grant is postponed.');
            return false;
        }

        if (item.type === 'non-consumable') {
            this.applyAdFree();
            this.toast('購入完了！広告完全非表示パス', '下部バナー広告を消去し動画スキップを適用しました');
            return true;
        }

        const packKey = Object.keys(this.products).find(k => this.products[k] === item);
        const total = item.coins * quantity;
        const unlocksAdFree = this.packUnlocksAdFree(item);
        this.app.coinManager.addCoins(total, `IAP購入: ${item.title}`);
        if (unlocksAdFree) this.applyAdFree(`pack:${packKey}`);

        // 375px幅でも語の途中で折り返さないよう、意味の切れ目で行を分ける。
        //   1行目: 「〇〇パック (¥金額) を獲得！」
        //   2行目: 「広告完全非表示（Ad-Free）も解放しました」
        // 以前は1文で流していたため「スタンダードパック」の後で折れ、
        // 2行目が「を獲得。広告…」と単語の途中から始まっていた。
        const priceLabel = this.getDisplayPrice(packKey) || item.fallbackPrice || '';
        const packLabel = priceLabel ? `${item.title} (${priceLabel})` : item.title;
        if (unlocksAdFree) {
            this.toast(
                `${packLabel} を獲得！`,
                '広告完全非表示（Ad-Free）も解放しました'
            );
        } else {
            this.toast(`${packLabel} を獲得しました`);
        }
        this.refreshShopUI();
        return true;
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
