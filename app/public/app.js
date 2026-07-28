/* ----------------------------------------------------------------------------
 *  経費精算システム 画面スクリプト
 *  ※ jQueryを使っていた頃の書き方が残っています。
 * ------------------------------------------------------------------------- */

var currentUsers = [];
var attachedImageBase64 = null;
var attachedFileName = null;

// ---- タブ切り替え ----
document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'list') {
            loadReports();
        }
    });
});

// ---- カテゴリによる入力欄の出し入れ ----
document.getElementById('category').addEventListener('change', function () {
    var isEnt = this.value === 'entertainment';
    document.getElementById('attendeeRow').style.display = isEnt ? 'flex' : 'none';
    document.getElementById('currencyRow').style.display = isEnt ? 'flex' : 'none';
});

// ---- 社員一覧の読み込み ----
function loadUsers() {
    fetch('/api/users')
        .then(function (r) { return r.json(); })
        .then(function (json) {
            currentUsers = json.data;
            var sel = document.getElementById('currentUser');
            json.data.forEach(function (u) {
                var opt = document.createElement('option');
                opt.value = u.id;
                opt.textContent = u.name + '（' + u.department + '／' + u.role + '）';
                sel.appendChild(opt);
            });
        });
}
loadUsers();

// ---- 明細行の操作 ----
document.getElementById('addItem').addEventListener('click', function () {
    var tbody = document.querySelector('#itemTable tbody');
    var tr = document.createElement('tr');
    tr.innerHTML =
        '<td><input type="text" class="item-desc"></td>' +
        '<td><input type="number" class="item-price" value="0"></td>' +
        '<td><input type="number" class="item-qty" value="1"></td>' +
        '<td><button class="remove-item">削除</button></td>';
    tbody.appendChild(tr);
});

document.addEventListener('click', function (e) {
    if (e.target.classList.contains('remove-item')) {
        e.target.closest('tr').remove();
    }
});

// ---- レシート画像の読み込み ----
// 写真はそのまま base64 にしてサーバに送ります。
// （縮小処理はサーバ側で行う仕様のため、ここでは何もしません）
document.getElementById('receiptFile').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
        attachedImageBase64 = reader.result;
        attachedFileName = file.name;
    };
    reader.readAsDataURL(file);
});

// ---- 申請 ----
document.getElementById('submitBtn').addEventListener('click', function () {
    var category = document.getElementById('category').value;
    var items = [];
    document.querySelectorAll('#itemTable tbody tr').forEach(function (tr) {
        items.push({
            description: tr.querySelector('.item-desc').value,
            unitPrice: tr.querySelector('.item-price').value,
            qty: tr.querySelector('.item-qty').value
        });
    });

    var payload = {
        userId: document.getElementById('currentUser').value,
        title: document.getElementById('title').value,
        targetMonth: document.getElementById('targetMonth').value || undefined,
        items: items
    };
    if (category === 'entertainment') {
        payload.attendeeCount = document.getElementById('attendeeCount').value;
        payload.currency = document.getElementById('currency').value;
    }

    document.getElementById('result').textContent = '送信中...';

    fetch('/api/reports/' + category, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(function (r) { return r.json(); })
        .then(function (json) {
            document.getElementById('result').textContent = JSON.stringify(json, null, 2);
            // レシートが添付されていれば続けてアップロードする
            if (attachedImageBase64 && json.data && json.data.reportId) {
                uploadReceipt(json.data.reportId);
            }
        });
});

function uploadReceipt(reportId) {
    var el = document.getElementById('result');
    el.textContent = el.textContent + '\n\nレシートをアップロードしています...';
    fetch('/api/receipts/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            reportId: reportId,
            filename: attachedFileName,
            imageBase64: attachedImageBase64
        })
    })
        .then(function (r) { return r.json(); })
        .then(function (json) {
            el.textContent = el.textContent + '\n' + JSON.stringify(json, null, 2);
        });
}

// ---- 申請一覧 ----
function loadReports() {
    var limit = document.getElementById('listLimit').value;
    var tbody = document.querySelector('#reportTable tbody');
    tbody.innerHTML = '<tr><td colspan="9">読み込み中...</td></tr>';

    fetch('/api/reports?limit=' + limit)
        .then(function (r) { return r.json(); })
        .then(function (json) {
            tbody.innerHTML = '';
            json.data.forEach(function (r) {
                var tr = document.createElement('tr');
                tr.innerHTML =
                    '<td>' + r.id + '</td>' +
                    '<td>' + r.title + '</td>' +
                    '<td>' + CATEGORY_LABEL[r.category] + '</td>' +
                    '<td><span class="badge badge-' + r.status + '">' + STATUS_LABEL[r.status] + '</span></td>' +
                    '<td class="num">' + r.subtotal_amount + '</td>' +
                    '<td class="num">' + r.tax_amount + '</td>' +
                    '<td class="num">' + r.total_amount + '</td>' +
                    '<td>' + r.target_month + '</td>' +
                    '<td>' + (r.hasReceipt ? '📎' : '') + '</td>';
                tbody.appendChild(tr);
            });
        });
}

document.getElementById('reloadList').addEventListener('click', loadReports);

// 仕様書に記載されているカテゴリと状態の表示名
var CATEGORY_LABEL = {
    transport: '交通費',
    lodging: '宿泊費',
    entertainment: '接待費',
    goods: '物品費',
    other: 'その他'
};
var STATUS_LABEL = {
    draft: '下書き',
    submitted: '申請中',
    approved: '承認済み',
    rejected: '却下'
};

// ---- 承認 ----
document.getElementById('approveBtn').addEventListener('click', function () {
    var id = document.getElementById('approveReportId').value;
    document.getElementById('approveResult').textContent = '処理中...';
    fetch('/api/reports/' + id + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            approverId: document.getElementById('currentUser').value,
            comment: document.getElementById('approveComment').value
        })
    })
        .then(function (r) { return r.json(); })
        .then(function (json) {
            document.getElementById('approveResult').textContent = JSON.stringify(json, null, 2);
        });
});

document.getElementById('rejectBtn').addEventListener('click', function () {
    var id = document.getElementById('approveReportId').value;
    fetch('/api/reports/' + id + '/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            approverId: document.getElementById('currentUser').value,
            comment: document.getElementById('approveComment').value
        })
    })
        .then(function (r) { return r.json(); })
        .then(function (json) {
            document.getElementById('approveResult').textContent = JSON.stringify(json, null, 2);
        });
});

document.getElementById('withdrawBtn').addEventListener('click', function () {
    var id = document.getElementById('approveReportId').value;
    fetch('/api/reports/' + id + '/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: document.getElementById('currentUser').value,
            comment: document.getElementById('approveComment').value
        })
    })
        .then(function (r) { return r.json(); })
        .then(function (json) {
            document.getElementById('approveResult').textContent = JSON.stringify(json, null, 2);
        });
});

// ---- 月次集計 ----
document.getElementById('summaryBtn').addEventListener('click', function () {
    var month = document.getElementById('summaryMonth').value;
    var userId = document.getElementById('currentUser').value;
    document.getElementById('summaryResult').textContent = '集計中...';
    fetch('/api/summary/' + userId + '/' + month)
        .then(function (r) { return r.json(); })
        .then(function (json) {
            document.getElementById('summaryResult').textContent = JSON.stringify(json, null, 2);
        });
});
