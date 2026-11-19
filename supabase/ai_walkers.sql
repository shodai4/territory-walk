-- ==========================================================
-- TERRITORY WALK - ai_walkers.sql
-- サーバー側（Supabase pg_cron）で動く「AIウォーカー」
--
--   ・1時間ごとに black / white それぞれ 3〜7 マスを territory_tiles に塗る
--   ・出発点は日本の主要14都市エリアのランダムな1点だけ
--     （「今週すでに塗られているマス」の近くからは出発しない）
--     → 実プレイヤーが歩いている街に寄っていくことはしない
--   ・塗るのは「今週まだ誰も塗っていない空白のマス」だけ。
--     すでに塗られているマス（実プレイヤー・AI のどちらでも）は
--     上書きせずにスキップし、次の空きマスを探して塗る
--     → 本物のプレイヤーが塗ったマスは絶対に消えない
--   ・更新するのは territory_tiles だけ。
--     territory_users（累計・コイン）と territory_weekly_rankings（週間順位）には
--     一切触らないので、本物のプレイヤーの順位・記録は邪魔されない
--
-- 実行方法:
--   Supabase ダッシュボード（プロジェクト xxzmrdfroqeflfgszgls）
--     → SQL Editor → New query → このファイル全文を貼り付けて Run。
--   pg_cron が未導入なら Database → Extensions で pg_cron を有効にしてから実行する。
--   何度実行してもジョブは増えない（冪等）。アプリ側のコード変更は不要。
-- ==========================================================


-- ----------------------------------------------------------
-- 0. pg_cron（1時間ごとのタイマー）
-- ----------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;


-- ----------------------------------------------------------
-- 1. 週ID（アプリと同じ JST・月曜はじまり 'YYYY-Www'）
--    weekly_maintenance.sql と同じ定義。未実行の環境でもこのファイルだけで動くよう
--    ここでも定義する（同名・同内容なので、先に weekly_maintenance.sql を
--    実行済みでも上書きされるだけで害はない）。
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.iso_week_id(ts TIMESTAMP WITH TIME ZONE DEFAULT now())
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT to_char(ts AT TIME ZONE 'Asia/Tokyo', 'IYYY-"W"IW');
$$;


-- ----------------------------------------------------------
-- 2. マスID（app の grid.js getMeshId() と同じ 'tile_{latIdx}_{lngIdx}'）
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_walker_tile_id(lat_idx INTEGER, lng_idx INTEGER)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT 'tile_' || lat_idx::TEXT || '_' || lng_idx::TEXT;
$$;


-- ----------------------------------------------------------
-- 3. AIウォーカー本体
--    戻り値: この回に塗ったマスの枚数（最大 14 = 7 + 7）
--
--    グリッドは grid.js と完全に同じ式:
--      lat_idx = floor(lat / 0.0009)
--      lng_idx = floor(lng / (0.0009 / cos(35°)))
--      tile_id = 'tile_' || lat_idx || '_' || lng_idx
--      week_id = JST の ISO 週（月曜はじまり）
-- ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_ai_walkers()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    -- grid.js と同じ 100m メッシュ定数（緯度 35 度基準）
    LAT_GRID     CONSTANT DOUBLE PRECISION := 0.0009;
    LNG_GRID     CONSTANT DOUBLE PRECISION := 0.0009 / cos(radians(35.0));
    -- 1マス塗るあたりの試行回数の安全上限。
    -- 空きマスが尽きた週でも無限ループしないための歯止め（3〜7 マス × 最大 20 回）。
    MAX_TRIES_PER_TILE CONSTANT INTEGER := 20;

    v_week_id  TEXT;
    v_team     TEXT;
    v_target   INTEGER;
    v_placed   INTEGER;
    v_attempts INTEGER;
    v_lat_idx  INTEGER;
    v_lng_idx  INTEGER;
    v_lat      DOUBLE PRECISION;
    v_lng      DOUBLE PRECISION;
    v_radius   DOUBLE PRECISION;
    v_r        DOUBLE PRECISION;
    v_theta    DOUBLE PRECISION;
    v_inserted INTEGER;          -- 直前に INSERT できた行数（0=既に塗られていた / 1=空きマスだった）
    v_total    INTEGER := 0;
BEGIN
    v_week_id := public.iso_week_id(now());   -- 例: '2026-W47'

    -- 両チーム（black / white）を同じ手順で歩かせる
    FOREACH v_team IN ARRAY ARRAY['black', 'white']::TEXT[] LOOP

        -- 1回あたり 3〜7 マス。毎時ランダムに増減するので偏りが積み上がらない
        v_target   := 3 + floor(random() * 5)::INTEGER;
        v_placed   := 0;
        v_attempts := 0;
        v_lat_idx  := NULL;   -- NULL = 新しい散歩の出発点を決める

        -- 安全上限: 目標枚数 × 20 回まで試して、塗れた分だけで終わる
        WHILE v_placed < v_target AND v_attempts < v_target * MAX_TRIES_PER_TILE LOOP
            v_attempts := v_attempts + 1;

            IF v_lat_idx IS NULL THEN
                -- 出発点は「主要14都市エリアのランダムな1点」だけ。
                -- （昔あった「今週すでに塗られているマスの近くから出発する」分岐は廃止）
                SELECT c.lat::DOUBLE PRECISION,
                       c.lng::DOUBLE PRECISION,
                       c.radius::DOUBLE PRECISION
                  INTO v_lat, v_lng, v_radius
                  FROM (VALUES
                      --   都市名          緯度      経度       散歩半径(m)
                      ('東京・東京駅',   35.6812,  139.7671,  1500.0),
                      ('東京・新宿',     35.6896,  139.7006,  1200.0),
                      ('東京・渋谷',     35.6580,  139.7016,  1000.0),
                      ('東京・池袋',     35.7295,  139.7109,  1000.0),
                      ('大阪・梅田',     34.7025,  135.4959,  1200.0),
                      ('大阪・難波',     34.6653,  135.5022,  1000.0),
                      ('大阪・天王寺',   34.6464,  135.5136,   800.0),
                      ('京都・四条',     35.0037,  135.7681,  1000.0),
                      ('名古屋・栄',     35.1681,  136.9066,  1200.0),
                      ('福岡・博多',     33.5898,  130.4207,  1000.0),
                      ('札幌・大通',     43.0606,  141.3540,  1000.0),
                      ('横浜',           35.4657,  139.6221,  1200.0),
                      ('神戸・三宮',     34.6946,  135.1955,   900.0),
                      ('仙台',           38.2601,  140.8819,   900.0)
                  ) AS c(name, lat, lng, radius)
                 ORDER BY random()
                 LIMIT 1;

                -- 円盤内のランダムな1点（中心に偏らないよう半径を sqrt）
                v_r     := v_radius * sqrt(random());
                v_theta := 2 * pi() * random();
                v_lat   := v_lat + (v_r * cos(v_theta)) / 111320.0;
                v_lng   := v_lng + (v_r * sin(v_theta)) / (111320.0 * cos(radians(v_lat)));

                v_lat_idx := floor(v_lat / LAT_GRID)::INTEGER;
                v_lng_idx := floor(v_lng / LNG_GRID)::INTEGER;
            ELSE
                -- ランダムウォーク: 東西南北のどれかへ1マス
                IF random() < 0.5 THEN
                    v_lat_idx := v_lat_idx + (CASE WHEN random() < 0.5 THEN 1 ELSE -1 END);
                ELSE
                    v_lng_idx := v_lng_idx + (CASE WHEN random() < 0.5 THEN 1 ELSE -1 END);
                END IF;
            END IF;

            -- 今週まだ誰も塗っていない空白マスにだけ塗る。
            -- すでに塗られているマス（実プレイヤー・AI のどちらでも）は
            -- 上書きせずに DO NOTHING で見送り、次の空きマスを探して歩き続ける。
            INSERT INTO public.territory_tiles (tile_id, week_id, team, lat_idx, lng_idx, updated_at)
            VALUES (
                public.ai_walker_tile_id(v_lat_idx, v_lng_idx),
                v_week_id,
                v_team,
                v_lat_idx,
                v_lng_idx,
                now()
            )
            ON CONFLICT (tile_id, week_id) DO NOTHING;

            -- DO NOTHING で見送ったときは 0 行。上書きは一切していない
            GET DIAGNOSTICS v_inserted = ROW_COUNT;

            IF v_inserted > 0 THEN
                -- 空きマスだった → 塗れた
                v_placed := v_placed + 1;
                v_total  := v_total + 1;
            ELSE
                -- すでに塗られていた → 上書きせずスキップ。
                -- 同じ場所で足踏みしないよう、半分の確率で別の街へ移る
                -- （残りの半分はそのまま次のマスを探す）。
                IF random() < 0.5 THEN
                    v_lat_idx := NULL;
                END IF;
            END IF;

            -- ときどき散歩を切り上げて、別の街へ移る
            IF random() < 0.12 THEN
                v_lat_idx := NULL;
            END IF;
        END LOOP;
    END LOOP;

    RETURN v_total;
END;
$$;

-- クライアント（anon / authenticated）からは実行できない。
-- pg_cron はジョブ作成者（postgres）として動くので、この剥奪で問題ない。
REVOKE ALL ON FUNCTION public.run_ai_walkers() FROM public, anon, authenticated;


-- ----------------------------------------------------------
-- 4. 1時間ごとのジョブ登録（冪等: 同じ名前があれば外してから貼り直す）
--    '0 * * * *' は「毎時0分」。1時間周期なのでタイムゾーンは影響しない。
-- ----------------------------------------------------------
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('ai-walkers-hourly', 'ai-walkers');

SELECT cron.schedule(
    'ai-walkers-hourly',
    '0 * * * *',
    $$SELECT public.run_ai_walkers();$$
);


-- ----------------------------------------------------------
-- 5. 手元で試す / 確認する（コピペ用）
--
--   -- (a) 1回だけ実行する（戻り値＝塗った枚数。3〜7の2チーム分＝6〜14が上限。
--   --      すでに塗られているマスが多い時間帯は、その分だけ少なくなる）
--   SELECT public.run_ai_walkers();
--
--   -- (b) 今週のチーム別マス数（黒と白がほぼ並ぶ）
--   SELECT team, count(*) AS tiles
--     FROM public.territory_tiles
--    WHERE week_id = public.iso_week_id()
--    GROUP BY team
--    ORDER BY team;
--
--   -- (c) 実際に塗られたマスの確認（新しい順。tile_id が 'tile_39000_135000' 形式か）
--   SELECT tile_id, week_id, team, lat_idx, lng_idx, updated_at
--     FROM public.territory_tiles
--    WHERE week_id = public.iso_week_id()
--    ORDER BY updated_at DESC
--    LIMIT 20;
--
--   -- (d) ジョブが登録されたか
--   SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'ai-walkers-hourly';
--
--   -- (e) 実行履歴（status = 'succeeded' ならOK。failed なら message を見る）
--   SELECT jobid, runid, status, return_message, start_time, end_time
--     FROM cron.job_run_details
--    ORDER BY start_time DESC
--    LIMIT 10;
--
--   -- (f) ジョブを止めたいとき
--   -- SELECT cron.unschedule('ai-walkers-hourly');
--
--   -- (g) この関数が触らないテーブル（順位・累計）の件数は変わらない
--   SELECT (SELECT count(*) FROM public.territory_users)           AS users,
--          (SELECT count(*) FROM public.territory_weekly_rankings)  AS rankings;
--
--   -- (h) 上書きしていないことの確認（実行前後で行数が増えた分だけが「新しく塗ったマス」）
--   SELECT count(*) FROM public.territory_tiles WHERE week_id = public.iso_week_id();
--
--   -- (i) 更新（UPDATE）された行が今週のマスに無いことを確認
--   --     updated_at は「新規に塗った時刻」だけを指す（既存マスは触らない）
--   SELECT tile_id, team, updated_at
--     FROM public.territory_tiles
--    WHERE week_id = public.iso_week_id()
--    ORDER BY updated_at ASC
--    LIMIT 5;
--
-- 代替手順（pg_cron が使えない環境）:
--   外部の定時実行（GitHub Actions の schedule 等）から service_role キーで
--     POST {SUPABASE_URL}/rest/v1/rpc/run_ai_walkers
--   を叩く。anon キーでは実行できない（実行権限を剥奪済み）。
-- ----------------------------------------------------------
