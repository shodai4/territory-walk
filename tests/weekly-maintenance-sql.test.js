/**
 * TERRITORY WALK - Node tests
 * v1.1 週次メンテナンス（Supabase SQL）:
 *   ・古い週の territory_tiles（マス座標）だけを削除し、DB容量を抑える
 *   ・territory_weekly_rankings / territory_users は消さない
 *   ・直近2週（今週と先週）は残す＝先週の結果発表・閲覧に支障を出さない
 *   ・プロコードの週次更新と同じジョブで走らせる
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'weekly_maintenance.sql'), 'utf8');

/** SQL から関数定義本体を取り出す */
function functionBody(name) {
    const pattern = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`);
    const match = SQL.match(pattern);
    return match ? match[0] : null;
}

test('週次削除: 古いマスの削除は territory_tiles だけを対象にする', () => {
    const body = functionBody('cleanup_old_territory_tiles');
    assert.ok(body, 'cleanup_old_territory_tiles がある');
    assert.match(body, /DELETE FROM public\.territory_tiles/);
    assert.doesNotMatch(body, /DELETE FROM public\.territory_weekly_rankings/,
        '週間ランキングは残す');
    assert.doesNotMatch(body, /DELETE FROM public\.territory_users/,
        '累計（ユーザー）テーブルは残す');
    assert.doesNotMatch(body, /TRUNCATE/i, '全消しはしない');
});

test('週次削除: 直近2週（今週・先週）は残す', () => {
    const body = functionBody('cleanup_old_territory_tiles');
    assert.match(body, /retain_weeks INTEGER DEFAULT 2/, '既定は2週保持');
    assert.match(body, /cutoff := public\.iso_week_id\(now\(\) - make_interval\(weeks => weeks\)\)/);
    assert.match(body, /WHERE week_id < cutoff/, 'cutoff より古い週だけ消す（cutoff の週は残る）');
});

test('週次削除: 週IDはアプリと同じ「YYYY-Www」（JST・月曜はじまり）', () => {
    const body = functionBody('iso_week_id');
    assert.ok(body, 'iso_week_id がある');
    assert.match(body, /AT TIME ZONE 'Asia\/Tokyo'/);
    assert.match(body, /IYYY-"W"IW/, 'アプリの `${year}-W${week}` と同じ並び');
});

test('週次削除: クライアントからは実行できない（権限を剥奪）', () => {
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.cleanup_old_territory_tiles\(INTEGER\) FROM public, anon, authenticated/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.weekly_maintenance\(\) FROM public, anon, authenticated/);
});

test('週次削除: プロコード更新と同じジョブでまとめて走る（毎週月曜 09:00 JST）', () => {
    const body = functionBody('weekly_maintenance');
    assert.ok(body, 'weekly_maintenance がある');
    assert.match(body, /PERFORM public\.rotate_pro_code\(\)/);
    assert.match(body, /public\.cleanup_old_territory_tiles\(2\)/);
    assert.match(SQL, /cron\.schedule\(\s*'weekly-maintenance',\s*'0 0 \* \* 1'/,
        '月曜 00:00 UTC = 月曜 09:00 JST の1本');
    assert.match(SQL, /cron\.unschedule\(jobid\)[\s\S]*'weekly-maintenance'/, '貼り直してもジョブが増えない');
});

test('週次削除: 手動で試せる（関数が用意されている）', () => {
    assert.match(SQL, /SELECT public\.cleanup_old_territory_tiles\(2\)/);
});

test('週次削除: 実行計画に使う week_id の索引が schema.sql にある', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
    assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_territory_tiles_week_bounds[\s\S]*?ON territory_tiles \(week_id/,
        'week_id 先頭の索引で削除が軽い');
});

module.exports = { functionBody };
