/**
 * TERRITORY WALK - Node tests
 * 「テーマ・マップ設定」のレイアウト崩れ防止
 *   1) 背景地図カラー：col-span 混在なし・文字切れ（truncate）なし・価格バッジは1行
 *   2) マステーマ：同じ2段（名前＋状態/価格バッジ）レイアウトで統一
 *   3) index.html のグリッド設定が揃っている（auto-rows-fr の2列）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * coins.js を vm 上で読み、DOM をスタブして描画結果（innerHTML）を取り出す。
 */
function createClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        toggle: (name, force) => { if (force === undefined ? !set.has(name) : force) set.add(name); else set.delete(name); },
        contains: (name) => set.has(name),
        values: () => [...set]
    };
}

/** どの id でも取り出せる汎用要素スタブ（coins.js の初期化を素通しさせる） */
function createAnyElement(id) {
    const listeners = {};
    return {
        id,
        textContent: '',
        innerHTML: '',
        className: '',
        style: {},
        dataset: {},
        classList: createClassList(),
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        removeEventListener() {},
        appendChild() {},
        removeChild() {},
        remove() {},
        setAttribute() {},
        removeAttribute() {},
        getAttribute() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }; },
        focus() {},
        blur() {}
    };
}

/**
 * coins.js を vm 上で読み、DOM をスタブして描画結果（innerHTML）を取り出す。
 */
function loadCoinManager(options = {}) {
    const container = { innerHTML: '', querySelectorAll: () => [] };
    const skinButtons = options.skinButtons || [];
    const storage = options.storage || {};
    const elements = new Map();
    const body = createAnyElement('body');
    body.dataset.skin = options.skin || 'default';

    const document = {
        body,
        getElementById: (id) => {
            if (id === 'map-theme-buttons-container') return container;
            if (!elements.has(id)) elements.set(id, createAnyElement(id));
            return elements.get(id);
        },
        querySelectorAll: (selector) => (selector === '.skin-btn' ? skinButtons : []),
        querySelector: () => null,
        createElement: (tag) => createAnyElement(tag),
        addEventListener: () => {}
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
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        confirm: () => false
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'coins.js'), 'utf8'), context, { filename: 'coins.js' });

    const CoinManager = vm.runInContext('CoinManager', context);
    const manager = new CoinManager({ showToast: () => {} }, null);
    return { manager, container, skinButtons };
}

/** map-theme-btn 1件分の HTML を配列で取り出す */
function splitThemeButtons(html) {
    return html.split('<button').slice(1).map((chunk) => `<button${chunk}`);
}

function createSkinButtons() {
    return ['default', 'pixel', 'sakura', 'monochrome', 'crimson', 'neon', 'gold', 'cyberpunk']
        .map((skin) => ({ dataset: { skin }, className: '', innerHTML: '' }));
}

/* ------------------------------------------------------------------ *
 * 1. 背景地図カラー
 * ------------------------------------------------------------------ */
test('背景地図カラー: 5種すべてが同じカード幅（col-span 混在なし）で描画される', () => {
    const { manager, container } = loadCoinManager();
    manager.renderMapThemesPanel();

    const buttons = splitThemeButtons(container.innerHTML);
    assert.equal(buttons.length, 5, '5種すべて描画する');
    buttons.forEach((html) => {
        assert.doesNotMatch(html, /col-span/, 'カード幅を個別に変えない');
        assert.match(html, /w-full/, 'カードは常に列幅いっぱい');
        assert.match(html, /flex-col/, '名前とバッジは縦積み2段');
    });
    assert.doesNotMatch(container.innerHTML, /col-span-2/);
});

test('背景地図カラー: 名前は省略されず、価格バッジは必ず1行（whitespace-nowrap）', () => {
    const { manager, container } = loadCoinManager();
    manager.renderMapThemesPanel();

    // 「ストリート」が「ストリ…」にならない
    assert.doesNotMatch(container.innerHTML, /truncate/);
    assert.match(container.innerHTML, /<span class="map-theme-name[^"]*whitespace-nowrap[^"]*">ストリート<\/span>/);
    assert.match(container.innerHTML, /<span class="map-theme-badge[^"]*whitespace-nowrap[^"]*">6,000 COIN<\/span>/);

    const badgeCount = (container.innerHTML.match(/map-theme-badge/g) || []).length;
    assert.equal(badgeCount, 5, 'すべてのカードにバッジが1つずつ付く');

    const buttons = splitThemeButtons(container.innerHTML);
    buttons.forEach((html) => {
        const badge = html.match(/map-theme-badge[^>]*>([^<]*)</);
        assert.ok(badge, 'バッジ文言がある');
        assert.doesNotMatch(badge[1], /\n/, 'バッジ内で改行しない');
    });
});

test('背景地図カラー: 未所持は価格、所持は「所持」、選択中は「選択中」を出す', () => {
    const { manager, container } = loadCoinManager({ storage: { tw_map_theme: 'mono' } });
    manager.renderMapThemesPanel();

    assert.match(container.innerHTML, /map-theme-badge[^>]*>選択中</);
    assert.match(container.innerHTML, /map-theme-badge[^>]*>所持</);
    assert.match(container.innerHTML, /map-theme-badge[^>]*>3,000 COIN</);
    assert.match(container.innerHTML, /map-theme-badge[^>]*>12,000 COIN</);
});

/* ------------------------------------------------------------------ *
 * 2. マステーマ
 * ------------------------------------------------------------------ */
test('マステーマ: 名前とバッジの2段で揃い、truncate を使わない', () => {
    const skinButtons = createSkinButtons();
    const { manager } = loadCoinManager({ skinButtons, storage: { territory_skin: 'default' } });
    manager.updateSkinButtonsUI();

    assert.equal(skinButtons.length, 8);
    skinButtons.forEach((button) => {
        assert.doesNotMatch(button.className, /truncate/, '文字切れの原因になる truncate を付けない');
        assert.match(button.className, /flex-col/, '名前とバッジは縦積み2段');
        assert.match(button.className, /h-full/, 'グリッド行の高さに揃える');
        assert.match(button.innerHTML, /<span class="skin-name[^"]*whitespace-nowrap[^"]*">/);
        assert.match(button.innerHTML, /<span class="skin-badge[^"]*whitespace-nowrap[^"]*">/);
        assert.doesNotMatch(button.innerHTML, /truncate/);
    });

    // 未所持は価格も1行のバッジで出る（名前と・で連結しない）
    const crimson = skinButtons.find((button) => button.dataset.skin === 'crimson');
    assert.match(crimson.innerHTML, /skin-name[^>]*>クリムゾン</);
    assert.match(crimson.innerHTML, /skin-badge[^>]*>8,000 COIN</);
    assert.doesNotMatch(crimson.innerHTML, /・/);

    const standard = skinButtons.find((button) => button.dataset.skin === 'default');
    assert.match(standard.className, /border-emerald-400/, '選択中はエメラルド枠');
    assert.match(standard.innerHTML, /skin-badge[^>]*>選択中</);
});

/* ------------------------------------------------------------------ *
 * 3. index.html のグリッド設定
 * ------------------------------------------------------------------ */
function themeSection() {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const start = html.indexOf('テーマ・マップ設定');
    const end = html.indexOf('デバッグモード', start);
    assert.ok(start !== -1 && end !== -1, 'テーマ・マップ設定セクションがある');
    return html.slice(start, end);
}

test('設定画面: マステーマ・背景地図カラーとも2列（auto-rows-fr）の等幅グリッド', () => {
    const section = themeSection();

    assert.match(section, /class="[^"]*grid grid-cols-2 gap-2 auto-rows-fr[^"]*"\s+id="skin-buttons-container"/);
    assert.match(section, /class="[^"]*grid grid-cols-2 gap-2 auto-rows-fr[^"]*"\s+id="map-theme-buttons-container"/);
    assert.doesNotMatch(section, /col-span/, 'セル幅を個別に変えない');
});

test('設定画面: マステーマの初期HTMLも truncate なし・バッジ1行', () => {
    const section = themeSection();
    const buttons = section.split('<button').slice(1).filter((chunk) => chunk.includes('class="skin-btn'));

    assert.equal(buttons.length, 8, 'マステーマは8種');
    buttons.forEach((html) => {
        assert.doesNotMatch(html, /truncate/);
        assert.match(html, /skin-name[^"]*whitespace-nowrap/);
        assert.match(html, /skin-badge[^"]*whitespace-nowrap/);
    });
});
