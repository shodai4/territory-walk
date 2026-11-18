/**
 * TERRITORY WALK - Node tests
 * 右下の片手操作ボタン（＋／－／マーキング／現在地）のサイズ統一
 *
 *   1) 4ボタンすべてが同じ正方形（52×52・角丸16px）で、右端が揃う
 *   2) サイズの指定は .map-control-btn の1か所だけ（個別の w-12 / w-14 / 角丸 / 余白で崩さない）
 *   3) 「マーキング」「ON」「停止中」が正方形の中に収まる（文字サイズ・行間・折り返しなし）
 *   4) 配布物（www/）にも同じ CSS / HTML が入っている
 *
 * 実行: npm test （node --test tests/）
 *
 * 375×812 の実測は downloads/2026-11-19_テリウォーク_ボタン統一_375px_*.png を参照
 * （＋／－／マーキング／現在地が left 307 / right 359 / 52×52・角丸16px で一致）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

const BUTTON_IDS = ['btn-zoom-in', 'btn-zoom-out', 'btn-marking-toggle', 'btn-recenter'];

/** index.html から指定 id のボタンの class 属性を取り出す */
function buttonClass(id) {
    const match = new RegExp(`<button[^>]*id="${id}"[^>]*class="([^"]*)"`).exec(HTML)
        || new RegExp(`<button[^>]*class="([^"]*)"[^>]*id="${id}"`).exec(HTML);
    assert.ok(match, `${id} のボタンが見つかる`);
    return match[1];
}

/** CSS の指定ブロックから宣言を取り出す */
function cssBlock(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
    return match ? match[1] : '';
}

/* ------------------------------------------------------------------ *
 * 1. 4ボタンが同じ正方形
 * ------------------------------------------------------------------ */

test('統一: 4ボタンすべてが共通のサイズ指定（.map-control-btn / .marking-toggle-btn）を持つ', () => {
    BUTTON_IDS.forEach((id) => {
        const cls = buttonClass(id);
        const shared = /(^|\s)map-control-btn(\s|$)/.test(cls);
        const marking = /(^|\s)marking-toggle-btn(\s|$)/.test(cls);
        assert.ok(shared || marking, `${id} が共通クラスでサイズを決める`);
    });

    // ＋／－／現在地は同じ共通クラス、マーキングは状態で中身が変わる専用クラス
    ['btn-zoom-in', 'btn-zoom-out', 'btn-recenter'].forEach((id) => {
        assert.match(buttonClass(id), /(^|\s)map-control-btn(\s|$)/, `${id} は .map-control-btn`);
    });
    assert.match(buttonClass('btn-marking-toggle'), /(^|\s)marking-toggle-btn(\s|$)/);
});

test('統一: 2つの共通クラスが同じ寸法を宣言している（見た目が一致する）', () => {
    const shared = cssBlock('.map-control-btn');
    const marking = cssBlock('.marking-toggle-btn');
    ['width: 52px;', 'height: 52px;', 'border-radius: 16px;'].forEach((decl) => {
        assert.ok(shared.includes(decl), `.map-control-btn に ${decl}`);
        assert.ok(marking.includes(decl), `.marking-toggle-btn に ${decl}`);
    });
});

test('統一: 共通クラス .map-control-btn が 52×52・角丸16px を1か所で決める', () => {
    const block = cssBlock('.map-control-btn');
    assert.ok(block, '.map-control-btn の宣言がある');
    assert.match(block, /(^|\s)width:\s*52px;/, '幅は 52px');
    assert.match(block, /(^|\s)height:\s*52px;/, '高さは 52px');
    assert.match(block, /border-radius:\s*16px;/, '角丸は 16px（rounded-2xl と同じ）');
    assert.match(block, /flex:\s*0 0 52px;/, 'flex で縮まない');
    assert.match(block, /box-sizing:\s*border-box;/, '枠線を含めて 52px');
});

test('統一: 個別の w-12 / w-14 / 角丸 / 余白クラスでサイズを崩していない', () => {
    BUTTON_IDS.forEach((id) => {
        const cls = buttonClass(id);
        assert.doesNotMatch(cls, /(^|\s)(w|h)-(12|14)(\s|$)/, `${id} に個別の幅・高さクラスが残っていない`);
        assert.doesNotMatch(cls, /rounded-2xl|rounded-xl|rounded-3xl/, `${id} に個別の角丸が残っていない`);
        assert.doesNotMatch(cls, /(^|\s)mt-0\.5(\s|$)/, `${id} に縦位置をずらす余白が無い`);
    });
});

test('統一: マーキングトグルも同じ 52×52・角丸16px（余白でずらさない）', () => {
    const block = cssBlock('.marking-toggle-btn');
    assert.match(block, /width:\s*52px;/, '幅は 52px');
    assert.match(block, /height:\s*52px;/, '高さは 52px');
    assert.match(block, /border-radius:\s*16px;/, '角丸は 16px');
    assert.match(block, /margin-top:\s*0;/, '上余白で縦の間隔を崩さない');
});

test('統一: コントロール列は縦一列・等間隔で、右端が揃う', () => {
    const container = /<div id="map-controls-container"[^>]*class="([^"]*)"/.exec(HTML);
    assert.ok(container, 'map-controls-container がある');
    const cls = container[1];
    assert.match(cls, /flex-col/, '縦に並べる');
    assert.match(cls, /items-center/, '同じ幅なので左右中央で揃う');
    assert.match(cls, /gap-2/, 'ボタン間は 8px で等間隔');

    // 4つとも同じ幅なので、右端（right）も揃う
    const right = /right:\s*calc\(1rem \+ env\(safe-area-inset-right\)\) !important;/;
    assert.match(cssBlock('#map-controls-container'), right, '右端の基準位置は1か所で決める');
});

/* ------------------------------------------------------------------ *
 * 2. 正方形の中に文字が収まる
 * ------------------------------------------------------------------ */

test('マーキング: 「マーキング」「ON」「停止中」が 52px の正方形に収まる', () => {
    const title = cssBlock('.marking-toggle-title');
    const state = cssBlock('.marking-toggle-state');
    const titleSize = Number(/font-size:\s*([\d.]+)px/.exec(title)[1]);
    const stateSize = Number(/font-size:\s*([\d.]+)px/.exec(state)[1]);

    assert.ok(titleSize > 0 && titleSize <= 9, `ラベルの文字サイズは 9px 以下（実測 ${titleSize}px）`);
    assert.ok(stateSize > 0 && stateSize <= 11, `状態の文字サイズは 11px 以下（実測 ${stateSize}px）`);
    assert.match(title, /white-space:\s*nowrap;/, 'ラベルは折り返さない');
    assert.match(state, /white-space:\s*nowrap;/, '状態は折り返さない');

    // 等幅フォントの目安（1文字 ≒ font-size）で、5文字＋3文字が 52px に収まる
    const titleWidth = 'マーキング'.length * titleSize;
    const stateWidth = '停止中'.length * stateSize;
    assert.ok(titleWidth <= 48, `「マーキング」が横に収まる（目安 ${titleWidth}px / 内寸 50px）`);
    assert.ok(stateWidth <= 48, `「停止中」が横に収まる（目安 ${stateWidth}px / 内寸 50px）`);

    // 縦：アイコン14 + ラベル + 状態 + 余白が 52px に収まる
    const icons = cssBlock('.marking-toggle-icons');
    const iconSize = Number(/height:\s*([\d.]+)px/.exec(icons)[1]);
    const stacked = iconSize + titleSize * 1.1 + stateSize * 1.1 + 2;
    assert.ok(stacked <= 48, `縦に積んでも収まる（目安 ${stacked.toFixed(1)}px / 内寸 50px）`);
});

test('マーキング: 状態で色が変わる（ON は緑・停止中はスカイ）', () => {
    assert.match(cssBlock('.marking-toggle-btn[data-state="paused"]'), /background: rgba\(8, 47, 73, 0\.92\);/);
    assert.match(cssBlock('.marking-toggle-state'), /color: #6ee7b7;/, 'ON は緑');
    assert.match(cssBlock('.marking-toggle-btn[data-state="paused"] .marking-toggle-state'), /color: #7dd3fc;/, '停止中はスカイ');
});

/* ------------------------------------------------------------------ *
 * 3. 配布物にも同じ見た目が入っている
 * ------------------------------------------------------------------ */

test('同期: www/ の index.html と style.css がルートと一致する', () => {
    ['index.html', 'style.css'].forEach((file) => {
        const wwwPath = path.join(ROOT, 'www', file);
        if (!fs.existsSync(wwwPath)) return; // 未ビルド環境ではスキップ
        assert.equal(fs.readFileSync(wwwPath, 'utf8'), fs.readFileSync(path.join(ROOT, file), 'utf8'), `www/${file} が同一`);
    });
});
