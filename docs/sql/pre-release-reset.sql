-- ==========================================================================
--  TERRITORY WALK — リリース直前 Supabase 本番データ全リセット
--  対象 : Supabase プロジェクト（public スキーマ）
--  実行 : Supabase ダッシュボード → SQL Editor → New query → 全文を貼り付けて Run
--
--  【重要】実行してよいのは「App Store 審査へ提出する直前」の1回だけ。
--    TestFlight で実機検証している期間中は絶対に実行しないこと。
--    テスターの陣地・生涯戦績・コインが消え、検証がやり直しになる。
--    実行の合図は、app.js の CONFIG.ENABLE_DEBUG_TOOLS を false に切り替えた
--    ビルドを TestFlight で最終確認したあと（＝「審査へ提出」を押す直前）。
--
--  このスクリプトが消すのは「行データ」だけ。
--    テーブル定義・カラム・インデックス・RLS ポリシー・権限はそのまま残る。
--    何度実行しても同じ結果になる（冪等）。
--
--  対象テーブル（アプリが読み書きする全テーブル / schema.sql と一致）
--    territory_tiles           … 陣地（週 × メッシュ）
--    territory_users           … ユーザープロフィール・生涯戦績・コイン・招待コード
--    territory_weekly_rankings … 週間ランキング集計
-- ==========================================================================


-- --------------------------------------------------------------------------
-- STEP 0. 実行前の件数確認（結果をコピーして控える。ここでは何も消さない）
-- --------------------------------------------------------------------------
select 'territory_tiles'           as table_name, count(*) as rows from public.territory_tiles
union all
select 'territory_users',                          count(*)       from public.territory_users
union all
select 'territory_weekly_rankings',                count(*)       from public.territory_weekly_rankings
order by table_name;


-- --------------------------------------------------------------------------
-- STEP 1. 全件削除（1つのトランザクションで実行。どこかで失敗したら全部戻る）
--   RESTART IDENTITY は将来 SERIAL/IDENTITY 列を足したときのための保険
--   （現在の主キーはすべて TEXT のため実害はない）。
--   CASCADE は参照している行も一緒に消す指定。現状 FK は無いが将来の保険。
-- --------------------------------------------------------------------------
begin;

truncate table public.territory_tiles           restart identity cascade;
truncate table public.territory_users           restart identity cascade;
truncate table public.territory_weekly_rankings restart identity cascade;

commit;


-- --------------------------------------------------------------------------
-- STEP 2. 削除後の確認（3行とも rows = 0 になっていれば成功）
-- --------------------------------------------------------------------------
select 'territory_tiles'           as table_name, count(*) as rows from public.territory_tiles
union all
select 'territory_users',                          count(*)       from public.territory_users
union all
select 'territory_weekly_rankings',                count(*)       from public.territory_weekly_rankings
order by table_name;


-- --------------------------------------------------------------------------
-- 代替手段（TRUNCATE が権限エラーになる場合のみ）
--   SQL Editor は通常 postgres ロールで動くため TRUNCATE できます。
--   それでも `must be owner of table` 等で拒否されたときは、下の DELETE 版を
--   STEP 1 の代わりに実行してください（行数が多いと遅い／ロックが長い）。
-- --------------------------------------------------------------------------
-- begin;
-- delete from public.territory_tiles;
-- delete from public.territory_users;
-- delete from public.territory_weekly_rankings;
-- commit;


-- ==========================================================================
--  リセット後にやること（SQL の外の作業）
-- --------------------------------------------------------------------------
--  1) 端末側のデータを消す
--     localStorage には tw_user_id / tw_user_stats / tw_nickname /
--     pending_tile_queue が残っている。そのまま起動すると、その端末の
--     プロフィール行が再作成され、未送信の陣地が再アップロードされて
--     リセットが一部やり直しになる。
--     → テスター端末（自分の実機を含む）からアプリを一度削除し、
--       TestFlight の最新ビルドを入れ直す。
--
--  2) 表示の確認（空の状態が正しい）
--     「今週のTOP10」→「今週の記録はまだありません」
--     「歴代ランキング」→「記録がありません」
--     自分で1マス塗ると、その端末のユーザーID（表示名の初期値）で行が作られる。
--
--  3) このスクリプトは本番公開後には実行しない
--     公開後のユーザーデータも同じ方法で消えてしまうため。
--     （公開後の個別削除は user_id を指定した DELETE で行う）
--
--  4) 実行日時・STEP 0 の件数・STEP 2 の結果をリリース記録に残す。
-- ==========================================================================
