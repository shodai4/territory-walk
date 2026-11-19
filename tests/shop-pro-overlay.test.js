/**
 * TERRITORY WALK - Node tests
 * SHOP & COINS ＞ 機能タブの Proサポーター「コード入力」の重ね表示の回帰チェック:
 *
 *   1) #pro-modal は #shop-modal（z-[2000]）より手前（z-[2050]）に置かれる
 *   2) 「コード入力」で SHOP を閉じず、その上に #pro-modal を開く
 *   3) #pro-modal を閉じると背後の SHOP がそのまま操作できる状態で残る
 *   4) SHOP を開いたまま有効化に成功したら、SHOP 側の Pro表示・各パネルも即座に更新される
 *   5) SHOP が閉じているときの有効化は、無駄な再描画をしない（従来どおり）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 1. 静的チェック: 重なり順と「SHOPを閉じない」入口
 * ------------------------------------------------------------------ */
test('静的: #pro-modal は #shop-modal より手前の z-index（2050 > 2000）', () => {
    const html = read('index.html');

    const proTag = html.match(/<div id="pro-modal"[^>]*>/);
    const shopTag = html.match(/<div id="shop-modal"[^>]*>/);
    assert.ok(proTag, '#pro-modal が存在する');
    assert.ok(shopTag, '#shop-modal が存在する');

    assert.match(proTag[0], /z-\[2050\]/, 'Pro入力モーダルは z-[2050]');
    assert.match(shopTag[0], /z-\[2000\]/, 'SHOPは z-[2000] のまま');

    const zOf = (tag) => Number((tag.match(/z-\[(\d+)\]/) || [])[1]);
    assert.ok(zOf(proTag[0]) > zOf(shopTag[0]), 'Pro入力モーダルが上に重なる');
});

test('静的: CSS でも #pro-modal の z-index を確定させている（CDN生成に依存しない）', () => {
    const css = read('style.css');
    const rule = css.match(/#pro-modal\s*\{([^}]*)\}/);
    assert.ok(rule, '#pro-modal のルールがある');
    assert.match(rule[1], /z-index:\s*2050/, 'z-index: 2050 を明示');

    const layered = css.match(/#pro-modal\.pro-over-shop\s*\{([^}]*)\}/);
    assert.ok(layered, 'SHOPの上に重ねたときの幕のルールがある');
    assert.match(layered[1], /background-color:\s*rgba\(0,\s*0,\s*0,\s*0\.35\)/, '幕は35%（背後のSHOPが見える）');
    assert.match(layered[1], /backdrop-filter:\s*none/, '背景ぼかしは切る（SHOPの文字を読める状態で残す）');
});

test('静的: 「コード入力」の処理は SHOP を閉じない（hidden を付けない）', () => {
    const source = read('coins.js');
    const start = source.indexOf('const proFromShopBtn');
    assert.ok(start >= 0, 'SHOPのコード入力ボタンの処理がある');
    const block = source.slice(start, source.indexOf("container.querySelectorAll('.btn-buy-perk')", start));

    assert.doesNotMatch(block, /shop-modal'\)[\s\S]{0,80}classList\.add\('hidden'\)/,
        'SHOPを閉じる処理は残っていない');
    assert.match(block, /openProModalFromShop\(\)/, 'SHOPを残したまま開く専用処理を呼ぶ');
});

/* ------------------------------------------------------------------ *
 * DOM スタブ（coins.js / pro.js を読み込むための最小構成）
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

function createElement(id) {
    const listeners = {};
    return {
        id,
        textContent: '',
        innerHTML: '',
        value: '',
        className: '',
        style: {},
        dataset: {},
        disabled: false,
        attributes: {},
        classList: createClassList(),
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        removeEventListener() {},
        fire(type, event = {}) {
            return Promise.all((listeners[type] || []).map((handler) => handler(event)));
        },
        appendChild() {},
        removeChild() {},
        remove() {},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }; },
        focus() {},
        blur() {},
        closest() { return null; }
    };
}

function createHarness() {
    const storage = {};
    const elements = new Map();
    const documentListeners = [];
    const body = createElement('body');
    const html = createElement('html');

    const document = {
        body,
        documentElement: html,
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, createElement(id));
            return elements.get(id);
        },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        createElement: (tag) => createElement(tag),
        addEventListener(type, handler) { documentListeners.push({ type, handler }); },
        removeEventListener() {}
    };

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
        setTimeout: (fn, ms) => ({ fn, ms }),
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        confirm: () => true,
        alert() {},
        prompt: () => ''
    });

    vm.runInContext(read('pro.js'), context, { filename: 'pro.js' });
    vm.runInContext(read('coins.js'), context, { filename: 'coins.js' });

    const ProManager = vm.runInContext('ProManager', context);
    const CoinManager = vm.runInContext('CoinManager', context);

    const toasts = [];
    const teamBadgeRenders = [];
    const app = {
        showToast: (...args) => toasts.push(args),
        renderTeamBadge: () => teamBadgeRenders.push(Date.now()),
        updateStatsDisplay: () => { teamBadgeRenders.push(Date.now()); },
        proManager: new ProManager(),
        statsManager: {
            stats: {},
            unlockedTitles: [],
            activeTitle: '',
            getOrCreateReferralCode: () => 'ABC123'
        }
    };
    const manager = new CoinManager(app, null);
    app.coinManager = manager;

    return {
        app,
        manager,
        storage,
        document,
        element: (id) => document.getElementById(id),
        teamBadgeRenders,
        toasts
    };
}

const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/* ------------------------------------------------------------------ *
 * 2. SHOP の上に開く / 閉じると SHOP に戻る
 * ------------------------------------------------------------------ */
test('重ね表示: 「コード入力」で SHOP を開いたまま Pro入力モーダルが上に開く', () => {
    const h = createHarness();
    h.manager.openShopModal('perks');

    const shop = h.element('shop-modal');
    const pro = h.element('pro-modal');
    assert.equal(shop.classList.contains('hidden'), false, 'SHOPは開いている');

    const opened = h.manager.openProModalFromShop();

    assert.equal(opened, true);
    assert.equal(pro.classList.contains('hidden'), false, 'Pro入力モーダルが開く');
    assert.equal(shop.classList.contains('hidden'), false, 'SHOPは閉じない（背後に残る）');
    assert.equal(shop.style.display, 'flex', 'SHOPの表示は保たれる');
    assert.equal(shop.style.pointerEvents, 'auto', 'SHOPは触れる状態のまま');
    assert.equal(pro.classList.contains('pro-over-shop'), true, '重ね表示のときだけ幕を薄くする');
});

test('重ね表示: 幕は重ねたときだけ薄くなり、閉じると元に戻る', async () => {
    const h = createHarness();
    h.app.proManager.initModal(h.app);

    const pro = h.element('pro-modal');
    assert.equal(pro.classList.contains('pro-over-shop'), false, 'MENUからの単独表示では薄くしない');

    h.manager.openShopModal('perks');
    h.manager.openProModalFromShop();
    assert.equal(pro.classList.contains('pro-over-shop'), true);

    await h.element('btn-close-pro').fire('click');
    assert.equal(pro.classList.contains('pro-over-shop'), false, '閉じたら幕の調整も戻す');
});

test('重ね表示: MENUから開き直すと幕は標準（濃いまま）に戻る', async () => {
    const h = createHarness();
    h.app.proManager.initModal(h.app);

    const pro = h.element('pro-modal');
    h.manager.openShopModal('perks');
    h.manager.openProModalFromShop();

    h.element('btn-open-pro-modal').fire('click');
    await flush();

    assert.equal(pro.classList.contains('pro-over-shop'), false, 'MENU導線は従来の見た目');
    assert.equal(pro.classList.contains('hidden'), false);
});

test('重ね表示: Pro入力モーダルを閉じると SHOP がそのまま操作できる', async () => {
    const h = createHarness();
    h.app.proManager.initModal(h.app);

    h.manager.openShopModal('perks');
    h.manager.openProModalFromShop();

    const shop = h.element('shop-modal');
    const pro = h.element('pro-modal');

    await h.element('btn-close-pro').fire('click');

    assert.equal(pro.classList.contains('hidden'), true, 'Pro入力モーダルは閉じる');
    assert.equal(shop.classList.contains('hidden'), false, 'SHOPは開いたまま');
    assert.equal(shop.style.display, 'flex');
    assert.equal(shop.style.pointerEvents, 'auto', '閉じた後もSHOPを操作できる');

    // もう一度「コード入力」を押しても同じように開く
    h.manager.openProModalFromShop();
    assert.equal(pro.classList.contains('hidden'), false, '再度開ける');
});

test('重ね表示: 背景タップで閉じても SHOP は残る', async () => {
    const h = createHarness();
    h.app.proManager.initModal(h.app);
    h.manager.openShopModal('perks');
    h.manager.openProModalFromShop();

    const pro = h.element('pro-modal');
    await pro.fire('click', { target: pro });

    assert.equal(pro.classList.contains('hidden'), true);
    assert.equal(h.element('shop-modal').classList.contains('hidden'), false);
});

test('重ね表示: 入力欄が無い環境でも落ちずに開く', () => {
    const h = createHarness();
    h.document.getElementById = ((original) => (id) => (
        id === 'input-pro-code' ? null : original.call(h.document, id)
    ))(h.document.getElementById);

    h.manager.openShopModal('perks');
    assert.doesNotThrow(() => h.manager.openProModalFromShop());
    assert.equal(h.element('pro-modal').classList.contains('hidden'), false);
});

/* ------------------------------------------------------------------ *
 * 3. 有効化後の SHOP 側の即時更新
 * ------------------------------------------------------------------ */
test('有効化: SHOPを開いたまま成功すると、背後のSHOP表示（未登録→有効）も更新される', async () => {
    const h = createHarness();
    h.app.proManager.initModal(h.app);
    // 本物の activateCode と同じく、成功時は setPro(true) まで行う
    h.app.proManager.activateCode = async () => { h.app.proManager.setPro(true); return true; };

    h.manager.openShopModal('perks');
    h.manager.openProModalFromShop();

    const perks = h.element('container-shop-perks');
    assert.match(perks.innerHTML, /未登録/, '有効化前は「未登録」');

    h.element('input-pro-code').value = 'VALID-CODE';
    await h.element('btn-activate-pro').fire('click');
    await flush();

    assert.equal(h.app.proManager.isPro(), true, 'Pro状態が有効になる');
    assert.equal(h.element('pro-modal').classList.contains('hidden'), true, '入力モーダルは閉じる');
    assert.equal(h.element('shop-modal').classList.contains('hidden'), false, 'SHOPは開いたまま');
    assert.match(perks.innerHTML, /有効/, 'SHOPのProステータスが「有効」に更新される');
    assert.doesNotMatch(perks.innerHTML, /未登録/, '「未登録」は残らない');
    assert.match(perks.innerHTML, /解放済み|確認/, '特典・確認ボタンの状態も更新される');
    assert.ok(h.teamBadgeRenders.length > 0, 'ヘッダー側（バッジ等）も更新される');
});

test('有効化: 操作はSHOPのタブを保ったまま（機能タブのパネルが表示されたまま）', async () => {
    const h = createHarness();
    h.app.proManager.initModal(h.app);
    // 本物の activateCode と同じく、成功時は setPro(true) まで行う
    h.app.proManager.activateCode = async () => { h.app.proManager.setPro(true); return true; };

    h.manager.openShopModal('perks');
    h.manager.openProModalFromShop();

    h.element('input-pro-code').value = 'VALID-CODE';
    await h.element('btn-activate-pro').fire('click');
    await flush();

    assert.equal(h.element('panel-shop-perks').classList.contains('hidden'), false);
    assert.equal(h.element('panel-shop-earn').classList.contains('hidden'), true);
});

test('有効化: SHOPが閉じているときは再描画しない（従来のMENU導線を変えない）', async () => {
    const h = createHarness();
    h.app.proManager.initModal(h.app);
    // 本物の activateCode と同じく、成功時は setPro(true) まで行う
    h.app.proManager.activateCode = async () => { h.app.proManager.setPro(true); return true; };

    let renders = 0;
    const original = h.manager.renderShopPanels.bind(h.manager);
    h.manager.renderShopPanels = () => { renders += 1; return original(); };

    h.element('shop-modal').classList.add('hidden');
    h.element('input-pro-code').value = 'VALID-CODE';
    await h.element('btn-activate-pro').fire('click');
    await flush();

    assert.equal(h.app.proManager.isPro(), true);
    assert.equal(renders, 0, '閉じているSHOPのパネルは描き直さない');
    assert.equal(h.app.proManager.refreshShopAfterProChange(), false, '閉じていれば何もしない');
});

test('有効化失敗: コードが違うときは入力モーダルを閉じず、SHOPの表示も変えない', async () => {
    const h = createHarness();
    h.app.proManager.initModal(h.app);
    h.app.proManager.activateCode = async () => false;

    h.manager.openShopModal('perks');
    h.manager.openProModalFromShop();

    const perks = h.element('container-shop-perks');
    h.element('input-pro-code').value = 'WRONG';
    await h.element('btn-activate-pro').fire('click');
    await flush();

    assert.equal(h.app.proManager.isPro(), false);
    assert.equal(h.element('pro-modal').classList.contains('hidden'), false, '入力し直せるよう開いたまま');
    assert.match(perks.innerHTML, /未登録/);
    assert.equal(h.element('shop-modal').classList.contains('hidden'), false, 'SHOPは背後に残る');
});

/* ------------------------------------------------------------------ *
 * 4. www/ の配布物にも同じ修正が入る（ビルド同期の確認）
 * ------------------------------------------------------------------ */
test('www: ビルド成果物の #pro-modal も z-[2050] / SHOPを閉じない処理になっている', () => {
    const wwwHtml = read(path.join('www', 'index.html'));
    const wwwCoins = read(path.join('www', 'coins.js'));
    const wwwPro = read(path.join('www', 'pro.js'));

    assert.match(wwwHtml, /<div id="pro-modal" class="hidden fixed inset-0 z-\[2050\]/);
    assert.match(wwwCoins, /openProModalFromShop\(\)/);
    assert.doesNotMatch(
        wwwCoins.slice(wwwCoins.indexOf('const proFromShopBtn'), wwwCoins.indexOf("container.querySelectorAll('.btn-buy-perk')", wwwCoins.indexOf('const proFromShopBtn'))),
        /shop-modal'\)[\s\S]{0,80}classList\.add\('hidden'\)/
    );
    assert.match(wwwPro, /refreshShopAfterProChange\(\)/);
});
