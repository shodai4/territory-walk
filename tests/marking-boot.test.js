/**
 * TERRITORY WALK - Node tests
 * 陣地マーキング ON/OFF：起動（コンストラクタ）からの通り抜け確認
 *
 * app.js を「DOM を最小スタブした vm」で実際に起動し、
 *   1) 停止中に起動 → 位置情報ウォッチャーを1本も張らず、停止バーが出る
 *   2) 停止していなければ従来どおり起動直後に測位が始まる
 *   3) 起動後の再開／停止で測位とバーの表示が切り替わる
 * を確かめる（メソッド単体では見えない initDOM → initMarkingToggle の配線もここで通る）。
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
 * DOM / 外部ライブラリの最小スタブ
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
    if (options.markingPaused) storage.tw_marking_paused = '1';
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

    const app = vm.runInContext('new TerritoryWalkApp()', context);
    return { app, context, elements, getElement, storage, geo };
}

/* ------------------------------------------------------------------ *
 * 1. 停止中に起動したら、測位を一切始めない
 * ------------------------------------------------------------------ */
test('起動（停止中）: 位置情報ウォッチャーを張らず、停止バーと「停止中」表示になる', () => {
    const { app, getElement, geo } = bootApp({ markingPaused: true });

    assert.equal(app.markingPaused, true, 'localStorage の停止状態を復元する');
    assert.equal(app.servicesStarted, true, '初回ゲート通過後の開始処理は走る');
    assert.equal(app.geolocationStarted, false);
    assert.equal(geo.watchPosition, 0, 'watchPosition を張らない');
    assert.equal(geo.getCurrentPosition, 0, '単発測位も要求しない');

    const banner = getElement('marking-paused-banner');
    assert.equal(banner.classList.contains('hidden'), false, '停止バーが出る');
    assert.equal(getElement('marking-toggle-label').textContent, '停止中');
    assert.equal(getElement('btn-marking-toggle').dataset.state, 'paused');
    assert.match(banner.style.top, /^\d+px$/, 'ヘッダー実測で位置を決める');
});

test('起動（通常）: 従来どおり起動直後に測位を開始し、停止バーは出ない', () => {
    const { app, getElement, geo } = bootApp({ markingPaused: false });

    assert.equal(app.markingPaused, false);
    assert.equal(app.geolocationStarted, true);
    assert.equal(geo.watchPosition, 1, 'watcher は1本だけ');
    assert.equal(getElement('marking-paused-banner').classList.contains('hidden'), true);
    assert.equal(getElement('marking-toggle-label').textContent, 'ON');
});

/* ------------------------------------------------------------------ *
 * 2. 起動後の切り替え（initDOM → initMarkingToggle の配線）
 * ------------------------------------------------------------------ */
test('起動後: 停止で測位が止まり、再開で測位が戻る（二重起動なし）', () => {
    const { app, getElement, geo, storage } = bootApp({ markingPaused: false });
    const banner = getElement('marking-paused-banner');
    const label = getElement('marking-toggle-label');

    app.toggleMarkingPaused();
    assert.equal(app.markingPaused, true);
    assert.deepEqual(geo.clearWatch, [5], 'watchPosition を clearWatch で止める');
    assert.equal(storage.tw_marking_paused, '1');
    assert.equal(banner.classList.contains('hidden'), false);
    assert.equal(label.textContent, '停止中');

    app.toggleMarkingPaused();
    assert.equal(app.markingPaused, false);
    assert.equal(geo.watchPosition, 2, '再開で張り直す（1本だけ増える）');
    assert.equal(storage.tw_marking_paused, '0');
    assert.equal(banner.classList.contains('hidden'), true);
    assert.equal(label.textContent, 'ON');
});
