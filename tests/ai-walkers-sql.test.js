/**
 * TERRITORY WALK - Node tests
 * v1.1 AIウォーカー（Supabase サーバー側 / supabase/ai_walkers.sql）:
 *
 *   1) pg_cron で1時間ごとに public.run_ai_walkers() が走る（貼り直してもジョブは増えない）
 *   2) 1回あたり black 3〜7マス・white 3〜7マス（毎回ランダムに差が付く）
 *   3) 書き込むのは territory_tiles だけ。users / 週間ランキングには一切触らない
 *   4) schema.sql の territory_tiles（列・NOT NULL・主キー・CHECK）と完全に一致する
 *   5) grid.js と同じ tile_id（tile_{lat_idx}_{lng_idx}）・同じ100mメッシュ・
 *      同じ week_id（JST・月曜はじまりの 'YYYY-Www'）になる
 *   6) 直近30分に塗られたマスは奪わない（歩いている人の足元を守る）
 *   7) 主要都市（10拠点以上）に散らばり、日本国内に収まっている
 *   8) 1週間（168回）動かしても黒白が 48%〜52% 前後で揺れる（100%:0% にならない）
 *   9) アプリ側（ルール画面の文言・コード）は変更していない＝裏側だけで完結する
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const SQL = read(path.join('supabase', 'ai_walkers.sql'));
const SCHEMA = read('schema.sql');
const GRID = read('grid.js');

/** SQL から関数定義本体（$$ ... $$;）を取り出す */
function functionBody(name) {
    const pattern = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`);
    const match = SQL.match(pattern);
    return match ? match[0] : null;
}

const RUN_BODY = functionBody('run_ai_walkers');
const TILE_ID_BODY = functionBody('ai_walker_tile_id');
const WEEK_BODY = functionBody('iso_week_id');

/* ------------------------------------------------------------------ *
 * 1. pg_cron: 1時間ごとのジョブ
 * ------------------------------------------------------------------ */

test('AIウォーカー: supabase/ai_walkers.sql に run_ai_walkers がある', () => {
    assert.ok(RUN_BODY, 'run_ai_walkers を定義している');
    assert.match(RUN_BODY, /RETURNS INTEGER/, '戻り値は今回塗った枚数');
    assert.match(RUN_BODY, /SECURITY DEFINER/, 'RLS を通さずに書き込むため DEFINER');
    assert.match(RUN_BODY, /SET search_path = public/);
});

test('AIウォーカー: 1時間ごとに走るジョブを登録し、貼り直しても増えない', () => {
    assert.match(SQL, /CREATE EXTENSION IF NOT EXISTS pg_cron/);
    assert.match(SQL, /cron\.unschedule\(jobid\)[\s\S]*?'ai-walkers-hourly'/, '同じ名前を先に外す（冪等）');
    assert.match(SQL, /cron\.schedule\(\s*'ai-walkers-hourly',\s*'0 \* \* \* \*',/, '毎時0分の1本だけ');
    assert.match(SQL, /SELECT public\.run_ai_walkers\(\);/, 'ジョブから呼ぶ関数名が一致している');
    assert.ok(
        SQL.indexOf("cron.unschedule") < SQL.indexOf("cron.schedule("),
        'unschedule → schedule の順（再実行しても二重登録しない）'
    );
});

/* ------------------------------------------------------------------ *
 * 2. 1回あたり 3〜7 マス × 両チーム
 * ------------------------------------------------------------------ */

test('AIウォーカー: 1回あたり 3〜7 マス（毎回ランダムに差が付く）', () => {
    assert.match(RUN_BODY, /v_target\s*:=\s*3 \+ floor\(random\(\) \* 5\)::INTEGER/,
        '3 + 0〜4 = 3〜7 マス');
    assert.match(RUN_BODY, /WHILE v_placed < v_target/, '目標枚数まで歩く');
    assert.match(RUN_BODY, /v_placed := v_placed \+ 1/, '実際に塗れた枚数だけ数える');
});

test('AIウォーカー: black と white の両チームを同じ手順で歩かせる', () => {
    assert.match(RUN_BODY, /FOREACH v_team IN ARRAY ARRAY\['black', 'white'\]::TEXT\[\]/,
        '黒・白の2チーム分を回す');
    assert.match(RUN_BODY, /VALUES \([\s\S]*?v_week_id,\s*v_team,/, 'INSERT の team はループのチーム');
});

/* ------------------------------------------------------------------ *
 * 3. 書き込むのは territory_tiles だけ
 * ------------------------------------------------------------------ */

test('AIウォーカー: 書き込みは territory_tiles だけで、users・週間ランキングには触らない', () => {
    assert.match(RUN_BODY, /INSERT INTO public\.territory_tiles \(tile_id, week_id, team, lat_idx, lng_idx, updated_at\)/);
    assert.doesNotMatch(RUN_BODY, /territory_users/, '累計・コイン・順位の元になる users は触らない');
    assert.doesNotMatch(RUN_BODY, /territory_weekly_rankings/, '週間ランキングは触らない');
    assert.doesNotMatch(RUN_BODY, /TRUNCATE|DELETE FROM/i, '消す処理はしない');
});

test('AIウォーカー: ランキング・累計テーブルを更新する SQL が1行も無い', () => {
    // ON CONFLICT ... DO UPDATE SET は行の書き換え（テーブル指定ではない）ので数えない
    const writeTargets = [...SQL.matchAll(/\b(?:INSERT INTO|DELETE FROM)\s+(?:public\.)?([a-z_]+)|\bUPDATE\s+(?!SET\b)(?:public\.)?([a-z_]+)/gi)]
        .map((m) => (m[1] || m[2]).toLowerCase());
    assert.deepEqual([...new Set(writeTargets)], ['territory_tiles'], `書き込み先: ${writeTargets.join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * 4. schema.sql との整合（列・NOT NULL・主キー・CHECK）
 * ------------------------------------------------------------------ */

test('AIウォーカー: territory_tiles の列を schema.sql と完全に一致させている', () => {
    const table = SCHEMA.match(/CREATE TABLE IF NOT EXISTS territory_tiles \(([\s\S]*?)\n\);/)[1];
    const columns = [...table.matchAll(/^\s{4}([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]);
    assert.deepEqual(columns, ['tile_id', 'week_id', 'team', 'lat_idx', 'lng_idx', 'updated_at'],
        'schema.sql の列（順序どおり）');

    const insert = RUN_BODY.match(/INSERT INTO public\.territory_tiles \(([^)]*)\)/)[1]
        .split(',').map((c) => c.trim());
    assert.deepEqual(insert, columns, 'NOT NULL の列を1つも落とさない（updated_at も明示）');
});

test('AIウォーカー: 主キー (tile_id, week_id) で UPSERT する', () => {
    const primaryKey = SCHEMA.match(/CREATE TABLE IF NOT EXISTS territory_tiles \([\s\S]*?PRIMARY KEY \(([^)]*)\)/)[1];
    assert.equal(primaryKey.replace(/\s+/g, ''), 'tile_id,week_id', 'schema.sql の主キー');
    assert.match(RUN_BODY, /ON CONFLICT \(tile_id, week_id\) DO UPDATE/, '同じマスは塗り替え（行を増やさない）');
});

test('AIウォーカー: team は schema.sql の CHECK と同じ white / black のみ', () => {
    const check = SCHEMA.match(/team TEXT NOT NULL CHECK \(team IN \(([^)]*)\)\)/)[1]
        .split(',').map((v) => v.trim().replace(/'/g, ''));
    assert.deepEqual(check.sort(), ['black', 'white']);
    assert.match(RUN_BODY, /ARRAY\['black', 'white'\]/, 'CHECK に無い値は入れない');
});

/* ------------------------------------------------------------------ *
 * 5. grid.js との整合（tile_id・メッシュ・週ID）
 * ------------------------------------------------------------------ */

/** SQL に書いた主要都市（VALUES の行）を読み取る */
function readCities() {
    return [...SQL.matchAll(/\('([^']+)',\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/g)].map((m) => ({
        name: m[1],
        lat: Number(m[2]),
        lng: Number(m[3]),
        radius: Number(m[4])
    }));
}

const LAT_GRID = Number(GRID.match(/this\.LAT_GRID = ([\d.]+);/)[1]);
const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);
const meshId = (lat, lng) => `tile_${Math.floor(lat / LAT_GRID)}_${Math.floor(lng / LNG_GRID)}`;

test('AIウォーカー: メッシュ定数が grid.js と同じ（0.0009 / cos35°）', () => {
    assert.equal(LAT_GRID, 0.0009, 'grid.js の LAT_GRID');
    assert.match(GRID, /this\.LNG_GRID = this\.LAT_GRID \/ Math\.cos\(35\.0 \* Math\.PI \/ 180\)/);
    assert.match(RUN_BODY, /LAT_GRID\s+CONSTANT DOUBLE PRECISION := ([\d.]+);/);
    assert.equal(Number(RUN_BODY.match(/LAT_GRID\s+CONSTANT DOUBLE PRECISION := ([\d.]+);/)[1]), LAT_GRID);
    assert.match(RUN_BODY, /LNG_GRID\s+CONSTANT DOUBLE PRECISION := 0\.0009 \/ cos\(radians\(35\.0\)\)/,
        'CSS の Math.cos(35 * PI / 180) と同じ式');
    assert.match(RUN_BODY, /floor\(v_lat \/ LAT_GRID\)::INTEGER/);
    assert.match(RUN_BODY, /floor\(v_lng \/ LNG_GRID\)::INTEGER/);
});

test('AIウォーカー: tile_id は grid.js の getMeshId() と同じ形式', () => {
    assert.match(GRID, /return `tile_\$\{latIdx\}_\$\{lngIdx\}`;/, 'grid.js の形式');
    assert.ok(TILE_ID_BODY, 'ai_walker_tile_id がある');
    assert.match(TILE_ID_BODY, /SELECT 'tile_' \|\| lat_idx::TEXT \|\| '_' \|\| lng_idx::TEXT/);
    assert.match(RUN_BODY, /public\.ai_walker_tile_id\(v_lat_idx, v_lng_idx\)/, '本体もこの関数を通す');

    // 都市の座標から作られるIDが実際に 'tile_数字_数字' になる
    const cities = readCities();
    assert.ok(cities.length > 0);
    cities.forEach((c) => {
        assert.match(meshId(c.lat, c.lng), /^tile_-?\d+_-?\d+$/, `${c.name} のID形式`);
    });
});

test('AIウォーカー: week_id は grid.js と同じ JST・月曜はじまりの YYYY-Www', () => {
    assert.match(GRID, /AT TIME ZONE|timeZone: 'Asia\/Tokyo'|timeZone: "Asia\/Tokyo"/);
    assert.ok(WEEK_BODY, 'iso_week_id をこのファイルでも定義している（weekly_maintenance 未実行でも動く）');
    assert.match(WEEK_BODY, /AT TIME ZONE 'Asia\/Tokyo'/);
    assert.match(WEEK_BODY, /IYYY-"W"IW/, 'ISO週・週番号は常に2桁（JS の padStart(2, "0") と同じ）');
    assert.match(RUN_BODY, /v_week_id := public\.iso_week_id\(now\(\)\)/);

    // JS 側の週IDも同じ書式（既存テストと同じ 2026-11-16 = W47）
    global.document = { body: { dataset: {} } };
    const { isoWeekIdJst } = require(path.join(ROOT, 'grid.js'));
    assert.equal(isoWeekIdJst(new Date('2026-11-16T03:00:00+09:00')), '2026-W47');
    ['2026-11-16T00:00:00+09:00', '2026-11-22T23:59:00+09:00', '2025-12-29T09:00:00+09:00']
        .forEach((iso) => assert.match(isoWeekIdJst(new Date(iso)), /^\d{4}-W\d{2}$/));
});

/* ------------------------------------------------------------------ *
 * 6. 歩いている人の足元を奪わない
 * ------------------------------------------------------------------ */

test('AIウォーカー: 直近30分に塗られたマスは塗り替えない', () => {
    assert.match(RUN_BODY, /STALE_BEFORE CONSTANT INTERVAL := INTERVAL '30 minutes'/);
    const conflict = RUN_BODY.match(/ON CONFLICT \(tile_id, week_id\) DO UPDATE[\s\S]*?;/)[0];
    assert.match(conflict, /SET team\s+= EXCLUDED\.team/, '邪魔なマスは塗り替える（AI同士の取り合い）');
    assert.match(conflict, /WHERE COALESCE\(territory_tiles\.updated_at,[\s\S]*?< now\(\) - STALE_BEFORE/,
        '直近の更新はスキップする条件が付いている');
    assert.match(RUN_BODY, /IF FOUND THEN[\s\S]*?v_placed := v_placed \+ 1/,
        'スキップされた分は塗った枚数に数えない');
});

/* ------------------------------------------------------------------ *
 * 7. 主要都市（日本国内・10拠点以上）
 * ------------------------------------------------------------------ */

test('AIウォーカー: 主要都市が10拠点以上あり、日本国内に収まっている', () => {
    const cities = readCities();
    assert.ok(cities.length >= 10, `拠点数: ${cities.length}`);
    const names = cities.map((c) => c.name).join(' ');
    ['東京', '梅田', '難波', '京都', '名古屋', '福岡', '札幌', '横浜', '神戸', '仙台']
        .forEach((key) => assert.ok(names.includes(key), `${key} がある`));

    cities.forEach((c) => {
        assert.ok(c.lat >= 30 && c.lat <= 46, `${c.name} の緯度が日本国内: ${c.lat}`);
        assert.ok(c.lng >= 129 && c.lng <= 146, `${c.name} の経度が日本国内: ${c.lng}`);
        assert.ok(c.radius >= 300 && c.radius <= 2000, `${c.name} の散歩半径が街の広さ: ${c.radius}m`);
    });
});

test('AIウォーカー: 街の中のランダムな1点から歩き出す（毎回同じ場所に固まらない）', () => {
    assert.match(RUN_BODY, /v_r\s*:= v_radius \* sqrt\(random\(\)\)/, '円盤内で中心に偏らない');
    assert.match(RUN_BODY, /v_theta := 2 \* pi\(\) \* random\(\)/);
    assert.match(RUN_BODY, /ORDER BY random\(\)\s*\n?\s*LIMIT 1/, '都市もランダムに選ぶ');
    assert.match(RUN_BODY, /v_lat_idx := v_lat_idx \+ \(CASE WHEN random\(\) < 0\.5 THEN 1 ELSE -1 END\)/,
        '1マスずつランダムウォークする');
});

/* ------------------------------------------------------------------ *
 * 8. 実行結果の分布（1週間で 48〜52% 前後）
 * ------------------------------------------------------------------ */

test('AIウォーカー: 1週間（168回）動かしても黒白がほぼ半々で、100%:0% にならない', () => {
    // SQL と同じ規則を決定的な乱数で再現する（seed 固定なので毎回同じ結果）
    let seed = 20261117;
    const rand = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const cities = readCities();
    const owns = new Map();            // tileKey -> 'black' | 'white'
    const perRun = { black: [], white: [] };

    for (let hour = 0; hour < 168; hour++) {
        ['black', 'white'].forEach((team) => {
            const target = 3 + Math.floor(rand() * 5);      // 3〜7
            let placed = 0;
            let latIdx = null;
            let lngIdx = null;
            let attempts = 0;
            while (placed < target && attempts < target * 8) {
                attempts += 1;
                if (latIdx === null) {
                    const c = cities[Math.floor(rand() * cities.length)];
                    const r = c.radius * Math.sqrt(rand());
                    const theta = 2 * Math.PI * rand();
                    const lat = c.lat + (r * Math.cos(theta)) / 111320;
                    const lng = c.lng + (r * Math.sin(theta)) / (111320 * Math.cos((lat * Math.PI) / 180));
                    latIdx = Math.floor(lat / LAT_GRID);
                    lngIdx = Math.floor(lng / LNG_GRID);
                } else if (rand() < 0.5) {
                    latIdx += rand() < 0.5 ? 1 : -1;
                } else {
                    lngIdx += rand() < 0.5 ? 1 : -1;
                }
                owns.set(`tile_${latIdx}_${lngIdx}`, team);   // 1時間前のマスは塗り替え可
                placed += 1;
                if (rand() < 0.12) latIdx = null;
            }
            assert.ok(placed >= 3 && placed <= 7, `${team} の1回の枚数: ${placed}`);
            perRun[team].push(placed);
        });
    }

    const black = [...owns.values()].filter((t) => t === 'black').length;
    const total = owns.size;
    const blackPct = (black / total) * 100;
    assert.ok(blackPct >= 45 && blackPct <= 55, `黒のシェアが半々: ${blackPct.toFixed(1)}%`);
    assert.ok(black > 0 && black < total, 'どちらかが0%にはならない');
    assert.ok(perRun.black.reduce((a, b) => a + b, 0) > 0, '黒は毎回歩いている');
    assert.ok(perRun.white.reduce((a, b) => a + b, 0) > 0, '白は毎回歩いている');
});

/* ------------------------------------------------------------------ *
 * 9. 実行手順・権限・アプリ側の扱い
 * ------------------------------------------------------------------ */

test('AIウォーカー: SQL Editor に貼るだけで試せる手順がコメントで入っている', () => {
    assert.match(SQL, /SELECT public\.run_ai_walkers\(\);/);
    assert.match(SQL, /FROM cron\.job\b[\s\S]*?jobname = 'ai-walkers-hourly'/);
    assert.match(SQL, /cron\.job_run_details/, '実行履歴の確認方法');
    assert.match(SQL, /Supabase|SQL Editor/, 'どこで実行するか');
    assert.match(SQL, /xxzmrdfroqeflfgszgls/, '対象プロジェクト');
});

test('AIウォーカー: クライアントからは実行できない（いたずら防止）', () => {
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.run_ai_walkers\(\) FROM public, anon, authenticated/);
    assert.doesNotMatch(SQL, /GRANT EXECUTE ON FUNCTION public\.run_ai_walkers\(\)/);
});

test('AIウォーカー: ルール画面の文言は変えない（裏側の仕組みだけで動く）', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /AIウォーカー/, 'アプリの画面には出さない（翔大さんの判断）');
    assert.match(html, /勝敗は歩いたマスだけで集計/, '先行のルール追記（bd539e4・文言は 2026-11-17 に短縮）はそのまま');
    // アプリのコードからこの関数を呼ばない＝サーバー側の cron だけで完結する
    ['app.js', 'supabase.js', 'grid.js', 'stats.js'].forEach((file) => {
        assert.doesNotMatch(read(file), /run_ai_walkers/, `${file} から呼ばない`);
    });
});

module.exports = { functionBody, readCities, meshId };
