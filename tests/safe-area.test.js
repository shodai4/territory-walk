/**
 * TERRITORY WALK - Node tests
 * iOS セーフエリア（Dynamic Island 下の二重余白）の回帰チェック:
 *   1) Capacitor は contentInset = "never"（WebView は画面全高・余白はCSSのみ）
 *   2) 上下の固定UIがすべて env(safe-area-inset-*) で保護されている
 *   3) Web（inset = 0px）の見た目が変わらない（calc の base 値が従来と同じ）
 *   4) www/ のビルド成果物がルートと一致している
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

const CSS = read('style.css');
const HTML = read('index.html');
const CAP = JSON.parse(read('capacitor.config.json'));

/* ------------------------------------------------------------------ *
 * 1. Capacitor 設定：セーフエリア制御は Web/CSS 側に一本化
 * ------------------------------------------------------------------ */
test('Capacitor: ios.contentInset は "never"（ネイティブ側で余白を足さない）', () => {
    assert.equal(CAP.ios.contentInset, 'never');
    assert.equal(CAP.ios.backgroundColor, '#000000', '地の色は黒のまま');
    assert.equal(CAP.ios.preferredContentMode, 'mobile', 'モバイル表示のまま');
    assert.equal(CAP.appId, 'com.oekaki.territorywalk', 'バンドルIDは変えない');
    assert.equal(CAP.webDir, 'www');
});

test('Capacitor: 画面全高を使う前提が viewport-fit=cover と揃っている', () => {
    assert.match(HTML, /viewport-fit=cover/, 'env(safe-area-inset-*) を有効にする');
    assert.match(HTML, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
});

/* ------------------------------------------------------------------ *
 * 2. 上セーフエリア（Dynamic Island）: 余白は1回だけ
 * ------------------------------------------------------------------ */
test('CSS: ヘッダーの上余白は env(safe-area-inset-top) + 0.5rem の1回だけ', () => {
    assert.match(CSS, /header \{\s*padding-top: calc\(env\(safe-area-inset-top, 0px\) \+ 0\.5rem\) !important;/, 'calc で1回だけ足す');
    assert.doesNotMatch(CSS, /padding-top: max\(0\.5rem, env\(safe-area-inset-top\)\)/, '上書き前の max 指定は残さない');
});

test('HTML: ヘッダーに上セーフエリアのパディングを二重に書かない', () => {
    const headerTag = HTML.slice(HTML.indexOf('<header'), HTML.indexOf('>', HTML.indexOf('<header')) + 1);
    assert.doesNotMatch(headerTag, /pt-\[calc\([^\]]*safe-area-inset-top/, 'セーフエリア余白は style.css に一本化');
});

/* ------------------------------------------------------------------ *
 * 3. 下セーフエリア（ホームインジケータ）: 固定UIがすべて保護されている
 * ------------------------------------------------------------------ */
test('CSS: 下部固定UIが env(safe-area-inset-bottom) で保護されている', () => {
    const bottomRules = [
        '#map-controls-container',
        '#dpad-container',
        '#app-footer-note',
        '#admob-banner-spacer'
    ];

    bottomRules.forEach((selector) => {
        const index = CSS.indexOf(selector);
        assert.notEqual(index, -1, `${selector} のスタイルがある`);
        const block = CSS.slice(index, index + 320);
        assert.match(block, /env\(safe-area-inset-bottom\)/, `${selector} が下セーフエリアを持つ`);
    });
});

test('HTML: 広告枠とそのスペーサーが下セーフエリアを含む高さになっている', () => {
    assert.match(HTML, /id="banner-ad-container"[^>]*pb-\[calc\(0\.375rem\+env\(safe-area-inset-bottom\)\)\]/, 'Web用広告枠');
    assert.match(CSS, /body\[data-native-banner="true"\] #admob-banner-spacer \{\s*height: calc\(var\(--admob-banner-height, 56px\) \+ env\(safe-area-inset-bottom\)\);/, 'AdMobバナー分のスペーサー');
});

test('CSS: モーダルは上下左右のセーフエリア内に収まる（デバッグ用モーダル含む）', () => {
    const paddingRule = CSS.slice(
        CSS.indexOf('#rules-modal, #menu-modal, #shop-modal'),
        CSS.indexOf('}', CSS.indexOf('#rules-modal, #menu-modal, #shop-modal'))
    );
    ['#rules-modal', '#menu-modal', '#shop-modal', '#stats-modal', '#pro-modal',
     '#weekly-result-modal', '#reward-ad-modal', '#search-modal', '#team-reset-modal',
     '#team-decision-modal'
    ].forEach((id) => {
        assert.ok(paddingRule.includes(id), `${id} がセーフエリア用パディングの対象に入っている`);
    });
    assert.match(paddingRule, /padding-top: max\(0\.75rem, env\(safe-area-inset-top\)\)/);
    assert.match(paddingRule, /padding-bottom: max\(1\.5rem, env\(safe-area-inset-bottom\)\)/);
});

/* ------------------------------------------------------------------ *
 * 4. Web（env = 0px）の既存表示を壊さない
 * ------------------------------------------------------------------ */
test('互換: Web では env(safe-area-inset-*) が 0px になり従来の余白と一致する', () => {
    // header: 0 + 0.5rem = 従来の py-2 相当（8px） / 左右は px-3（12px）
    assert.match(CSS, /padding-left: calc\(env\(safe-area-inset-left, 0px\) \+ 0\.75rem\) !important;/);
    assert.match(CSS, /padding-right: calc\(env\(safe-area-inset-right, 0px\) \+ 0\.75rem\) !important;/);
    // クレジットは従来の bottom-2（8px）
    assert.match(
        CSS,
        /#app-footer-note \{\s*bottom: calc\(0\.5rem \+ env\(safe-area-inset-bottom\)\) !important;/,
        'クレジット表記の下余白は従来の 8px ＋ 下セーフエリア'
    );
});

/* ------------------------------------------------------------------ *
 * 5. ビルド成果物（www/）の同期
 * ------------------------------------------------------------------ */
test('ビルド: www/ の style.css / index.html / admob.js / app.js がルートと一致する', () => {
    ['style.css', 'index.html', 'admob.js', 'app.js', 'startup-gate.js'].forEach((file) => {
        const rootText = read(file);
        const wwwPath = path.join(ROOT, 'www', file);
        assert.ok(fs.existsSync(wwwPath), `www/${file} が存在する`);
        assert.equal(read(path.join('www', file)), rootText, `www/${file} がルートと同一`);
    });
});
