/**
 * TERRITORY WALK - Node tests
 * App Store 提出ビルド（CONFIG.ENABLE_DEBUG_TOOLS = false）の動作確認。
 *
 * 提出直前はユーザーの指示でフラグを true のまま検証を続けるため、
 * 「false に切り替えたときにアプリが壊れないか」をこのテストで常時裏取りする。
 *   1) false でも起動が最後まで通り、例外を投げない
 *   2) デバッグUI（MENUのデバッグ欄・D-PAD）が出ない
 *   3) デバッグ操作（仮想散歩・チーム切替の入口・陣地リセット）が無効
 *   4) 位置情報・マーキング再開など、本来の機能は true のときと変わらず動く
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
 * 最小限のDOMスタブ（marking-boot.test.js と同じ方式）
 * ------------------------------------------------------------------ */
function createClassList() {
    const set = new Set();
    return {
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        toggle: (name, force) => {
            const on = force === undefined ? !set.has(name) : force;
            if (on) set.add(name); else set.delete(name);
            return on;
        },
        contains: (name) => set.has(name),
        values: () => [...set]
    };
}

function createElement(id) {
    const el = {
        id,
        textContent: '',
        innerHTML: '',
        className: '',
        value: '',
        checked: false,
        disabled: false,
        classList: createClassList(),
        style: {},
        dataset: {},
        children: [],
        options: [],
        addEventListener() {},
        removeEventListener() {},
        appendChild(child) { el.children.push(child); return child; },
        removeChild() {},
        remove() {},
        insertBefore(child) { return child; },
        setAttribute() {},
        getAttribute() { return null; },
        removeAttribute() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        insertAdjacentHTML() {},
        closest() { return null; },
        getContext() { return null; },
        animate() { return { finished: Promise.resolve() }; },
        matches() { return false; },
        contains() { return false; },
        focus() {},
        blur() {},
        click() {},
        scrollTo() {},
        reset() {},
        cloneNode() { return createElement(id); },
        getBoundingClientRect() {
            return { top: 0, bottom: 150, height: 150, left: 0, right: 375, width: 375 };
        }
    };
    return el;
}

/** 何を呼んでも同じプロキシを返す（Leaflet / Supabase / AdMob 等を素通しさせる） */
function chainable(name) {
    const fn = function () { return chainable(name); };
    return new Proxy(fn, {
        get(target, prop) {
            if (prop === 'then') return undefined;
            if (prop === Symbol.toPrimitive) return () => 1;
            if (prop === 'length') return 0;
            if (prop === 'prototype') return {};
            return chainable(String(prop));
        },
        set() { return true; },
        apply() { return chainable(name); },
        construct() { return chainable(name); }
    });
}

function bootApp(options = {}) {
    const elements = new Map();
    const getElement = (id) => {
        if (!elements.has(id)) elements.set(id, createElement(id));
        return elements.get(id);
    };
    const doc = {
        body: createElement('body'),
        documentElement: createElement('html'),
        hidden: false,
        visibilityState: 'visible',
        title: 'test',
        getElementById: getElement,
        createElement: () => createElement('created'),
        querySelector: (selector) => createElement(selector),
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        createTextNode: (text) => ({ text })
    };

    const storage = { territory_rules_seen_v1: 'true' };
    const geo = { watchPosition: 0, getCurrentPosition: 0, clearWatch: [] };

    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        document: doc,
        navigator: {
            userAgent: 'node',
            language: 'ja',
            geolocation: {
                watchPosition: () => { geo.watchPosition += 1; return 5; },
                getCurrentPosition: () => { geo.getCurrentPosition += 1; },
                clearWatch: (id) => geo.clearWatch.push(id)
            }
        },
        localStorage: {
            getItem: (key) => (key in storage ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; },
            key: () => null,
            length: 0
        },
        location: { search: '', href: 'http://localhost/', origin: 'http://localhost' },
        screen: { width: 375, height: 812 },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval() {},
        requestAnimationFrame: (cb) => setTimeout(cb, 0),
        MutationObserver: function () { return { observe() {}, disconnect() {}, takeRecords: () => [] }; },
        IntersectionObserver: function () { return { observe() {}, disconnect() {} }; },
        ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
        L: chainable('L'),
        supabase: chainable('supabase'),
        AdMob: chainable('AdMob'),
        cordova: chainable('cordova'),
        CdvPurchase: chainable('CdvPurchase'),
        store: chainable('store'),
        Image: function () { return createElement('img'); },
        AudioContext: function () {
            return {
                currentTime: 0,
                destination: {},
                close() {},
                createOscillator: () => ({
                    connect() {}, start() {},
                    frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }
                }),
                createGain: () => ({
                    connect() {},
                    gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }
                })
            };
        },
        matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
        URLSearchParams: class { get() { return null; } has() { return false; } },
        URL: class { constructor(url) { this.href = url; } },
        alert() {},
        confirm: () => false,
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window.addEventListener = () => {};
    sandbox.window.removeEventListener = () => {};
    sandbox.window.localStorage = sandbox.localStorage;
    sandbox.window.location = sandbox.location;
    sandbox.window.navigator = sandbox.navigator;
    sandbox.window.document = doc;
    sandbox.window.screen = sandbox.screen;

    const context = vm.createContext(sandbox);
    ['permission.js', 'pro.js', 'poster.js', 'supabase.js', 'stats.js', 'coins.js', 'search.js',
     'admob.js', 'iap.js', 'grid.js', 'outbox.js', 'startup-gate.js', 'debug-tools.js', 'app.js'
    ].forEach((file) => {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    });

    // 提出ビルド相当に切り替えてから起動する（アプリ側と同じ1か所のスイッチ）
    vm.runInContext(`CONFIG.ENABLE_DEBUG_TOOLS = ${options.debugTools === false ? 'false' : 'true'};`, context);

    const app = vm.runInContext('new TerritoryWalkApp()', context);
    return { app, context, elements, getElement, storage, geo };
}

/* ------------------------------------------------------------------ *
 * 1. 起動
 * ------------------------------------------------------------------ */
test('提出ビルド相当（ENABLE_DEBUG_TOOLS=false）でも起動が完了する', () => {
    const { app, getElement, geo } = bootApp({ debugTools: false });

    assert.equal(app.debugEnabled, false, 'デバッグ機能は無効');
    assert.equal(app.servicesStarted, true, '初回ゲート通過後の開始処理は走る');
    assert.equal(geo.watchPosition, 1, '位置情報ウォッチャーは通常どおり1本');
    assert.equal(getElement('marking-toggle-label').textContent, 'ON', 'マーキングはONのまま');
});

test('提出ビルド相当: デバッグUI（MENUのデバッグ欄・D-PAD）が表示されない', () => {
    const { getElement } = bootApp({ debugTools: false });

    assert.equal(getElement('debug-mode-section').classList.contains('hidden'), true, 'デバッグモード欄は隠れる');
    assert.equal(getElement('dpad-container').classList.contains('hidden'), true, 'D-PADは隠れる');
});

test('提出ビルド相当: デバッグ操作が無効（仮想散歩・トグル・陣地リセット）', async () => {
    const { app, context, getElement } = bootApp({ debugTools: false });

    assert.equal(app.isVirtualWalkActive(), false);

    app.toggleDebugMode();
    assert.equal(app.isDebugMode, false, 'デバッグトグルは無効');
    assert.equal(getElement('dpad-container').classList.contains('hidden'), true, 'D-PADは開かない');

    const isEnabled = vm.runInContext('DebugTools.isEnabled(this.__app)', Object.assign(context, { __app: app }));
    assert.equal(isEnabled, false, 'DebugTools も無効を返す');

    const reset = await vm.runInContext('DebugTools.resetTerritories(this.__app, {})', Object.assign(context, { __app: app }));
    assert.equal(reset.ok, false, '陣地リセットは実行されない');
    assert.equal(reset.reason, 'debug-disabled', '無効理由も明示される');

    await app.resetAllTerritories();
    assert.equal(app.debugEnabled, false);
});

test('提出ビルド相当: マーキングの一時停止／再開は通常どおり動く', () => {
    const { app, getElement } = bootApp({ debugTools: false });

    app.toggleMarkingPaused();
    assert.equal(app.markingPaused, true);
    assert.equal(getElement('marking-paused-banner').classList.contains('hidden'), false);

    app.toggleMarkingPaused();
    assert.equal(app.markingPaused, false);
    assert.equal(getElement('marking-paused-banner').classList.contains('hidden'), true);
});

/* ------------------------------------------------------------------ *
 * 2. テスト中（ENABLE_DEBUG_TOOLS=true）は従来どおり使える
 * ------------------------------------------------------------------ */
test('検証ビルド（ENABLE_DEBUG_TOOLS=true）: デバッグ欄とトグルが使える', () => {
    const { app, getElement } = bootApp({ debugTools: true });

    assert.equal(app.debugEnabled, true);
    assert.equal(getElement('debug-mode-section').classList.contains('hidden'), false, 'デバッグモード欄が出る');

    app.toggleDebugMode();
    assert.equal(app.isDebugMode, true);
    assert.equal(getElement('dpad-container').classList.contains('hidden'), false, 'D-PADが開く');
});

/* ------------------------------------------------------------------ *
 * 3. フラグの置き場所（提出前の切替を1か所で済ませる）
 * ------------------------------------------------------------------ */
test('配線: ENABLE_DEBUG_TOOLS は app.js の CONFIG に1か所だけある', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const matches = appSource.match(/ENABLE_DEBUG_TOOLS\s*:/g) || [];
    assert.equal(matches.length, 1, '定義は1か所だけ');
    assert.match(appSource, /ENABLE_DEBUG_TOOLS:\s*(true|false)/);
});

test('配線: 広告のテスト／本番も同じフラグに連動する（admob.js）', () => {
    const admobSource = fs.readFileSync(path.join(ROOT, 'admob.js'), 'utf8');
    assert.match(admobSource, /CONFIG\.ENABLE_DEBUG_TOOLS !== false/);
});
