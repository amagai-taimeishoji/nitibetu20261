"use strict";

/* ---------------- 設定（必ず確認・変更する部分） ---------------- */
// Google Apps Script の公開 exec URL（その月のものに差し替えてください）
const API_URL = "https://script.google.com/macros/s/AKfycbyReINxzHNQ1gSJat81lWRn9Ta5Q21X7ehzkm72H4DgAHYz22KBfoiPUwGAqk405OlzhA/exec";

// 集計対象の年月（日付ドロップダウンはこの月で固定）
const YEAR = 2026;
const MONTH = 1;
const DAY_MIN = 1;
const DAY_MAX = 31;

// ローディングアニメーションの最大時間（ミリ秒）
const LOADING_DURATION_MS = 20000; // 
/* ----------------------------------------------------------------- */


/* ---------------- グローバル変数 ---------------- */
let barChartInstance = null;
let pieChartInstance = null;
let loadingStart = null;
let loadingRaf = null;
let waitingForData = false;  // データ待ち状態フラグ

/* ---------------- DOM 要素（事前に HTML 内で定義されている想定） ---------------- */
const updateStatusEl = document.getElementById("update-status");
const visitorCountEl = document.getElementById("visitor-count");
const memberInfoEl = document.getElementById("member-info");

const nameInput = document.getElementById("name-input");
const dateSelect = document.getElementById("date-select");
const prevBtn = document.getElementById("prev-day");
const nextBtn = document.getElementById("next-day");
const searchBtn = document.getElementById("search-button");

const loadingArea = document.getElementById("loading-area");
const loadingFill = document.getElementById("loading-fill");
const loadingText = document.getElementById("loading-text");
const resultsSection = document.getElementById("results");

const rankingTable = document.getElementById("ranking-table");
const scoredataTable = document.getElementById("scoredata-table");
const tenhanList = document.getElementById("tenhan-list");
const barCanvas = document.getElementById("bar-chart");
const rankCountTable = document.getElementById("rank-count-table");
const pieCanvas = document.getElementById("pie-chart");
/* -------------------------------------------------------------------------- */


/* ========== 初期化処理 ========== */
populateDateDropdown(YEAR, MONTH); // 日付プルダウン生成
setInitialDate();                  // 初期日付設定（20時ルール）
attachEvents();                    // イベント登録
/* ================================ */


/* ================= 日付ドロップダウンを作る =================
   - YEAR, MONTH, DAY_MIN..DAY_MAX を使って option を作成します
   - 表示例: "10/1 (水)" のように曜日を付与
   ============================================================ */
function populateDateDropdown(year, month) {
  dateSelect.innerHTML = "";
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

  // month の末日と DAY_MAX の小さい方まで作る
  const last = Math.min(new Date(year, month, 0).getDate(), DAY_MAX);
  for (let d = DAY_MIN; d <= last; d++) {
    const option = document.createElement("option");
    const dt = new Date(year, month - 1, d);

    option.value = `${year}/${String(month).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
    option.textContent = `${month}/${d} (${weekdays[dt.getDay()]})`;

    dateSelect.appendChild(option);
  }
}


/* ================= 初期表示日付の決定（20時ルール） =================
   - JST 現在時刻を参照（タイムゾーン補正）
   - 20:00 未満なら「前日」を初期値にする
   - ただし YEAR, MONTH と一致しない場合は DAY_MIN にフォールバック
   ================================================================ */
function setInitialDate() {
  const nowStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
  const nowJst = new Date(nowStr);
  let base = new Date(nowJst);

  if (nowJst.getHours() < 20) {
    base.setDate(nowJst.getDate() - 1);
  }

  // 月が合わないときは安全に DAY_MIN を使う
  if (base.getFullYear() !== YEAR || base.getMonth() + 1 !== MONTH) {
    base = new Date(YEAR, MONTH - 1, DAY_MIN);
  }

  dateSelect.value = `${YEAR}/${String(MONTH).padStart(2, "0")}/${String(base.getDate()).padStart(2, "0")}`;
  updateNavButtons();
}


/* ========== 時間を "HH:MM" 形式に揃えるユーティリティ ========== */
function formatTimeHHMM(timeStr) {
  if (!timeStr) return "-";
  const parts = timeStr.split(":");
  const h = (parts[0] || "0").padStart(2, "0");
  const m = (parts[1] || "0").padStart(2, "0");
  return `${h}:${m}`;
}


/* ================= イベント登録 ================= */
function attachEvents() {
  searchBtn.addEventListener("click", () => fetchAndRender({ triggeredBy: "search" }));
  dateSelect.addEventListener("change", () => fetchAndRender({ triggeredBy: "select" }));
  prevBtn.addEventListener("click", () => { changeSelectedDay(-1); fetchAndRender({ triggeredBy: "nav" }); });
  nextBtn.addEventListener("click", () => { changeSelectedDay(1); fetchAndRender({ triggeredBy: "nav" }); });

  // Enter キーで検索
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fetchAndRender({ triggeredBy: "search" });
  });
}


/* ================= 日付ナビゲーション補助 ================= */
function changeSelectedDay(delta) {
  const current = parseSelectedDay();
  let target = current + delta;
  const last = Math.min(new Date(YEAR, MONTH, 0).getDate(), DAY_MAX);

  if (target < DAY_MIN) target = DAY_MIN;
  if (target > last) target = last;

  dateSelect.value = `${YEAR}/${String(MONTH).padStart(2, "0")}/${String(target).padStart(2, "0")}`;
  updateNavButtons();
}

function parseSelectedDay() {
  return parseInt(dateSelect.value.split("/")[2], 10);
}

function updateNavButtons() {
  const day = parseSelectedDay();
  prevBtn.hidden = (day <= DAY_MIN);
  const last = Math.min(new Date(YEAR, MONTH, 0).getDate(), DAY_MAX);
  nextBtn.hidden = (day >= last);
}


/* ================= Loading アニメーション制御（15s 非ループ） =================
   - startLoading() で表示、loadingTick が RAF で進める
   - 100% 到達時に自動的に stopLoading() を呼びます
   ======================================================================== */
function startLoading() {
  loadingArea.style.display = "flex";
  loadingFill.style.width = "0%";
  loadingText.style.display = "block";
  updateStatusEl.textContent = "────────";

  waitingForData = true;  // データ取得を待機中にセット
  loadingStart = performance.now();
  cancelAnimationFrame(loadingRaf);
  loadingRaf = requestAnimationFrame(loadingTick);
}
function loadingTick(now){
  const elapsed = now - loadingStart;
  const pct = Math.min(100, (elapsed / LOADING_DURATION_MS) * 100);
  loadingFill.style.width = pct + "%";

  if (pct < 100) {
    loadingRaf = requestAnimationFrame(loadingTick);
  } else {
    if (waitingForData) {
      // データまだ来てない → 表示を切り替える（要望の文言に変更）
      loadingText.textContent = "もうちょっとまってほしい！";
      // stopLoading() は呼ばない（そのままデータ到着を待つ）
    } else {
      stopLoading();
    }
  }
}

function stopLoading() {
  cancelAnimationFrame(loadingRaf);
  loadingFill.style.width = "100%";
  // 少し待ってから非表示にしてリセット
  setTimeout(() => {
    loadingArea.style.display = "none";
    loadingFill.style.width = "0%";
    loadingText.style.display = "none";
  }, 220);
}


/* ================= Fetch（GAS API）して描画まで行うメイン関数 =================
   - パラメータ: name, date (yyyy/MM/dd)
   - サーバーエラーや data.error を表示
   - 受け取った data を整形し、ランキングや表・グラフを描画
   ================================================================ */
async function fetchAndRender({ triggeredBy = "search" } = {}) {
  const name = nameInput.value.trim();
  if (!name) {
    alert("名前を入力してねっ");
    return;
  }

  const dateParam = dateSelect.value; // yyyy/MM/dd

  // ローディング開始・結果非表示
  startLoading();
  resultsSection.style.display = "none";

  try {
    const url = `${API_URL}?name=${encodeURIComponent(name)}&date=${encodeURIComponent(dateParam)}`;
    const res = await fetch(url);
    const data = await res.json();
    waitingForData = false;   // フラグ解除
    stopLoading();

    if (data.error) {
      // API 側でエラーが返った場合は stop & メッセージ
      stopLoading();
      updateStatusEl.textContent = data.error;
      return;
    }

    // サーバー返却の更新状況文字列は読み込み完了後に表示（仕様）
    updateStatusEl.textContent = data.updateStatus || "ー";

    /* ---------- all 配列を正規化 (日本語キー / 英語キー 対応) ---------- */
    const rawAll = data.all || [];
    const normalizedAll = rawAll.map(item => {
      const half = Number(item["半荘数"] ?? item.half ?? (Array.isArray(item.games) ? item.games.length : 0)) || 0;
      const total = Number(item["総スコア"] ?? item.total ?? 0) || 0;
      const high = Number(item["最高スコア"] ?? item.high ?? 0) || 0;
      const avg = Number(item["平均スコア"] ?? item.avg ?? (half ? total / half : 0)) || 0;

      // 平均着順は存在しない場合 null を許容
      const avgRankRaw = (item["平均着順"] ?? item.avgRank ?? item["平均着順"]);
      const avgRank = (avgRankRaw === undefined || avgRankRaw === null || avgRankRaw === "") ? null : Number(avgRankRaw);

      return {
        name: item.name,
        half,
        total,
        high,
        avg,
        avgRank,
        raw: item
      };
    });

    // 集計人数（ゲームが一つ以上ある人の数）
    const uniqueCount = normalizedAll.filter(p => p.half > 0).length;
    visitorCountEl.textContent = `集計人数: ${uniqueCount} 人`;

    // No. と名前（API の data.no と data.name を使う）
    memberInfoEl.textContent = `No. ${data.no || "不明"}   ${data.name || ""}`;

    /* ---------- ランキング計算（全員分） ---------- */
    // 半荘数 > 0 の人だけランキング対象にする
    const rankMaps = buildAllRankMaps(normalizedAll.filter(p => p.half > 0));

    // 表示する自分の名前（API が返す name を優先）
    const userName = data.name || name;

    // 自分の順位 (安全に取得)
    const ranksRow = [
      formatRankValue(rankMaps.half[userName]),
      formatRankValue(rankMaps.total[userName]),
      formatRankValue(rankMaps.high[userName]),
      formatRankValue(rankMaps.avg[userName]),
      formatRankValue(rankMaps.avgRank[userName])
    ];

    // ランキング表レンダリング（自分だけの順位表示）
    createTable("ranking-table", [
      ["累計半荘数\nランキング", "総スコア\nランキング", "最高スコア\nランキング", "平均スコア\nランキング", "平均着順\nランキング"],
      ranksRow
    ], 5);

    /* ---------- 日別スコアサマリ（summary）表示 ---------- */
    const s = data.summary || {};
    createTable("scoredata-table", [
      ["累計半荘数", "総スコア", "最高スコア", "平均スコア", "平均着順"],
      [
        s.半荘数 != null ? `${s.半荘数}半荘` : (s.half != null ? `${s.half}半荘` : "データなし"),
        s.総スコア != null ? `${Number(s.総スコア).toFixed(1)}pt` : (s.total != null ? `${Number(s.total).toFixed(1)}pt` : "データなし"),
        s.最高スコア != null ? `${Number(s.最高スコア).toFixed(1)}pt` : (s.high != null ? `${Number(s.high).toFixed(1)}pt` : "データなし"),
        s.平均スコア != null ? `${Number(s.平均スコア).toFixed(3)}pt` : (s.avg != null ? `${Number(s.avg).toFixed(3)}pt` : "データなし"),
        s.平均着順 != null ? `${Number(s.平均着順).toFixed(3)}位` : (s.avgRank != null ? `${Number(s.avgRank).toFixed(3)}位` : "データなし")
      ]
    ], 5);

    /* ---------- ゲームリストを時刻でソートして描画 ---------- */
    const games = (data.games || []).slice().sort((a, b) =>
      parseTimeForSort(data.date, a.time) - parseTimeForSort(data.date, b.time)
    );

    renderGameList(games);

    /* ---------- チャートと着順テーブルを作成 ---------- */
    createBarChart(games);                 // 棒グラフ（center 0）
    const rankCounts = countRanks(games);  // 着順カウント
    createRankCountTable(rankCounts);      // 着順テーブル
    createPieChart(rankCounts);            // 円グラフ

    // 結果表示して loading を止める
    resultsSection.style.display = "block";
    stopLoading();

  } catch (err) {
    // 例外時はローディングを止めてエラーメッセージを表示
    stopLoading();
    updateStatusEl.textContent = `成績更新チュ♡今は見れません (${err.message})`;
    console.error(err);
  }
}


/* ========== ヘルパー: 日付文字列 + 時刻文字列をソート用に変換 ==========
   dateStr: "yyyy/MM/dd"
   timeStr: "HH:mm:ss" など（空白なら当日00:00と扱う）
   戻り値: ミリ秒 (Number)
   ================================================================ */
function parseTimeForSort(dateStr, timeStr) {
  if (!timeStr) {
    return new Date(dateStr.replace(/\//g, "-") + "T00:00:00+09:00").getTime();
  }
  // timeStr は "HH:mm:ss" 形式で入ってくる前提（すでにそうなっている）
  return new Date(dateStr.replace(/\//g, "-") + "T" + timeStr + "+09:00").getTime();
}


/* ================== buildAllRankMaps: 全員分の順位マップを返す ==================
   - 入力: normalizedAll の配列 (name, half, total, high, avg, avgRank)
   - 出力: { half: {name:rank}, total: {...}, high: {...}, avg: {...}, avgRank: {...} }
   - 同値は同順位（同着）扱い
   ======================================================================= */
function buildAllRankMaps(arr) {
  const list = arr.slice();

  function calc(key, asc = false) {
    // 配列を (name, val) に整形。欠損値は asc/desc に応じて末尾に移動
    const tmp = list.map(a => {
      let v = a[key];
      if (v === null || v === undefined || isNaN(Number(v))) {
        v = asc ? Infinity : -Infinity;
      } else {
        v = Number(v);
      }
      return { name: a.name, val: v };
    });

    // 並び替え
    tmp.sort((x, y) => (asc ? x.val - y.val : y.val - x.val));

    // ランク付け（同値 -> 同着）
    const map = {};
    let prev = null;
    let lastRank = 0;

    for (let i = 0; i < tmp.length; i++) {
      const it = tmp[i];
      if (prev !== null && it.val === prev) {
        map[it.name] = lastRank; // 同値なので前の順位を使う
      } else {
        lastRank = i + 1;
        map[it.name] = lastRank;
        prev = it.val;
      }
    }
    return map;
  }

  return {
    half: calc("half", false),
    total: calc("total", false),
    high: calc("high", false),
    avg: calc("avg", false),
    avgRank: calc("avgRank", true) // 平均着順は昇順で良い
  };
}


/* ================== 表示ユーティリティ ================== */
function formatRankValue(v) {
  return v == null ? "データなし" : `${v}位`;
}

/* テーブル描画ユーティリティ
   id: DOM id
   rows: 2次元配列（行ごとのセル）
   cols: 列数
*/
function createTable(id, rows, cols) {
  const table = document.getElementById(id);
  if (!table) return;
  table.innerHTML = "";
  table.style.gridTemplateColumns = `repeat(${cols}, 18vw)`; // 固定列幅（既存設計に合わせる）

  rows.forEach((row, rowIndex) => {
    row.forEach(cell => {
      const div = document.createElement("div");
      div.textContent = cell;
      div.className = rowIndex % 2 === 0 ? "header" : "data";

      // 空白セルは見えなくする
      if (!cell || cell.toString().trim() === "") div.classList.add("empty-cell");

      table.appendChild(div);
    });
  });
}


/* ================== ゲームリスト（カード）を描画 ==================
   - 横長カードを縦に並べる（最新が一番下）
   - 左側: 時刻 (HH:MM)
   - 右側: 着順 と スコア
   ============================================================ */
function renderGameList(games) {
  tenhanList.innerHTML = "";

  if (!games || games.length === 0) {
    const d = document.createElement("div");
    d.className = "score-card";
    d.textContent = "スコアなし";
    tenhanList.appendChild(d);
    return;
  }

  // games は時間昇順（fetchAndRender でソート済み）
  games.forEach((g, i) => {
    const card = document.createElement("div");
    card.className = "score-card";

    // 左: 時刻（HH:MM）
    const left = document.createElement("div");
    left.className = "card-left";
    left.textContent = formatTimeHHMM(g.time);

    // 右: 着順 + スコア
    const right = document.createElement("div");
    right.className = "card-right";

    // スコア表示: 小数がないなら整数表示、あれば小数1桁
    const scoreStr = (g.score == null || isNaN(g.score))
      ? "データ不足"
      : `${Number(g.score).toFixed(Math.abs(g.score - Math.round(g.score)) < 1e-6 ? 0 : 1)}pt`;

    right.textContent = `${g.rank != null ? g.rank + "着" : "着順なし"}　${scoreStr}`;

    card.appendChild(left);
    card.appendChild(right);

    tenhanList.appendChild(card);
  });
}


/* ================== 棒グラフ（中心0）作成 ==================
   - データは games（ユーザーの当日ゲーム配列）
   - 右端が最新＝黄色、それ以外は紫（rgba(186,140,255,0.7)）
   - y 軸は最大絶対値に合わせて上下対象に
   - 横ラベルは斜め表示で多数でも重ならないように autoSkip を有効
   ================================================================== */
function createBarChart(games) {
  if (barChartInstance) barChartInstance.destroy();

  // コンテキスト取得
  const ctx = barCanvas.getContext("2d");

  // ラベル = 時刻 (HH:MM)
  const labels = games.map(g => formatTimeHHMM(g.time));

  // 値 = スコア（数値化）
  const values = games.map(g => Number(g.score || 0));

  // 表示レンジ
  const maxVal = values.length ? Math.max(...values) : 0;
  const minVal = values.length ? Math.min(...values) : 0;
  let maxAbs = Math.max(Math.abs(maxVal), Math.abs(minVal));
  if (maxAbs <= 0) maxAbs = 10; // 表示の最低レンジ（0 のときの見やすさ確保）

  // 色: 最右が最新 = 黄色、それ以外は紫
  const bg = values.map((_, i) =>
    i === values.length - 1 ? "rgba(255, 206, 86, 0.95)" : "rgba(186, 140, 255, 0.7)"
  );

    // Chart.js インスタンス生成
  barChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "スコア",
        data: values,
        backgroundColor: bg
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 60,
            minRotation: 45,
            autoSkip: true,
            maxTicksLimit: 20
          }
        },
        y: {
          min: -maxAbs * 1.1,
          max: maxAbs * 1.1,
          ticks: {
            // 目盛りはおおよそ 5 分割になるよう step を設定
            stepSize: Math.ceil((maxAbs * 1.1) / 5)
          }
        }
      }
    }
  });
}


/* ================== 着順カウント（ユーザーのゲームのみ） ================== */
function countRanks(games) {
  const keys = ["1", "1.5", "2", "2.5", "3", "3.5", "4"];
  const cnt = {};
  keys.forEach(k => cnt[k] = 0);

  games.forEach(g => {
    if (g.rank == null) return;
    const key = String(g.rank);
    if (cnt[key] !== undefined) cnt[key] += 1;
  });

  return cnt;
}


/* ================== 着順テーブル作成 ================== */
function createRankCountTable(counts) {
  const id = "rank-count-table";
  const table = document.getElementById(id);
  if (!table) return;

  table.innerHTML = "";
  const cols = 4;
  table.style.gridTemplateColumns = `repeat(${cols}, 18vw)`;

  const row1 = ["1着の回数", "2着の回数", "3着の回数", "4着の回数"];
  const row2 = [
    `${counts["1"] || 0}回`,
    `${counts["2"] || 0}回`,
    `${counts["3"] || 0}回`,
    `${counts["4"] || 0}回`
  ];
  const row3 = ["1.5着の回数", "2.5着の回数", "3.5着の回数", ""];
  const row4 = [
    `${counts["1.5"] || 0}回`,
    `${counts["2.5"] || 0}回`,
    `${counts["3.5"] || 0}回`,
    ""
  ];

  [row1, row2, row3, row4].forEach((r, ri) =>
    r.forEach(cell => {
      const d = document.createElement("div");
      d.textContent = cell;
      d.className = ri % 2 === 0 ? "header" : "data";
      if (!cell || cell.toString().trim() === "") d.classList.add("empty-cell");
      table.appendChild(d);
    })
  );
}


/* ================== 円グラフ作成 ==================
   - データが全て 0 の場合でもエラーにならないように処理
   - 色やツールチップは既存仕様に準拠
   =================================================== */
function createPieChart(counts) {
  // canvas 要素の再取得（念のため）
  const pieCanvasLocal = document.getElementById("pie-chart");
  if (!pieCanvasLocal) {
    console.error("pieCanvas not found!");
    return;
  }
  const ctx = pieCanvasLocal.getContext("2d");

  const keys = ["1", "1.5", "2", "2.5", "3", "3.5", "4"];
  const dataArr = keys.map(k => counts[k] || 0);
  const total = dataArr.reduce((a, b) => a + b, 0);

  // 以前のインスタンスを破棄（あれば）
  if (pieChartInstance) pieChartInstance.destroy();

  // 色配列
  const colors = [
    "rgba(240,122,122,1)",
    "rgba(240,158,109,1)",
    "rgba(240,217,109,1)",
    "rgba(181,217,109,1)",
    "rgba(109,194,122,1)",
    "rgba(109,194,181,1)",
    "rgba(109,158,217,1)"
  ];

  // Chart.js に渡すデータ（total === 0 でも Chart は作れるが表示上意味がないため空グラフを作る）
  pieChartInstance = new Chart(ctx, {
    type: "pie",
    data: {
      labels: ["1着", "1.5着", "2着", "2.5着", "3着", "3.5着", "4着"],
      datasets: [{
        data: dataArr,
        backgroundColor: colors
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: "left"
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              const value = context.raw || 0;
              const pct = total ? ((value / total) * 100).toFixed(1) : "0.0";
              return `${context.label}: ${value}回 (${pct}%)`;
            }
          }
        }
      }
    }
  });

  // ※ total === 0 の場合、円は見えないがインスタンスは作られる（表示上 '0' 件）
}
