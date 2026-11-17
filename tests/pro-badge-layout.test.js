/**
 * TERRITORY WALK - Node tests
 * v1.1 実機スクショ指摘：2段目バッジ行の並び
 *   ・左端は [YOU（○陣営）] だけ
 *   ・[PRO SUPPORTER] は同じ行の右端（☰ MENU の下の空き）へ右寄せ
 *   ・PRO 非表示のときも YOU は左端のまま
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function createElement(id) {
    return {
        id,
        innerHTML: '',
        textContent: '',
        className: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        setAttribute() {},
        style: {}
    };
}

function loadApp() {
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, createElement(id));
            return elements.get(id);
        },
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        body: { dataset: {} }
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document,
        window: {},
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        navigator: {},
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval() {}
    });
    vm.runInContext(APP_SOURCE, context, { filename: 'app.js' });
    return { TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context), elements, document };
}

function createApp(loaded, options = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    Object.assign(app, {
        isProActive: () => !!options.isPro,
        proManager: { getSupporterBadgeHtml: () => '<span id="pro-supporter">PRO SUPPORTER</span>' },
        currentTeam: options.team || 'white',
        barWhiteEl: null,
        barBlackEl: null,
        menuTeamText: null,
        teamBadgeContainer: null
    });
    return app;
}

test('バッジ行: 左端は YOU、PRO は右端の別枠（pro-badge-slot）に入る', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { isPro: true, team: 'white' });

    app.renderTeamBadge();

    const you = loaded.elements.get('you-indicator');
    const slot = loaded.elements.get('pro-badge-slot');

    assert.match(you.innerHTML, /YOU \(白陣営\)/, 'YOU は左端の箱に残る');
    assert.doesNotMatch(you.innerHTML, /PRO SUPPORTER/, 'YOU の箱に PRO を混ぜない');
    assert.match(slot.innerHTML, /PRO SUPPORTER/, 'PRO は右端の箱に入る');
});

test('バッジ行: 黒陣営でも同じ（YOU は左端・PRO は右端）', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { isPro: true, team: 'black' });

    app.renderTeamBadge();

    assert.match(loaded.elements.get('you-indicator').innerHTML, /YOU \(黒陣営\)/);
    assert.doesNotMatch(loaded.elements.get('you-indicator').innerHTML, /PRO SUPPORTER/);
    assert.match(loaded.elements.get('pro-badge-slot').innerHTML, /PRO SUPPORTER/);
});

test('バッジ行: PRO でないときは右端が空でも YOU は左端に留まる', () => {
    const loaded = loadApp();
    const app = createApp(loaded, { isPro: false, team: 'white' });

    app.renderTeamBadge();

    assert.match(loaded.elements.get('you-indicator').innerHTML, /YOU \(白陣営\)/);
    assert.equal(loaded.elements.get('pro-badge-slot').innerHTML, '', '右端の箱は空のまま');
});

test('バッジ行: HTML は justify-between で左右に振り分けている', () => {
    assert.match(INDEX, /id="pro-badge-slot"/, 'PRO の置き場所がある');
    const rowStart = INDEX.indexOf('id="you-indicator"');
    const slotIndex = INDEX.indexOf('id="pro-badge-slot"');
    assert.ok(rowStart > 0 && slotIndex > rowStart, 'YOU の後ろ（右側）に PRO を置く');

    // 同じ行のコンテナが左右振り分けになっている
    const beforeYou = INDEX.slice(Math.max(0, rowStart - 400), rowStart);
    assert.match(beforeYou, /justify-between/, '左端と右端に振り分ける');

    // 同期バッジも右側のまとまりの中に入れる（PRO と重ならない）
    assert.ok(INDEX.indexOf('id="sync-queue-badge"') < slotIndex, '同期バッジの右隣に PRO');
});

test('バッジ行: renderTeamBadge はスロット経由で PRO を描く', () => {
    assert.match(APP_SOURCE, /const proBadgeSlot = document\.getElementById\('pro-badge-slot'\)/);
    assert.match(APP_SOURCE, /proBadgeSlot\.innerHTML = supporterBadge/);
});
