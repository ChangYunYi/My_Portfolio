/* ═══════════════════════════════════════════════════════
   app.js — 메인 대시보드 애플리케이션
   JSONP 데이터 로딩 · 파싱 · 탭 시스템 · 렌더러

   의존: config.js, utils.js, treemap.js, risk-sentinel.js
   ═══════════════════════════════════════════════════════ */

// ── 전역 상태 ──
let TICKER_MAP = { index: [], dividend: [], growth: [] };
let RAW = {}, P = {}, activeTab = "overview", charts = {};

// ── 모바일 감지 ──
const _isMobile = window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);


/* ═══════════════════════════════════════════════════════
   JSONP — Google Sheets 데이터 로딩
   ═══════════════════════════════════════════════════════ */

function jsonp(sheet) {
  return new Promise((res, rej) => {
    const cb = `_c${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
    const t = setTimeout(() => { cl(); rej("timeout"); }, 15000);
    const cl = () => { clearTimeout(t); delete window[cb]; document.getElementById(cb)?.remove(); };
    window[cb] = r => { cl(); r?.status === "ok" && r?.table ? res(r.table) : rej(r?.status); };
    const s = document.createElement("script");
    s.id = cb;
    s.src = `https://docs.google.com/spreadsheets/d/${SID}/gviz/tq?tqx=out:json;responseHandler:${cb}&sheet=${encodeURIComponent(sheet)}`;
    s.onerror = () => { cl(); rej("err"); };
    document.head.appendChild(s);
  });
}

async function loadAllSheets() {
  const badge = document.getElementById("statusBadge");
  const info = document.getElementById("loadInfo");
  badge.className = "bdg bdg-ld";
  badge.textContent = "LOADING";

  let ok = 0;
  for (const n of SHEETS) {
    try { RAW[n] = await jsonp(n); ok++; } catch (e) { console.warn(n, e); }
    info.textContent = `${ok}/${SHEETS.length}`;
  }

  if (ok >= 3) {
    badge.className = "bdg bdg-ok";
    badge.textContent = `LIVE · ${ok}/${SHEETS.length}`;
    parseAll();
  } else {
    badge.className = "bdg bdg-er";
    badge.textContent = "FAIL";
  }
}


/* ═══════════════════════════════════════════════════════
   데이터 파싱
   ═══════════════════════════════════════════════════════ */

function parseAll() {
  const tb = RAW["TotalBoard"], ds = RAW["데이터시트"], kr_raw = RAW["국내 포트폴리오"];

  // 환율
  P.rate = 1440;
  if (ds) { const r = Vn(ds, 0, 4); if (r > 1000 && r < 2000) P.rate = r; }
  if (kr_raw) {
    for (let i = kr_raw.rows.length - 1; i >= 0; i--) {
      if (Vs(kr_raw, i, 3) === "환율") { const r = Vn(kr_raw, i, 4); if (r > 1000) P.rate = r; break; }
    }
  }

  // TotalBoard 요약
  P.tb = {};
  if (tb) {
    for (let i = 0; i < Math.min(tb.rows.length, 5); i++) {
      const nm = Vs(tb, i, 0);
      if (["지수형", "배당", "성장", "Total"].includes(nm))
        P.tb[nm] = { inv: Vn(tb, i, 1), val: Vn(tb, i, 2), plp: Vn(tb, i, 3) * 100 };
    }
    P.tb["국내"] = { inv: Vn(tb, 0, 7), val: Vn(tb, 0, 8), plp: Vn(tb, 0, 9) * 100 };
  }

  // 포트폴리오 파싱
  const stdCols = { name: 1, ticker: 2, qty: 3, avg: 4, cur: 5, daily: 6, inv: 7, val: 8, pl: 9, plp: 10, divY: 11, bb20: 12, bb252: 13, rsi: 14, mdd: 15, target: 16 };
  P.index = parsePort("지수형 포트폴리오", stdCols);
  P.dividend = parsePort("배당 포트폴리오", stdCols);
  P.growth = parsePort("성장 포트폴리오", stdCols);
  P.kr = parsePort("국내 포트폴리오", { name: 1, ticker: 3, qty: 4, avg: 5, cur: 6, daily: 7, inv: 8, val: 9, pl: 10, plp: 11, divY: 12, bb20: 13, bb252: 14, rsi: 15, mdd: 16, target: 17 });

  // 현금
  P.cash = { rp: 0, usd: 0, krw: 0 };
  const dv = RAW["배당 포트폴리오"];
  if (dv) {
    for (let i = 0; i < dv.rows.length; i++) {
      const n = Vs(dv, i, 1);
      if (n === "삼성RP") P.cash.rp = parseFloat(Vf(dv, i, 2).replace(/[$,]/g, "")) || 0;
      if (n === "예수금") { P.cash.usd = parseFloat(Vf(dv, i, 2).replace(/[$,]/g, "")) || 0; P.cash.krw = Vn(dv, i, 3); }
    }
  }

  // 데이터시트2 파싱: 티커별 가격 히스토리
  P.tickerHistory = {};
  const ds2 = RAW["데이터시트2"];
  if (ds2) {
    const cols = ds2.cols || [];
    const rows = ds2.rows || [];

    // 컬럼 스캔: (Date컬럼, Close컬럼) 쌍 자동 감지
    const pairs = [];
    for (let ci = 0; ci < cols.length - 1; ci += 2) {
      const label = (cols[ci].label || "").trim();
      const type = cols[ci].type;
      if (type === "datetime" || type === "date" || label.includes("Date")) {
        const ticker = label.replace(/\s*Date\s*/i, "").trim().toUpperCase();
        if (ticker) pairs.push({ ticker, dateCol: ci, priceCol: ci + 1 });
      }
    }

    // 각 티커별 시계열 추출
    pairs.forEach(pair => {
      const history = [];
      for (let ri = 0; ri < rows.length; ri++) {
        const dateStr = Vf(ds2, ri, pair.dateCol);
        const price = Vn(ds2, ri, pair.priceCol);
        if (!dateStr || price === 0) continue;
        let short = dateStr.replace(/\s*오[전후]\s*\d+:\d+:\d+/g, "").trim();
        if (short.length > 12) short = short.slice(0, 12);
        history.push({ d: short, p: price });
      }
      if (history.length > 1) P.tickerHistory[pair.ticker] = history;
    });

    // 포트폴리오 티커와 데이터시트2 티커를 자동 매칭
    const ds2Tickers = new Set(Object.keys(P.tickerHistory));
    TICKER_MAP.index = P.index.map(h => h.ticker.toUpperCase()).filter(t => ds2Tickers.has(t));
    TICKER_MAP.dividend = P.dividend.map(h => h.ticker.toUpperCase()).filter(t => ds2Tickers.has(t));
    TICKER_MAP.growth = P.growth.map(h => h.ticker.toUpperCase()).filter(t => ds2Tickers.has(t));

    console.log("데이터시트2 종목:", [...ds2Tickers].join(", "));
    console.log("TICKER_MAP 자동 구성:", JSON.stringify(TICKER_MAP));
  }

  // 포트폴리오별 합계
  const sum = (a, k) => a.reduce((s, h) => s + (h[k] || 0), 0);
  P.idxT = { inv: sum(P.index, "inv"), val: sum(P.index, "val") };
  P.divT = { inv: sum(P.dividend, "inv"), val: sum(P.dividend, "val") };
  P.groT = { inv: sum(P.growth, "inv"), val: sum(P.growth, "val") };
  P.krT = { inv: sum(P.kr, "inv"), val: sum(P.kr, "val") };
  P.usdAll = P.idxT.val + P.divT.val + P.groT.val;
  P.cashAll = P.cash.rp + P.cash.usd;
  P.grand = P.usdAll + P.krT.val / P.rate + P.cashAll;

  // UI 업데이트
  document.getElementById("rateDisp").textContent = `₩${P.rate.toLocaleString()}/USD`;
  document.getElementById("grandTotal").textContent = fU(Math.round(P.grand));
  renderTabs();
  switchTab(activeTab);
  setTimeout(startRSSentinel, 200);
}

function parsePort(sheetName, cols) {
  const t = RAW[sheetName];
  if (!t) return [];
  const items = [];
  for (let i = 0; i < t.rows.length; i++) {
    const name = Vs(t, i, cols.name);
    if (!name || name === "현금" || name.includes("관심") || name.includes("Total")) continue;
    if (!V(t, i, cols.name)) continue;
    const h = {
      name, ticker: Vs(t, i, cols.ticker), qty: Vn(t, i, cols.qty), avg: Vn(t, i, cols.avg), cur: Vn(t, i, cols.cur),
      daily: p100(Vn(t, i, cols.daily)), inv: Vn(t, i, cols.inv), val: Vn(t, i, cols.val), pl: Vn(t, i, cols.pl),
      plp: p100(Vn(t, i, cols.plp)), divY: p100(Vn(t, i, cols.divY)),
      rsi: cols.rsi != null ? Vn(t, i, cols.rsi) : 0, mdd: p100(Vn(t, i, cols.mdd)),
      target: cols.target != null ? Vf(t, i, cols.target) : "",
      bb20: cols.bb20 != null ? Vn(t, i, cols.bb20) : 0, bb252: cols.bb252 != null ? Vn(t, i, cols.bb252) : 0,
    };
    if (h.val === 0 && h.inv === 0 && h.qty === 0) continue;
    items.push(h);
  }
  return items;
}


/* ═══════════════════════════════════════════════════════
   탭 시스템
   ═══════════════════════════════════════════════════════ */

function renderTabs() {
  document.getElementById("tabBar").innerHTML = TABS.map(t =>
    `<button class="${t.id === activeTab ? 'active' : ''}" onclick="switchTab('${t.id}')">${t.icon} ${t.label}</button>`
  ).join("");
}

function switchTab(id) {
  activeTab = id;
  renderTabs();
  Object.values(charts).forEach(c => c.destroy());
  charts = {};
  const el = document.getElementById("content");
  const renderers = {
    overview: renderOverview, index: renderIndex, dividend: renderDividend,
    growth: renderGrowth, kr: renderKR,
    "us-risk": renderUSRisk, "kr-risk": renderKRRisk
  };
  renderers[id]?.(el);
}


/* ═══════════════════════════════════════════════════════
   종목 상세 팝업 / 모달
   ═══════════════════════════════════════════════════════ */

function openStock(ticker, market, name, stype) {
  const url = "stock.html?ticker=" + encodeURIComponent(ticker) + "&market=" + market + "&name=" + encodeURIComponent(name) + "&type=" + (stype || "stock");
  if (_isMobile) {
    let overlay = document.getElementById("stockModal");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "stockModal";
      overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:var(--bg);display:flex;flex-direction:column";
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;padding:8px 12px;background:var(--s1);border-bottom:1px solid var(--bdr);flex-shrink:0";
      bar.innerHTML = '<button onclick="closeStockModal(true)" style="background:none;border:1px solid var(--bdr);color:var(--txt);padding:6px 14px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">← 돌아가기</button><span style="margin-left:12px;font-size:14px;font-weight:800;color:var(--txt)">' + name + '</span>';
      const frame = document.createElement("iframe");
      frame.id = "stockFrame";
      frame.style.cssText = "flex:1;border:none;width:100%";
      overlay.appendChild(bar);
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
    }
    overlay.style.display = "flex";
    overlay.querySelector("span").textContent = name;
    document.getElementById("stockFrame").src = url;
    document.body.style.overflow = "hidden";
    history.pushState({ modal: true }, "");
  } else {
    const w = 820, h = 700, left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    window.open(url, "stockDetail", "width=" + w + ",height=" + h + ",left=" + left + ",top=" + top + ",scrollbars=yes,resizable=yes");
  }
}

function closeStockModal(fromBtn) {
  const m = document.getElementById("stockModal");
  if (m && m.style.display === "flex") {
    m.style.display = "none";
    document.getElementById("stockFrame").src = "";
    document.body.style.overflow = "";
    if (fromBtn) history.back();
  }
}

// 뒤로가기 버튼 지원
window.addEventListener("popstate", () => closeStockModal(false));

// 테이블 행 클릭 → 종목 상세
document.addEventListener("click", e => {
  const tr = e.target.closest("tr[data-ticker]");
  if (tr) {
    if (tr.dataset.market === "kr") return;
    openStock(tr.dataset.ticker, tr.dataset.market, tr.dataset.name, tr.dataset.type);
  }
});


/* ═══════════════════════════════════════════════════════
   트리맵 렌더링
   ═══════════════════════════════════════════════════════ */

function renderTreemap(cid, data, fmt) {
  const box = document.getElementById(cid);
  if (!box) return;
  const W = box.offsetWidth, H = box.offsetHeight;
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) { box.innerHTML = ''; return; }

  const rects = squarify(data, 0, 0, W, H);
  box.innerHTML = "";

  rects.forEach(r => {
    const div = document.createElement("div");
    div.className = "tm-cell";
    div.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${r.color}`;
    const pct = r.value / total * 100, mn = Math.min(r.w, r.h);
    const ns = Math.max(9, Math.min(17, mn * 0.2));
    const vs = Math.max(8, Math.min(14, mn * 0.14));
    const ps = Math.max(7, Math.min(11, mn * 0.1));
    const ds = Math.max(7, Math.min(11, mn * 0.11));
    const dailyStr = r.daily != null ? `${r.daily >= 0 ? "+" : ""}${r.daily.toFixed(2)}%` : "";
    const plpStr = r.plp != null ? `${r.plp >= 0 ? "+" : ""}${r.plp.toFixed(1)}%` : "";
    let h = "";
    if (r.w > 30 && r.h > 18) h += `<div class="tm-name" style="font-size:${ns}px">${r.ticker || r.label}</div>`;
    if (r.w > 45 && r.h > 32) h += `<div class="tm-val" style="font-size:${vs}px">${fmt(r.value)}</div>`;
    if (r.w > 55 && r.h > 44 && plpStr) h += `<div class="tm-pct" style="font-size:${ps}px">${plpStr}</div>`;
    if (r.w > 55 && r.h > 56 && dailyStr) h += `<div class="tm-pct" style="font-size:${ds}px;margin-top:1px">${dailyStr}</div>`;
    div.innerHTML = h;
    div.title = `${r.label} (${r.cat})\n${fmt(r.value)} · 수익률 ${plpStr}\n일변동: ${dailyStr}`;
    box.appendChild(div);
  });
}


/* ═══════════════════════════════════════════════════════
   공용 UI 컴포넌트
   ═══════════════════════════════════════════════════════ */

/** 종목 테이블 HTML 생성 */
function mkTable(items, isKR) {
  const heads = ["종목", "현재가", "일변동", "수익률", "평가금", "배당률", "BB(20)", "BB(252)", "RSI", "MDD"];
  return `<div class="tbl-wrap"><table>
    <thead><tr>${heads.map((h, i) => `<th${i === 0 ? ' style="text-align:left"' : ''}>${h}</th>`).join("")}</tr></thead>
    <tbody>${items.map(h => {
      const cur = isKR ? h.cur.toLocaleString() : fUd(h.cur);
      const val = isKR ? fK(h.val) : fU(Math.round(h.val));
      const plS = isKR ? (h.pl >= 0 ? "+" : "") + fK(h.pl) : (h.pl >= 0 ? "+" : "") + fU(Math.round(h.pl));
      const mc = Math.abs(h.mdd) >= 10 ? "var(--red)" : Math.abs(h.mdd) >= 5 ? "var(--amber)" : "var(--green)";
      const sigC = v => v >= 70 ? "var(--green)" : v <= 30 ? "var(--red)" : "var(--txt)";
      const st = isETF(h.ticker) ? "etf" : "stock";
      return `<tr style="cursor:${isKR ? "default" : "pointer"}" data-ticker="${h.ticker}" data-market="${isKR ? "kr" : "us"}" data-name="${h.name}" data-type="${st}">
        <td style="text-align:left"><div style="font-weight:800;font-size:13px;color:var(--txt)">${h.name}</div><div style="font-size:10px;color:var(--sub)">${h.ticker} · ${isKR ? h.qty : h.qty % 1 ? h.qty.toFixed(2) : h.qty}주</div></td>
        <td class="mono"><div>${cur}</div><div style="font-size:10px;color:var(--mute)">${isKR ? h.avg.toLocaleString() : fUd(h.avg)}</div></td>
        <td><span class="${bc(h.daily)}">${fP(h.daily)}</span></td>
        <td style="color:${pc(h.plp)};font-weight:800;font-size:13px">${fP(h.plp)}</td>
        <td><div style="font-weight:700;font-size:12px;color:var(--txt2)">${val}</div><div style="font-size:10px;color:${pc(h.pl)}">${plS}</div></td>
        <td><span style="color:${h.divY >= 3 ? "var(--green)" : h.divY >= 1 ? "var(--amber)" : "var(--sub)"};font-weight:700;font-size:12px">${h.divY.toFixed(2)}%</span></td>
        <td style="text-align:center"><span style="color:${sigC(h.bb20)};font-weight:700;font-size:12px">${h.bb20 || "-"}</span></td>
        <td style="text-align:center"><span style="color:${sigC(h.bb252)};font-weight:700;font-size:12px">${h.bb252 || "-"}</span></td>
        <td style="text-align:center"><span style="color:${sigC(h.rsi)};font-weight:800;font-size:13px">${h.rsi > 0 ? h.rsi.toFixed(0) : "-"}</span></td>
        <td><span style="color:${mc};font-weight:700;font-size:12px">${h.mdd.toFixed(1)}%</span></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

/** 투자금 대비 목표 진행률 바 */
function mkProgress(inv, target, color) {
  const pct = target > 0 ? Math.min((inv / target) * 100, 150) : 0;
  return `<div style="display:flex;justify-content:space-between;font-size:12px;margin-top:8px">
      <span style="color:var(--txt2)">${fU(Math.round(inv))}</span>
      <span style="font-weight:800;color:${pct >= 100 ? "var(--green)" : "var(--txt2)"}">${pct.toFixed(0)}%</span></div>
    <div class="pbar"><div class="pbar-fill" style="width:${Math.min(pct, 100)}%;background:${pct >= 100 ? "var(--green)" : color}"></div></div>
    <div style="font-size:9px;color:var(--mute);margin-top:2px;text-align:right">목표 ${fU(target)}</div>`;
}

/** 수익률 추이 라인차트 (데이터시트2 기반) */
function mkPriceTrendChart(canvasId, tickerList) {
  const available = tickerList.filter(t => P.tickerHistory[t]?.length > 1);
  if (available.length === 0) return;

  const refTicker = available[0];
  const labels = P.tickerHistory[refTicker].map(d => d.d);

  const datasets = available.map((ticker, i) => {
    const hist = P.tickerHistory[ticker];
    const first = hist[0].p;
    return {
      label: ticker,
      data: hist.map(h => ((h.p / first) - 1) * 100),
      borderColor: LINE_COLORS[i % LINE_COLORS.length],
      backgroundColor: LINE_COLORS[i % LINE_COLORS.length] + "20",
      fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
    };
  });

  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#5e82a8", font: { size: 9 }, maxTicksLimit: 8 }, grid: { color: "#1f3a6220" } },
        y: { ticks: { color: "#5e82a8", font: { size: 10 }, callback: v => v.toFixed(0) + "%" }, grid: { color: "#1f3a6220" } }
      },
      plugins: {
        legend: { labels: { color: "#9db5d4", font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ctx.dataset.label + ": " + ctx.raw?.toFixed(2) + "%" } }
      }
    }
  });
}

/** RS 종목 카드 HTML 생성 */
function mkRSCard(h, isKR, accentColor) {
  const sid = rsSafeId(h.ticker);
  const dispTicker = h.ticker.startsWith("KRX:") ? h.ticker.replace("KRX:", "") : h.ticker;
  return `<div class="rs-mon-card" id="rscard_${sid}" onclick="rsShowDetail('${h.ticker}',${isKR})">
    <div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,${accentColor},transparent)"></div>
    <div id="rscnt_${sid}" class="rs-cnt-badge rs-cnt-wait">—</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;padding-right:22px">
      <div style="min-width:0;flex:1">
        <div style="font-size:12px;font-weight:800;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${h.name}">${h.name.length > 10 ? h.name.slice(0, 10) + '…' : h.name}</div>
        <div style="font-size:9px;color:var(--sub);margin-top:1px">${dispTicker}</div>
      </div>
      <div id="rscardprice_${sid}" style="text-align:right;flex-shrink:0">
        <div style="font-size:10px;color:var(--mute);font-family:monospace">—</div>
      </div>
    </div>
    <div id="rscardpark_${sid}" style="margin:5px 0 3px"><div class="rs-spark-ph"></div></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
      <div id="rscardbadge_${sid}" style="flex:1;min-height:14px">
        <span style="font-size:8px;color:var(--mute)">대기중...</span>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:8px;color:var(--mute)">배당 <span style="color:var(--green);font-weight:700">${h.divY > 0 ? h.divY.toFixed(1) + "%" : "—"}</span></div>
      </div>
    </div>
  </div>`;
}

/** 리스크 차트 공통 렌더러 */
function _renderRiskChart(canvasId, stocks, isKR) {
  const riskData = stocks.filter(h => h.rsi > 0 || h.bb20 || h.bb252 || h.mdd !== 0).sort((a, b) => b.val - a.val);
  if (!riskData.length) return;
  const labels = riskData.map(h => isKR ? h.name.slice(0, 6) : h.ticker || h.name.slice(0, 6));
  const cid = canvasId.replace("chUS", "usRisk").replace("chKR", "krRisk");
  charts[cid] = new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: {
      labels, datasets: [
        { label: "RSI", data: riskData.map(h => h.rsi || null), backgroundColor: "#4d9affbb", borderRadius: 4, maxBarThickness: 20, yAxisID: "yL", order: 2 },
        { label: "BB(20)", data: riskData.map(h => h.bb20 || null), backgroundColor: "#2ee0a8bb", borderRadius: 4, maxBarThickness: 20, yAxisID: "yL", order: 2 },
        { label: "BB(252)", data: riskData.map(h => h.bb252 || null), backgroundColor: "#ae82ffbb", borderRadius: 4, maxBarThickness: 20, yAxisID: "yL", order: 2 },
        {
          label: "MDD%", data: riskData.map(h => h.mdd || null), type: "line", borderColor: "#ff6b78", backgroundColor: "#ff6b7820",
          pointBackgroundColor: riskData.map(h => Math.abs(h.mdd) >= 10 ? "#ff6b78" : Math.abs(h.mdd) >= 5 ? "#ffc05c" : "#2ee0a8"),
          pointRadius: 5, pointHoverRadius: 7, borderWidth: 2, tension: 0.3, fill: true, yAxisID: "yR", order: 1
        }
      ]
    },
    options: {
      responsive: true, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#f2f6ff", font: { size: 11, weight: "bold" }, usePointStyle: true, padding: 14 } },
        tooltip: { callbacks: { label: ctx => { const v = ctx.raw; if (v == null) return null; return `${ctx.dataset.label}: ${ctx.dataset.label === "MDD%" ? v.toFixed(2) + "%" : v.toFixed(0)}`; } } }
      },
      scales: {
        x: { ticks: { color: "#9db5d4", font: { size: 10, weight: "bold" }, maxRotation: 45 }, grid: { display: false } },
        yL: { position: "left", min: 0, max: 120, title: { display: true, text: "RSI/BB", color: "#5e82a8", font: { size: 10 } }, ticks: { color: "#5e82a8", font: { size: 10 }, stepSize: 20 }, grid: { color: "#1f3a6218" }, afterDataLimits: s => { s.max = 120; } },
        yR: { position: "right", title: { display: true, text: "MDD%", color: "#ff6b78", font: { size: 10 } }, ticks: { color: "#ff6b78", font: { size: 10 }, callback: v => v.toFixed(0) + "%" }, grid: { display: false } }
      }
    }
  });
}

/** 국내 종목 섹터 조회 */
function krSectorOf(ticker) {
  const t = (ticker || "").replace(/\.(KS|KQ)$/i, "").toUpperCase();
  return KR_SECTORS.find(s => s.tickers.some(st => st.toUpperCase() === t)) || null;
}


/* ═══════════════════════════════════════════════════════
   일변동 기반 트리맵 색상
   ═══════════════════════════════════════════════════════ */

function dailyColor(daily) {
  const abs = Math.min(Math.abs(daily), 4);
  const t = abs / 4;
  const neutral = [40, 52, 68];
  const green = [16, 185, 90];
  const red = [210, 45, 45];
  const target = daily >= 0 ? green : red;
  const r = Math.round(neutral[0] + (target[0] - neutral[0]) * t);
  const g = Math.round(neutral[1] + (target[1] - neutral[1]) * t);
  const b = Math.round(neutral[2] + (target[2] - neutral[2]) * t);
  return `rgb(${r},${g},${b})`;
}


/* ═══════════════════════════════════════════════════════
   렌더러 — 전체 개요
   ═══════════════════════════════════════════════════════ */

function renderOverview(el) {
  const usdInv = P.idxT.inv + P.divT.inv + P.groT.inv;
  const usdPl = P.usdAll - usdInv, usdPlp = usdInv > 0 ? (usdPl / usdInv * 100) : 0;
  const krPl = P.krT.val - P.krT.inv, krPlp = P.krT.inv > 0 ? (krPl / P.krT.inv * 100) : 0;
  const all = [...P.index, ...P.dividend, ...P.growth];
  const divI = all.reduce((s, h) => s + h.val * (h.divY / 100), 0);
  const krDivI = P.kr.reduce((s, h) => s + h.val * (h.divY / 100), 0) / P.rate;
  const totalDiv = divI + krDivI;

  const usdTotal = P.usdAll;
  const krwInUsd = P.krT.val / P.rate;
  const totalAll = usdTotal + krwInUsd;
  const usdRatio = totalAll > 0 ? Math.max((usdTotal / totalAll * 2), 0.5).toFixed(2) : "1.5";
  const krwRatio = totalAll > 0 ? Math.max((krwInUsd / totalAll * 2), 0.5).toFixed(2) : "0.5";

  el.innerHTML = `<div class="section">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px" id="topGrid">
      <div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:12px">
        <div class="card"><div class="topline" style="background:linear-gradient(90deg,var(--blue),transparent)"></div>
          <div class="lbl">달러($) 자산</div><div class="big">${fU(Math.round(P.usdAll))}</div>
          <div class="mid" style="color:${pc(usdPl)};margin-top:4px">${fP(usdPlp)} · ${usdPl >= 0 ? "+" : ""}${fU(Math.round(usdPl))}</div></div>
        <div class="card"><div class="topline" style="background:linear-gradient(90deg,var(--amber),transparent)"></div>
          <div class="lbl">원화(₩) 자산</div><div class="big">${fK(P.krT.val)}</div>
          <div class="mid" style="color:${pc(krPl)};margin-top:4px">${fP(krPlp)}</div></div>
        <div class="card"><div class="topline" style="background:linear-gradient(90deg,var(--cyan),transparent)"></div>
          <div class="lbl">현금 보유</div><div class="big">${fU(P.cashAll)}</div>
          <div style="font-size:12px;color:var(--sub);margin-top:4px">RP ${fU(P.cash.rp)} · 예수금 ${fU(P.cash.usd)}</div></div>
        <div class="card"><div class="topline" style="background:linear-gradient(90deg,var(--green),transparent)"></div>
          <div class="lbl">연간 배당</div><div class="big" style="color:var(--green)">${fU(Math.round(totalDiv))}</div>
          <div style="font-size:12px;color:var(--sub);margin-top:4px">월 ${fU(Math.round(totalDiv / 12))}</div></div>
      </div>
      <div class="card" style="display:flex;flex-direction:column"><div class="lbl" style="margin-bottom:8px">포트폴리오별 수익률</div><div style="flex:1;position:relative"><canvas id="chRet"></canvas></div></div>
    </div>
    <div style="display:grid;grid-template-columns:${usdRatio}fr ${krwRatio}fr;gap:12px;margin-bottom:14px" id="tmGrid">
      <div class="card">
        <div class="lbl" style="margin-bottom:8px">달러 자산 구성 <span style="color:var(--mute);font-weight:400">${fU(Math.round(usdTotal))}</span></div>
        <div class="treemap-box" id="tmUSD" style="height:280px"></div>
        <div class="tm-legend" id="tmLegend"></div>
      </div>
      <div class="card">
        <div class="lbl" style="margin-bottom:8px">원화 자산 구성 <span style="color:var(--mute);font-weight:400">${fU(Math.round(P.krT.val / P.rate))}</span></div>
        <div class="treemap-box" id="tmKRW" style="height:280px"></div>
      </div>
    </div>
  </div>`;

  // USD 트리맵
  P._tmUSD = [];
  [{ arr: P.index, cat: "지수형" }, { arr: P.dividend, cat: "배당" }, { arr: P.growth, cat: "성장" }].forEach(g => {
    [...g.arr].sort((a, b) => b.val - a.val).forEach(h =>
      P._tmUSD.push({ label: h.name, ticker: h.ticker, origTicker: h.ticker, value: h.val, cat: g.cat, daily: h.daily, plp: h.plp, color: dailyColor(h.daily) })
    );
  });
  renderTreemap("tmUSD", P._tmUSD, fU);

  // KRW 트리맵
  P._tmKRW = [];
  [...P.kr].sort((a, b) => b.val - a.val).forEach(h =>
    P._tmKRW.push({ label: h.name, ticker: h.name, origTicker: h.ticker, value: h.val, cat: "국내", daily: h.daily, plp: h.plp, color: dailyColor(h.daily) })
  );
  renderTreemap("tmKRW", P._tmKRW, fK);

  // 범례
  document.getElementById("tmLegend").innerHTML = `
    <div class="tm-leg"><div class="tm-dot" style="background:rgb(210,45,45)"></div>하락</div>
    <div class="tm-leg"><div class="tm-dot" style="background:rgb(125,49,57)"></div>소폭↓</div>
    <div class="tm-leg"><div class="tm-dot" style="background:rgb(40,52,68)"></div>보합</div>
    <div class="tm-leg"><div class="tm-dot" style="background:rgb(28,119,79)"></div>소폭↑</div>
    <div class="tm-leg"><div class="tm-dot" style="background:rgb(16,185,90)"></div>상승</div>`;

  // 포트폴리오별 수익률 차트
  const rp = t => t.inv > 0 ? ((t.val - t.inv) / t.inv * 100) : 0;
  const rd = [
    { l: "지수형", v: rp(P.idxT), c: "#4d9aff" }, { l: "배당", v: rp(P.divT), c: "#2ee0a8" },
    { l: "성장", v: rp(P.groT), c: "#ae82ff" }, { l: "국내", v: P.krT.inv > 0 ? ((P.krT.val - P.krT.inv) / P.krT.inv * 100) : 0, c: "#ffc05c" }
  ];
  charts.ret = new Chart(document.getElementById("chRet"), {
    type: "bar",
    data: { labels: rd.map(d => d.l), datasets: [{ data: rd.map(d => d.v), backgroundColor: rd.map(d => d.c + "cc"), borderRadius: 8, maxBarThickness: 50 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fP(ctx.raw) } } },
      scales: {
        x: { ticks: { color: "#9db5d4", font: { size: 11, weight: "bold" } }, grid: { display: false } },
        y: { ticks: { color: "#5e82a8", font: { size: 10 }, callback: v => v.toFixed(0) + "%" }, grid: { color: "#1f3a6220" } }
      }
    }
  });
}


/* ═══════════════════════════════════════════════════════
   렌더러 — 포트폴리오 탭 (지수형/배당/성장/국내)
   ═══════════════════════════════════════════════════════ */

function renderIndex(el) {
  const divI = P.index.reduce((s, h) => s + h.val * (h.divY / 100), 0);
  const plp = P.idxT.inv > 0 ? ((P.idxT.val - P.idxT.inv) / P.idxT.inv * 100) : 0;
  const pct = TARGET_INDEX > 0 ? Math.min((P.idxT.inv / TARGET_INDEX) * 100, 150) : 0;
  el.innerHTML = `<div class="section">
    <div style="display:grid;grid-template-columns:1.8fr 1fr;gap:10px;margin-bottom:14px;height:clamp(220px,25vw,300px)">
      <div class="card" style="overflow:hidden;display:flex;flex-direction:column;padding:12px 14px"><div class="lbl" style="margin-bottom:6px">지수형 종목 수익률 추이 (%)</div><div style="flex:1;min-height:0"><canvas id="chIdxTrend"></canvas></div></div>
      <div class="side-cards" style="display:flex;flex-direction:column;gap:8px;overflow:hidden;min-height:0">
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="topline" style="background:linear-gradient(90deg,var(--blue),transparent)"></div>
          <div class="lbl">평가금액</div><div class="big">${fU(Math.round(P.idxT.val))}</div>
          <div class="mid" style="color:${pc(plp)};margin-top:4px">${fP(plp)}</div></div>
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="lbl">목표 진행률 (투자금)</div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px"><span style="color:var(--txt2)">${fU(Math.round(P.idxT.inv))}</span><span style="font-weight:800;color:${pct >= 100 ? "var(--green)" : "var(--txt2)"}">${pct.toFixed(0)}%</span></div>
          <div class="pbar"><div class="pbar-fill" style="width:${Math.min(pct, 100)}%;background:${pct >= 100 ? "var(--green)" : "var(--blue)"}"></div></div>
          <div style="font-size:9px;color:var(--mute);margin-top:2px;text-align:right">목표 ${fU(TARGET_INDEX)}</div></div>
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="lbl">연간 배당</div><div class="big" style="color:var(--green)">${fU(Math.round(divI))}</div>
          <div style="font-size:10px;color:var(--sub);margin-top:1px">월 ${fU(Math.round(divI / 12))}</div></div>
      </div>
    </div>
    <div class="card">${mkTable(P.index, false)}</div></div>`;
  mkPriceTrendChart("chIdxTrend", TICKER_MAP.index);
}

function renderDividend(el) {
  const divI = P.dividend.reduce((s, h) => s + h.val * (h.divY / 100), 0);
  const plp = P.divT.inv > 0 ? ((P.divT.val - P.divT.inv) / P.divT.inv * 100) : 0;
  const pct = TARGET_DIVIDEND > 0 ? Math.min((P.divT.inv / TARGET_DIVIDEND) * 100, 150) : 0;
  el.innerHTML = `<div class="section">
    <div style="display:grid;grid-template-columns:1.8fr 1fr;gap:10px;margin-bottom:14px;height:clamp(220px,25vw,300px)">
      <div class="card" style="overflow:hidden;display:flex;flex-direction:column;padding:12px 14px"><div class="lbl" style="margin-bottom:6px">배당 종목 수익률 추이 (%)</div><div style="flex:1;min-height:0"><canvas id="chDivTrend"></canvas></div></div>
      <div class="side-cards" style="display:flex;flex-direction:column;gap:8px;overflow:hidden;min-height:0">
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="topline" style="background:linear-gradient(90deg,var(--green),transparent)"></div>
          <div class="lbl">평가금액</div><div class="big">${fU(Math.round(P.divT.val))}</div>
          <div class="mid" style="color:${pc(plp)};margin-top:4px">${fP(plp)}</div></div>
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="lbl">목표 진행률 (투자금)</div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px"><span style="color:var(--txt2)">${fU(Math.round(P.divT.inv))}</span><span style="font-weight:800;color:${pct >= 100 ? "var(--green)" : "var(--txt2)"}">${pct.toFixed(0)}%</span></div>
          <div class="pbar"><div class="pbar-fill" style="width:${Math.min(pct, 100)}%;background:${pct >= 100 ? "var(--green)" : "var(--green)"}"></div></div>
          <div style="font-size:9px;color:var(--mute);margin-top:2px;text-align:right">목표 ${fU(TARGET_DIVIDEND)}</div></div>
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="lbl">연간 배당 수익</div><div class="big" style="color:var(--green)">${fU(Math.round(divI))}</div>
          <div style="font-size:10px;color:var(--sub);margin-top:1px">월 ${fU(Math.round(divI / 12))}</div></div>
      </div>
    </div>
    <div class="card">${mkTable(P.dividend, false)}</div></div>`;
  mkPriceTrendChart("chDivTrend", TICKER_MAP.dividend);
}

function renderGrowth(el) {
  const best = [...P.growth].sort((a, b) => b.plp - a.plp)[0];
  const plp = P.groT.inv > 0 ? ((P.groT.val - P.groT.inv) / P.groT.inv * 100) : 0;
  const pct = TARGET_GROWTH > 0 ? Math.min((P.groT.inv / TARGET_GROWTH) * 100, 150) : 0;
  el.innerHTML = `<div class="section">
    <div style="display:grid;grid-template-columns:1.8fr 1fr;gap:10px;margin-bottom:14px;height:clamp(220px,25vw,300px)">
      <div class="card" style="overflow:hidden;display:flex;flex-direction:column;padding:12px 14px"><div class="lbl" style="margin-bottom:6px">성장 종목 수익률 추이 (%)</div><div style="flex:1;min-height:0"><canvas id="chGroTrend"></canvas></div></div>
      <div class="side-cards" style="display:flex;flex-direction:column;gap:8px;overflow:hidden;min-height:0">
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="topline" style="background:linear-gradient(90deg,var(--purple),transparent)"></div>
          <div class="lbl">평가금액</div><div class="big">${fU(Math.round(P.groT.val))}</div>
          <div class="mid" style="color:${pc(plp)};margin-top:4px">${fP(plp)}</div></div>
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="lbl">목표 진행률 (투자금)</div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px"><span style="color:var(--txt2)">${fU(Math.round(P.groT.inv))}</span><span style="font-weight:800;color:${pct >= 100 ? "var(--green)" : "var(--txt2)"}">${pct.toFixed(0)}%</span></div>
          <div class="pbar"><div class="pbar-fill" style="width:${Math.min(pct, 100)}%;background:${pct >= 100 ? "var(--green)" : "var(--purple)"}"></div></div>
          <div style="font-size:9px;color:var(--mute);margin-top:2px;text-align:right">목표 ${fU(TARGET_GROWTH)}</div></div>
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="lbl">최고 수익</div>${best ? `<div style="font-size:20px;font-weight:900;color:var(--green)">${best.name}</div><div style="font-size:14px;color:var(--green);font-weight:800">${fP(best.plp)}</div>` : ""}</div>
      </div>
    </div>
    <div class="card">${mkTable(P.growth, false)}</div></div>`;
  mkPriceTrendChart("chGroTrend", TICKER_MAP.growth);
}

function renderKR(el) {
  const krDiv = P.kr.reduce((s, h) => s + h.val * (h.divY / 100), 0);
  const plp = P.krT.inv > 0 ? ((P.krT.val - P.krT.inv) / P.krT.inv * 100) : 0;
  el.innerHTML = `<div class="section"><div class="grid-3">
    <div class="card"><div class="topline" style="background:linear-gradient(90deg,var(--amber),transparent)"></div>
      <div class="lbl">원화 평가금액</div><div class="big">${fK(P.krT.val)}</div>
      <div class="mid" style="color:${pc(plp)};margin-top:4px">${fP(plp)}</div></div>
    <div class="card"><div class="lbl">보유 종목</div><div class="big">${P.kr.length}<span style="font-size:14px;color:var(--sub)"> 종목</span></div></div>
    <div class="card"><div class="lbl">연간 배당</div><div class="big" style="color:var(--green)">${fK(krDiv)}</div></div></div>
    <div class="card">${mkTable(P.kr, true)}</div></div>`;
}


/* ═══════════════════════════════════════════════════════
   매크로 리스크 지표 패널 — FRED + Yahoo Finance
   ═══════════════════════════════════════════════════════ */

// ── FRED 시리즈 정의 ──
const FRED_SERIES = {
  // 금리 & 유동성
  DGS10:       { label: "미국채 10Y 금리",         unit: "%",   cat: "rate",   danger: "> 5%",      src: "FRED" },
  DGS2:        { label: "미국채 2Y 금리",          unit: "%",   cat: "rate",   danger: "> 5%",      src: "FRED" },
  T10Y2Y:      { label: "장단기 금리차 (10Y-2Y)",  unit: "%p",  cat: "rate",   danger: "< 0 (역전)", src: "FRED" },
  DFEDTARU:    { label: "연준 기준금리 (상단)",     unit: "%",   cat: "rate",   danger: "급격한 인상", src: "FRED" },
  DFII10:      { label: "10Y 실질금리 (TIPS)",     unit: "%",   cat: "rate",   danger: "> 2.5%",    src: "FRED" },
  WM2NS:       { label: "M2 통화량",              unit: "B$",  cat: "rate",   danger: "전년비 감소", src: "FRED" },
  // 경기 & 펀더멘털
  MPMISM:      { label: "ISM 제조업 PMI",         unit: "",    cat: "econ",   danger: "< 50 (위축)", src: "FRED" },
  UMCSENT:     { label: "미시간 소비자심리지수",    unit: "",    cat: "econ",   danger: "급락",       src: "FRED" },
  UNRATE:      { label: "실업률",                 unit: "%",   cat: "econ",   danger: "급등",       src: "FRED" },
  CPIAUCSL:    { label: "CPI (소비자물가지수)",    unit: "",    cat: "econ",   danger: "전년비 > 4%", src: "FRED" },
  SP500:       { label: "S&P 500",               unit: "",    cat: "econ",   danger: "급락",       src: "FRED" },
  // 신용 & 위험 프리미엄
  BAMLH0A0HYM2:{ label: "하이일드 스프레드 (OAS)", unit: "%",   cat: "credit", danger: "> 5%",      src: "FRED" },
  TEDRATE:     { label: "TED 스프레드",           unit: "%",   cat: "credit", danger: "> 1%",      src: "FRED" },
  DTWEXBGS:    { label: "달러 무역가중지수",       unit: "",    cat: "credit", danger: "급등",       src: "FRED" },
  BAMLC0A4CBBB:{ label: "BBB 회사채 스프레드",    unit: "%",   cat: "credit", danger: "> 3%",      src: "FRED" },
  // 심리 & 시장
  VIXCLS:      { label: "VIX (공포지수)",         unit: "",    cat: "senti",  danger: "> 30",      src: "FRED" },
  DCOILWTICO:  { label: "WTI 원유",              unit: "$",   cat: "senti",  danger: "급등/급락",   src: "FRED" },
  GOLDAMGBD228NLBM: { label: "금 현물 (런던 PM)", unit: "$",   cat: "senti",  danger: "급등 → 위험회피", src: "FRED" },
};

// ── Yahoo Finance 보조 심볼 ──
const YAHOO_SYMBOLS = {
  dxy:  { sym: "DX-Y.NYB", label: "달러 인덱스 (DXY)", unit: "", cat: "credit", danger: "급등 → 신흥국 압박", src: "Yahoo" },
  hyg:  { sym: "HYG",      label: "HY 채권 ETF (HYG)", unit: "$", cat: "credit", danger: "급락 → 신용위험",    src: "Yahoo" },
};

let _macroCache = { data: null, ts: 0 };

// ── FRED API fetch ──
async function _fetchFRED(seriesId) {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=2`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return null;
    const j = await r.json();
    const obs = j?.observations?.filter(o => o.value !== ".");
    if (!obs?.length) return null;
    const cur = { value: parseFloat(obs[0].value), date: obs[0].date };
    const prev = obs.length > 1 ? { value: parseFloat(obs[1].value), date: obs[1].date } : null;
    const chg = prev ? cur.value - prev.value : null;
    return { ...cur, prev: prev?.value, chg };
  } catch { return null; }
}

// ── Yahoo Finance fetch (보조) ──
async function _fetchYahooQuote(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d&includePrePost=false`;
  for (const p of [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    `https://corsproxy.io/?${encodeURIComponent(u)}`
  ]) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(p, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res) continue;
      const m = res.meta;
      const price = m?.regularMarketPrice;
      const prev = m?.chartPreviousClose || m?.previousClose;
      const chg = (price && prev) ? (price - prev) : null;
      return { value: price, prev, chg, date: new Date().toISOString().slice(0,10) };
    } catch {}
  }
  return null;
}

// ── 전체 매크로 데이터 로드 ──
async function fetchMacroIndicators() {
  if (_macroCache.data && Date.now() - _macroCache.ts < 300000) return _macroCache.data;
  const results = {};

  // FRED 병렬 fetch
  const fredKeys = Object.keys(FRED_SERIES);
  const fredFetches = fredKeys.map(async k => { results[k] = await _fetchFRED(k); });

  // Yahoo 병렬 fetch
  const yahooKeys = Object.keys(YAHOO_SYMBOLS);
  const yahooFetches = yahooKeys.map(async k => { results["Y_" + k] = await _fetchYahooQuote(YAHOO_SYMBOLS[k].sym); });

  await Promise.allSettled([...fredFetches, ...yahooFetches]);
  _macroCache = { data: results, ts: Date.now() };
  return results;
}

// ── 값 포맷 헬퍼 ──
function _mFmt(v, unit) {
  if (v == null || isNaN(v)) return "—";
  if (unit === "B$") return "$" + (v / 1000).toFixed(1) + "T";
  if (unit === "$") return "$" + Number(v).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
  if (unit === "%" || unit === "%p") return v.toFixed(2) + unit;
  return Number(v).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
}

function _mChgHTML(chg, unit) {
  if (chg == null || isNaN(chg)) return "";
  const arrow = chg >= 0 ? "▲" : "▼";
  const color = chg >= 0 ? "var(--green)" : "var(--red)";
  const fmt = (unit === "%" || unit === "%p") ? Math.abs(chg).toFixed(2) + unit : Math.abs(chg).toFixed(2);
  return `<span style="font-size:9px;color:${color};margin-left:4px">${arrow}${fmt}</span>`;
}

function _mSignal(value, danger) {
  if (value == null || isNaN(value)) return { level: "none", color: "var(--mute)" };
  const d = danger.toLowerCase();
  if (d.includes(">")) {
    const th = parseFloat(d.replace(/[^0-9.\-]/g, ""));
    if (!isNaN(th) && value > th) return { level: "danger", color: "var(--red)" };
    if (!isNaN(th) && value > th * 0.85) return { level: "warn", color: "var(--amber)" };
    return { level: "ok", color: "var(--green)" };
  }
  if (d.includes("< 0") || d.includes("역전")) {
    if (value < 0) return { level: "danger", color: "var(--red)" };
    if (value < 0.3) return { level: "warn", color: "var(--amber)" };
    return { level: "ok", color: "var(--green)" };
  }
  if (d.includes("< 50")) {
    if (value < 50) return { level: "danger", color: "var(--red)" };
    if (value < 52) return { level: "warn", color: "var(--amber)" };
    return { level: "ok", color: "var(--green)" };
  }
  return { level: "none", color: "var(--mute)" };
}

// ── 카드 한 장 (카테고리별) HTML ──
function _mCardRow(id, info, data) {
  const d = data?.[id];
  const val = d?.value;
  const sig = _mSignal(val, info.danger);
  const dotColor = d ? sig.color : "var(--mute)";
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(31,58,98,0.25)">
    <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
      <span style="width:6px;height:6px;border-radius:50%;background:${dotColor};flex-shrink:0"></span>
      <div style="min-width:0">
        <div style="font-size:11px;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${info.label}</div>
        <div style="font-size:9px;color:var(--mute)">${info.src}${d?.date ? " · " + d.date : ""}</div>
      </div>
    </div>
    <div style="text-align:right;flex-shrink:0;margin-left:8px">
      <div id="mv_${id}" style="font-size:13px;font-weight:700;color:${d ? "var(--txt)" : "var(--mute)"};font-family:'SF Mono',monospace">${d ? _mFmt(val, info.unit) : '<span class="rs-dot-load" style="width:4px;height:4px"></span>'}</div>
      <div style="font-size:9px">${d ? _mChgHTML(d.chg, info.unit) : ""}</div>
    </div>
  </div>`;
}

function _mYahooRow(id, info, data) {
  const d = data?.["Y_" + id];
  return _mCardRow("Y_" + id, info, data ? { ["Y_" + id]: d } : null);
}

function _macroRiskHTML() {
  const cats = [
    { id: "rate",   icon: "💵", title: "금리 & 유동성",       color: "var(--blue)",   dangerNote: "금리 급등·유동성 축소 시 위험" },
    { id: "econ",   icon: "🏭", title: "경기 & 펀더멘털",     color: "var(--green)",  dangerNote: "PMI<50·실업률 급등 시 위험" },
    { id: "credit", icon: "🔗", title: "신용 & 위험 프리미엄",  color: "var(--amber)",  dangerNote: "스프레드 확대·달러 급등 시 위험" },
    { id: "senti",  icon: "🧠", title: "심리 & 시장",         color: "var(--purple)", dangerNote: "VIX>30·원자재 급변 시 위험" },
  ];

  return `
    <div style="margin-top:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding:10px 16px;background:var(--s1);border-radius:11px;border:1px solid var(--bdr)">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:16px">🌐</span>
          <span style="font-size:13px;font-weight:800;color:var(--txt)">매크로 리스크 대시보드</span>
          <span style="font-size:10px;color:var(--mute)">${Object.keys(FRED_SERIES).length + Object.keys(YAHOO_SYMBOLS).length}개 지표</span>
        </div>
        <div id="macroStatus" style="display:flex;align-items:center;gap:6px">
          <span class="rs-dot-load"></span>
          <span style="font-size:9px;color:var(--mute)">데이터 로딩중...</span>
        </div>
      </div>

      <div class="macro-grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
      ${cats.map(cat => {
        const fredItems = Object.entries(FRED_SERIES).filter(([,v]) => v.cat === cat.id);
        const yahooItems = Object.entries(YAHOO_SYMBOLS).filter(([,v]) => v.cat === cat.id);
        return `
        <div class="card" style="padding:14px 16px;border-left:3px solid ${cat.color}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="font-size:15px">${cat.icon}</span>
            <span style="font-size:12px;font-weight:800;color:${cat.color}">${cat.title}</span>
          </div>
          <div style="font-size:9px;color:var(--mute);margin-bottom:10px;padding:4px 8px;background:rgba(255,107,120,0.08);border-radius:6px">⚠ ${cat.dangerNote}</div>
          ${fredItems.map(([k, info]) => `<div id="mrow_${k}">${_mCardRow(k, info, null)}</div>`).join("")}
          ${yahooItems.map(([k, info]) => `<div id="mrow_Y_${k}">${_mYahooRow(k, info, null)}</div>`).join("")}
        </div>`;
      }).join("")}
      </div>

      <div style="margin-top:10px;padding:8px 14px;background:rgba(31,58,98,0.12);border-radius:8px;font-size:9px;color:var(--mute);line-height:1.7;display:flex;gap:20px;flex-wrap:wrap">
        <span>📡 <b>FRED</b> — Federal Reserve Economic Data (api.stlouisfed.org)</span>
        <span>📈 <b>Yahoo Finance</b> — 실시간 시세 (CORS proxy, ~15분 지연)</span>
        <span>🔄 자동 캐시 5분 · 상태 신호등: <span style="color:var(--green)">●</span> 정상 <span style="color:var(--amber)">●</span> 주의 <span style="color:var(--red)">●</span> 위험</span>
      </div>
    </div>`;
}

// ── DOM 업데이트 ──
function _updateMacroDOM(data) {
  // FRED 지표
  for (const [k, info] of Object.entries(FRED_SERIES)) {
    const row = document.getElementById("mrow_" + k);
    if (row) row.innerHTML = _mCardRow(k, info, data);
  }
  // Yahoo 지표
  for (const [k, info] of Object.entries(YAHOO_SYMBOLS)) {
    const row = document.getElementById("mrow_Y_" + k);
    if (row) row.innerHTML = _mYahooRow(k, info, data);
  }
  // 상태바
  document.querySelectorAll("#macroStatus").forEach(el => {
    const now = new Date();
    const ts = `${now.getHours()}:${String(now.getMinutes()).padStart(2,"0")}`;
    el.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block"></span>
      <span style="font-size:9px;color:var(--mute)">${ts} 업데이트 완료</span>`;
  });
}

async function loadMacroData() {
  try {
    const data = await fetchMacroIndicators();
    _updateMacroDOM(data);
  } catch { /* silent */ }
}

/* ═══════════════════════════════════════════════════════
   렌더러 — 미장 Risk / 국장 Risk
   ═══════════════════════════════════════════════════════ */

function renderUSRisk(el) {
  const usStocks = [...P.index, ...P.dividend, ...P.growth].filter(h => h.ticker);
  const sectors = [
    { label: "지수형 INDEX", color: "var(--blue)", icon: "📊", items: P.index },
    { label: "배당형 DIVIDEND", color: "var(--green)", icon: "💰", items: P.dividend },
    { label: "성장주 GROWTH", color: "var(--purple)", icon: "🚀", items: P.growth },
  ];

  el.innerHTML = `<div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding:10px 16px;background:var(--s1);border-radius:11px;border:1px solid var(--bdr)">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:16px">🌎</span>
        <span style="font-size:13px;font-weight:800;color:var(--txt)">미국 시장 실시간 리스크 모니터</span>
        <span style="font-size:10px;color:var(--mute)">${usStocks.length}개 종목</span>
      </div>
      <div id="rsStatusUS" style="display:flex;align-items:center;gap:6px">
        <span class="rs-dot-load"></span>
        <span style="font-size:9px;color:var(--mute)">초기화 중...</span>
      </div>
    </div>
    ${sectors.map(sec => `
    <div style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:7px;border-bottom:1px solid rgba(31,58,98,0.4)">
        <span style="font-size:14px">${sec.icon}</span>
        <span style="font-size:12px;font-weight:800;color:${sec.color};letter-spacing:0.5px">${sec.label}</span>
        <div style="flex:1;height:1px;background:linear-gradient(90deg,${sec.color}30,transparent)"></div>
        <span id="rsSecAlert_${rsSafeId(sec.label)}" style="font-size:10px;color:var(--mute)"></span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px">
        ${sec.items.filter(h => h.ticker).map(h => mkRSCard(h, false, sec.color)).join("")}
      </div>
    </div>`).join("")}
    ${_macroRiskHTML()}
  </div>`;
  setTimeout(() => rsUpdateMonitor("us"), 0);
  setTimeout(() => loadMacroData(), 100);
}

function renderKRRisk(el) {
  const krStocks = P.kr.filter(h => h.ticker);
  const sectorItems = KR_SECTORS.map(sec => ({
    ...sec,
    items: krStocks.filter(h => krSectorOf(h.ticker)?.id === sec.id),
  }));
  const uncategorized = krStocks.filter(h => !krSectorOf(h.ticker));

  el.innerHTML = `<div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding:10px 16px;background:var(--s1);border-radius:11px;border:1px solid var(--bdr)">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:16px">📡</span>
        <span style="font-size:13px;font-weight:800;color:var(--txt)">국내 시장 실시간 리스크 모니터</span>
        <span style="font-size:10px;color:var(--mute)">${krStocks.length}개 종목</span>
      </div>
      <div id="rsStatusKR" style="display:flex;align-items:center;gap:6px">
        <span class="rs-dot-load"></span>
        <span style="font-size:9px;color:var(--mute)">초기화 중...</span>
      </div>
    </div>
    ${sectorItems.filter(sec => sec.items.length > 0).map(sec => `
    <div style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:7px;border-bottom:1px solid rgba(31,58,98,0.4)">
        <span style="font-size:14px">${sec.icon}</span>
        <span style="font-size:12px;font-weight:800;color:${sec.color};letter-spacing:0.5px">${sec.label}</span>
        <div style="flex:1;height:1px;background:linear-gradient(90deg,${sec.color}30,transparent)"></div>
        <span id="rsSecAlert_${rsSafeId(sec.label)}" style="font-size:10px;color:var(--mute)"></span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px">
        ${sec.items.map(h => mkRSCard(h, true, sec.color)).join("")}
      </div>
    </div>`).join("")}
    ${uncategorized.length > 0 ? `
    <div style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:7px;border-bottom:1px solid rgba(31,58,98,0.4)">
        <span style="font-size:14px">🇰🇷</span>
        <span style="font-size:12px;font-weight:800;color:var(--amber);letter-spacing:0.5px">기타</span>
        <div style="flex:1;height:1px;background:linear-gradient(90deg,var(--amber)30,transparent)"></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px">
        ${uncategorized.map(h => mkRSCard(h, true, "var(--amber)")).join("")}
      </div>
    </div>` : ""}
    ${_macroRiskHTML()}
  </div>`;
  setTimeout(() => rsUpdateMonitor("kr"), 0);
  setTimeout(() => loadMacroData(), 100);
}


/* ═══════════════════════════════════════════════════════
   자동 새로고침 + 리사이즈 + 초기화
   ═══════════════════════════════════════════════════════ */

let _countdown = REFRESH_SEC;
let _resizeTimer;

function startAutoRefresh() {
  setInterval(() => {
    _countdown--;
    const m = Math.floor(_countdown / 60), s = _countdown % 60;
    const el = document.getElementById("refreshTimer");
    if (el) el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    if (_countdown <= 0) {
      _countdown = REFRESH_SEC;
      loadAllSheets();
    }
  }, 1000);
}

window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    Object.values(charts).forEach(c => c.resize());
    if (activeTab === "overview") {
      if (P._tmUSD?.length) renderTreemap("tmUSD", P._tmUSD, fU);
      if (P._tmKRW?.length) renderTreemap("tmKRW", P._tmKRW, fK);
    }
  }, 300);
});

window.addEventListener("DOMContentLoaded", () => {
  loadAllSheets();
  startAutoRefresh();
});

// 서비스 워커 등록
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
