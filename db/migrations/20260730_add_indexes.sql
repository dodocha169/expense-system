-- ============================================================================
--  索引の追加（INQ-001 / INQ-002 の性能改善）
--
--  対象      : expense_db
--  作成日    : 2026-07-30
--  所要時間  : 下記「事前確認」の行数に依存。目安は本ファイル末尾を参照
--
--  ★★ 実行前に必ず読んでください ★★
--
--  このスクリプトは CREATE INDEX を使用します。CREATE INDEX は SHARE ロックを
--  取得するため、実行中は【読み取りは可能ですが、書き込みが待たされます】。
--  検証環境（300万行・104MB）では、索引作成 3.3 秒のあいだ INSERT が 3.4 秒
--  待たされることを確認済みです。
--
--  したがって【稼働時間外に実行してください】。
--  仕様書9章の稼働時間は「平日 8:00〜22:00」です。
--
--  CONCURRENTLY を使えば書き込みを止めずに作成できますが、
--  トランザクションが使えず、失敗時に INVALID な索引が残るため採用していません。
--  本スクリプトは全体を1トランザクションにまとめており、
--  途中で失敗した場合は【何も作成されていない状態に自動で戻ります】。
--
--  ロールバック : 20260730_add_indexes_rollback.sql
--  手順書       : README.md
-- ============================================================================

\timing on
\set ON_ERROR_STOP on
SET client_min_messages = warning;

\echo ''
\echo '=== 事前確認：対象データ量 ==='
SELECT
    (SELECT COUNT(*) FROM expense_items)   AS expense_items,
    (SELECT COUNT(*) FROM expense_reports) AS expense_reports,
    (SELECT COUNT(*) FROM receipts)        AS receipts,
    (SELECT COUNT(*) FROM approvals)       AS approvals,
    (SELECT COUNT(*) FROM monthly_budgets) AS monthly_budgets;

\echo ''
\echo '=== 事前確認：現在の索引サイズ ==='
SELECT c.relname AS "テーブル",
       pg_size_pretty(pg_indexes_size(c.oid)) AS "索引サイズ"
FROM pg_class c
WHERE c.relkind = 'r'
  AND c.relname IN ('expense_items','expense_reports','receipts','approvals','monthly_budgets')
ORDER BY c.relname;

\echo ''
\echo '=== 索引の作成を開始します（この間、書き込みは待たされます） ==='

-- 全体を1トランザクションにまとめる。途中で失敗すれば全て巻き戻る。
BEGIN;

-- 一覧・詳細・集計が1件ごとに実行する明細取得
--   GET /api/reports、GET /api/reports/:id、GET /api/summary
CREATE INDEX IF NOT EXISTS idx_expense_items_report_id
    ON expense_items (report_id);

-- 一覧のレシート添付判定、詳細のレシート取得
CREATE INDEX IF NOT EXISTS idx_receipts_report_id
    ON receipts (report_id);

-- 一覧の承認履歴取得
CREATE INDEX IF NOT EXISTS idx_approvals_report_id
    ON approvals (report_id);

-- 月次集計、予算枠チェック、定期券の二重申請チェック
--   GET /api/summary/:userId/:month、各申請ハンドラ
CREATE INDEX IF NOT EXISTS idx_expense_reports_user_month
    ON expense_reports (user_id, target_month);

-- CSV出力（対象月のみで絞るため、上の複合索引では効かない）
--   GET /api/export/:month
CREATE INDEX IF NOT EXISTS idx_expense_reports_target_month
    ON expense_reports (target_month);

-- 予算枠の照会・更新
--   承認・取り下げ時のロック取得を含む
CREATE INDEX IF NOT EXISTS idx_monthly_budgets_user_month
    ON monthly_budgets (user_id, target_month);

COMMIT;

\echo ''
\echo '=== 統計情報を更新します（プランナに索引を使わせるため） ==='
ANALYZE expense_items;
ANALYZE expense_reports;
ANALYZE receipts;
ANALYZE approvals;
ANALYZE monthly_budgets;

\echo ''
\echo '=== 事後確認：作成された索引 ==='
SELECT i.indexrelname AS "索引",
       i.relname      AS "テーブル",
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS "サイズ",
       x.indisvalid   AS "有効"
FROM pg_stat_user_indexes i
JOIN pg_index x ON x.indexrelid = i.indexrelid
WHERE i.indexrelname IN (
    'idx_expense_items_report_id',
    'idx_receipts_report_id',
    'idx_approvals_report_id',
    'idx_expense_reports_user_month',
    'idx_expense_reports_target_month',
    'idx_monthly_budgets_user_month'
)
ORDER BY i.indexrelname;

\echo ''
\echo '=== 事後確認：Seq Scan が消えたか ==='
EXPLAIN SELECT * FROM expense_items WHERE report_id = 1;

\echo ''
\echo '完了しました。上の一覧に6本すべてが「有効 = t」で並んでいることを確認してください。'
\echo '6本に足りない場合、または「有効 = f」がある場合は README.md の「異常時」を参照してください。'
\echo ''

-- ============================================================================
--  所要時間の目安（検証環境での実測値）
--
--    expense_items    9,070行  →  613ms
--    実験用テーブル  300万行  →  3,318ms（この間 INSERT が 3.4 秒待たされた）
--
--  行数にほぼ比例します。本番の行数は「事前確認」の出力で確認できます。
--  100万行あたり約1秒を目安に、書き込みが止まる時間を見積もってください。
--
--  書き込み性能への影響（索引追加後、恒常的に発生）
--    明細3,000件のINSERT : 19.3ms → 23.4ms（1.21倍、1件あたり +0.0014ms）
-- ============================================================================
