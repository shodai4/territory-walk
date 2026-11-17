-- ==========================================================
-- TERRITORY WALK - transfer_code.sql
-- 機種変更・再インストール用の「引き継ぎコード」を territory_users に追加する
--
-- 実行方法（1回だけ）:
--   Supabase ダッシュボード（プロジェクト xxzmrdfroqeflfgszgls）
--     → SQL Editor → New query → このファイル全文を貼り付けて Run
--   何度実行しても安全（冪等）。
--
-- 何をするか:
--   1. territory_users に transfer_code 列（8文字の英数コード）を追加
--   2. 既存ユーザー全員にコードを払い出す（未設定の行だけ）
--   3. transfer_code にユニークインデックスを張る（同じコードの重複を防ぐ）
--
-- アプリ側の対応（実装済み・変更不要）:
--   ・自分のコードを territory_users.transfer_code に自動で登録する
--     （列が無い間はアプリが自動で列なしの同期へ退避し、ゲームは普通に動く）
--   ・別端末でコードを入力すると territory_users を検索し、
--     user_id / team / 累計戦績 / コイン を新しい端末へ引き継いで再起動する
--
-- 注意（既知の制限）:
--   現在の RLS は territory_users を「全公開（SELECT/UPDATE 誰でも可）」にしているため、
--   anon キーを知っていれば誰でもコードを読める状態です（既存の referral_code と同じ）。
--   公開アプリの anon キーは元々公開情報で、現状は他人の行を書き換えることも可能なので
--   今回の追加で新たに弱くなるわけではありませんが、将来 RLS を厳しくする場合は
--   「コード→ユーザー」の照合を SECURITY DEFINER の RPC に置き換えるのが本筋です。
-- ==========================================================

-- 1. 列を追加
ALTER TABLE territory_users
    ADD COLUMN IF NOT EXISTS transfer_code TEXT;

-- 2. 既存ユーザーへコードを払い出す（未設定の行だけ／8文字）
UPDATE territory_users
SET transfer_code = upper(substr(md5(random()::text || user_id || clock_timestamp()::text), 1, 8))
WHERE transfer_code IS NULL OR transfer_code = '';

-- 3. 重複を防ぐ（照合を1件に絞れる）
CREATE UNIQUE INDEX IF NOT EXISTS idx_territory_users_transfer_code
    ON territory_users (transfer_code);

-- 4. 確認（missing = 0 なら全員にコードが付いている）
SELECT
    count(*)                                        AS total_users,
    count(*) FILTER (WHERE transfer_code IS NULL)   AS missing,
    count(DISTINCT transfer_code)                   AS distinct_codes
FROM territory_users;
