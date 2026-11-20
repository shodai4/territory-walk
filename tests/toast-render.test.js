/**
 * TERRITORY WALK - Node tests
 * トースト描画（app.js renderToast）
 *   1) `\n` を改行として描画できる（white-space: pre-line）
 *   2) 文言は textContent で入れる（HTML をタグとして解釈しない＝XSS 安全）
 *   3) message / subtitle の2行構成がそのまま2つの行として出る
 *   4) 375px幅で折り返さないための break-keep（語の途中で折らない）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readAppSource, readWwwAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = readAppSource();

/* ------------------------------------------------------------------ *
 * 最小限のDOMスタブ（jsdom を使わず、app.js を vm 上で動かす）
 * ------------------------------------------------------------------ */
function createStubElement(tag = 'div') {
    const el = {
        tagName: tag,
        id: '',
        className: '',
        children: [],
        style: {},
        textContent: '',
        _innerHTML: '',
        classList: {
            add() {},
            remove() {},
            contains() { return false; }
        },
        appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
            return child;
        },
        removeChild(child) {
            const index = this.children.indexOf(child);
            if (index >= 0) this.children.splice(index, 1);
            return child;
        },
        setAttribute() {},
        getAttribute() { return null; },
        addEventListener() {},
        getBoundingClientRect() {
            return { top: 0, bottom: 0, height: 0, left: 0, right: 375, width: 375 };
        }
    };
    Object.defineProperty(el, 'innerHTML', {
        get() { return this._innerHTML; },
        set(value) { this._innerHTML = String(value); this.children = []; }
    });
    return el;
}

function loadApp() {
    const elements = new Map();
    const body = createStubElement('body');
    const document = {
        body,
        getElementById(id) {
            if (!elements.has(id)) return null;
            return elements.get(id);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement: (tag) => createStubElement(tag),
        addEventListener() {}
    };

    const timers = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document,
        navigator: {},
        window: {},
        localStorage: {
            getItem: () => null,
            setItem() {},
            removeItem() {}
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
        clearInterval() {}
    };

    const context = vm.createContext(sandbox);
    vm.runInContext(APP_SOURCE, context, { filename: 'app.js' });

    const TerritoryWalkApp = vm.runInContext('TerritoryWalkApp', context);
    // コンストラクタは通さず、トースト描画に必要な状態だけを持たせる
    const app = Object.create(TerritoryWalkApp.prototype);
    app.toastQueue = [];
    app.toastTimer = null;
    app.isAnyModalOpen = () => false;

    /** トースト描画で作られたコンテナ（初回renderで body に追加される） */
    function getContainer() {
        return body.children.find((child) => child.id === 'toast-container') || null;
    }

    return { app, body, document, elements, timers, getContainer };
}

/* ------------------------------------------------------------------ *
 * 1. `\n` を改行として描画する
 * ------------------------------------------------------------------ */
test('描画: message 内の改行は pre-line で改行として出る', () => {
    const { app, getContainer } = loadApp();
    app.renderToast('スタンダードパック (¥500) を獲得！\n広告完全非表示（Ad-Free）も解放しました');

    const container = getContainer();
    assert.ok(container, 'toast-container が作られる');
    const toast = container.children[0];
    assert.ok(toast, 'トーストが1件だけ出る');

    const lines = toast.children;
    assert.equal(lines.length, 1, '改行1つ＝1つの行要素（\n はそのまま保持）');
    assert.equal(lines[0].style.whiteSpace, 'pre-line', '\n を描画する white-space 指定');
    assert.equal(
        lines[0].textContent,
        'スタンダードパック (¥500) を獲得！\n広告完全非表示（Ad-Free）も解放しました'
    );
});

/* ------------------------------------------------------------------ *
 * 2. message / subtitle の2行構成
 * ------------------------------------------------------------------ */
test('描画: message と subtitle は別々の行として出る', () => {
    const { app, getContainer } = loadApp();
    app.renderToast('スタンダードパック (¥500) を獲得！', '広告完全非表示（Ad-Free）も解放しました');

    const toast = getContainer().children[0];
    assert.equal(toast.children.length, 2, '2行構成');
    assert.equal(toast.children[0].textContent, 'スタンダードパック (¥500) を獲得！');
    assert.equal(toast.children[1].textContent, '広告完全非表示（Ad-Free）も解放しました');
    toast.children.forEach((line) => {
        assert.equal(line.style.whiteSpace, 'pre-line');
        assert.match(line.className, /break-keep/, '日本語を語の途中で折らない');
        assert.doesNotMatch(line.className, /break-all/, 'break-all は使わない');
        assert.match(line.className, /max-w-full/, 'トースト幅からはみ出さない');
    });
    // 2行目の色/サイズは従来どおり控えめ（補足行）
    assert.match(toast.children[1].className, /text-\[11px\]/);
});

test('描画: subtitle なしは1行だけ', () => {
    const { app, getContainer } = loadApp();
    app.renderToast('ビギナーパック (¥120) を獲得しました');

    const toast = getContainer().children[0];
    assert.equal(toast.children.length, 1);
    assert.equal(toast.children[0].textContent, 'ビギナーパック (¥120) を獲得しました');
});

/* ------------------------------------------------------------------ *
 * 3. XSS 安全（textContent で入れる）
 * ------------------------------------------------------------------ */
test('描画: 文言に HTML が混ざってもタグとして解釈しない（XSS 安全）', () => {
    const { app, getContainer } = loadApp();
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

    app.renderToast(evil, '<b>sub</b>');

    const toast = getContainer().children[0];
    assert.equal(toast.innerHTML, '', 'innerHTML には何も書き込まない');
    assert.equal(toast.children[0].textContent, evil, '文字列はそのままテキストとして保持');
    assert.equal(toast.children[1].textContent, '<b>sub</b>');
    assert.equal(toast.children.length, 2, 'タグが要素として増えない');
});

/* ------------------------------------------------------------------ *
 * 4. ソース点検（再発防止）
 * ------------------------------------------------------------------ */
test('描画: renderToast は文言を innerHTML に埋め込まない', () => {
    assert.doesNotMatch(APP_SOURCE, /toast\.innerHTML\s*=\s*`[^`]*\$\{message\}/, 'innerHTML に message を埋め込まない');
    assert.doesNotMatch(APP_SOURCE, /toast\.innerHTML\s*=\s*`[^`]*\$\{subtitle\}/, 'innerHTML に subtitle を埋め込まない');
    assert.match(APP_SOURCE, /createToastLine\(/, '行生成ヘルパーを使う');
    assert.match(APP_SOURCE, /line\.textContent = /, '行は textContent で入れる');
    assert.match(APP_SOURCE, /line\.style\.whiteSpace = 'pre-line'/, 'pre-line で改行を描画する');
});

test('描画: キャッシュバスター v63 と www/ 同期', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /app\.js\?v=20261121v65/, 'app.js は v65');
    assert.match(html, /iap\.js\?v=20261115v50/, 'iap.js は v50');

    assert.equal(readWwwAppSource(), APP_SOURCE, 'www/ の app 分割モジュールはルートと同一');
});
