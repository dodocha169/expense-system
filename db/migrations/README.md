# 索引追加の実施手順書

| 項目 | 内容 |
|---|---|
| 対象 | 経費精算システム（Kessai）データベース `expense_db` |
| 目的 | 一覧・月次集計・CSV出力の性能改善（INQ-001 / INQ-002） |
| 内容 | 索引6本の追加。**データの変更は行いません** |
| 作成日 | 2026-07-30 |
| スクリプト | `20260730_add_indexes.sql` |
| ロールバック | `20260730_add_indexes_rollback.sql` |
| 適用方式 | **手動実行**（スキーマ定義には含めていません。下記「手動実行が必要な場面」参照） |

---

## ★ 手動実行が必要な場面

**この索引は `db/init.sql`（スキーマ定義）に含まれていません。**
そのため、**データベースを作り直すたびに、このスクリプトを手動で実行する必要があります。**

### 手動実行が必要になる操作

| 操作 | 索引の状態 |
|---|---|
| `docker compose down -v` → `docker compose up` | **消える。要再実行** |
| DBボリュームの削除・再作成 | **消える。要再実行** |
| バックアップからのリストア（スキーマのみ） | **消える。要再実行** |
| `docker compose restart` / `docker compose down`（`-v` なし） | 残る |
| アプリの再ビルド（`--build app`） | 残る |

### 忘れた場合に起きること

**エラーは一切出ません。** 索引が無くても全機能が正常に動作し、結果も変わりません。
起きるのは**性能が元に戻ること**だけです。

| | 索引あり | 索引なし |
|---|---|---|
| `GET /api/reports?limit=100` | 221ms | 379ms |
| `GET /api/summary/1/2026-07` | 86ms | 150ms |

つまり**気づかないまま性能劣化した状態で運用が続く**可能性があります。
DBを作り直したときは、必ず下記で索引の有無を確認してください。

```sql
SELECT COUNT(*) AS "索引の数（6なら適用済み）"
FROM pg_stat_user_indexes
WHERE indexrelname IN (
    'idx_expense_items_report_id',
    'idx_receipts_report_id',
    'idx_approvals_report_id',
    'idx_expense_reports_user_month',
    'idx_expense_reports_target_month',
    'idx_monthly_budgets_user_month'
);
```

`0` が返った場合は未適用です。「実施手順」に従って実行してください。
本番環境で再実行する場合も**稼働時間外**の制約は同じです。

### なぜスキーマ定義に含めていないのか

`db/init.sql` に索引を追記すれば新規環境に自動で反映されますが、
**既存DB用のこのスクリプトとの二重管理**になり、片方だけ更新されると
環境間で索引構成が乖離します。乖離した場合、検証環境で再現しない
性能問題が本番で起きることになり、原因の特定が困難になります。

今回は「手動実行を手順として残す」方針を選択しています。
**この判断を変更する場合は、両ファイルを必ず同時に更新する運用を
引き継いでください。**

---

## ★ 実施タイミングの制約

**稼働時間外に実施してください。** 仕様書9章の稼働時間は「平日 8:00〜22:00」です。

`CREATE INDEX` は SHARE ロックを取得するため、**実行中は読み取りは可能ですが書き込みが待たされます**。検証環境（300万行・104MB）で、索引作成3.3秒のあいだ INSERT が3.4秒待たされることを確認しています。

所要時間は行数にほぼ比例します。**100万行あたり約1秒**を目安にしてください。実際の行数はスクリプトの「事前確認」で出力されます。

> `CREATE INDEX CONCURRENTLY` を使えば書き込みを止めずに作成できますが、トランザクションが使えず失敗時に不完全な索引が残るため、今回は採用していません。稼働時間内に実施せざるを得ない場合のみ検討してください。

---

## 実施前の確認

1. **バックアップが取得済みであること**
   索引の追加はデータを変更しませんが、DDLを流す前の慣行として確認してください。
2. **PostgreSQL のバージョン**
   ```sql
   SELECT version();
   ```
   検証は PostgreSQL 15 で行っています。
3. **空きディスク容量**
   検証環境（申請3,067件・明細9,070件）では追加分は約 350kB でした。行数に比例します。
   ```sql
   SELECT pg_size_pretty(pg_database_size('expense_db'));
   ```
4. **他のDDL・バッチが動いていないこと**
   夜間バッチとの同時実行は避けてください（`t_system_flags` に `BATCH_LOCK_MODE` というフラグがありますが、参照しているコードはリポジトリ内に存在しません。運用担当者に確認してください）。

---

## 実施手順

### Docker Compose 環境の場合

```bash
docker compose exec -T db psql -U expense_user -d expense_db -f /dev/stdin < db/migrations/20260730_add_indexes.sql
```

### psql が直接使える環境の場合

```bash
psql -U expense_user -d expense_db -f 20260730_add_indexes.sql
```

`\set ON_ERROR_STOP on` を設定しているため、**エラーが発生した時点で停止します**。索引の作成部分は1トランザクションにまとめてあるので、途中で失敗した場合は**何も作成されていない状態に自動で戻ります**。

---

## 実施後の確認

スクリプトの最後に確認用のクエリが含まれています。以下を確認してください。

1. **6本すべてが「有効 = t」で並んでいること**

   | 索引 | 対象 |
   |---|---|
   | `idx_expense_items_report_id` | expense_items (report_id) |
   | `idx_receipts_report_id` | receipts (report_id) |
   | `idx_approvals_report_id` | approvals (report_id) |
   | `idx_expense_reports_user_month` | expense_reports (user_id, target_month) |
   | `idx_expense_reports_target_month` | expense_reports (target_month) |
   | `idx_monthly_budgets_user_month` | monthly_budgets (user_id, target_month) |

2. **`EXPLAIN` の出力が `Seq Scan` でないこと**
   スクリプト末尾で `EXPLAIN SELECT * FROM expense_items WHERE report_id = 1;` を実行します。
   `Index Scan` または `Bitmap Heap Scan` になっていれば成功です。

3. **画面が正常に動作すること**
   申請一覧・月次集計・CSV出力を開いて、件数と金額が従来どおりであることを確認してください。
   索引は結果を変えませんが、念のための確認です。

---

## 期待される効果（検証環境での実測値）

| クエリ | 追加前 | 追加後 |
|---|---|---|
| 明細の取得（一覧が1件ごとに実行） | Seq Scan 6.796ms | Bitmap Heap Scan 0.344ms |
| 月次集計の対象抽出 | Seq Scan 4.536ms | Bitmap Heap Scan 0.191ms |
| CSV出力の対象抽出 | Seq Scan 0.773ms | Bitmap Heap Scan 0.406ms |
| 予算枠の照会 | Seq Scan 0.418ms | Index Scan 0.156ms |

API単位では以下です。

| | 追加前 | 追加後 |
|---|---|---|
| `GET /api/reports?limit=20` | 97ms | 46ms |
| `GET /api/reports?limit=100` | 379ms | 221ms |
| `GET /api/summary/1/2026-07` | 150ms | 86ms |
| `GET /api/export/2026-07` | 50ms | 40ms |

**索引だけでは1.7〜2.1倍止まりです。** 一覧が1件ごとに3クエリを発行する構造（N+1）と、使わない画像データまで読み込んでいる問題が残っているためです。これらは別途対応が必要です。

### 副作用（恒常的に発生）

書き込みが約1.21倍遅くなります。明細3,000件のINSERTで 19.3ms → 23.4ms、1件あたり +0.0014ms です。申請1件は明細数件のため、利用者が体感する差ではありません。

---

## 異常時

### 途中で失敗した場合

トランザクションが巻き戻るため、**索引は1本も作成されていません**。エラーメッセージを記録して、そのまま再実行できます（`IF NOT EXISTS` を付けているため、再実行は安全です）。

### 「有効 = f」の索引がある場合

想定していない状態です。該当の索引を削除してから再実行してください。

```sql
DROP INDEX <索引名>;
```

### 実施後に問題が発生した場合

ロールバックスクリプトを実行してください。索引を削除するだけで、**データは元に戻す必要がありません**（変更していないため）。

```bash
psql -U expense_user -d expense_db -f 20260730_add_indexes_rollback.sql
```

---

## 引き継ぎ事項

* **この索引は手動実行です。** DBを作り直すたびに再実行が必要です。詳細と確認方法は冒頭の「手動実行が必要な場面」を参照してください。**忘れてもエラーは出ず、性能が静かに劣化します**
* 既存の索引のうち `idx_legacy_reports_note`（40kB）・`idx_users_is_deleted`・`idx_legacy_users_employee_code` は**一度も使用されていない**ことを確認済みですが、削除は今回の対象外としています
* この索引だけでは一覧の性能は1.7〜2.1倍止まりです。N+1（一覧が1件ごとに3クエリを発行）と `SELECT *` による画像データの読み込みが残っています
