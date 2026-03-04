/* ═══════════════════════════════════════════════════════
   stock-detail.js — 종목 상세 페이지 (stock.html 전용)

   의존: config.js (SID, PROXY), utils.js (fB, pc, fU, fK, fP)
   ═══════════════════════════════════════════════════════ */

// ── URL 파라미터 ──
const _P = new URLSearchParams(location.search);
const TICKER = _P.get("ticker") || "";
const NAME = decodeURIComponent(_P.get("name") || TICKER);
const STYPE = _P.get("type") || "stock";
const IS_ETF = STYPE === "etf";

// ── 상태 ──
let charts = {}, _priceData = [], _mktCap = 0, _curPrice = 0, _curEPS = 0, _rawEPS = 0, _rawPER = 0;


/* ═══════════════════════════════════════════════════════
   유틸리티
   ═══════════════════════════════════════════════════════ */

/** 메트릭 셀 값 설정 + 색상 적용 */
function sM(id, v, fmt) {
  const el = document.getElementById(id);
  if (!el || v == null || v === "" || v === 0) return;
  el.textContent = fmt(Number(v));
  if (["mROE", "mOPM", "mDivY", "mR1Y", "mR3Y", "mR5Y"].indexOf(id) >= 0)
    el.style.color = pc(Number(v));
}

/** Google Sheets JSONP 날짜 파싱: "Date(2022,0,3)" → "2022-01-03" */
function parseGDate(v) {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = s.match(/Date\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    const yr = m[1], mo = String(Number(m[2]) + 1).padStart(2, "0"), dy = m[3].padStart(2, "0");
    return yr + "-" + mo + "-" + dy;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/** 상대 시간 표시 (뉴스용) */
function tA(ds) {
  if (!ds) return "";
  const d = Math.floor((Date.now() - new Date(ds)) / 1000);
  if (d < 3600) return Math.floor(d / 60) + "분 전";
  if (d < 86400) return Math.floor(d / 3600) + "시간 전";
  if (d < 604800) return Math.floor(d / 86400) + "일 전";
  return new Date(ds).toLocaleDateString("ko-KR");
}


/* ═══════════════════════════════════════════════════════
   JSONP — Google Sheets 데이터 로딩
   ═══════════════════════════════════════════════════════ */

let _cbIdx = 0;
function jsonp(sheetName, tqQuery) {
  return new Promise(function(resolve, reject) {
    const cb = "__cb" + (++_cbIdx) + "_" + Date.now();
    const timeout = setTimeout(function() { delete window[cb]; reject(new Error("timeout")); }, 15000);
    window[cb] = function(resp) {
      clearTimeout(timeout); delete window[cb];
      if (!resp || !resp.table) { reject(new Error("no data")); return; }
      const cols = resp.table.cols.map(function(c) { return c.label || c.id; });
      const rows = resp.table.rows.map(function(r) {
        const o = {};
        r.c.forEach(function(cell, i) { o[cols[i]] = cell ? cell.v : null; o[i] = cell ? cell.v : null; });
        return o;
      });
      resolve({ cols, rows });
    };
    const s = document.createElement("script");
    let url = "https://docs.google.com/spreadsheets/d/" + SID + "/gviz/tq?tqx=out:json;responseHandler:" + cb + "&sheet=" + encodeURIComponent(sheetName);
    if (tqQuery) url += "&tq=" + encodeURIComponent(tqQuery);
    s.src = url;
    s.onerror = function() { clearTimeout(timeout); delete window[cb]; reject(new Error("load err")); };
    document.head.appendChild(s);
  });
}


/* ═══════════════════════════════════════════════════════
   헤더 + 메트릭 그리드 초기화
   ═══════════════════════════════════════════════════════ */

document.getElementById("sName").innerHTML = NAME + '<span class="badge ' + (IS_ETF ? "etf" : "stock") + '">' + (IS_ETF ? "ETF" : "주식") + "</span>";
document.getElementById("sTicker").textContent = TICKER + " · US";
document.title = NAME + " - " + TICKER;

const mg = document.getElementById("metricsGrid");
mg.innerHTML = IS_ETF
  ? '<div class="m-card"><div class="k">보수율</div><div class="v" id="mER">-</div></div><div class="m-card"><div class="k">순자산</div><div class="v" id="mAUM">-</div></div><div class="m-card"><div class="k">배당률</div><div class="v" id="mDivY">-</div></div><div class="m-card"><div class="k">섹터</div><div class="v" id="mSector" style="font-size:10px">-</div></div><div class="m-card"><div class="k">1Y 수익률</div><div class="v" id="mR1Y">-</div></div><div class="m-card"><div class="k">3Y 수익률</div><div class="v" id="mR3Y">-</div></div><div class="m-card"><div class="k">5Y 수익률</div><div class="v" id="mR5Y">-</div></div><div class="m-card"><div class="k">시가총액</div><div class="v" id="mCap">-</div></div>'
  : '<div class="m-card"><div class="k">PER</div><div class="v" id="mPER">-</div></div><div class="m-card"><div class="k">PBR</div><div class="v" id="mPBR">-</div></div><div class="m-card"><div class="k">ROE</div><div class="v" id="mROE">-</div></div><div class="m-card"><div class="k">EPS</div><div class="v" id="mEPS">-</div></div><div class="m-card"><div class="k">시가총액</div><div class="v" id="mCap">-</div></div><div class="m-card"><div class="k">배당률</div><div class="v" id="mDivY">-</div></div><div class="m-card"><div class="k">부채비율</div><div class="v" id="mDebt">-</div></div><div class="m-card"><div class="k">영업이익률</div><div class="v" id="mOPM">-</div></div>';


/* ═══════════════════════════════════════════════════════
   탭 시스템
   ═══════════════════════════════════════════════════════ */

const tabs = IS_ETF
  ? [{ id: "Chart", l: "📈 주가" }, { id: "Holdings", l: "📦 보유종목" }, { id: "News", l: "📰 뉴스" }]
  : [{ id: "Chart", l: "📈 주가" }, { id: "Financial", l: "📊 재무" }, { id: "News", l: "📰 뉴스" }];

document.getElementById("detailTabs").innerHTML = tabs.map((t, i) =>
  '<button class="' + (i === 0 ? "active" : "") + '" onclick="showTab(\'' + t.id + '\')">' + t.l + "</button>"
).join("");

let _hL = 0, _fL = 0, _nL = 0;
function showTab(id) {
  tabs.forEach(t => {
    const p = document.getElementById("panel" + t.id);
    if (p) p.style.display = t.id === id ? "" : "none";
  });
  document.querySelectorAll("#detailTabs button").forEach((b, i) => b.classList.toggle("active", tabs[i].id === id));
  if (id === "Holdings" && !_hL) { _hL = 1; loadHoldings(); }
  if (id === "Financial" && !_fL) { _fL = 1; loadFinancials(); }
  if (id === "News" && !_nL) { _nL = 1; loadNews(); }
}

document.querySelectorAll(".period-btn").forEach(b => {
  b.addEventListener("click", function() {
    document.querySelectorAll(".period-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    renderChart(b.dataset.p);
  });
});


/* ═══════════════════════════════════════════════════════
   메트릭 로딩 (StockCache)
   ═══════════════════════════════════════════════════════ */

async function loadMetrics() {
  try {
    const data = await jsonp("StockCache");
    let row = null;
    for (let i = 0; i < data.rows.length; i++) {
      const t = String(data.rows[i][0] || "").trim().toUpperCase();
      if (t === TICKER.toUpperCase()) { row = data.rows[i]; break; }
    }
    if (!row) { console.warn("[CACHE] ticker NOT found:", TICKER); return; }

    if (IS_ETF) {
      sM("mER", row[11], v => v + "%");
      sM("mAUM", row[12], fB);
      sM("mDivY", row[8], v => v.toFixed(2) + "%");
      sM("mCap", row[7], fB);
      const sec = row[13];
      if (sec) document.getElementById("mSector").textContent = sec;
    } else {
      sM("mPER", row[3], v => v.toFixed(1));
      sM("mPBR", row[4], v => v.toFixed(2));
      sM("mROE", row[5], v => v.toFixed(1) + "%");
      _rawEPS = Number(row[6]) || 0;
      _rawPER = Number(row[3]) || 0;
      _mktCap = Number(row[7]) || 0;
      _curEPS = _rawEPS;
      if (Math.abs(_rawEPS) <= 1000) {
        sM("mEPS", _rawEPS, v => "$" + v.toFixed(2));
      } else {
        document.getElementById("mEPS").textContent = "보정중...";
        document.getElementById("mEPS").style.color = "var(--amber)";
      }
      sM("mCap", row[7], fB);
      sM("mDivY", row[8], v => v.toFixed(2) + "%");
      sM("mDebt", row[9], v => v.toFixed(1) + "%");
      sM("mOPM", row[10], v => v.toFixed(1) + "%");
    }

    const updated = row[14];
    if (updated) document.getElementById("tsUpdated").textContent = "최종 갱신: " + new Date(updated).toLocaleString("ko-KR");
  } catch (e) {
    console.error("[CACHE] metrics err:", e);
    document.getElementById("tsUpdated").textContent = "메트릭 로딩 실패: " + e.message;
    document.getElementById("tsUpdated").style.color = "var(--red)";
  }
}


/* ═══════════════════════════════════════════════════════
   가격 데이터 로딩 + 차트
   ═══════════════════════════════════════════════════════ */

async function loadPrices() {
  try {
    const data = await jsonp("PriceCache", "SELECT * WHERE A='" + TICKER + "'");
    _priceData = [];
    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i];
      const dt = r[1], cl = Number(r[2]);
      if (!dt || !cl || isNaN(cl)) continue;
      const dateStr = parseGDate(dt);
      if (!dateStr) continue;
      _priceData.push({ date: dateStr, close: cl, open: Number(r[3]) || cl, high: Number(r[4]) || cl, low: Number(r[5]) || cl });
    }
    _priceData.sort((a, b) => a.date > b.date ? 1 : -1);

    if (_priceData.length > 1) {
      const last = _priceData[_priceData.length - 1], prev = _priceData[_priceData.length - 2];
      const ch = last.close - prev.close, cp = ch / prev.close * 100;
      _curPrice = last.close;
      document.getElementById("sPrice").textContent = "$" + last.close.toFixed(2);
      document.getElementById("sPrice").style.color = pc(ch);
      document.getElementById("sChange").innerHTML = '<span style="color:' + pc(ch) + '">' + (ch >= 0 ? "+" : "") + ch.toFixed(2) + " (" + (cp >= 0 ? "+" : "") + cp.toFixed(2) + "%)</span>";
    }
    renderChart("1y");
    if (IS_ETF && _priceData.length > 60) calcReturns();
  } catch (e) { console.error("[CACHE] prices err:", e); }
}

function calcReturns() {
  const now = _priceData[_priceData.length - 1].close;
  [{ id: "mR1Y", y: 1 }, { id: "mR3Y", y: 3 }, { id: "mR5Y", y: 5 }].forEach(r => {
    const cut = new Date();
    cut.setFullYear(cut.getFullYear() - r.y);
    const old = _priceData.find(d => new Date(d.date) >= cut);
    if (old) {
      const ret = (now / old.close - 1) * 100;
      sM(r.id, ret, v => (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
    }
  });
}

function renderChart(period) {
  if (!_priceData.length) return;
  const now = new Date(), cut = new Date(now);
  if (period === "3m") cut.setMonth(now.getMonth() - 3);
  else if (period === "6m") cut.setMonth(now.getMonth() - 6);
  else if (period === "1y") cut.setFullYear(now.getFullYear() - 1);
  else if (period === "3y") cut.setFullYear(now.getFullYear() - 3);
  else cut.setFullYear(now.getFullYear() - 5);

  const cutStr = cut.toISOString().slice(0, 10);
  let f = _priceData.filter(d => d.date >= cutStr);
  if (!f.length) f = _priceData;

  const ma = f.map((_, i) => { if (i < 19) return null; let s = 0; for (let j = i - 19; j <= i; j++) s += f[j].close; return s / 20; });
  const labels = f.map(d => {
    const p = d.date.split("-");
    if (period === "3m" || period === "6m") return p[1] + "." + p[2];
    if (period === "1y") return "'" + p[0].slice(2) + "." + p[1];
    return p[0] + "." + p[1];
  });

  if (charts.price) charts.price.destroy();
  charts.price = new Chart(document.getElementById("chPrice"), {
    type: "line",
    data: {
      labels, datasets: [
        { label: "종가", data: f.map(d => d.close), borderColor: "#4d9aff", backgroundColor: "rgba(77,154,255,0.06)", fill: true, tension: 0.2, pointRadius: 0, borderWidth: 1.5 },
        { label: "MA20", data: ma, borderColor: "#ffc05c", borderWidth: 1, pointRadius: 0, borderDash: [3, 2], tension: 0.3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#5e82a8", font: { size: 8 }, maxTicksLimit: 7 }, grid: { color: "#1f3a6215" } },
        y: { ticks: { color: "#5e82a8", font: { size: 9 }, callback: v => "$" + v.toFixed(0) }, grid: { color: "#1f3a6215" } }
      },
      plugins: {
        legend: { labels: { color: "#9db5d4", font: { size: 10 } } },
        tooltip: { callbacks: { title: ctx => f[ctx[0].dataIndex].date, label: ctx => ctx.dataset.label + ": $" + ctx.raw?.toFixed(2) } }
      }
    }
  });
}


/* ═══════════════════════════════════════════════════════
   보유종목 (ETF)
   ═══════════════════════════════════════════════════════ */

async function loadHoldings() {
  try {
    const data = await jsonp("HoldingsCache", "SELECT * WHERE A='" + TICKER + "'");
    const holdings = [];
    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i];
      holdings.push({ rank: r[1], name: r[2] || "", ticker: r[3] || "", weight: Number(r[4]) || 0 });
    }
    holdings.sort((a, b) => a.rank - b.rank);

    if (!holdings.length) {
      document.getElementById("holdingsList").innerHTML = '<div style="text-align:center;padding:16px;color:var(--sub);font-size:11px">보유종목 데이터 없음</div>';
      return;
    }

    const colors = ["#4d9aff", "#2ee0a8", "#ae82ff", "#ffc05c", "#ff6b78", "#5cc9f5", "#ff9cf5", "#8aff80", "#ffb347", "#6c8eff"];
    if (charts.hold) charts.hold.destroy();
    charts.hold = new Chart(document.getElementById("chHoldings"), {
      type: "doughnut",
      data: { labels: holdings.map(h => h.name), datasets: [{ data: holdings.map(h => h.weight), backgroundColor: colors, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "55%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.label + ": " + ctx.raw.toFixed(2) + "%" } } } }
    });

    let html = "";
    holdings.forEach((h, i) => {
      html += '<div class="hold-row"><div class="hold-rank">' + (i + 1) + '</div><div class="hold-name"><div class="n">' + h.name + '</div>' + (h.ticker ? '<div class="t">' + h.ticker + '</div>' : '') + '</div><div class="hold-pct">' + h.weight.toFixed(2) + '%</div></div>';
    });
    document.getElementById("holdingsList").innerHTML = html;
  } catch (e) {
    document.getElementById("holdingsList").innerHTML = '<div class="err">' + e.message + '</div>';
  }
}


/* ═══════════════════════════════════════════════════════
   재무 (Stock)
   ═══════════════════════════════════════════════════════ */

async function loadFinancials() {
  try {
    const data = await jsonp("FinCache", "SELECT * WHERE A='" + TICKER + "'");
    let years = [], revenue = [], opincome = [], netincome = [], eps = [], assets = [], debt = [], equity = [];

    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i];
      years.push(String(r[1] || "")); revenue.push(Number(r[2]) || 0); opincome.push(Number(r[3]) || 0);
      netincome.push(Number(r[4]) || 0); eps.push(Number(r[5]) || 0);
      assets.push(Number(r[6]) || 0); debt.push(Number(r[7]) || 0); equity.push(Number(r[8]) || 0);
    }

    // 연도순 정렬
    const idx = years.map((_, i) => i).sort((a, b) => years[a] > years[b] ? 1 : -1);
    years = idx.map(i => years[i]); revenue = idx.map(i => revenue[i]);
    opincome = idx.map(i => opincome[i]); netincome = idx.map(i => netincome[i]);
    eps = idx.map(i => eps[i]); assets = idx.map(i => assets[i]);
    debt = idx.map(i => debt[i]); equity = idx.map(i => equity[i]);

    // EPS 보정: EPS 컬럼에 Net Income 값이 들어온 경우 감지
    const maxEps = Math.max.apply(null, eps.filter(v => v !== 0).map(Math.abs));
    const epsLooksLikeNetIncome = maxEps > 1000;

    if (epsLooksLikeNetIncome) {
      console.warn("[FIN] EPS 이상 감지: max=" + maxEps + " → Net Income으로 추정");
      let sharesEst = 0;
      if (_mktCap > 0 && _curPrice > 0) {
        sharesEst = _mktCap / _curPrice;
      }
      if (sharesEst > 0) {
        eps = eps.map(v => v !== 0 ? v / sharesEst : 0);
      } else {
        eps = eps.map(() => 0);
      }
    }

    if (!years.length) { document.getElementById("finTableWrap").innerHTML = '<div class="err">재무 데이터 없음</div>'; return; }

    // Revenue chart
    if (charts.rev) charts.rev.destroy();
    charts.rev = new Chart(document.getElementById("chRevenue"), {
      type: "bar",
      data: {
        labels: years, datasets: [
          { label: "매출", data: revenue, backgroundColor: "#4d9aff80", borderRadius: 4, maxBarThickness: 28 },
          { label: "영업이익", data: opincome, backgroundColor: "#2ee0a880", borderRadius: 4, maxBarThickness: 28 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { x: { ticks: { color: "#5e82a8", font: { size: 9 } }, grid: { display: false } }, y: { ticks: { color: "#5e82a8", font: { size: 8 }, callback: fB }, grid: { color: "#1f3a6215" } } },
        plugins: { legend: { labels: { color: "#9db5d4", font: { size: 10 }, usePointStyle: true } } }
      }
    });

    // Earnings chart
    const epsHasData = eps.some(v => v !== 0);
    if (charts.earn) charts.earn.destroy();
    charts.earn = new Chart(document.getElementById("chEarnings"), {
      type: "bar",
      data: {
        labels: years, datasets: [
          { label: "순이익", data: netincome, backgroundColor: "#ae82ff80", borderRadius: 4, maxBarThickness: 28, yAxisID: "yL" },
          epsHasData ? { label: "EPS", data: eps, type: "line", borderColor: "#ffc05c", pointBackgroundColor: "#ffc05c", pointRadius: 3, borderWidth: 1.5, yAxisID: "yR" } : null
        ].filter(Boolean)
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: "#5e82a8", font: { size: 9 } }, grid: { display: false } },
          yL: { position: "left", ticks: { color: "#5e82a8", font: { size: 8 }, callback: fB }, grid: { color: "#1f3a6215" } },
          yR: epsHasData ? { position: "right", ticks: { color: "#ffc05c", font: { size: 8 }, callback: v => "$" + v.toFixed(1) }, grid: { display: false } } : { display: false }
        },
        plugins: { legend: { labels: { color: "#9db5d4", font: { size: 10 }, usePointStyle: true } } }
      }
    });

    // Table
    const items = [{ l: "매출", d: revenue, f: fB }, { l: "영업이익", d: opincome, f: fB }, { l: "순이익", d: netincome, f: fB }];
    if (epsHasData) {
      items.push({ l: "EPS", d: eps, f: v => "$" + v.toFixed(2) });
    } else {
      items.push({ l: "EPS", d: eps, f: v => v === 0 ? "데이터 보정 필요" : "$" + v.toFixed(2) });
    }
    if (assets[0]) items.push({ l: "총자산", d: assets, f: fB }, { l: "총부채", d: debt, f: fB }, { l: "자기자본", d: equity, f: fB });

    let h = '<table class="fin-tbl"><thead><tr><th>항목</th>' + years.map(y => "<th>" + y + "</th>").join("") + "</tr></thead><tbody>";
    items.forEach(r => {
      h += "<tr><td>" + r.l + "</td>" + r.d.map(v => '<td style="color:' + (v < 0 ? "var(--red)" : "var(--txt2)") + '">' + (v ? r.f(v) : "-") + "</td>").join("") + "</tr>";
    });
    if (epsLooksLikeNetIncome && epsHasData) {
      h += '<tr><td colspan="' + (years.length + 1) + '" style="color:var(--amber);font-size:10px;text-align:center;padding:8px">EPS는 시가총액 기반으로 자동 보정된 값입니다</td></tr>';
    }
    document.getElementById("finTableWrap").innerHTML = h + "</tbody></table>";
  } catch (e) {
    document.getElementById("finTableWrap").innerHTML = '<div class="err">' + e.message + "</div>";
  }
}


/* ═══════════════════════════════════════════════════════
   뉴스 (Google RSS)
   ═══════════════════════════════════════════════════════ */

async function loadNews() {
  try {
    const xml = await (await fetch(PROXY + encodeURIComponent("https://news.google.com/rss/search?q=" + encodeURIComponent(TICKER + " stock") + "&hl=en&gl=US&ceid=US:en"))).text();
    const items = new DOMParser().parseFromString(xml, "text/xml").querySelectorAll("item");
    if (!items.length) { document.getElementById("newsList").innerHTML = '<div class="err">뉴스 없음</div>'; return; }

    let h = "";
    for (let i = 0; i < Math.min(items.length, 10); i++) {
      const it = items[i];
      h += '<div class="news-item"><a href="' + (it.querySelector("link")?.textContent || "#") + '" target="_blank">' + (it.querySelector("title")?.textContent || "") + '</a><div class="meta">' + (it.querySelector("source")?.textContent || "") + " · " + tA(it.querySelector("pubDate")?.textContent) + "</div></div>";
    }
    document.getElementById("newsList").innerHTML = h;
  } catch (e) {
    document.getElementById("newsList").innerHTML = '<div class="err">뉴스 로딩 실패</div>';
  }
}


/* ═══════════════════════════════════════════════════════
   EPS 상단 보정 + 초기화
   ═══════════════════════════════════════════════════════ */

function correctTopEPS() {
  if (!_rawEPS || Math.abs(_rawEPS) <= 1000) return;
  let corrected = _rawEPS;
  if (_mktCap > 0 && _curPrice > 0) {
    const shares = _mktCap / _curPrice;
    corrected = _rawEPS / shares;
  } else if (_rawPER > 0 && _curPrice > 0) {
    corrected = _curPrice / _rawPER;
  }
  if (Math.abs(corrected) <= 1000 && corrected !== _rawEPS) {
    _curEPS = corrected;
    sM("mEPS", corrected, v => "$" + v.toFixed(2));
    console.log("[FIX] 상단 EPS 보정 완료: " + _rawEPS + " → " + corrected.toFixed(2));
  }
}

// ── 시작 ──
console.log("=== STOCK DETAIL (Cache) ===", TICKER, STYPE);
Promise.all([loadMetrics(), loadPrices()]).then(() => correctTopEPS());
