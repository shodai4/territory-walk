/**
 * TERRITORY WALK - Node tests
 * 課金（StoreKit / CdvPurchase v13）で「購入してもコインが増えない」不具合の再発防止。
 *
 *   1) 真因の再現：検証サーバー未設定だと .verified() のレシートは
 *      collection が空（プラグインの後方互換パス）なので、そこからは何も付与できない
 *   2) 修正： approved のトランザクションから付与し、その場で finish する
 *   3) 同じトランザクションは1回だけ付与（連続発火・再起動・isAcknowledged 再送）
 *   4) 同じパックの2回目購入は別トランザクションとして付与される
 *   5) 付与できなかったトランザクションは finish しない（StoreKit が再送する）
 *   6) 非消耗型（Ad-Free）はコインを増やさず権利だけ付与し、finish する
 *   7) 500円以上のパックは Ad-Free も同時解放
 *   8) キャンセル・エラー時にUIロックが残らない
 *   9) 検証サーバーを設定したときだけ verify → verified 経由で付与する
 *  10) SHOP「購入」タブの Ad-Free 説明文が単語途中で折り返さない（<br> 区切り）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const IAP_SOURCE = fs.readFileSync(path.join(ROOT, 'iap.js'), 'utf8');

/* ------------------------------------------------------------------ *
 * DOM / タイマー スタブ
 * ------------------------------------------------------------------ */
function createElement(id) {
    return {
        id,
        textContent: '',
        innerHTML: '',
        className: '',
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        getAttribute() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
}

/**
 * プラグインに依存しない IAPManager 用の最小環境。
 * localStorage はテスト間で共有でき、再起動（新しいマネージャ）を再現できる。
 */
function createHarness(options = {}) {
    const storage = options.storage || {};

    const elements = new Map();
    const documentListeners = {};
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, createElement(id));
            return elements.get(id);
        },
        addEventListener(type, cb) {
            (documentListeners[type] = documentListeners[type] || []).push(cb);
        },
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement: (tag) => createElement(tag)
    };

    const timers = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document,
        window: { Capacitor: { isNativePlatform: () => true } },
        navigator: {},
        localStorage: {
            getItem: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; }
        },
        setTimeout: (fn, ms) => {
            const handle = { fn, ms };
            timers.push(handle);
            return handle;
        },
        clearTimeout: (handle) => {
            const index = timers.indexOf(handle);
            if (index >= 0) timers.splice(index, 1);
        },
        setInterval: () => 0,
        clearInterval: () => {}
    });

    vm.runInContext(IAP_SOURCE, context, { filename: 'iap.js' });

    /* ---- CdvPurchase v13 のスタブ（store.js の挙動に合わせる） ---- */
    const callbacks = { approved: [], verified: [], unverified: [], finished: [] };
    const registered = new Map();
    const products = new Map();
    const orders = [];

    const CdvPurchase = {
        Platform: { APPLE_APPSTORE: 'ios-appstore' },
        ProductType: { CONSUMABLE: 'consumable', NON_CONSUMABLE: 'non-consumable' },
        TransactionState: {
            INITIATED: 'initiated', PENDING: 'pending', APPROVED: 'approved',
            CANCELLED: 'cancelled', FINISHED: 'finished'
        },
        LogLevel: { WARNING: 2 },
        ErrorCode: { PAYMENT_CANCELLED: 'payment-cancelled', PURCHASE: 'purchase' },
        store: null
    };

    const whenApi = {
        productUpdated(cb) { callbacks.productUpdated = cb; return whenApi; },
        approved(cb) { callbacks.approved.push(cb); return whenApi; },
        verified(cb) { callbacks.verified.push(cb); return whenApi; },
        unverified(cb) { callbacks.unverified.push(cb); return whenApi; },
        finished(cb) { callbacks.finished.push(cb); return whenApi; },
        receiptsReady(cb) { callbacks.receiptsReady = cb; return whenApi; }
    };

    let validator;
    const store = {
        initialized: false,
        registerError: null,
        get validator() { return validator; },
        set validator(value) { validator = value; },
        register(list) {
            if (store.registerError) throw store.registerError;
            list.forEach(item => registered.set(item.id, item));
        },
        when() { return whenApi; },
        error(cb) { store._errorCb = cb; },
        ready(cb) { store._readyCb = cb; },
        initialize() { store.initialized = true; },
        get(id) { return products.get(id) || undefined; },
        order(offer) {
            orders.push(offer);
            return store.orderResult ? store.orderResult(offer) : Promise.resolve(undefined);
        },
        restorePurchases() { return Promise.resolve(); },
        update() { return Promise.resolve(); },
        localReceipts: [],
        localTransactions: [],
        verifiedPurchases: [],
        findInVerifiedReceipts() { return undefined; }
    };
    CdvPurchase.store = store;
    context.window.CdvPurchase = CdvPurchase;

    /* ---- アプリ本体（CoinManager）のスタブ ---- */
    const coins = { total: 0, adFree: [], toasts: [], failGrant: false, renders: 0 };
    const app = {
        showToast: (title, subtitle) => coins.toasts.push([title, subtitle]),
        coinManager: {
            addCoins(amount) {
                if (coins.failGrant) throw new Error('storage unavailable');
                coins.total += amount;
            },
            setAdFree(enabled, source) {
                coins.adFree.push({ enabled, source });
                storage.tw_is_ad_free = enabled ? 'true' : 'false';
                if (source) storage.tw_ad_free_source = source;
            },
            renderPacksPanel() { coins.renders++; }
        }
    };

    const IAPManager = vm.runInContext('IAPManager', context);
    const iap = new IAPManager(app);
    // ネイティブの deviceready は来ないので、明示的にストア初期化まで進める。
    iap.initStore();

    function makeTransaction(productId, txOptions = {}) {
        const tx = {
            transactionId: txOptions.transactionId || `${productId}-${Math.random().toString(36).slice(2, 8)}`,
            products: [{ id: productId }],
            quantity: txOptions.quantity || 1,
            state: CdvPurchase.TransactionState.APPROVED,
            isAcknowledged: txOptions.isAcknowledged,
            isPending: txOptions.isPending,
            purchaseDate: new Date(txOptions.time || 1763200000000),
            verifyCalls: 0,
            finishCalls: 0,
            finishRegistrySnapshot: null,
            verify() {
                this.verifyCalls++;
                // store.js: 検証サーバーが無い場合は後方互換で
                // { id, latest_receipt: true } を返す＝collection は空。
                const hasValidator = !!store.validator;
                const receipt = {
                    id: this.transactionId,
                    latestReceipt: true,
                    collection: hasValidator
                        ? [{ id: productId, transactionId: this.transactionId, quantity: this.quantity }]
                        : [],
                    finishCalls: 0,
                    finish() { receipt.finishCalls++; return Promise.resolve(); }
                };
                this.lastVerifiedReceipt = receipt;
                callbacks.verified.forEach(cb => cb(receipt));
                return Promise.resolve();
            },
            finish() {
                this.finishCalls++;
                const raw = storage.tw_iap_processed_tx_v1;
                this.finishRegistrySnapshot = raw ? JSON.parse(raw) : [];
                this.state = CdvPurchase.TransactionState.FINISHED;
                callbacks.finished.forEach(cb => cb(this));
                return Promise.resolve();
            }
        };
        return tx;
    }

    return {
        iap, app, store, products, orders, coins, storage, callbacks, timers,
        CdvPurchase, makeTransaction,
        makeProduct(id, overrides = {}) {
            const product = {
                id,
                owned: false,
                getOffer: () => ({
                    id: 'default',
                    productId: id,
                    pricingPhases: [{ price: '¥500' }]
                }),
                ...overrides
            };
            products.set(id, product);
            return product;
        },
        emitApproved(transaction) {
            callbacks.approved.forEach(cb => cb(transaction));
            return transaction;
        }
    };
}

const PACK_500 = 'com.shodai.territorywalk.coins4500';
const PACK_120 = 'com.shodai.territorywalk.coins1000';
const AD_FREE = 'com.shodai.territorywalk.adfree';

/* ------------------------------------------------------------------ *
 * 1. 真因：検証サーバー未設定の verified は collection が空で何も付与できない
 * ------------------------------------------------------------------ */
test('真因: 検証サーバー未設定の verified レシートは collection が空で、そこからは付与できない', () => {
    const h = createHarness();
    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-1' });
    tx.verify();
    const receipt = tx.lastVerifiedReceipt;

    assert.deepEqual(receipt.collection, [], 'CdvPurchase v13 の後方互換パスは collection を返さない');

    // 空の collection で検証済みイベントが来ても、コインは増えない（旧実装の挙動）
    h.iap.onVerifiedReceipt(receipt);
    assert.equal(h.coins.total, 0);
});

test('修正: 検証サーバー未設定なら approved のトランザクションから付与し、その場で finish する', () => {
    const h = createHarness();
    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-2' });

    h.emitApproved(tx);

    assert.equal(tx.verifyCalls, 0, '検証サーバーが無いのに verify() を呼ばない（空collectionに依存しない）');
    assert.equal(h.coins.total, 4500, 'スタンダードパックの 4,500 COIN が付与される');
    assert.equal(tx.finishCalls, 1, '付与後に finish される');
    assert.equal(h.iap.pendingProductId, null, 'UIロックが残らない');
    assert.ok(h.storage.tw_iap_processed_tx_v1.includes('tx-2'), '取引IDが永続記録される');
});

test('付与は finish より先（finish 時点で取引IDが記録済み）', () => {
    const h = createHarness();
    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-3' });
    h.emitApproved(tx);

    assert.ok(
        tx.finishRegistrySnapshot.some(key => key.indexOf('tx-3') >= 0),
        'finish する前に取引IDが保存されている（付与直後のクラッシュでも二重付与しない）'
    );
});

/* ------------------------------------------------------------------ *
 * 2. 重複付与防止
 * ------------------------------------------------------------------ */
test('同じトランザクションが二度 approved されても付与は1回だけ', () => {
    const h = createHarness();
    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-4' });

    h.emitApproved(tx);
    h.emitApproved(tx);

    assert.equal(h.coins.total, 4500);
});

test('再起動（新しいマネージャ・同じ localStorage）でも同じトランザクションは再付与しない', () => {
    const storage = {};
    const first = createHarness({ storage });
    const tx = first.makeTransaction(PACK_500, { transactionId: 'tx-5' });
    first.emitApproved(tx);
    assert.equal(first.coins.total, 4500);

    const second = createHarness({ storage });
    const replay = second.makeTransaction(PACK_500, { transactionId: 'tx-5' });
    second.emitApproved(replay);

    assert.equal(second.coins.total, 0, '再起動後の再送では二重付与しない');
    assert.equal(replay.finishCalls, 1, '付与済みなので finish はする（未完了のまま残さない）');
});

test('StoreKit 2 が finish 済みトランザクションを再送（isAcknowledged）しても二重付与しない', () => {
    const h = createHarness();
    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-6', isAcknowledged: true });

    h.emitApproved(tx);

    assert.equal(h.coins.total, 0);
    assert.equal(tx.finishCalls, 1);
});

test('同じパックの2回目購入は新しいトランザクションIDなので、きちんと2回目も付与される', () => {
    const h = createHarness();

    h.emitApproved(h.makeTransaction(PACK_500, { transactionId: 'tx-7a' }));
    assert.equal(h.coins.total, 4500);

    h.emitApproved(h.makeTransaction(PACK_500, { transactionId: 'tx-7b' }));
    assert.equal(h.coins.total, 9000, '買い直しが「付与済み」と誤判定されない');
});

test('数量つきトランザクションは数量分まとめて付与する', () => {
    const h = createHarness();
    h.emitApproved(h.makeTransaction(PACK_120, { transactionId: 'tx-8', quantity: 2 }));
    assert.equal(h.coins.total, 2000);
});

/* ------------------------------------------------------------------ *
 * 3. 付与できなかったときは finish しない
 * ------------------------------------------------------------------ */
test('付与に失敗したら finish せず、次回起動時の再送に委ねる', () => {
    const h = createHarness();
    h.coins.failGrant = true;
    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-9' });

    h.emitApproved(tx);

    assert.equal(tx.finishCalls, 0, '付与できていないトランザクションは閉じない');
    assert.equal(h.coins.total, 0);
    assert.equal(h.iap.pendingProductId, null, 'それでもUIロックは解除する');

    // 次回起動時に再送されて、今度は付与できる
    h.coins.failGrant = false;
    h.emitApproved(h.makeTransaction(PACK_500, { transactionId: 'tx-9' }));
    assert.equal(h.coins.total, 4500);
});

test('商品カタログにないIDのトランザクションは付与も finish もしない', () => {
    const h = createHarness();
    const tx = h.makeTransaction('com.shodai.territorywalk.unknown', { transactionId: 'tx-10' });

    h.emitApproved(tx);

    assert.equal(h.coins.total, 0);
    assert.equal(tx.finishCalls, 0);
});

/* ------------------------------------------------------------------ *
 * 4. 非消耗型（Ad-Free）とパック特典
 * ------------------------------------------------------------------ */
test('Ad-Free パス（非消耗型）はコインを増やさず、権利を有効化して finish する', () => {
    const h = createHarness();
    const tx = h.makeTransaction(AD_FREE, { transactionId: 'tx-11' });

    h.emitApproved(tx);

    assert.equal(h.coins.total, 0, 'コインは付与しない');
    assert.equal(h.storage.tw_is_ad_free, 'true');
    assert.equal(h.storage.tw_ad_free_source, 'ad-free-pass');
    assert.equal(tx.finishCalls, 1);
});

test('500円以上のコインパックは Ad-Free も同時に解放する', () => {
    const h = createHarness();
    h.emitApproved(h.makeTransaction(PACK_500, { transactionId: 'tx-12' }));

    assert.equal(h.coins.total, 4500);
    const applied = h.coins.adFree.filter(entry => entry.source === 'pack:pack-500');
    assert.equal(applied.length, 1, 'パック特典として Ad-Free が1回だけ適用される');
    assert.equal(h.storage.tw_is_ad_free, 'true');
});

test('120円のビギナーパックでは Ad-Free を解放しない', () => {
    const h = createHarness();
    h.emitApproved(h.makeTransaction(PACK_120, { transactionId: 'tx-13' }));

    assert.equal(h.coins.total, 1000);
    assert.equal(h.coins.adFree.length, 0);
});

/* ------------------------------------------------------------------ *
 * 5. 保留・キャンセル・エラー時のUIロック
 * ------------------------------------------------------------------ */
test('保留（Ask to Buy）では付与せず、UIロックだけ解除する', () => {
    const h = createHarness();
    h.iap.pendingProductId = PACK_500;

    h.emitApproved(h.makeTransaction(PACK_500, { transactionId: 'tx-14', isPending: true }));

    assert.equal(h.coins.total, 0);
    assert.equal(h.iap.pendingProductId, null);
});

test('キャンセル時はコインもエラートーストも出さず、ロックを解除する', async () => {
    const h = createHarness();
    h.makeProduct(PACK_500);
    h.store.orderResult = () => Promise.resolve({ code: 'payment-cancelled' });

    // store.order がキャンセルを返すケース
    h.iap.pendingProductId = PACK_500;
    h.iap.onStoreError({ code: 'payment-cancelled', message: 'cancelled' });

    assert.equal(h.iap.pendingProductId, null);
    assert.equal(h.coins.total, 0);
    assert.equal(h.coins.toasts.filter(t => t[0].indexOf('エラー') >= 0).length, 0, 'キャンセルでエラー表示しない');
});

test('購入処理中の二重タップは購入を始めない', () => {
    const h = createHarness();
    h.makeProduct(PACK_500);
    h.iap.pendingProductId = PACK_500;

    h.iap.purchasePack('pack-500');

    assert.equal(h.orders.length, 0, 'ストアに注文を投げない');
    assert.ok(h.coins.toasts.some(t => t[0] === '購入処理中です'));
});

test('購入を開始すると保留ロックが立つ（finish で解除される）', async () => {
    const h = createHarness();
    h.makeProduct(PACK_500);
    h.store.orderResult = () => Promise.resolve(undefined);

    await h.iap.purchasePack('pack-500');
    assert.equal(h.iap.pendingProductId, PACK_500);

    h.emitApproved(h.makeTransaction(PACK_500, { transactionId: 'tx-15' }));
    assert.equal(h.iap.pendingProductId, null);
    assert.equal(h.coins.total, 4500);
});

/* ------------------------------------------------------------------ *
 * 6. 検証サーバーを設定した場合の従来フロー
 * ------------------------------------------------------------------ */
test('検証サーバー設定時は approved → verify → verified の順で付与する', () => {
    const h = createHarness({ storage: { tw_iap_validator_url: 'https://validator.example.test/iap' } });
    assert.equal(h.store.validator, 'https://validator.example.test/iap', '検証URLがストアに渡っている');

    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-16' });
    // 検証サーバーの応答はまだ返っていない状態（プラグインは verify() だけ呼ぶ）
    tx.verify = function () { this.verifyCalls++; return Promise.resolve(); };
    const verifiedReceipt = {
        id: 'tx-16',
        collection: [{ id: PACK_500, transactionId: 'tx-16', quantity: 1 }],
        finishCalls: 0,
        finish() { this.finishCalls++; return Promise.resolve(); }
    };

    h.emitApproved(tx);

    assert.equal(tx.verifyCalls, 1, '検証サーバーがあるときだけ verify する');
    assert.equal(h.coins.total, 0, '検証が終わるまで付与しない');
    assert.equal(tx.finishCalls, 0, '検証が終わるまで finish しない');

    // 検証OKの通知（プラグインが verified を発火する）
    h.callbacks.verified.forEach(cb => cb(verifiedReceipt));

    assert.equal(h.coins.total, 4500, '検証済みレシートの collection から付与される');
    assert.equal(verifiedReceipt.finishCalls, 1, '検証済みレシートを finish する');
    assert.equal(h.iap.pendingProductId, null);
});

test('検証失敗（unverified）では付与も finish もしない', () => {
    const h = createHarness({ storage: { tw_iap_validator_url: 'https://validator.example.test/iap' } });
    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-17' });
    tx.verify = function () { this.verifyCalls++; return Promise.resolve(); };
    h.iap.pendingProductId = PACK_500;

    h.iap.onApprovedTransaction(tx);
    h.callbacks.unverified.forEach(cb => cb({ payload: { ok: false, code: 'verification-failed', message: 'ng' } }));

    assert.equal(h.coins.total, 0);
    assert.equal(tx.finishCalls, 0);
    assert.equal(h.iap.pendingProductId, null);
});

test('コインマネージャが未準備で付与できないときは finish しない（起動直後の再送で拾い直す）', () => {
    const h = createHarness();
    const tx = h.makeTransaction(PACK_500, { transactionId: 'tx-18' });
    const saved = h.app.coinManager;
    h.app.coinManager = null;

    h.emitApproved(tx);
    assert.equal(tx.finishCalls, 0, '付与できていないので閉じない');
    assert.ok(!String(h.storage.tw_iap_processed_tx_v1 || '').includes('tx-18'), '記録も残さない');

    h.app.coinManager = saved;
    h.emitApproved(h.makeTransaction(PACK_500, { transactionId: 'tx-18' }));
    assert.equal(h.coins.total, 4500, '再送で付与できる');
});

/* ------------------------------------------------------------------ *
 * 7. リストア（復元）の点検
 * ------------------------------------------------------------------ */
test('復元: 非消耗型の Ad-Free を所有していれば権利を再適用し、コインは増やさない', async () => {
    const h = createHarness();
    h.makeProduct(AD_FREE, { owned: true });

    await h.iap.restorePurchases();

    assert.equal(h.coins.total, 0, '消耗型は復元できない');
    assert.equal(h.storage.tw_is_ad_free, 'true');
    assert.equal(h.storage.tw_ad_free_source, 'ad-free-pass');
    assert.ok(h.coins.toasts.some(t => t[0] === '購入の復元が完了しました'));
});

test('復元: 何も持っていなければ「復元できる購入がありません」を出す', async () => {
    const h = createHarness();
    h.makeProduct(AD_FREE, { owned: false });

    await h.iap.restorePurchases();

    assert.equal(h.coins.total, 0);
    assert.equal(h.storage.tw_is_ad_free, undefined);
    assert.ok(h.coins.toasts.some(t => t[0] === '復元できる購入がありませんでした'));
});

test('復元: 500円以上のパック購入歴から Ad-Free 特典だけを復元する', async () => {
    const h = createHarness();
    h.makeProduct(AD_FREE, { owned: false });
    // 消耗型なのでコインは再付与されないが、購入履歴はレシートに残っている
    h.store.localTransactions = [{ products: [{ id: PACK_500 }], isPending: false }];

    await h.iap.restorePurchases();

    assert.equal(h.coins.total, 0);
    assert.equal(h.storage.tw_is_ad_free, 'true');
    assert.equal(h.storage.tw_ad_free_source, 'pack-history');
});

/* ------------------------------------------------------------------ *
 * 8. ストア初期化の防御
 * ------------------------------------------------------------------ */
test('商品登録に失敗しても例外を外に漏らさず、購入時にエラートーストで止まる', () => {
    const h = createHarness();
    h.store.registerError = new Error('register failed');
    h.iap.initStarted = false;
    h.iap.initStore();

    assert.equal(h.iap.store, h.store, 'ストア参照は保持され、購入時のガードで止まる');
});

/* ------------------------------------------------------------------ *
 * 8. 静的チェック（真因に戻っていないこと）
 * ------------------------------------------------------------------ */
test('静的: 付与は approved 起点で、.verified は検証サーバー用の補助に留めている', () => {
    assert.match(IAP_SOURCE, /\.approved\(transaction => this\.onApprovedTransaction\(transaction\)\)/);
    assert.match(IAP_SOURCE, /\.unverified\(failure => this\.onUnverifiedReceipt\(failure\)\)/);
    assert.doesNotMatch(IAP_SOURCE, /handleVerifiedReceipt/, '旧: collection 依存の付与関数は残っていない');
    assert.match(IAP_SOURCE, /if \(!delivered\)/, '付与できなかったトランザクションを finish しない分岐がある');
    assert.match(IAP_SOURCE, /if \(this\.store && this\.store\.validator\)/, '検証サーバー設定時だけ verify / receipt.finish する');
});

test('静的: 維持事項（暗号化申告）は変更していない', () => {
    const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    // 提出ビルドはデバッグ無効（ENABLE_DEBUG_TOOLS: false）。値はどちらでもよいが定義は必ず1か所に残す。
    assert.match(appJs, /ENABLE_DEBUG_TOOLS:\s*(true|false)/);
    const configure = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-ios.js'), 'utf8');
    assert.match(configure, /ITSAppUsesNonExemptEncryption/);
    assert.match(configure, /false/);
});

/* ------------------------------------------------------------------ *
 * 9. SHOP「購入」タブの Ad-Free 説明文（375px で単語途中の折り返しをしない）
 * ------------------------------------------------------------------ */
function extractAdFreeCardTemplate() {
    const source = fs.readFileSync(path.join(ROOT, 'coins.js'), 'utf8');
    const start = source.indexOf('const adFreeCard = `');
    assert.ok(start >= 0, 'Ad-Free カードのテンプレートがある');
    const end = source.indexOf('`;', start);
    const template = source.slice(start, end);
    assert.match(template, /Ad-Free Pro/, 'Ad-Free Pro のカードである');
    const desc = template.match(/<div class="shop-desc[^"]*">([\s\S]*?)<\/div>/);
    assert.ok(desc, '説明文の div がある');
    return desc[1];
}

test('Ad-Free 説明文: 「完全消去 &」と「動画リワード」の区切りで改行する', () => {
    const inner = extractAdFreeCardTemplate();

    assert.match(inner, /画面下部バナー広告を完全消去 ＆<br>動画リワード待ち受け不要/);
    assert.doesNotMatch(inner, /完全消去 ＆ 動画/, 'スペース区切りの一続きの文に戻っていない');
});

test('Ad-Free 説明文: 375px幅で単語途中に折り返さない長さ（1行21文字以内）に収まる', () => {
    const inner = extractAdFreeCardTemplate();
    const lines = inner.split(/<br\s*\/?>/).map(line => line.trim()).filter(Boolean);

    assert.equal(lines.length, 2, '2行に分かれている');
    lines.forEach((line) => {
        assert.ok(line.length <= 21, `1行が375px幅に収まる長さ（${line.length}文字）: ${line}`);
    });
    assert.ok(lines[1].startsWith('動画'), '2行目は「動画」から始まる（動/画 で割らない）');
    assert.ok(!/[、。]$/.test(lines[0]), '1行目は語の途中で切れていない');
});

test('Ad-Free 説明文: キャッシュバスターが更新されている', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /iap\.js\?v=\d{8}v\d+/);
    assert.match(html, /coins\.js\?v=\d{8}v\d+/);
});

/* ------------------------------------------------------------------ *
 * 10. 価格表示はすべて日本円（¥）固定（$ 表記の根絶）
 *     実機で「ビギナーパック ($0.99) を獲得しました」と出た不具合の再発防止。
 * ------------------------------------------------------------------ */
test('価格: カタログは全パック日本円表記で、yen と fallbackPrice が一致する', () => {
    const h = createHarness();
    const expected = {
        'pack-120': '¥120',
        'pack-500': '¥500',
        'pack-1500': '¥1,500',
        'pack-5000': '¥5,000',
        'ad-free': '¥480'
    };

    Object.keys(expected).forEach((packKey) => {
        const item = h.iap.products[packKey];
        assert.ok(item, `${packKey} がある`);
        assert.equal(item.fallbackPrice, expected[packKey], `${packKey} のカタログ表記が円`);
        assert.equal(h.iap.formatYen(item.yen), expected[packKey], `${packKey} の金額から円表記を作れる`);
        assert.doesNotMatch(h.iap.formatYen(item.yen), /\$/, '円表記に $ を含めない');
    });
});

test('価格: StoreKit が $0.99 を返しても表示価格・購入完了トーストは円のまま', () => {
    const h = createHarness();

    // サンドボックスが返す外貨価格（実機で起きたケース）
    const product = h.makeProduct(PACK_120, {
        getOffer: () => ({ id: 'default', productId: PACK_120, pricingPhases: [{ price: '$0.99' }] })
    });
    assert.equal(typeof h.callbacks.productUpdated, 'function', 'productUpdated が配線されている');
    h.callbacks.productUpdated(product);

    // 参照用には記録されるが、表示には一切使わない
    assert.equal(h.iap.storePriceByProductId[PACK_120], '$0.99');
    assert.equal(h.iap.getDisplayPrice('pack-120'), '¥120', 'パックの表示価格は円固定');
    assert.equal(h.iap.getDisplayPriceForYen(120), '¥120', '円額からの表示価格も円固定');
    assert.equal(h.iap.getDisplayPriceForYen(1500), '¥1,500', '3桁区切りも円表記');

    // 購入完了トースト（実機で $ が出た箇所）
    const tx = h.makeTransaction(PACK_120, { transactionId: 'tx-dollar-1' });
    h.emitApproved(tx);

    const granted = h.coins.toasts.find((t) => t.join(' ').indexOf('獲得しました') >= 0);
    assert.ok(granted, '購入完了トーストが出る');
    assert.match(granted[0], /ビギナーパック \(¥120\) を獲得しました/);
    assert.doesNotMatch(JSON.stringify(h.coins.toasts), /\$0\.99/, '$ 表記をトーストに出さない');
});

test('価格: 未知の円額でも日本円表記にフォールバックする（null を返さない）', () => {
    const h = createHarness();
    assert.equal(h.iap.getDisplayPriceForYen(300), '¥300', 'カタログ外の円額も円表記');
    assert.equal(h.iap.getDisplayPrice('unknown-pack'), null, '未知のパックキーは null');
});

test('ソース点検: iap.js / coins.js / app.js / index.html に $ 価格表記が残っていない', () => {
    ['iap.js', 'coins.js', 'app.js', 'index.html'].forEach((file) => {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(source, /\$\s?\d/, `${file} に「$ + 数字」の価格表記が無い`);
    });
});

test('ソース点検: iap.js はストア価格を表示用ヘルパーの戻り値に使わない', () => {
    assert.doesNotMatch(IAP_SOURCE, /storePriceByProductId\[[^\]]+\]\s*\|\|/, '表示にストア価格を使わない');
    assert.match(IAP_SOURCE, /getDisplayPrice\(packKey\) \{[\s\S]*?return this\.formatYen\(item\.yen\)/, 'getDisplayPrice は円固定');
    assert.match(IAP_SOURCE, /getDisplayPriceForYen\(yen\) \{[\s\S]*?return this\.formatYen\(/, 'getDisplayPriceForYen も円固定');
});

/* ------------------------------------------------------------------ *
 * 11. 課金完了トーストの改行整形
 *     実機で「スタンダードパック」の後で折り返し、2行目が「を獲得。広告…」と
 *     単語の途中から始まっていた不具合の再発防止。
 * ------------------------------------------------------------------ */

/**
 * トースト1行の推定描画幅（px）。
 * トーストは font-mono / text-xs（12px）、2行目は text-[11px]。
 * 全角（CJK・全角記号）は 1em、半角は 0.6em として保守的に見積もる。
 */
function estimateLineWidth(text, fontSize) {
    let em = 0;
    for (const ch of String(text)) {
        em += /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.6;
    }
    return em * fontSize;
}

// 375px幅のトースト本文の描画可能幅（max-w-92vw = 345px - px-4 の左右32px）
const TOAST_LINE_BUDGET_PX = 300;

const AD_FREE_PACKS = {
    [PACK_500]: 'スタンダードパック',
    'com.shodai.territorywalk.coins14000': 'プレミアムパック',
    'com.shodai.territorywalk.coins50000': 'アルティメットパック'
};

test('トースト: 500円以上パックは「〇〇パック (¥金額) を獲得！」と「Ad-Free解放」の2行に分かれる', () => {
    Object.keys(AD_FREE_PACKS).forEach((productId, index) => {
        const h = createHarness();
        h.emitApproved(h.makeTransaction(productId, { transactionId: `tx-lines-${index}` }));

        const toast = h.coins.toasts.find((t) => String(t[0] || '').indexOf('を獲得') >= 0);
        assert.ok(toast, `${AD_FREE_PACKS[productId]} の購入完了トーストが出る`);

        const [line1, line2] = toast;
        assert.match(line1, /^.+パック \(¥[\d,]+\) を獲得！$/, '1行目は「パック名 (¥金額) を獲得！」');
        assert.equal(line2, '広告完全非表示（Ad-Free）も解放しました', '2行目は Ad-Free 解放の一文だけ');
        assert.equal(toast.length, 2, '3行目は作らない');
    });
});

test('トースト: 1文の流し込みに戻らず、2行目が「を獲得」から始まらない', () => {
    const h = createHarness();
    h.emitApproved(h.makeTransaction(PACK_500, { transactionId: 'tx-lines-guard' }));

    const all = h.coins.toasts.map((t) => t.filter(Boolean).join('\n'));
    assert.ok(all.length > 0);
    all.forEach((text) => {
        assert.doesNotMatch(text, /を獲得。/, '「を獲得。広告…」の連結が残っていない');
        text.split('\n').forEach((line) => {
            assert.doesNotMatch(line, /^[をもの]/, `行頭が助詞から始まらない: ${line}`);
        });
    });
});

test('トースト: 375px幅（本文300px）で意図しない再折り返しをしない', () => {
    Object.keys(AD_FREE_PACKS).forEach((productId, index) => {
        const h = createHarness();
        h.emitApproved(h.makeTransaction(productId, { transactionId: `tx-width-${index}` }));
        const toast = h.coins.toasts.find((t) => String(t[0] || '').indexOf('を獲得') >= 0);

        const [line1, line2] = toast;
        assert.ok(estimateLineWidth(line1, 12) <= TOAST_LINE_BUDGET_PX,
            `1行目が375pxに収まる（${Math.round(estimateLineWidth(line1, 12))}px）: ${line1}`);
        assert.ok(estimateLineWidth(line2, 11) <= TOAST_LINE_BUDGET_PX,
            `2行目が375pxに収まる（${Math.round(estimateLineWidth(line2, 11))}px）: ${line2}`);
    });
});

test('トースト: 120円のビギナーパックは1行で「ビギナーパック (¥120) を獲得しました」', () => {
    const h = createHarness();
    h.emitApproved(h.makeTransaction(PACK_120, { transactionId: 'tx-beginner-line' }));

    const toast = h.coins.toasts.find((t) => String(t[0] || '').indexOf('獲得しました') >= 0);
    assert.ok(toast, '購入完了トーストが出る');
    assert.equal(toast[0], 'ビギナーパック (¥120) を獲得しました', '文言は確定仕様どおり');
    assert.equal(toast[1] == null, true, '2行目（Ad-Free行）は付けない');
    assert.ok(estimateLineWidth(toast[0], 12) <= TOAST_LINE_BUDGET_PX,
        `375px幅で1行に収まる（${Math.round(estimateLineWidth(toast[0], 12))}px）`);
    assert.doesNotMatch(toast[0], /\$/, 'ドル表記を含まない（円固定）');
});

test('トースト: 旧文言（購入完了！ +N COIN / を獲得。…）が残っていない', () => {
    assert.doesNotMatch(IAP_SOURCE, /購入完了！ \+/, '旧1行目の「購入完了！ +N COIN」を残さない');
    assert.doesNotMatch(IAP_SOURCE, /を獲得。広告完全非表示/, '単語途中で折れる旧1文を残さない');
});

