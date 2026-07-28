-- ============================================================
--  経費精算システム (Kessai Expense System) v1.4.2
--  DB初期化スクリプト
--
--  ※ 2019年の初期構築時から継ぎ足しで運用されているスクリプトです。
--    ALTER の履歴は残っていません（開発当時の担当者は退職済み）。
-- ============================================================

-- ------------------------------------------------------------
-- 社員マスタ
-- ------------------------------------------------------------
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(200),
    -- role: 'employee'（申請者） / 'approver'（承認者） / 'admin'
    role            VARCHAR(20) DEFAULT 'employee',
    department      VARCHAR(100),
    -- 上長。承認ルートの決定に使う想定だったが、実装では使われていない
    manager_id      INTEGER,
    -- 平文で入っている（移行時にハッシュ化するはずだった）
    password_hash   VARCHAR(200),
    -- 使われていないカラム群（2020年の要件変更で不要になったが消せていない）
    employee_code   VARCHAR(50),
    bank_account    VARCHAR(100),
    last_login_ip   VARCHAR(50),
    is_deleted      BOOLEAN DEFAULT false,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 経費申請ヘッダ
-- ------------------------------------------------------------
CREATE TABLE expense_reports (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    title           VARCHAR(200),
    -- category: 'transport' / 'lodging' / 'entertainment' / 'goods' / 'other'
    category        VARCHAR(50),
    -- status: 仕様書では draft / submitted / approved / rejected の4値のはずだが
    --         実際には他の値も入っている（VARCHARなので何でも入る）
    status          VARCHAR(30),
    subtotal_amount NUMERIC(12, 2),
    tax_amount      NUMERIC(12, 2),
    total_amount    NUMERIC(12, 2),
    -- 対象月 'YYYY-MM'。予算枠の突き合わせに使う
    target_month    VARCHAR(7),
    note            TEXT,
    submitted_at    TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 経費申請明細
-- ------------------------------------------------------------
CREATE TABLE expense_items (
    id              SERIAL PRIMARY KEY,
    report_id       INTEGER NOT NULL,
    description     VARCHAR(300),
    unit_price      NUMERIC(12, 2),
    qty             INTEGER DEFAULT 1,
    amount          NUMERIC(12, 2),
    -- 接待費のみ使用（参加人数）。他カテゴリでは NULL
    attendee_count  INTEGER,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- レシート画像
--   画像は base64 文字列のまま TEXT に格納している。
--   構築当時「ファイルサーバを増やす予算が無い」という理由でこうなった。
-- ------------------------------------------------------------
CREATE TABLE receipts (
    id              SERIAL PRIMARY KEY,
    report_id       INTEGER NOT NULL,
    filename        VARCHAR(300),
    mime_type       VARCHAR(100),
    image_base64    TEXT,
    thumb_base64    TEXT,
    exif_json       TEXT,
    byte_size       INTEGER,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 月次予算枠（部署・個人ごとの上限管理）
-- ------------------------------------------------------------
CREATE TABLE monthly_budgets (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    target_month    VARCHAR(7) NOT NULL,
    limit_amount    NUMERIC(12, 2) DEFAULT 200000,
    used_amount     NUMERIC(12, 2) DEFAULT 0,
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 承認履歴
-- ------------------------------------------------------------
CREATE TABLE approvals (
    id              SERIAL PRIMARY KEY,
    report_id       INTEGER NOT NULL,
    approver_id     INTEGER,
    step            INTEGER DEFAULT 1,
    -- decision: 'approved' / 'rejected' / 'withdrawn'
    decision        VARCHAR(30),
    comment         TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 監査ログ（誰も見ていない）
-- ------------------------------------------------------------
CREATE TABLE audit_logs (
    id              SERIAL PRIMARY KEY,
    action_type     VARCHAR(100),
    target_id       INTEGER,
    payload         TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 経費カテゴリマスタ
--   税率・上限額はここで管理する設計だったが、
--   アプリ側は一切参照せずコードに直書きされている。
-- ------------------------------------------------------------
CREATE TABLE m_expense_category (
    code            VARCHAR(50) PRIMARY KEY,
    label           VARCHAR(100),
    tax_rate        NUMERIC(5, 3),
    limit_amount    NUMERIC(12, 2),
    note            TEXT
);

INSERT INTO m_expense_category (code, label, tax_rate, limit_amount, note) VALUES
    ('transport',     '交通費',   0.100,  50000, '公共交通機関のみ。タクシーは要事前申請'),
    ('lodging',       '宿泊費',   0.100,  30000, '1泊あたりの上限'),
    ('entertainment', '接待費',   0.100,  10000, '参加者1名あたりの上限'),
    ('goods',         '物品費',   0.100, 100000, '10万円以上は資産計上のため経費申請不可'),
    ('other',         'その他',   0.100,  30000, '内容を必ず記載すること');

-- ============================================================
--  インデックス
--  ※ report_id / user_id / target_month に索引が無い。
--    「本番でCREATE INDEXを流すと止まるので次のメンテ時に」と
--    引き継がれたまま5年経過している。
-- ============================================================
CREATE INDEX idx_users_is_deleted ON users(is_deleted);
CREATE INDEX idx_legacy_users_employee_code ON users(employee_code);
CREATE INDEX idx_legacy_reports_note ON expense_reports(note);

-- ============================================================
--  初期データ
-- ============================================================

-- 社員 40名（うち5名が承認者）
INSERT INTO users (name, email, role, department, manager_id, password_hash, employee_code)
SELECT
    '社員' || i,
    'user' || i || '@example.co.jp',
    CASE WHEN i % 8 = 0 THEN 'approver' ELSE 'employee' END,
    CASE (i % 4)
        WHEN 0 THEN '営業部'
        WHEN 1 THEN '開発部'
        WHEN 2 THEN '管理部'
        ELSE '企画部'
    END,
    CASE WHEN i % 8 = 0 THEN NULL ELSE ((i / 8) * 8 + 8) END,
    'password123',
    'EMP' || LPAD(i::text, 5, '0')
FROM generate_series(1, 40) AS s(i);

-- 月次予算枠（2026年01月〜07月）
INSERT INTO monthly_budgets (user_id, target_month, limit_amount, used_amount)
SELECT
    u.id,
    '2026-' || LPAD(m::text, 2, '0'),
    200000,
    0
FROM users u CROSS JOIN generate_series(1, 7) AS s(m);

-- 過去の申請データ 3000件
INSERT INTO expense_reports (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month, note, submitted_at)
SELECT
    (i % 40) + 1,
    '経費申請 #' || i,
    (ARRAY['transport', 'lodging', 'entertainment', 'goods', 'other'])[(i % 5) + 1],
    (ARRAY['submitted', 'approved', 'rejected', 'pending', 'OK', 'wip'])[(i % 6) + 1],
    (1000 + (i * 37) % 40000),
    0,
    (1000 + (i * 37) % 40000),
    '2026-' || LPAD((((i % 6) + 1))::text, 2, '0'),
    NULL,
    NOW() - ((i % 180) || ' days')::interval
FROM generate_series(1, 3000) AS s(i);

-- 明細（1申請あたり1〜3件）
INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
SELECT
    r.id,
    '明細 ' || g,
    r.subtotal_amount / 3,
    1,
    r.subtotal_amount / 3
FROM expense_reports r CROSS JOIN generate_series(1, 3) AS s(g);

-- 使用済み予算の集計（過去分）
UPDATE monthly_budgets b
SET used_amount = COALESCE((
    SELECT SUM(r.total_amount)
    FROM expense_reports r
    WHERE r.user_id = b.user_id
      AND r.target_month = b.target_month
      AND r.status IN ('approved')
), 0);

-- ============================================================
--  運用メモ用テーブル（削除するとバッチが落ちると言われている）
-- ============================================================
CREATE TABLE t_system_flags (
    flag_key    VARCHAR(100) PRIMARY KEY,
    flag_value  VARCHAR(200),
    memo        TEXT
);

INSERT INTO t_system_flags (flag_key, flag_value, memo) VALUES
    ('ENABLE_LEGACY_TAX_ROUNDING', 'true',  '2019年の税制対応で追加。触るな。'),
    ('BATCH_LOCK_MODE',            'v2',    '夜間バッチとの排他制御用。v1に戻すと二重計上する。'),
    ('IMAGE_PROCESS_ON_SERVER',    'true',  'クライアント側処理は非対応端末があるためサーバで実施。');
