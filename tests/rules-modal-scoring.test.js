/**
 * TERRITORY WALK - Node tests
 * v1.1 ルール説明: 「勝敗は歩いたマスだけで集計」の追記（2026-11-17 に短い2行版へ短縮）
 *   1) ルール説明モーダルは 1〜5 の5項目で、5番目が新しい項目
 *   2) 5番目のタイトル・本文が仕様どおりの文言（1〜4と同じ2行に収まる短い版）
 *   3) 既存1〜4とデザインが揃っている（丸数字バッジ・本文サイズ・折り返し条件）
 *   4) www/（Capacitor 配布物）にも同じ内容が反映されている
 *   5) 文言が実装と食い違っていない（％バーと勝敗は実際に塗ったマスだけで数える）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readAppSource, APP_SOURCE_FILES } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');

const RULE_TITLE = '勝敗は歩いたマスだけで集計';
const RULE_BODY = '地図上の初期配置はプライバシー保護のダミーです。勝敗は今週実際に塗られたマスだけで決まります。';

/** #rules-modal の中身だけを取り出す（ネストした div を数えて閉じ位置を決める） */
function extractRulesModal(html) {
    const start = html.indexOf('id="rules-modal"');
    assert.ok(start > -1, '#rules-modal が存在する');
    const openTagStart = html.lastIndexOf('<div', start);
    const tagRe = /<div\b|<\/div>/g;
    tagRe.lastIndex = openTagStart;
    let depth = 0;
    let match;
    while ((match = tagRe.exec(html)) !== null) {
        if (match[0] === '</div>') depth -= 1; else depth += 1;
        if (depth === 0) return html.slice(openTagStart, match.index + '</div>'.length);
    }
    throw new Error('#rules-modal の閉じタグが見つからない');
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const modal = extractRulesModal(html);

/** 各項目のバッジ数字・タイトル・本文を取り出す */
function readItems(block) {
    const items = [];
    const itemRe = /<span class="w-5 h-5[^"]*">(\d)<\/span>\s*<div>\s*<div class="font-bold[^"]*">([^<]*)<\/div>\s*<div class="text-zinc-400 text-\[11px\]">([^<]*)<\/div>/g;
    let m;
    while ((m = itemRe.exec(block)) !== null) {
        items.push({ no: m[1], title: m[2], body: m[3] });
    }
    return items;
}

/* ------------------------------------------------------------------ *
 * 1〜2: 5項目・文言
 * ------------------------------------------------------------------ */

test('ルール説明: 1〜5 の5項目がこの順で並ぶ', () => {
    const items = readItems(modal);
    assert.deepEqual(items.map((item) => item.no), ['1', '2', '3', '4', '5']);
});

test('ルール説明: 5番目は「勝敗は歩いたマスだけで集計」と仕様どおりの本文', () => {
    const items = readItems(modal);
    const fifth = items.find((item) => item.no === '5');
    assert.ok(fifth, '5番目の項目がある');
    assert.equal(fifth.title, RULE_TITLE);
    assert.equal(fifth.body, RULE_BODY);
});

test('ルール説明: 5番目は項目4の直後・開始ボタンの手前にある', () => {
    assert.ok(modal.indexOf(RULE_TITLE) > modal.indexOf('MENUで自由にカスタマイズ'), '項目4の後ろ');
    assert.ok(modal.indexOf(RULE_TITLE) < modal.indexOf('id="btn-close-rules"'), '開始ボタンより前');
});

/* ------------------------------------------------------------------ *
 * 3: 既存項目と同じデザイン（375px ではみ出さない条件）
 * ------------------------------------------------------------------ */

test('ルール説明: 5番目も既存1〜4と同じバッジ・本文クラスで組んである', () => {
    const items = readItems(modal);
    assert.equal(items.length, 5, '全項目が同じクラス構成で抽出できる');
    const wrapperOpen = modal.match(/<div class="flex items-start gap-2\.5">/g) || [];
    assert.equal(wrapperOpen.length, 5, '各項目の外枠は flex items-start gap-2.5 で揃える');
    const bodyBlocks = modal.match(/<div class="text-zinc-400 text-\[11px\]">/g) || [];
    assert.equal(bodyBlocks.length, 5, '本文は text-[11px] で揃える');
});

test('ルール説明: 親要素の横はみ出し防止（overflow-x-hidden / max-w）が効いている', () => {
    assert.match(modal, /class="fixed inset-0[^"]*overflow-x-hidden[^"]*"/, '外枠に overflow-x-hidden');
    assert.match(modal, /max-w-\[calc\(100vw-2rem\)\]/, 'カードは画面幅から余白を引いた上限');
    assert.match(modal, /class="[^"]*box-border[^"]*"/, 'box-border で内側の余白を含めて収める');
    // 折り返せない長い英数字（URL・コード）を本文に入れない
    const items = readItems(modal);
    items.forEach((item) => {
        assert.doesNotMatch(item.body, /https?:\/\/|[A-Za-z0-9_-]{20,}/, `${item.no}番目の本文に折り返せない長い文字列は入れない`);
    });
});

/* ------------------------------------------------------------------ *
 * 4: www/ への反映
 * ------------------------------------------------------------------ */

test('配布物: www/index.html にも同じルール説明が入っている（npm run build 済み）', () => {
    const wwwHtml = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');
    assert.equal(extractRulesModal(wwwHtml), modal, 'www/index.html は index.html と同一内容');
});

/* ------------------------------------------------------------------ *
 * 5: 文言と実装の一致
 * ------------------------------------------------------------------ */

test('整合性: 上部の％バーは実際に塗ったマスだけで数える（全国集計→未取得時は claimedTilesCache）', () => {
    const app = readAppSource();
    const body = app.slice(app.indexOf('updateScoreUI() {'), app.indexOf('initDPad() {'));
    assert.ok(body.length > 0, 'updateScoreUI の定義を切り出せる');
    assert.match(body, /this\.getScoreCounts\(\)/, '集計は getScoreCounts に集約する');
    assert.doesNotMatch(body, /deterministicInitialTeam/, '初期配置50%は集計に入れない');

    const counts = app.slice(app.indexOf('getScoreCounts() {'), app.indexOf('applyGlobalCountDelta('));
    assert.match(counts, /this\.globalTeamCounts/, '全国集計を参照する');
    assert.match(counts, /\.loaded/, '全国集計が取れていればそれを使う');
    assert.match(counts, /claimedTilesCache\.values\(\)/, '未取得時は従来どおり実績マスで数える');
    assert.doesNotMatch(counts, /deterministicInitialTeam/, '初期配置50%は集計に入れない');
});

test('整合性: 勝敗（前週結果）も実際に塗ったマスの枚数から決まる', () => {
    const stats = fs.readFileSync(path.join(ROOT, 'stats.js'), 'utf8');
    const body = stats.slice(stats.indexOf('async getPreviousWeekResult'), stats.indexOf('async getCurrentWeekLiveResult'));
    assert.match(body, /from\('territory_weekly_rankings'\)/, 'ランキング（実績）テーブルを使う');
    assert.match(body, /tiles_count/, '枚数は tiles_count（実際に塗った数）');
    assert.doesNotMatch(body, /deterministicInitialTeam/, '初期配置50%は勝敗に入れない');
});
