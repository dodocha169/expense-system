-- ============================================================================
--  索引追加のロールバック
--
--  対象   : 20260730_add_indexes.sql で作成した6本の索引を削除する
--  作成日 : 2026-07-30
--
--  DROP INDEX は ACCESS EXCLUSIVE ロックを取得するため、実行中は
--  【読み取りも書き込みも待たされます】。ただし索引の削除自体は
--  カタログの更新のみで一瞬で終わります（データは読みません）。
--  作成時と同様、稼働時間外の実行を推奨します。
--
--  索引を削除してもデータは一切変わりません。検索経路が減り、
--  Seq Scan に戻るだけです。
-- ============================================================================

\timing on
\set ON_ERROR_STOP on
SET client_min_messages = warning;

\echo ''
\echo '=== 削除前：対象の索引 ==='
SELECT indexrelname AS "索引", relname AS "テーブル",
       pg_size_pretty(pg_relation_size(indexrelid)) AS "サイズ",
       idx_scan AS "使用回数"
FROM pg_stat_user_indexes
WHERE indexrelname IN (
    'idx_expense_items_report_id',
    'idx_receipts_report_id',
    'idx_approvals_report_id',
    'idx_expense_reports_user_month',
    'idx_expense_reports_target_month',
    'idx_monthly_budgets_user_month'
)
ORDER BY indexrelname;

\echo ''
\echo '=== 削除します ==='

BEGIN;

DROP INDEX IF EXISTS idx_expense_items_report_id;
DROP INDEX IF EXISTS idx_receipts_report_id;
DROP INDEX IF EXISTS idx_approvals_report_id;
DROP INDEX IF EXISTS idx_expense_reports_user_month;
DROP INDEX IF EXISTS idx_expense_reports_target_month;
DROP INDEX IF EXISTS idx_monthly_budgets_user_month;

COMMIT;

ANALYZE expense_items;
ANALYZE expense_reports;
ANALYZE receipts;
ANALYZE approvals;
ANALYZE monthly_budgets;

\echo ''
\echo '=== 削除後の確認（0件なら削除完了） ==='
SELECT COUNT(*) AS "残っている対象索引"
FROM pg_stat_user_indexes
WHERE indexrelname IN (
    'idx_expense_items_report_id',
    'idx_receipts_report_id',
    'idx_approvals_report_id',
    'idx_expense_reports_user_month',
    'idx_expense_reports_target_month',
    'idx_monthly_budgets_user_month'
);

\echo ''
\echo 'ロールバックが完了しました。'
\echo ''
