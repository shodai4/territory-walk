-- ==========================================================
-- TERRITORY WALK - weekly_maintenance.sql
-- 毎週月曜 09:00 JST（= 月曜 00:00 UTC）に走る定期処理
--
--   1) プロサポーターコードを新しい1本へ上書き（履歴は残さない）
--   2) 結果発表・閲覧に支障のない範囲で、古い週のマス座標 territory_tiles を削除
--      ※ territory_weekly_rankings（週間ランキング）と territory_users（累計）は消さない
--
-- 実行方法:
--   Supabase ダッシュボード → SQL Editor にこのファイルを貼り付けて実行する。
--   Database → Extensions で pg_cron を有効化しておくこと（無い場合の代替は末尾）。
-- ==========================================================

-- ----------------------------------------------------------
-- 0. pg_cron（定期実行のタイマー）
-- ----------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ==========================================================
-- A. プロサポーターコード（常に最新の1本だけ）
-- ==========================================================

CREATE TABLE IF NOT EXISTS public.pro_access_codes (
    id         INTEGER PRIMARY KEY DEFAULT 1,
    code       TEXT NOT NULL,
    rotated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT pro_access_codes_single_row CHECK (id = 1)
);

-- 直接アクセスは許可しない（RLS 有効 + ポリシー無し + 権限剥奪）
ALTER TABLE public.pro_access_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pro codes are private" ON public.pro_access_codes;
REVOKE ALL ON TABLE public.pro_access_codes FROM anon, authenticated;

-- ランダムコード生成（TW-XXXX-XXXX / 紛らわしい文字 I,O,0,1 を除外）
CREATE OR REPLACE FUNCTION public.generate_pro_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    result   TEXT := 'TW-';
    i        INTEGER;
BEGIN
    FOR i IN 1..8 LOOP
        result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::INT, 1);
        IF i = 4 THEN
            result := result || '-';
        END IF;
    END LOOP;
    RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_pro_code() FROM public, anon, authenticated;

-- 上書き更新（履歴を残さない）
CREATE OR REPLACE FUNCTION public.rotate_pro_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    new_code TEXT;
BEGIN
    new_code := public.generate_pro_code();
    INSERT INTO public.pro_access_codes (id, code, rotated_at)
    VALUES (1, new_code, now())
    ON CONFLICT (id) DO UPDATE
        SET code = EXCLUDED.code,
            rotated_at = now();
    RETURN new_code;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_pro_code() FROM public, anon, authenticated;

-- 照合RPC（クライアントが呼ぶ唯一の入口。返すのは true/false だけ）
CREATE OR REPLACE FUNCTION public.verify_pro_code(input_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.pro_access_codes
        WHERE upper(btrim(input_code)) = upper(code)
    );
$$;

REVOKE ALL ON FUNCTION public.verify_pro_code(TEXT) FROM public;
GRANT EXECUTE ON FUNCTION public.verify_pro_code(TEXT) TO anon, authenticated;

-- 初回コードの発行（既にあれば触らない）
INSERT INTO public.pro_access_codes (id, code, rotated_at)
SELECT 1, public.generate_pro_code(), now()
WHERE NOT EXISTS (SELECT 1 FROM public.pro_access_codes WHERE id = 1);

-- ==========================================================
-- B. 古い週のマス座標データの削除（DB容量対策）
--    残す: 直近2週（今週 + 先週）／ランキング・累計テーブル
-- ==========================================================

-- アジア/東京の ISO 週（月曜はじまり）を 'YYYY-Www' で返す
CREATE OR REPLACE FUNCTION public.iso_week_id(ts TIMESTAMP WITH TIME ZONE DEFAULT now())
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT to_char(ts AT TIME ZONE 'Asia/Tokyo', 'IYYY-"W"IW');
$$;

CREATE OR REPLACE FUNCTION public.cleanup_old_territory_tiles(retain_weeks INTEGER DEFAULT 2)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    weeks   INTEGER;
    cutoff  TEXT;
    removed BIGINT;
BEGIN
    weeks := COALESCE(NULLIF(retain_weeks, 0), 2);
    IF weeks < 1 THEN
        weeks := 1;
    END IF;

    -- 例: retain_weeks = 2 なら「2週前の週」より古いものを消す
    --     → 今週と先週は残る（先週の結果発表・閲覧に支障なし）
    cutoff := public.iso_week_id(now() - make_interval(weeks => weeks));

    DELETE FROM public.territory_tiles
    WHERE week_id < cutoff;

    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_territory_tiles(INTEGER) FROM public, anon, authenticated;

-- ==========================================================
-- C. 週次ジョブ（コード更新 + 古いマスの削除をまとめて実行）
-- ==========================================================

CREATE OR REPLACE FUNCTION public.weekly_maintenance()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    removed BIGINT;
BEGIN
    PERFORM public.rotate_pro_code();
    removed := public.cleanup_old_territory_tiles(2);
    RAISE NOTICE 'weekly_maintenance: pro code rotated, % old territory tiles removed', removed;
END;
$$;

REVOKE ALL ON FUNCTION public.weekly_maintenance() FROM public, anon, authenticated;

-- 既存の同名ジョブがあれば貼り直す（冪等）
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('rotate-pro-code-weekly', 'weekly-maintenance');

SELECT cron.schedule(
    'weekly-maintenance',
    '0 0 * * 1',                                   -- 毎週月曜 00:00 UTC = 月曜 09:00 JST
    $$SELECT public.weekly_maintenance();$$
);

-- ----------------------------------------------------------
-- 手元で1回だけ試すとき:
--   SELECT public.cleanup_old_territory_tiles(2);   -- 削除件数が返る
--   SELECT public.iso_week_id();                    -- 今週の 'YYYY-Www'
--   SELECT public.verify_pro_code('TW-XXXX-XXXX');  -- true / false
--
-- 代替手順（pg_cron が使えない場合）:
--   GitHub Actions の cron から service_role キーで
--     POST {SUPABASE_URL}/rest/v1/rpc/weekly_maintenance
--   を叩く。anon キーでは実行できない（実行権限を剥奪済み）。
-- ----------------------------------------------------------
