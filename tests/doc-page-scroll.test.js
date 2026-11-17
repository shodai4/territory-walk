/**
 * TERRITORY WALK - Node tests
 * v1.1 実機報告：アプリ内の「利用規約」「プライバシーポリシー」「サポート」が
 * 縦スクロールできない。
 *
 * 原因は、法的ページ3枚がマップ画面用の style.css を読み込み、冒頭の
 *   html, body { overflow: hidden !important; position: fixed; ... }
 * が効いてしまうこと。マップ（index.html）の全画面固定はそのままに、
 * 法的ページだけスクロールできるようにする。
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const DOC_PAGES = ['terms.html', 'privacy.html', 'support.html'];
const STYLE = read('style.css');
const INDEX = read('index.html');

test('法的ページ: 3ページとも <html class="doc-scroll"> でスクロールを許可する', () => {
    for (const page of DOC_PAGES) {
        const html = read(page);
        assert.match(html, /<html[^>]*class="doc-scroll"/, `${page} に doc-scroll が付く`);
        assert.match(html, /viewport-fit=cover/, `${page} はセーフエリア対応の viewport を持つ`);
    }
});

test('法的ページ: マップ画面（index.html）の <html> には doc-scroll を付けない', () => {
    const indexHtmlTag = INDEX.match(/<html[^>]*>/);
    assert.ok(indexHtmlTag, 'index.html の <html> がある');
    assert.doesNotMatch(indexHtmlTag[0], /doc-scroll/, 'マップの全画面固定はそのまま');
});

test('法的ページ: マップ用の全画面固定ルールは残っている（回帰させない）', () => {
    assert.match(STYLE, /html, body \{[\s\S]*?overflow: hidden !important;[\s\S]*?position: fixed;/,
        'マップ画面の html, body 固定は維持する');
});

test('法的ページ: doc-scroll の上書きが固定を解除する（position/height/overflow）', () => {
    const block = STYLE.match(/html\.doc-scroll \{[\s\S]*?\n\}/);
    assert.ok(block, 'html.doc-scroll のルールがある');
    assert.match(block[0], /position: static !important;/, 'position: fixed を解除する');
    assert.match(block[0], /overflow: visible !important;/, 'html の overflow: hidden を解除する');

    const bodyBlock = STYLE.match(/html\.doc-scroll body \{[\s\S]*?\n\}/);
    assert.ok(bodyBlock, 'html.doc-scroll body のルールがある');
    assert.match(bodyBlock[0], /position: static !important;/);
    assert.match(bodyBlock[0], /height: auto !important;/, '100vh 固定をやめて内容の高さに任せる');
    assert.match(bodyBlock[0], /overflow-y: visible !important;/);
    assert.match(bodyBlock[0], /-webkit-overflow-scrolling: touch;/, 'iOS の慣性スクロール');
});

test('法的ページ: セーフエリア（Dynamic Island・ホームバー）の上下余白を保つ', () => {
    assert.match(STYLE, /html\.doc-scroll body \{[\s\S]*?padding-top: calc\(env\(safe-area-inset-top, 0px\) \+ 1rem\) !important;/);
    assert.match(STYLE, /padding-bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ 1rem\) !important;/);
    assert.match(STYLE, /@media \(min-width: 640px\) \{[\s\S]*?padding-top: calc\(env\(safe-area-inset-top, 0px\) \+ 2rem\) !important;/,
        '広い画面では従来の p-8 相当を保つ');
});

test('法的ページ: キャッシュバスターを更新して WKWebView に新しい CSS を読ませる', () => {
    for (const page of DOC_PAGES) {
        const html = read(page);
        assert.match(html, /style\.css\?v=20261117v57/, `${page} の style.css が今回の版を指す`);
        assert.doesNotMatch(html, /style\.css\?v=20261113v13/, `${page} に旧版が残っていない`);
    }
});

test('配布物: www/ の3ページと style.css がソースと一致する（npm run build 済み）', () => {
    if (!fs.existsSync(path.join(ROOT, 'www'))) return; // www が無い環境ではスキップ
    for (const file of [...DOC_PAGES, 'style.css']) {
        assert.equal(read('www', file), read(file), `www/${file} が同期されている`);
    }
});
