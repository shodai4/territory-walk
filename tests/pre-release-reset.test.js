/**
 * TERRITORY WALK - Node tests
 * リリース直前の Supabase 本番データ全リセット（docs/sql/pre-release-reset.sql）。
 *
 *   1) アプリが読み書きする全テーブルをリセット対象に含んでいる
 *      （schema.sql の CREATE TABLE と、JS の .from('...') の両方から突き合わせる）
 *   2) 件数確認 → トランザクション内 TRUNCATE → 件数再確認、の順で書かれている
 *   3) TestFlight検証中は実行しない注意が書かれている
 *   4) リリース手順書の「提出直前」ステップとチェックリストに組み込まれている
 *   5) アプリ本体はこのSQLを読み込まない（事故で実行されない）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SQL_PATH = path.join(ROOT, 'docs', 'sql', 'pre-release-reset.sql');
const GUIDE_PATH = path.join(ROOT, 'docs', 'app-store-release-guide.md');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SQL = fs.readFileSync(SQL_PATH, 'utf8');
const GUIDE = fs.readFileSync(GUIDE_PATH, 'utf8');

/** `--` 行コメントを落として、実際に実行される SQL だけにする */
const SQL_CODE = SQL
    .split('\n')
    .map((line) => {
        const index = line.indexOf('--');
        return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');

/** 実行する価値のあるSQLが残っていることを前提にしておく（全行コメント化の検出） */
test('リセットSQL: 行コメントを除いてもTRUNCATEが残っている', () => {
    assert.match(SQL_CODE, /truncate\s+table/i);
});

/* ------------------------------------------------------------------ *
 * 1. 対象テーブルの網羅
 * ------------------------------------------------------------------ */
const SCHEMA_TABLES = [...read('schema.sql').matchAll(/create\s+table\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)/gi)]
    .map((m) => m[1]);
const CODE_TABLES = new Set();
['supabase.js', 'stats.js', 'coins.js', 'outbox.js'].forEach((file) => {
    [...read(file).matchAll(/\.from\('([a-z_][a-z0-9_]*)'\)/g)].forEach((m) => CODE_TABLES.add(m[1]));
});
const TARGET_TABLES = [...new Set([...SCHEMA_TABLES, ...CODE_TABLES])].sort();

test('リセットSQL: schema.sql と実装の全テーブルを対象にしている', () => {
    assert.deepEqual(
        TARGET_TABLES,
        ['territory_tiles', 'territory_users', 'territory_weekly_rankings'],
        '対象テーブルが増減したら、このテストとリセットSQLを更新する'
    );
});

test('リセットSQL: 各テーブルを TRUNCATE（または DELETE）で全件削除している', () => {
    TARGET_TABLES.forEach((table) => {
        const truncated = new RegExp(`truncate\\s+table\\s+public\\.${table}\\b`, 'i');
        const deleted = new RegExp(`delete\\s+from\\s+public\\.${table}\\b`, 'i');
        assert.ok(
            truncated.test(SQL_CODE) || deleted.test(SQL_CODE),
            `${table} が全件削除の対象に入っていない`
        );
    });
});

test('リセットSQL: 全テーブルを1つのトランザクションで消す', () => {
    const begin = SQL_CODE.search(/\bbegin\s*;/i);
    const commit = SQL_CODE.search(/\bcommit\s*;/i);
    assert.ok(begin !== -1, 'begin; がある');
    assert.ok(commit > begin, 'commit; が begin; より後にある');

    // すべての TRUNCATE が begin ～ commit の内側にある
    const body = SQL_CODE.slice(begin, commit);
    TARGET_TABLES.forEach((table) => {
        assert.match(body, new RegExp(`public\\.${table}\\b`, 'i'), `${table} がトランザクション内にある`);
    });
    assert.match(body, /restart\s+identity/i, 'RESTART IDENTITY 付き');
});

test('リセットSQL: 実行前後で件数確認クエリを出し、各テーブルを3回以上数える', () => {
    TARGET_TABLES.forEach((table) => {
        const count = (SQL_CODE.match(new RegExp(`public\\.${table}\\b`, 'gi')) || []).length;
        assert.ok(count >= 3, `${table} の参照が ${count} 回（前確認・削除・後確認で3回以上必要）`);
    });
});

test('リセットSQL: 実行してよいタイミングと禁止事項が書かれている', () => {
    assert.match(SQL, /TestFlight/);
    assert.match(SQL, /絶対に実行しない/);
    assert.match(SQL, /審査へ提出/);
    assert.match(SQL, /ENABLE_DEBUG_TOOLS/);
    assert.match(SQL, /テーブル定義[^。\n]*RLS/i, 'テーブル定義・RLSは残ることが分かる');
    assert.match(SQL, /公開後[^。\n]*実行しない/, '本番公開後は実行しないと分かる');
    assert.match(SQL, /localStorage/, '端末側データの注意がある');
});

/* ------------------------------------------------------------------ *
 * 2. リリース手順書への組み込み
 * ------------------------------------------------------------------ */
test('手順書: 提出直前の最終ステップに全リセットが組み込まれている', () => {
    assert.ok(GUIDE.includes('docs/sql/pre-release-reset.sql'), 'SQLファイルの場所が書かれている');

    const debugToggle = GUIDE.indexOf('CONFIG.ENABLE_DEBUG_TOOLS');
    const resetStep = GUIDE.indexOf('### 提出直前：Supabase本番データの全リセット');
    const minimumIos = GUIDE.indexOf('### 最低対応OS');

    assert.ok(debugToggle !== -1 && resetStep !== -1, '見出しがある');
    assert.ok(debugToggle < resetStep, 'デバッグ無効化の切替より後に書かれている');
    assert.ok(resetStep < minimumIos, '第4章（最後にやること）の中に置かれている');

    const section = GUIDE.slice(resetStep, minimumIos);
    ['territory_tiles', 'territory_users', 'territory_weekly_rankings', 'TRUNCATE', 'TestFlight', 'localStorage']
        .forEach((keyword) => {
            assert.ok(section.includes(keyword), `リセット手順に ${keyword} の記載がある`);
        });
});

test('手順書: 残タスクのチェックリストにリセットと端末側の対応が入っている', () => {
    assert.match(GUIDE, /- \[ \] \*\*提出直前\*\*：Supabase本番データを全リセット/);
    assert.match(GUIDE, /- \[ \] リセット後、テスター端末[^\n]*削除/);
});

/* ------------------------------------------------------------------ *
 * 3. アプリ本体からは実行できない（事故防止）
 * ------------------------------------------------------------------ */
test('事故防止: アプリのコードとHTMLはリセットSQLを参照しない', () => {
    const files = fs.readdirSync(ROOT).filter((name) => /\.(js|html)$/.test(name));
    files.forEach((file) => {
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.ok(!text.includes('pre-release-reset'), `${file} がリセットSQLを参照している`);
        assert.doesNotMatch(
            text,
            /delete\s+from\s+territory_|truncate\s+table/i,
            `${file} に全消しのSQLが埋め込まれている`
        );
    });
});
