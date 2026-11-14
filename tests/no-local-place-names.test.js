/**
 * TERRITORY WALK - Node tests
 * 特定のローカル地名（開発者の生活圏を指す地名）がアプリに残っていないことの回帰チェック。
 *
 *   1) ソース（.js / .html / .css / .md / .json / .yml）に地名の生文字列がない
 *   2) 配布物 www/（iOS 同梱物・GitHub Pages 配信物）にも地名の生文字列がない
 *   3) 旧称号データの後方互換マップは、地名を Unicode エスケープで保持しつつ
 *      画面表示は汎用名称へ変換される（表示に地名が出ない）
 *
 * 検査語はソース上でもエスケープで持ち、このテスト自身が地名の生文字列を含まないようにする。
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 検査対象の拡張子（テキストのみ。画像などのバイナリは対象外） */
const TEXT_EXTENSIONS = new Set(['.js', '.html', '.css', '.md', '.json', '.yml', '.yaml', '.sql', '.txt']);

/** 走査しないディレクトリ（依存・生成物・VCS・バイナリ資源） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'resources', 'ios', 'android']);

/**
 * 検査語（地名・駅名・旧住所の要素）。ソースに生文字列を残さないためエスケープで定義する。
 * - 大阪府東部の市名 / 沿線の駅名 / 旧住所の町名 / ローマ字表記
 */
const BANNED_TERMS = [
    '\u6771\u5927\u962a',                             // 市名
    '\u74e2\u7b2a\u5c71',                             // 駅名
    '\u6771\u82b1\u5712',                             // 駅名
    '\u6cb3\u5185',                                   // 旧国名・沿線名
    '\u5e03\u65bd',                                   // 駅名
    '\u516b\u5c3e',                                   // 市名
    '\u677e\u539f\u5e02',                             // 市名
    '\u65b0\u6c60\u5cf6',                             // 町名
    '\u77f3\u5207',                                   // 駅名
    '\u679a\u5ca1',                                   // 駅名
    '\u4e0a\u75305',                                  // 旧住所（町名＋丁目）
    '\u8fd1\u9244'                                    // 沿線名
];

/** ローマ字表記の検査語（このテスト自身が生文字列を持たないよう符号値から組み立てる） */
const ROMAJI_CODES = [
    [72, 105, 103, 97, 115, 104, 105, 111, 115, 97, 107, 97],                     // 市名（連結表記）
    [72, 105, 103, 97, 115, 104, 105, 45, 79, 115, 97, 107, 97],                 // 市名（ハイフン表記）
    [72, 105, 114, 97, 111, 107, 97, 121, 97, 109, 97]                              // 駅名
];
BANNED_TERMS.push(...ROMAJI_CODES.map((codes) => String.fromCharCode(...codes)));

/** ディレクトリ配下のテキストファイルを再帰的に集める */
function collectFiles(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            collectFiles(full, acc);
        } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            acc.push(full);
        }
    }
    return acc;
}

/** ファイル群から検査語の出現を洗い出す */
function findViolations(files) {
    const violations = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const term of BANNED_TERMS) {
            if (text.includes(term)) {
                violations.push(`${path.relative(ROOT, file)}: ${term}`);
            }
        }
    }
    return violations;
}

const SOURCE_FILES = collectFiles(ROOT).filter(
    (file) => !file.startsWith(path.join(ROOT, 'www') + path.sep)
);

test('地名: ソースにローカル地名の生文字列が残っていない', () => {
    const violations = findViolations(SOURCE_FILES);
    assert.deepEqual(violations, [], `地名が残っている: ${violations.join(', ')}`);
});

test('地名: 配布物 www/ にもローカル地名が含まれない（npm run build 後）', () => {
    const www = path.join(ROOT, 'www');
    if (!fs.existsSync(www)) {
        assert.ok(true, 'www/ が未生成の環境ではスキップ（CI は npm run build 後に実行）');
        return;
    }
    const violations = findViolations(collectFiles(www));
    assert.deepEqual(violations, [], `www/ に地名が残っている: ${violations.join(', ')}`);
});

test('地名: 旧称号の後方互換マップは表示名に地名を出さない（汎用名称へ変換）', () => {
    const statsSource = fs.readFileSync(path.join(ROOT, 'stats.js'), 'utf8');
    const start = statsSource.indexOf('LEGACY_TITLE_RENAMES = ');
    assert.ok(start >= 0, 'LEGACY_TITLE_RENAMES が定義されている');
    const end = statsSource.indexOf('};', start);
    const literal = statsSource
        .slice(start, end + 1)
        .replace('LEGACY_TITLE_RENAMES = ', 'var MAP = ');
    const sandbox = {};
    // マップ定義のみを評価して中身を確認する（旧キーはエスケープ済み）
    new Function('sandbox', `with (sandbox) { ${literal}; sandbox.MAP = MAP; }`)(sandbox);
    const map = sandbox.MAP;

    const legacyPlaceKey = '\u6771\u5927\u962a\u306e\u8987\u8005';
    assert.equal(
        map[legacyPlaceKey],
        'エリアウォーカー',
        '旧称号は汎用名称（エリアウォーカー）へ変換され、画面に地名が出ない'
    );
    for (const [from, to] of Object.entries(map)) {
        assert.ok(
            !BANNED_TERMS.some((term) => String(to).includes(term)),
            `変換後の称号に地名が含まれない: ${from} -> ${to}`
        );
    }
});
