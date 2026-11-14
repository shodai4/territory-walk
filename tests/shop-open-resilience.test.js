/**
 * TERRITORY WALK - Node tests
 * ショップが開かなくなる不具合（「押しても遷移しない／アプリを消したら直る」）の再発防止。
 *
 *   1) Pro状態のメソッド上書き（proManager.isPro = false）でショップが死なない
 *   2) 描画中に例外が出てもモーダルは必ず開く（パネルは個別に保護）
 *   3) 残存オーバーレイ・pointer-events/スクロールロックの自己修復
 *   4) 連打・二重発火ガードは finally で必ず解除される
 *   5) 開く入口は document 委譲（要素が差し替わっても無反応にならない）
 *   6) 動画リワードのフォールバック（存在しなかった showRewardAdModal）と二重付与なし
 *   7) 招待コードの互換API（getInviteCode）が無くても落ちない
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * DOM スタブ
 * ------------------------------------------------------------------ */
function createClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...names) => names.forEach((n) => set.add(n)),
        remove: (...names) => names.forEach((n) => set.delete(n)),
        toggle: (name, force) => {
            if (force === undefined ? !set.has(name) : force) set.add(name);
            else set.delete(name);
        },
        contains: (name) => set.has(name),
        values: () => [...set]
    };
}

function createElement(id, options = {}) {
    const listeners = {};
    const el = {
        id,
        textContent: '',
        innerHTML: '',
        className: '',
        style: {},
        dataset: {},
        disabled: false,
        classList: createClassList(options.classes || []),
        listeners,
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        removeEventListener() {},
        appendChild() {},
        removeChild() {},
        remove() {},
        setAttribute(name, value) { this.attributes = this.attributes || {}; this.attributes[name] = value; },
        removeAttribute(name) { if (this.attributes) delete this.attributes[name]; },
        getAttribute(name) { return (this.attributes && Object.prototype.hasOwnProperty.call(this.attributes, name)) ? this.attributes[name] : null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }; },
        focus() {},
        blur() {},
        closest() { return null; }
    };
    return el;
}

/**
 * coins.js / pro.js を読み込むための最小 DOM。存在しない id は null を返せる。
 */
function createHarness(options = {}) {
    const storage = {};
    const elements = new Map();
    const documentListeners = [];
    const body = createElement('body');
    const html = createElement('html');
    const missingIds = new Set(options.missingIds || []);

    const document = {
        body,
        documentElement: html,
        getElementById(id) {
            if (missingIds.has(id)) return null;
            if (!elements.has(id)) elements.set(id, createElement(id));
            return elements.get(id);
        },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        createElement: (tag) => createElement(tag),
        addEventListener(type, handler) {
            documentListeners.push({ type, handler });
        },
        removeEventListener() {}
    };

    const timers = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document,
        window: {},
        navigator: {},
        localStorage: {
            getItem: (key) => (key in storage ? storage[key] : null),
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
        clearInterval: () => {},
        confirm: () => true,
        alert() {},
        prompt: () => ''
    });

    vm.runInContext(fs.readFileSync(path.join(ROOT, 'pro.js'), 'utf8'), context, { filename: 'pro.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'coins.js'), 'utf8'), context, { filename: 'coins.js' });

    const ProManager = vm.runInContext('ProManager', context);
    const CoinManager = vm.runInContext('CoinManager', context);

    const toasts = [];
    const app = {
        showToast: (...args) => toasts.push(args),
        proManager: new ProManager(),
        iapManager: options.iapManager !== undefined ? options.iapManager : undefined,
        statsManager: options.statsManager !== undefined ? options.statsManager : {
            stats: {},
            unlockedTitles: [],
            activeTitle: '',
            getOrCreateReferralCode: () => 'ABC123'
        }
    };
    const manager = new CoinManager(app, null);
    app.coinManager = manager;

    const shopModal = document.getElementById('shop-modal');

    return {
        manager,
        app,
        storage,
        document,
        elements,
        timers,
        toasts,
        shopModal,
        documentListeners,
        ProManager,
        /** document に登録された click 委譲を発火する */
        dispatchClick(target) {
            documentListeners
                .filter((entry) => entry.type === 'click')
                .forEach((entry) => entry.handler({ target }));
        }
    };
}

/** ショップを開く入口ボタン（委譲の判定に必要な最小限） */
function createTrigger(id, attrs = {}) {
    return {
        id,
        disabled: false,
        getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
        closest(selector) {
            const matches = selector.split(',').map((part) => part.trim());
            const hasId = matches.some((part) => part === `#${this.id}`);
            const hasData = Object.prototype.hasOwnProperty.call(attrs, 'data-tw-open-shop')
                && matches.includes('[data-tw-open-shop]');
            return (hasId || hasData) ? this : null;
        }
    };
}

/* ------------------------------------------------------------------ *
 * 1. 原因の直接修正：Pro状態のメソッドを上書きしない
 * ------------------------------------------------------------------ */
test('原因の再現: 購入アイテムリセット後も proManager.isPro はメソッドのまま', () => {
    const h = createHarness();
    h.storage.territory_pro_unlocked = 'true';
    h.storage.tw_pro_unlocked = 'true';

    h.manager.resetPurchasedItems();

    assert.equal(typeof h.app.proManager.isPro, 'function', 'isPro はメソッドのまま（真偽値で上書きしない）');
    assert.equal(h.app.proManager.isPro(), false, 'Pro状態は解除される');
    assert.equal(h.storage.territory_pro_unlocked, undefined, 'ProManager が実際に見るキーを消している');
    assert.equal(h.storage.tw_pro_unlocked, undefined, '旧キーも消す');
});

test('原因の再現: リセット直後でもショップが開く（例外で塞がれない）', () => {
    const h = createHarness();
    h.manager.resetPurchasedItems();

    const opened = h.manager.openShopModal('earn');

    assert.equal(opened, true);
    assert.equal(h.shopModal.classList.contains('hidden'), false, 'モーダルが開いている');
    assert.equal(h.shopModal.style.display, 'flex');
});

test('旧端末の保険: isPro が真偽値で上書きされていてもショップは開く', () => {
    const h = createHarness();
    // 壊れた状態（v20 のデバッグリセットを踏んだ端末と同じ）
    h.app.proManager.isPro = false;

    assert.doesNotThrow(() => h.manager.renderShopPanels());
    assert.equal(h.manager.isProActive(), false);
    assert.equal(h.manager.openShopModal('perks'), true);
    assert.equal(h.shopModal.classList.contains('hidden'), false);

    // メソッドが消えていても Pro 特典は「無効」として扱う（落ちない）
    assert.equal(h.manager.isAdFree(), false);
    assert.equal(h.manager.isSkinUnlocked('neon'), false);
    assert.equal(h.manager.isPerkUnlocked('pin_gold'), false);
});

/* ------------------------------------------------------------------ *
 * 2. 例外が出てもモーダルは開く / パネルは個別保護
 * ------------------------------------------------------------------ */
test('例外耐性: タブ描画が例外を投げてもモーダルは必ず開く', () => {
    const h = createHarness();
    h.manager.switchShopTab = () => { throw new Error('render boom'); };

    const opened = h.manager.openShopModal('packs');

    assert.equal(opened, true);
    assert.equal(h.shopModal.classList.contains('hidden'), false, 'モーダルが開く');
    assert.equal(h.manager.shopOpening, false, 'ロックは finally で解ける');
});

test('例外耐性: 1つのパネルが落ちても他のパネルは描画を続ける', () => {
    const h = createHarness();
    const rendered = [];
    h.manager.renderEarnPanel = () => { throw new Error('earn boom'); };
    h.manager.renderSkinsPanel = () => rendered.push('skins');
    h.manager.renderPerksPanel = () => rendered.push('perks');

    assert.doesNotThrow(() => h.manager.renderShopPanels());
    assert.deepEqual(rendered, ['skins', 'perks'], '落ちたパネルの後ろも描画される');
});

test('例外耐性: statsManager が壊れていても（招待コード取得が例外でも）開く', () => {
    const h = createHarness({
        statsManager: {
            stats: {},
            unlockedTitles: [],
            activeTitle: '',
            getOrCreateReferralCode() { throw new Error('stats broken'); }
        }
    });

    assert.doesNotThrow(() => h.manager.openShopModal('earn'));
    assert.equal(h.shopModal.classList.contains('hidden'), false);
    assert.equal(h.manager.getInviteCode(), '', '取得できなければ空文字でフォールバック');
});

/* ------------------------------------------------------------------ *
 * 3. オーバーレイ残存・タップロックの自己修復
 * ------------------------------------------------------------------ */
test('自己修復: hidden なのに inline display が残った透明オーバーレイを閉じる', () => {
    const h = createHarness();
    const rules = h.document.getElementById('rules-modal');
    rules.classList.add('hidden');
    rules.style.display = 'flex';           // ← クラスと食い違い、画面を覆い続ける状態
    rules.style.pointerEvents = 'auto';
    h.document.body.style.pointerEvents = 'none';
    h.document.body.style.overflow = 'hidden';

    h.manager.openShopModal('earn');

    assert.equal(rules.style.display, '', '残存オーバーレイの inline display を解除');
    assert.equal(rules.style.pointerEvents, '');
    assert.equal(h.shopModal.classList.contains('hidden'), false);
    assert.equal(h.document.body.style.pointerEvents, '', 'body のタップロックを解除');
    assert.equal(h.document.body.style.overflow, '', 'body のスクロールロックを解除');
    assert.equal(h.shopModal.style.pointerEvents, 'auto');
});

test('開閉の往復: 閉じて再度開いても毎回開く（連続開閉）', () => {
    const h = createHarness();

    for (let i = 0; i < 5; i += 1) {
        assert.equal(h.manager.openShopModal('earn'), true);
        assert.equal(h.shopModal.classList.contains('hidden'), false, `${i + 1}回目: 開く`);
        h.manager.closeShopModal();
        assert.equal(h.shopModal.classList.contains('hidden'), true, `${i + 1}回目: 閉じる`);
        assert.equal(h.shopModal.style.display, '', '閉じたら inline display も戻す');
    }
});

/* ------------------------------------------------------------------ *
 * 4. 連打ガード（finally ＋ タイムアウト監視）
 * ------------------------------------------------------------------ */
test('連打ガード: 例外が出てもロックは残らず、次のタップで開く', () => {
    const h = createHarness();
    let calls = 0;
    h.manager.switchShopTab = () => { calls += 1; throw new Error('boom'); };

    h.manager.openShopModal('earn');
    assert.equal(h.manager.shopOpening, false, '1回目の後、ロックが残らない');

    h.manager.openShopModal('earn');
    assert.equal(calls, 2, '2回目のタップも処理される（ロックで塞がれない）');
});

test('連打ガード: 処理中の二重発火は1回にまとめる', () => {
    const h = createHarness();
    let calls = 0;
    h.manager.switchShopTab = () => { calls += 1; };

    h.manager.shopOpening = true; // 処理中を再現
    const result = h.manager.openShopModal('earn');

    assert.equal(result, true, '呼び出し自体は成功扱い');
    assert.equal(calls, 0, '処理中の二重発火では描画しない');
    assert.equal(h.shopModal.classList.contains('hidden'), false, 'すでに開く指示が出ている状態は維持');
});

test('連打ガード: 2秒の監視タイマーでロックが必ず解ける', () => {
    const h = createHarness();
    h.manager.openShopModal('earn');

    // finally で解除されるため、タイマーは残っていない
    assert.equal(h.timers.length, 0, '監視タイマーは finally で破棄される');
    assert.equal(h.manager.shopOpenWatchdog, null);
});

/* ------------------------------------------------------------------ *
 * 5. 入口は document 委譲（リスナー脱落対策）
 * ------------------------------------------------------------------ */
test('委譲: ヘッダーのコインからショップが開く', () => {
    const h = createHarness();
    h.shopModal.classList.add('hidden');

    h.dispatchClick(createTrigger('btn-header-coins'));

    assert.equal(h.shopModal.classList.contains('hidden'), false);
});

test('委譲: MENUのSHOPはメニューを閉じてショップを開く', () => {
    const h = createHarness();
    const menu = h.document.getElementById('menu-modal');
    menu.classList.remove('hidden');

    h.dispatchClick(createTrigger('btn-open-shop-from-menu', { 'data-tw-open-shop': 'packs' }));

    assert.equal(menu.classList.contains('hidden'), true, 'メニューは閉じる');
    assert.equal(h.shopModal.classList.contains('hidden'), false, 'ショップは開く');
});

test('委譲: ボタンを作り直してもリスナーが失われない（document に1回だけ登録）', () => {
    const h = createHarness();
    const clickListeners = () => h.documentListeners.filter((e) => e.type === 'click');

    // 何度 initDOM 相当を呼んでも document への登録は増えない
    h.manager.installShopOpenDelegation();
    h.manager.installShopOpenDelegation();
    assert.equal(clickListeners().length, 1, 'document への click 登録は1回だけ');

    // ハンドラは document 側にあるので、ボタンが作り直されても開く
    h.dispatchClick(createTrigger('btn-header-coins'));
    assert.equal(h.shopModal.classList.contains('hidden'), false);
});

test('委譲: data-tw-open-shop で開くタブを指定できる', () => {
    const h = createHarness();
    const opened = [];
    h.manager.openShopModal = (tab) => { opened.push(tab); return true; };

    h.dispatchClick(createTrigger('some-new-button', { 'data-tw-open-shop': 'titles' }));

    assert.deepEqual(opened, ['titles']);
});

test('委譲: disabled のボタンは無視する', () => {
    const h = createHarness();
    let opened = 0;
    h.manager.openShopModal = () => { opened += 1; return true; };

    const trigger = createTrigger('btn-header-coins');
    trigger.disabled = true;
    h.dispatchClick(trigger);

    assert.equal(opened, 0);
});

/* ------------------------------------------------------------------ *
 * 6. 動画リワード（AdMob フォールバック）
 * ------------------------------------------------------------------ */
test('動画リワード: admob.js が呼ぶ showRewardAdModal が存在する', () => {
    const h = createHarness();
    assert.equal(typeof h.manager.showRewardAdModal, 'function');
});

test('動画リワード: シミュレーションで受け取るとコールバックが1回だけ呼ばれる（二重付与なし）', () => {
    const h = createHarness();
    const before = h.manager.getCoins();
    let granted = 0;

    h.manager.showRewardAdModal(() => {
        granted += 1;
        h.manager.addCoins(500, 'AdMob動画リワード');
    });
    h.manager.claimRewardAd();

    assert.equal(granted, 1, 'コールバックは1回だけ');
    assert.equal(h.manager.getCoins(), before + 500, '500 COIN だけ増える');
});

test('動画リワード: コールバック無しなら従来どおり +500 COIN', () => {
    const h = createHarness();
    const before = h.manager.getCoins();

    h.manager.startRewardAdSimulation();
    h.manager.claimRewardAd();

    assert.equal(h.manager.getCoins(), before + 500);
});

test('動画リワード: モーダルが無い環境でもリワードを失わない', () => {
    const h = createHarness({ missingIds: ['reward-ad-modal'] });
    let called = 0;

    h.manager.startRewardAdSimulation(() => { called += 1; });

    assert.equal(called, 1, '即時に付与される');
});

/* ------------------------------------------------------------------ *
 * 7. 招待コード互換API
 * ------------------------------------------------------------------ */
test('招待コード: getInviteCode が statsManager のコードを返す', () => {
    const h = createHarness();
    assert.equal(h.manager.getInviteCode(), 'ABC123');
});

test('招待コード: statsManager が無い／壊れていても空文字で返す（シェアが落ちない）', () => {
    const h = createHarness({ statsManager: null });
    assert.equal(h.manager.getInviteCode(), '');
});

/* ------------------------------------------------------------------ *
 * 9. 購入タブの表示（日本円・説明文なし）
 * ------------------------------------------------------------------ */
function packsHtml(iapManager) {
    const h = createHarness({ iapManager });
    return h.elements.get('container-shop-packs').innerHTML;
}

test('購入タブ: 価格はすべて日本円（¥）で表示される', () => {
    const html = packsHtml({ getDisplayPriceForYen: () => null });

    ['¥120', '¥500', '¥1,500', '¥5,000'].forEach((price) => {
        assert.ok(html.includes(price), `${price} が表示されている`);
    });
    assert.doesNotMatch(html, /\$/, '外貨記号は出さない');
});

test('購入タブ: StoreKit が外貨を返しても円表示に直す', () => {
    const html = packsHtml({ getDisplayPriceForYen: () => '$0.99' });

    assert.doesNotMatch(html, /\$0\.99/);
    assert.ok(html.includes('¥120'));
    assert.ok(html.includes('¥5,000'));
});

test('購入タブ: 円建てのローカライズ価格はそのまま使う', () => {
    const html = packsHtml({ getDisplayPriceForYen: () => '¥160' });
    assert.ok(html.includes('¥160'));
});

test('購入タブ: グレーの補足説明は表示しない', () => {
    const html = packsHtml({ getDisplayPriceForYen: () => null });

    assert.doesNotMatch(html, /入門スキンや入門称号/);
    assert.doesNotMatch(html, /サクラ・モノトーンと中級称号向け/);
    assert.doesNotMatch(html, /Ad-Freeパス（単体/);
    // パック名・コイン数・バッジは残す
    assert.ok(html.includes('ビギナーパック'));
    assert.ok(html.includes('+1,000 COIN'));
});

test('購入タブ: 価格ボタンは折り返さない（whitespace-nowrap）', () => {
    const html = packsHtml({ getDisplayPriceForYen: () => null });
    const buttons = html.match(/<button class="btn-buy-pack[^>]*>/g) || [];
    assert.equal(buttons.length, 4);
    buttons.forEach((button) => assert.match(button, /whitespace-nowrap/));
});

/* ------------------------------------------------------------------ *
 * 10. 注意書き・説明文の折り返し
 * ------------------------------------------------------------------ */
test('注意書き: 文の区切りで改行される（文の途中で折り返さない）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    assert.match(html, /<span class="block[^"]*">買えるのは見た目や称号などの着せ替えだけ。<\/span>/);
    assert.match(html, /<span class="block[^"]*">勝負は歩いた分だけで決まります！<\/span>/);
    assert.match(html, /<span class="block[^"]*">ここで買えるのは見た目や称号などの着せ替えだけ。<\/span>/);
    // 見出しは獨立した行にする
    assert.match(html, /<div class="text-amber-400 font-bold leading-tight">※課金で勝敗は変わりません<\/div>/);
    // 旧来の一続きの文は残っていない
    assert.doesNotMatch(html, /着せ替えだけ。勝負は歩いた分だけで決まります！/);
});

test('機能タブ: Proサポーターの説明は1行に収まる長さに短縮されている', () => {
    const h = createHarness({ iapManager: undefined });
    const html = h.elements.get('container-shop-perks').innerHTML;

    assert.match(html, /全スキン解放・ポスター無制限・限定バッジ/);
    assert.doesNotMatch(html, /全スキン解放・無制限ポスター保存・限定サポーターバッジ/);
    // 375px幅：説明文の実効幅 215px ÷ 10pxフォント = 21文字以内
    assert.ok('全スキン解放・ポスター無制限・限定バッジ'.length <= 21);
});
test('静的: coins.js は Pro状態のメソッドを上書きしない', () => {
    const source = fs.readFileSync(path.join(ROOT, 'coins.js'), 'utf8');
    // コメント行を除いた実行コードだけを見る
    const code = source
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();
            return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
        })
        .join('\n');

    assert.doesNotMatch(code, /\.isPro\s*=\s*(false|true)\b/, 'isPro を真偽値で上書きしていない');
    assert.match(code, /isProActive\(\)/, '安全な Pro 判定を持っている');
});

test('静的: ショップ入口に data-tw-open-shop が付いている', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /id="btn-header-coins"[^>]*data-tw-open-shop="earn"/);
    assert.match(html, /id="btn-open-shop-from-menu"[^>]*data-tw-open-shop="packs"/);
});

test('静的: admob.js は存在しないメソッドを前提にしない', () => {
    const source = fs.readFileSync(path.join(ROOT, 'admob.js'), 'utf8');
    assert.match(source, /typeof coinManager\.showRewardAdModal === 'function'/);
    assert.match(source, /typeof coinManager\.startRewardAdSimulation === 'function'/, '旧インターフェースへのフォールバックもある');
});
