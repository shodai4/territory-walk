/**
 * TERRITORY WALK - Node tests
 * v1.1 画面まわりの起動スモーク（jsdomなし・最小DOMスタブ）
 *   1) 非表示ピンのモーダルを開いて、現在地で登録→一覧に出る→削除できる
 *   2) 地図タップで登録するモードが1回で解除される
 *   3) 月曜の結果通知のトグルが、通知ON/OFFで表示を切り替える
 *   4) メニューを開いたときに件数表示が更新される
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
 * 最小DOM
 * ------------------------------------------------------------------ */
function createElement(tag = 'div') {
    const listeners = {};
    const el = {
        tagName: tag.toUpperCase(),
        children: [],
        attributes: {},
        dataset: {},
        style: {},
        value: '',
        textContent: '',
        disabled: false,
        className: '',
        classList: {
            set: new Set(),
            add(...names) { names.forEach((name) => this.set.add(name)); },
            remove(...names) { names.forEach((name) => this.set.delete(name)); },
            toggle(name, force) {
                const on = force === undefined ? !this.set.has(name) : force;
                if (on) this.set.add(name); else this.set.delete(name);
                return on;
            },
            contains(name) { return this.set.has(name); }
        },
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        removeEventListener() {},
        dispatch(type, event = {}) {
            (listeners[type] || []).forEach((handler) => handler({ type, target: el, preventDefault() {}, ...event }));
        },
        appendChild(child) { el.children.push(child); return child; },
        removeChild(child) {
            el.children = el.children.filter((item) => item !== child);
            return child;
        },
        setAttribute(name, value) { el.attributes[name] = String(value); },
        getAttribute(name) { return el.attributes[name] === undefined ? null : el.attributes[name]; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
    // innerHTML = '' でのクリアを再現する（renderUI が使う）
    let innerHTMLValue = '';
    Object.defineProperty(el, 'innerHTML', {
        get() { return innerHTMLValue; },
        set(value) {
            innerHTMLValue = value;
            if (value === '') el.children = [];
        }
    });
    return el;
}

function createDocument(ids, radiusButtons = []) {
    const elements = new Map();
    ids.forEach((id) => {
        const el = createElement(id.includes('input') ? 'input' : 'div');
        el.id = id;
        elements.set(id, el);
    });
    return {
        body: { dataset: {}, classList: createElement().classList },
        getElementById: (id) => elements.get(id) || null,
        createElement,
        querySelectorAll: (selector) => {
            if (selector === '[data-privacy-radius]') return radiusButtons;
            return [];
        },
        elements
    };
}

function createStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key)
    };
}

/**
 * privacy.js / notifications.js / watch-bridge.js を1つの文脈で読み込む。
 * ブラウザの古典スクリプトと同じく、class 宣言はグローバル字句環境に入るので
 * vm.runInContext で名前を引いて取り出す。
 */
function loadModules(context) {
    const sandbox = vm.createContext(context);
    ['privacy.js', 'notifications.js', 'watch-bridge.js'].forEach((file) => {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        vm.runInContext(source, sandbox, { filename: file });
    });
    const pick = (name) => vm.runInContext(name, sandbox);
    return {
        PrivacyZoneManager: pick('PrivacyZoneManager'),
        WeeklyResultNotifier: pick('WeeklyResultNotifier'),
        WatchBridgeClient: pick('WatchBridgeClient')
    };
}

const PRIVACY_IDS = [
    'privacy-modal', 'privacy-zone-list', 'privacy-zone-empty', 'privacy-zone-count',
    'input-privacy-label', 'privacy-pending-center', 'btn-privacy-add-current',
    'btn-privacy-add-map', 'btn-close-privacy', 'btn-close-privacy-icon', 'btn-open-privacy',
    'menu-modal', 'privacy-summary-text', 'btn-toggle-weekly-notify', 'weekly-notify-dot',
    'weekly-notify-text'
];

function setup() {
    const radiusButtons = [300, 500].map((value) => {
        const el = createElement('button');
        el.setAttribute('data-privacy-radius', String(value));
        return el;
    });
    const doc = createDocument(PRIVACY_IDS, radiusButtons);
    const storage = createStorage();
    const toasts = [];
    const app = {
        map: null,
        gridManager: null,
        virtualPos: [34.6, 135.6],
        showToast: (message) => toasts.push(message),
        currentTeam: 'black',
        isMarkingPaused: () => false,
        setMarkingPaused: () => true
    };
    const sandbox = loadModules({
        document: doc,
        localStorage: storage,
        window: {},
        setInterval,
        clearInterval,
        console
    });
    return { doc, storage, toasts, app, sandbox, radiusButtons };
}

/* ------------------------------------------------------------------ *
 * 1: 登録→一覧→削除
 * ------------------------------------------------------------------ */

test('スモーク: 現在地で登録すると一覧に出て、削除で消える', () => {
    const { doc, app, sandbox, toasts } = setup();
    const manager = new sandbox.PrivacyZoneManager(app);
    manager.initUI();

    assert.equal(doc.getElementById('privacy-zone-count').textContent, '0 / 5');

    doc.getElementById('btn-open-privacy').dispatch('click');
    assert.equal(doc.getElementById('privacy-modal').classList.contains('hidden'), false, 'モーダルが開く');

    doc.getElementById('input-privacy-label').value = '自宅';
    doc.getElementById('btn-privacy-add-current').dispatch('click');

    const list = doc.getElementById('privacy-zone-list');
    assert.equal(list.children.length, 1, '一覧に1件');
    assert.equal(list.children[0].children[0].children[0].textContent, '自宅', '名前が出る');
    assert.match(list.children[0].children[0].children[1].textContent, /半径 300m/);
    assert.equal(doc.getElementById('privacy-zone-count').textContent, '1 / 5');
    assert.equal(doc.getElementById('privacy-modal').classList.contains('hidden'), true, '登録後に閉じる');
    assert.ok(toasts.some((message) => message.includes('登録しました')));

    // 削除
    const deleteButton = list.children[0].children[1];
    deleteButton.dispatch('click');
    assert.equal(manager.getZones().length, 0);
    assert.equal(doc.getElementById('privacy-zone-list').children.length, 0);
    assert.equal(doc.getElementById('privacy-zone-count').textContent, '0 / 5');
});

test('スモーク: 半径ボタンで 500m を選ぶと、その半径で登録される', () => {
    const { doc, app, sandbox } = setup();
    const manager = new sandbox.PrivacyZoneManager(app);
    manager.initUI();

    manager.openModal();
    const fiveHundred = doc
        .querySelectorAll('[data-privacy-radius]')
        .find((button) => button.getAttribute('data-privacy-radius') === '500');
    fiveHundred.dispatch('click');
    assert.equal(manager.radius, 500);

    doc.getElementById('btn-privacy-add-current').dispatch('click');
    assert.equal(manager.getZones()[0].radius, 500);
    assert.equal(fiveHundred.getAttribute('aria-pressed'), 'true');
});

test('スモーク: 5件登録すると追加ボタンが押せなくなる', () => {
    const { doc, app, sandbox } = setup();
    const manager = new sandbox.PrivacyZoneManager(app);
    manager.initUI();
    for (let i = 0; i < 6; i += 1) {
        manager.add({ lat: 34.6 + i * 0.01, lng: 135.6, radius: 300, label: `場所${i}` });
    }
    assert.equal(manager.getZones().length, 5);
    assert.equal(doc.getElementById('btn-privacy-add-current').disabled, true);
    assert.equal(doc.getElementById('privacy-zone-count').textContent, '5 / 5');
});

/* ------------------------------------------------------------------ *
 * 2: 地図タップ
 * ------------------------------------------------------------------ */

test('スモーク: 地図タップで登録モードになり、1回タップで解除＋指定地点が出る', () => {
    let clickHandler = null;
    const map = {
        on: () => {},
        off: () => {},
        once: (type, handler) => { if (type === 'click') clickHandler = handler; },
        removeLayer: () => {},
        addLayer: () => {}
    };
    const { doc, app, sandbox } = setup();
    app.map = map;
    const manager = new sandbox.PrivacyZoneManager(app);
    manager.initUI();
    manager.openModal();

    doc.getElementById('btn-privacy-add-map').dispatch('click');
    assert.equal(manager.pickMode, true);
    assert.equal(typeof clickHandler, 'function');

    clickHandler({ latlng: { lat: 34.61, lng: 135.62 } });
    assert.equal(manager.pickMode, false, '1回で解除');
    assert.equal(manager.pendingCenter.lat, 34.61);
    assert.equal(manager.pendingCenter.lng, 135.62);
    assert.match(doc.getElementById('privacy-pending-center').textContent, /34\.61000, 135\.62000/);
    assert.equal(doc.getElementById('btn-privacy-add-current').textContent, 'この地点で登録');
});

/* ------------------------------------------------------------------ *
 * 3: 通知トグル
 * ------------------------------------------------------------------ */

test('スモーク: 通知トグルは未対応環境でOFFのまま（表示もOFF）', async () => {
    const { doc, sandbox } = setup();
    const notifier = new sandbox.WeeklyResultNotifier({ showToast: () => {} });
    notifier.bindUI();
    notifier.renderUI();
    assert.equal(doc.getElementById('weekly-notify-text').textContent, 'OFF');

    doc.getElementById('btn-toggle-weekly-notify').dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(notifier.enabled, false);
    assert.equal(doc.getElementById('weekly-notify-text').textContent, 'OFF');
});
