/**
 * TERRITORY WALK - Node tests
 * マーキングトグルボタン上部のアイコン表示（v1.2 詳細度バグの回帰テスト）
 *
 * 不具合（v1.2 ビルド71 = 8c6c521 まで）:
 *   .marking-toggle-icons svg { display: block; }   … 詳細度 0,1,1
 *   .marking-icon-off { display: none; }            … 詳細度 0,1,0
 *   のため OFF 用（一時停止）アイコンの display: none が効かず、マーキング ON のとき
 *   「ペン＋一時停止」の2アイコンが 14px 幅の中に並んで表示されていた。
 *   ブラウザ実測（375×812・headless Chrome）でも ON 時に
 *   on: display block / 7×14px、off: display block / 7×14px の両方が可視だった。
 *
 * このテストは飾りではなく、CSS を実際にカスケード解決して
 *   ON    : .marking-icon-on だけが display を持ち、.marking-icon-off は none
 *   停止中: .marking-icon-off だけが display を持ち、.marking-icon-on は none
 * になることを、セレクタの詳細度と出現順から機械的に確かめる。
 * （実機幅での見た目は downloads/2026-11-19_テリウォーク_マーキングON_ペンのみ_375px.png と
 *   downloads/2026-11-19_テリウォーク_マーキング停止中_一時停止のみ_375px.png で確認済み）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

/* ------------------------------------------------------------------ *
 * ごく小さな CSS パーサ（トップレベルの規則だけを読む）
 * ------------------------------------------------------------------ */

/** コメントを落とし、トップレベルの「セレクタ { 宣言 }」を順番に返す */
function parseRules(css) {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    let buffer = '';
    let depth = 0;
    let selector = '';
    for (const ch of source) {
        if (ch === '{') {
            depth += 1;
            if (depth === 1) {
                selector = buffer.trim();
                buffer = '';
            }
            continue;
        }
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                if (selector && !selector.startsWith('@')) {
                    rules.push({ selector, body: buffer });
                }
                selector = '';
                buffer = '';
            }
        } else {
            buffer += ch;
        }
    }
    return rules;
}

/** セレクタをカンマで分けた1つ1つの詳細度 [id, class, element] を数える */
function specificity(compoundSelector) {
    const ids = (compoundSelector.match(/#[\w-]+/g) || []).length;
    const classes = (compoundSelector.match(/\.[\w-]+/g) || []).length
        + (compoundSelector.match(/\[[^\]]+\]/g) || []).length
        + (compoundSelector.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
    const elements = (compoundSelector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length
        + (compoundSelector.match(/::[\w-]+/g) || []).length;
    return [ids, classes, elements];
}

function compareSpecificity(a, b) {
    for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/** 1つの複合セレクタが要素（tag / classes / attrs）に一致するか */
function matchesCompound(compound, element) {
    const classes = compound.match(/\.[\w-]+/g) || [];
    if (classes.some((cls) => !element.classes.includes(cls.slice(1)))) return false;

    const attrs = compound.match(/\[([\w-]+)(?:="([^"]*)")?\]/g) || [];
    for (const attr of attrs) {
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(attr);
        const name = m[1];
        const value = m[2];
        if (!(name in element.attrs)) return false;
        if (value !== undefined && element.attrs[name] !== value) return false;
    }

    const tagMatch = /^([a-zA-Z][\w-]*)/.exec(compound.trim());
    if (tagMatch && tagMatch[1].toLowerCase() !== element.tag.toLowerCase()) return false;

    const idMatch = /#([\w-]+)/.exec(compound);
    if (idMatch && idMatch[1] !== element.attrs.id) return false;

    return true;
}

/** 空白区切りの子孫セレクタが、要素とその祖先の並びに一致するか */
function matchesSelector(selector, element, ancestors) {
    const compounds = selector.trim().split(/\s+/).filter(Boolean);
    if (compounds.length === 0) return false;
    if (!matchesCompound(compounds[compounds.length - 1], element)) return false;
    let ancestorIndex = ancestors.length - 1;
    for (let i = compounds.length - 2; i >= 0; i -= 1) {
        let found = false;
        while (ancestorIndex >= 0) {
            if (matchesCompound(compounds[i], ancestors[ancestorIndex])) {
                found = true;
                ancestorIndex -= 1;
                break;
            }
            ancestorIndex -= 1;
        }
        if (!found) return false;
    }
    return true;
}

/** 要素に実際に効く display の値（詳細度 → 出現順で解決） */
function resolvedDisplay(element, ancestors) {
    let winner = null;
    parseRules(CSS).forEach((rule, index) => {
        rule.selector.split(',').forEach((selector) => {
            const trimmed = selector.trim();
            if (!matchesSelector(trimmed, element, ancestors)) return;
            const display = /(?:^|;)\s*display\s*:\s*([^;]+);/.exec(rule.body);
            if (!display) return;
            const score = specificity(trimmed);
            if (
                !winner
                || compareSpecificity(score, winner.score) > 0
                || (compareSpecificity(score, winner.score) === 0 && index > winner.index)
            ) {
                winner = { value: display[1].trim(), score, index };
            }
        });
    });
    return winner ? winner.value : null;
}

/* ------------------------------------------------------------------ *
 * シーン: ボタン（data-state=active / paused）> span > svg
 * ------------------------------------------------------------------ */

const iconsSpan = { tag: 'span', classes: ['marking-toggle-icons'], attrs: { 'aria-hidden': 'true' } };

function scene(state) {
    const button = { tag: 'button', classes: ['marking-toggle-btn'], attrs: { 'data-state': state } };
    const makeSvg = (cls) => ({ tag: 'svg', classes: [cls], attrs: {} });
    return {
        button,
        on: () => ({ element: makeSvg('marking-icon-on'), ancestors: [button, iconsSpan] }),
        off: () => ({ element: makeSvg('marking-icon-off'), ancestors: [button, iconsSpan] })
    };
}

/* ------------------------------------------------------------------ *
 * 1. 詳細度バグの再発防止
 * ------------------------------------------------------------------ */

test('詳細度: .marking-toggle-icons svg に display を書かない（アイコンの表示は状態セレクタだけが決める）', () => {
    const rules = parseRules(CSS).filter((rule) => rule.selector.split(',').some((s) => s.trim() === '.marking-toggle-icons svg'));
    assert.equal(rules.length, 1, '.marking-toggle-icons svg の規則が1つある');
    assert.doesNotMatch(rules[0].body, /display\s*:/, 'svg への display: block が残っていない');
    assert.match(rules[0].body, /width:\s*14px;/, 'アイコンは 14px 幅のまま');
    assert.match(rules[0].body, /height:\s*14px;/, 'アイコンは 14px 高のまま');
});

test('カスケード: マーキング ON のときはペン（marking-icon-on）だけが表示される', () => {
    const s = scene('active');
    const on = s.on();
    const off = s.off();
    assert.equal(resolvedDisplay(on.element, on.ancestors), 'block', 'ON のペンアイコンは可視');
    assert.equal(resolvedDisplay(off.element, off.ancestors), 'none', 'ON のとき一時停止アイコンは非表示');
});

test('カスケード: 停止中は一時停止（marking-icon-off）だけが表示される', () => {
    const s = scene('paused');
    const on = s.on();
    const off = s.off();
    assert.equal(resolvedDisplay(on.element, on.ancestors), 'none', '停止中はペンアイコンを隠す');
    assert.equal(resolvedDisplay(off.element, off.ancestors), 'block', '停止中は一時停止アイコンを可視');
});

/* ------------------------------------------------------------------ *
 * 2. HTML の配線（アイコン2つ＋ラベル）は変えていない
 * ------------------------------------------------------------------ */

test('HTML: トグルボタンはペンと一時停止の2つの svg を持ち、状態は data-state で切り替える', () => {
    const button = /<button[^>]*id="btn-marking-toggle"[^>]*>([\s\S]*?)<\/button>/.exec(HTML);
    assert.ok(button, 'トグルボタンがある');
    assert.match(button[0], /data-state="active"/, '初期状態はマーキング ON');
    assert.match(button[1], /class="marking-toggle-icons"/, 'アイコンをまとめる span がある');
    assert.match(button[1], /<svg class="marking-icon-on"/, 'ON 用（ペン）の svg がある');
    assert.match(button[1], /<svg class="marking-icon-off"/, 'OFF 用（一時停止）の svg がある');
    assert.match(button[1], /id="marking-toggle-label"/, 'ON / 停止中 のラベルがある');
});

test('HTML: アイコンは aria-hidden（読み上げは「ON / 停止中」の文字と aria-label が担う）', () => {
    assert.match(HTML, /<span class="marking-toggle-icons" aria-hidden="true">/);
});

/* ------------------------------------------------------------------ *
 * 3. ボタンの大きさ・レイアウトは変えていない（52×52・14px アイコン枠）
 * ------------------------------------------------------------------ */

test('レイアウト: ボタン 52×52 とアイコン枠 14×14 は据え置き', () => {
    assert.match(CSS, /\.marking-toggle-btn \{[^}]*width: 52px;[^}]*height: 52px;/);
    assert.match(CSS, /\.marking-toggle-icons \{[^}]*width: 14px;[^}]*height: 14px;/);
});

/* ------------------------------------------------------------------ *
 * 4. 配布物（www/）とキャッシュバスター
 * ------------------------------------------------------------------ */

test('キャッシュバスター: style.css は v52 を参照する', () => {
    assert.match(HTML, /style\.css\?v=20261119v52/);
});

test('ビルド: www/ の style.css / index.html がルートと一致する', () => {
    ['style.css', 'index.html'].forEach((file) => {
        const wwwPath = path.join(ROOT, 'www', file);
        assert.ok(fs.existsSync(wwwPath), `www/${file} が存在する`);
        assert.equal(fs.readFileSync(wwwPath, 'utf8'), fs.readFileSync(path.join(ROOT, file), 'utf8'), `www/${file} が同一`);
    });
});
