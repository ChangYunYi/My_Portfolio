/* ═══════════════════════════════════════════════════════
   app.js — 메인 대시보드 애플리케이션
   데이터: holdings.json(정적) + market.json(GitHub Actions)
         + Finnhub(실시간, risk-sentinel.js)

   의존: config.js, utils.js, treemap.js, risk-sentinel.js
   ═══════════════════════════════════════════════════════ */

// ── 전역 상태 ──
let TICKER_MAP = { index: [], dividend: [], growth: [] };
let P = {}, activeTab = "overview", charts = {};

// ── 모바일 감지 ──
const _isMobile = window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);


/* ═══════════════════════════════════════════════════════
   데이터 로딩 — holdings.json + market.json
   ═══════════════════════════════════════════════════════ */

/** holdings.json + market.json에서 데이터 로드 */
async function loadFromData() {
  const badge = document.getElementById("statusBadge");
  const info = document.getElementById("loadInfo");
  badge.className = "bdg bdg-ld";
  badge.textContent = "LOADING";

  try {
    const [holdingsRes, marketRes] = await Promise.all([
      fetch(`./data/holdings.json?t=${Date.now()}`),
      fetch(`./data/market.json?t=${Date.now()}`),
    ]);

    if (!holdingsRes.ok) throw new Error(`Holdings: HTTP ${holdingsRes.status}`);
    const holdings = await holdingsRes.json();

    let market = { tickers: {} };
    if (marketRes.ok) {
      market = await marketRes.json();
    }

    computeAll(holdings, market);

    const age = market.updated ? Math.round((Date.now() - new Date(market.updated).getTime()) / 60000) : "?";
    const tCount = Object.keys(market.tickers).length;
    badge.className = "bdg bdg-ok";
    badge.textContent = `DATA · ${age}m ago`;
    info.textContent = `${tCount} tickers`;

    console.log(`[Data] holdings + market loaded (${tCount} tickers, ${age}m old)`);
    return true;
  } catch (e) {
    console.warn("[Data] Failed:", e.message);
    badge.className = "bdg bdg-er";
    badge.textContent = "FAIL";
    return false;
  }
}

/** 데이터 갱신 (자동 새로고침용) */
async function refreshMarketData() {
  try {
    const [holdingsRes, marketRes] = await Promise.all([
      fetch(`./data/holdings.json?t=${Date.now()}`),
      fetch(`./data/market.json?t=${Date.now()}`),
    ]);
    if (!holdingsRes.ok) return;
    const holdings = await holdingsRes.json();
    let market = { tickers: {} };
    if (marketRes.ok) market = await marketRes.json();
    computeAll(holdings, market);
  } catch (e) {
    console.warn("[Refresh] Failed:", e.message);
  }
}


/* ═══════════════════════════════════════════════════════
   데이터 계산 — holdings + market → P (전역 상태)
   ═══════════════════════════════════════════════════════ */

/** 종목 배열 빌드: holdings 정적 데이터 + market 시세 데이터 병합 */
function buildPort(items, mk, isKR) {
  return (items || []).map(h => {
    const d = mk[h.ticker] || {};
    const cur = d.price || h.avg;
    const inv = h.qty * h.avg;
    const val = h.qty * cur;
    const pl = val - inv;
    const plp = inv > 0 ? pl / inv * 100 : 0;
    const daily = d.changePct || 0;
    const divY = d.divYield || 0;
    return {
      name: h.name, ticker: h.ticker, qty: h.qty, avg: h.avg, cur,
      daily, inv, val, pl, plp, divY,
      rsi: d.rsi || 0, mdd: d.mdd || 0,
      bb20: d.bb20 || 0, bb252: d.bb252 || 0,
      target: "",
    };
  });
}

/** 전체 포트폴리오 계산 */
function computeAll(holdings, market) {
  const mk = market.tickers || {};

  // 환율
  P.rate = holdings.rate || 1450;

  // 현금
  P.cash = holdings.cash || { rp: 0, usd: 0, krw: 0 };

  // 포트폴리오 빌드
  P.index = buildPort(holdings.portfolios?.index, mk, false);
  P.dividend = buildPort(holdings.portfolios?.dividend, mk, false);
  P.growth = buildPort(holdings.portfolios?.growth, mk, false);
  P.kr = buildPort(holdings.portfolios?.kr, mk, true);

  // 티커 히스토리 (market.json에서 가져온 60일 히스토리)
  P.tickerHistory = {};
  for (const [ticker, data] of Object.entries(mk)) {
    if (data.history?.length > 1) {
      P.tickerHistory[ticker] = data.history;
    }
  }

  // TICKER_MAP (차트 렌더용)
  const histTickers = new Set(Object.keys(P.tickerHistory));
  TICKER_MAP.index = P.index.map(h => h.ticker.toUpperCase()).filter(t => histTickers.has(t));
  TICKER_MAP.dividend = P.dividend.map(h => h.ticker.toUpperCase()).filter(t => histTickers.has(t));
  TICKER_MAP.growth = P.growth.map(h => h.ticker.toUpperCase()).filter(t => histTickers.has(t));
  console.log("TICKER_MAP:", JSON.stringify(TICKER_MAP));

  // 포트폴리오별 합계
  const sum = (a, k) => a.reduce((s, h) => s + (h[k] || 0), 0);
  P.idxT = { inv: sum(P.index, "inv"), val: sum(P.index, "val") };
  P.divT = { inv: sum(P.dividend, "inv"), val: sum(P.dividend, "val") };
  P.groT = { inv: sum(P.growth, "inv"), val: sum(P.growth, "val") };
  P.krT = { inv: sum(P.kr, "inv"), val: sum(P.kr, "val") };
  P.usdAll = P.idxT.val + P.divT.val + P.groT.val;
  P.cashUsd = P.cash.rp + P.cash.usd;
  P.cashKrw = P.cash.krw || 0;
  P.cashAll = P.cashUsd; // 달러 현금 합계 (UI 표시용)
  P.grand = P.usdAll + P.krT.val / P.rate + P.cashUsd + P.cashKrw / P.rate;

  // TotalBoard (렌더링 호환용)
  const rp = t => t.inv > 0 ? ((t.val - t.inv) / t.inv * 100) : 0;
  P.tb = {
    "지수형": { inv: P.idxT.inv, val: P.idxT.val, plp: rp(P.idxT) },
    "배당":   { inv: P.divT.inv, val: P.divT.val, plp: rp(P.divT) },
    "성장":   { inv: P.groT.inv, val: P.groT.val, plp: rp(P.groT) },
    "Total":  { inv: P.idxT.inv + P.divT.inv + P.groT.inv, val: P.usdAll, plp: rp({ inv: P.idxT.inv + P.divT.inv + P.groT.inv, val: P.usdAll }) },
    "국내":   { inv: P.krT.inv, val: P.krT.val, plp: rp(P.krT) },
  };

  // UI 업데이트
  document.getElementById("rateDisp").textContent = `₩${P.rate.toLocaleString()}/USD`;
  document.getElementById("grandTotal").textContent = fU(Math.round(P.grand));
  renderTabs();
  switchTab(activeTab);
  setTimeout(startRSSentinel, 200);
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
    growth: renderGrowth, kr: renderKR
  };
  renderers[id]?.(el);

  // 국내 탭 이탈 시 KR 리프레쉬 정지
  if (id !== "kr") {
    _stopKRTabRefresh();
  }

  // US 탭 이탈 시 US 리프레쉬 정지
  if (id !== "index" && id !== "dividend" && id !== "growth") {
    _stopUSTabRefresh();
  }

  // 개요 탭에서 매크로 서머리 업데이트
  if (id === "overview" && _macroCache.data) {
    setTimeout(() => _updateMacroSummary(_macroCache.data), 100);
  }
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
      document.body.appendChild(overlay);
    }
    // 매번 내부를 재생성 (이전 iframe 잔재 방지)
    overlay.innerHTML = '';
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;padding:8px 12px;background:var(--s1);border-bottom:1px solid var(--bdr);flex-shrink:0";
    bar.innerHTML = '<button onclick="closeStockModal(true)" style="background:none;border:1px solid var(--bdr);color:var(--txt);padding:6px 14px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">← 돌아가기</button><span style="margin-left:12px;font-size:14px;font-weight:800;color:var(--txt)">' + name + '</span>';
    const frame = document.createElement("iframe");
    frame.id = "stockFrame";
    frame.style.cssText = "flex:1;border:none;width:100%";
    overlay.appendChild(bar);
    overlay.appendChild(frame);
    overlay.style.display = "flex";
    frame.src = url;
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
    // iframe 완전 해제 (메모리 누수 방지)
    const frame = document.getElementById("stockFrame");
    if (frame) {
      try { frame.contentWindow?.stop?.(); } catch {}
      frame.src = "about:blank";
      frame.remove();
    }
    m.style.display = "none";
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
    if (tr.dataset.market === "kr") {
      rsShowDetail(tr.dataset.ticker, true);
      return;
    }
    // 미국 종목: RS 리스크 상세 팝업
    rsShowDetail(tr.dataset.ticker, false);
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

/** 종목 테이블 HTML 생성 (US: 스파크라인 + 리스크 배지 + 행 발광 포함) */
function mkTable(items, isKR) {
  const heads = ["종목", "차트", "현재가", "일변동", "수익률", "평가금", "배당률", "BB(20)", "BB(252)", "RSI", "MDD"];
  return `<div class="tbl-wrap"><table class="kr-tbl">
    <colgroup>
      <col style="width:130px"><col style="width:88px"><col style="width:90px"><col style="width:68px">
      <col style="width:68px"><col style="width:100px"><col style="width:62px">
      <col style="width:52px"><col style="width:56px"><col style="width:48px"><col style="width:56px">
    </colgroup>
    <thead><tr>${heads.map((h, i) => `<th${i === 0 ? ' style="text-align:left"' : i === 1 ? ' style="text-align:center"' : ''}>${h}</th>`).join("")}</tr></thead>
    <tbody>${items.map(h => {
      const cur = isKR ? h.cur.toLocaleString() : fUd(h.cur);
      const val = isKR ? fK(h.val) : fU(Math.round(h.val));
      const plS = isKR ? (h.pl >= 0 ? "+" : "") + fK(h.pl) : (h.pl >= 0 ? "+" : "") + fU(Math.round(h.pl));
      const mc = Math.abs(h.mdd) >= 10 ? "var(--red)" : Math.abs(h.mdd) >= 5 ? "var(--amber)" : "var(--green)";
      const sigC = v => v >= 70 ? "var(--green)" : v <= 30 ? "var(--red)" : "var(--txt)";
      const st = isETF(h.ticker) ? "etf" : "stock";
      const sid = rsSafeId(h.ticker);
      const prefix = isKR ? "kr" : "us";
      return `<tr id="${prefix}row_${sid}" style="cursor:pointer;transition:background .3s,box-shadow .3s" data-ticker="${h.ticker}" data-market="${isKR ? "kr" : "us"}" data-name="${h.name}" data-type="${st}">
        <td style="text-align:left"><div style="font-weight:800;font-size:13px;color:var(--txt)">${h.name}</div><div style="font-size:10px;color:var(--sub)">${h.ticker} · ${isKR ? h.qty : h.qty % 1 ? h.qty.toFixed(2) : h.qty}주</div></td>
        <td style="text-align:center;position:relative;padding:4px 2px">
          <div id="${prefix}spark_${sid}" style="width:80px;height:26px;margin:0 auto;display:flex;align-items:center;justify-content:center">
            <div class="kr-spark-placeholder"></div>
          </div>
          <div id="${prefix}badge_${sid}" style="position:absolute;top:0;right:2px"></div>
        </td>
        <td class="mono" id="${prefix}price_${sid}"><div class="kr-cur">${cur}</div><div style="font-size:10px;color:var(--mute)">${isKR ? h.avg.toLocaleString() : fUd(h.avg)}</div></td>
        <td id="${prefix}daily_${sid}"><span class="${bc(h.daily)}">${fP(h.daily)}</span></td>
        <td id="${prefix}plp_${sid}" style="color:${pc(h.plp)};font-weight:800;font-size:13px">${fP(h.plp)}</td>
        <td id="${prefix}val_${sid}"><div style="font-weight:700;font-size:12px;color:var(--txt2)">${val}</div><div style="font-size:10px;color:${pc(h.pl)}">${plS}</div></td>
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
          <div class="lbl">현금 보유</div><div class="big">${fU(P.cashUsd)}${P.cashKrw > 0 ? ` <span style="font-size:14px;color:var(--sub)">+ ${fK(P.cashKrw)}</span>` : ""}</div>
          <div style="font-size:12px;color:var(--sub);margin-top:4px">RP ${fU(P.cash.rp)} · 예수금 ${fU(P.cash.usd)}${P.cashKrw > 0 ? ` · 원화 ${fK(P.cashKrw)}` : ""}</div></div>
        <div class="card"><div class="topline" style="background:linear-gradient(90deg,var(--green),transparent)"></div>
          <div class="lbl">연간 배당</div><div class="big" style="color:var(--green)">${fU(Math.round(totalDiv))}</div>
          <div style="font-size:12px;color:var(--sub);margin-top:4px">월 ${fU(Math.round(totalDiv / 12))}</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${_macroSummaryHTML()}
        <div class="card" style="display:flex;flex-direction:column"><div class="lbl" style="margin-bottom:8px">포트폴리오별 수익률</div><div style="flex:1;position:relative"><canvas id="chRet"></canvas></div></div>
      </div>
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

  // 매크로 서머리 데이터 로드
  setTimeout(() => loadMacroData(), 200);
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
          <div class="mid" style="color:${pc(plp)};margin-top:4px">${fP(plp)}</div>
          <div id="usRiskStatus_index" style="font-size:9px;color:var(--mute);margin-top:3px"></div></div>
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
  setTimeout(() => _updateUSTableRS(), 100);
  _startUSTabRefresh();
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
          <div class="mid" style="color:${pc(plp)};margin-top:4px">${fP(plp)}</div>
          <div id="usRiskStatus_dividend" style="font-size:9px;color:var(--mute);margin-top:3px"></div></div>
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
  setTimeout(() => _updateUSTableRS(), 100);
  _startUSTabRefresh();
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
          <div class="mid" style="color:${pc(plp)};margin-top:4px">${fP(plp)}</div>
          <div id="usRiskStatus_growth" style="font-size:9px;color:var(--mute);margin-top:3px"></div></div>
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="lbl">목표 진행률 (투자금)</div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px"><span style="color:var(--txt2)">${fU(Math.round(P.groT.inv))}</span><span style="font-weight:800;color:${pct >= 100 ? "var(--green)" : "var(--txt2)"}">${pct.toFixed(0)}%</span></div>
          <div class="pbar"><div class="pbar-fill" style="width:${Math.min(pct, 100)}%;background:${pct >= 100 ? "var(--green)" : "var(--purple)"}"></div></div>
          <div style="font-size:9px;color:var(--mute);margin-top:2px;text-align:right">목표 ${fU(TARGET_GROWTH)}</div></div>
        <div class="card" style="flex:1;overflow:hidden;min-height:0"><div class="lbl">최고 수익</div>${best ? `<div style="font-size:20px;font-weight:900;color:var(--green)">${best.name}</div><div style="font-size:14px;color:var(--green);font-weight:800">${fP(best.plp)}</div>` : ""}</div>
      </div>
    </div>
    <div class="card">${mkTable(P.growth, false)}</div></div>`;
  mkPriceTrendChart("chGroTrend", TICKER_MAP.growth);
  setTimeout(() => _updateUSTableRS(), 100);
  _startUSTabRefresh();
}

function renderKR(el) {
  const krDiv = P.kr.reduce((s, h) => s + h.val * (h.divY / 100), 0);
  const plp = P.krT.inv > 0 ? ((P.krT.val - P.krT.inv) / P.krT.inv * 100) : 0;
  const mktOpen = _isKRMarketOpen();

  const summaryHTML = `<div class="grid-3">
    <div class="card">
      <div class="topline" style="background:linear-gradient(90deg,var(--amber),transparent)"></div>
      <div class="lbl">원화 평가금액</div>
      <div class="big">${fK(P.krT.val)}</div>
      <div class="mid" style="color:${pc(plp)};margin-top:4px">${fP(plp)}</div>
    </div>
    <div class="card">
      <div class="lbl">보유 종목</div>
      <div class="big">${P.kr.length}<span style="font-size:14px;color:var(--sub)"> 종목</span></div>
      <div style="margin-top:6px;font-size:9px;padding:2px 8px;border-radius:5px;font-weight:700;display:inline-block;background:${mktOpen ? "rgba(46,224,168,0.15)" : "rgba(255,107,120,0.12)"};color:${mktOpen ? "var(--green)" : "var(--red)"}">${mktOpen ? "장중 · 자동갱신" : "장 마감"}</div>
      <div id="krRiskStatus" style="font-size:9px;color:var(--mute);margin-top:3px"></div>
    </div>
    <div class="card">
      <div class="lbl">연간 배당</div>
      <div class="big" style="color:var(--green)">${fK(krDiv)}</div>
    </div>
  </div>`;

  el.innerHTML = `<div class="section">
    ${summaryHTML}
    <div class="card" style="margin-top:16px">${_mkKRTable(P.kr)}</div>
  </div>`;
  setTimeout(() => _updateKRTableRS(), 100);
  _startKRTabRefresh();
}

/** 국내 종목 테이블 (스파크라인 + 리스크 배지 포함) */
function _mkKRTable(items) {
  const heads = ["종목", "차트", "현재가", "일변동", "수익률", "평가금", "배당률", "BB(20)", "BB(252)", "RSI", "MDD"];
  return `<div class="tbl-wrap"><table class="kr-tbl">
    <colgroup>
      <col style="width:140px"><col style="width:88px"><col style="width:90px"><col style="width:68px">
      <col style="width:68px"><col style="width:100px"><col style="width:62px">
      <col style="width:52px"><col style="width:56px"><col style="width:48px"><col style="width:56px">
    </colgroup>
    <thead><tr>${heads.map((h, i) => `<th${i === 0 ? ' style="text-align:left"' : i === 1 ? ' style="text-align:center"' : ''}>${h}</th>`).join("")}</tr></thead>
    <tbody>${items.map(h => {
      const cur = h.cur.toLocaleString();
      const val = fK(h.val);
      const plS = (h.pl >= 0 ? "+" : "") + fK(h.pl);
      const mc = Math.abs(h.mdd) >= 10 ? "var(--red)" : Math.abs(h.mdd) >= 5 ? "var(--amber)" : "var(--green)";
      const sigC = v => v >= 70 ? "var(--green)" : v <= 30 ? "var(--red)" : "var(--txt)";
      const sid = rsSafeId(h.ticker);
      return `<tr id="krrow_${sid}" style="cursor:pointer;transition:background .3s,box-shadow .3s" data-ticker="${h.ticker}" data-market="kr" data-name="${h.name}" data-type="stock">
        <td style="text-align:left"><div style="font-weight:800;font-size:13px;color:var(--txt)">${h.name}</div><div style="font-size:10px;color:var(--sub)">${h.ticker} · ${h.qty}주</div></td>
        <td style="text-align:center;position:relative;padding:4px 2px">
          <div id="krspark_${sid}" style="width:80px;height:26px;margin:0 auto;display:flex;align-items:center;justify-content:center">
            <div class="kr-spark-placeholder"></div>
          </div>
          <div id="krbadge_${sid}" style="position:absolute;top:0;right:2px"></div>
        </td>
        <td class="mono" id="krprice_${sid}"><div class="kr-cur">${cur}</div><div style="font-size:10px;color:var(--mute)">${h.avg.toLocaleString()}</div></td>
        <td id="krdaily_${sid}"><span class="${bc(h.daily)}">${fP(h.daily)}</span></td>
        <td id="${prefix}plp_${sid}" style="color:${pc(h.plp)};font-weight:800;font-size:13px">${fP(h.plp)}</td>
        <td id="${prefix}val_${sid}"><div style="font-weight:700;font-size:12px;color:var(--txt2)">${val}</div><div style="font-size:10px;color:${pc(h.pl)}">${plS}</div></td>
        <td><span style="color:${h.divY >= 3 ? "var(--green)" : h.divY >= 1 ? "var(--amber)" : "var(--sub)"};font-weight:700;font-size:12px">${h.divY.toFixed(2)}%</span></td>
        <td style="text-align:center"><span style="color:${sigC(h.bb20)};font-weight:700;font-size:12px">${h.bb20 || "-"}</span></td>
        <td style="text-align:center"><span style="color:${sigC(h.bb252)};font-weight:700;font-size:12px">${h.bb252 || "-"}</span></td>
        <td style="text-align:center"><span style="color:${sigC(h.rsi)};font-weight:800;font-size:13px">${h.rsi > 0 ? h.rsi.toFixed(0) : "-"}</span></td>
        <td><span style="color:${mc};font-weight:700;font-size:12px">${h.mdd.toFixed(1)}%</span></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

/** 국내 테이블에 RS 데이터 점진 반영 (스파크라인 + 배지 + 행 발광 + 실시간 가격) */
function _updateKRTableRS() {
  if (activeTab !== "kr") return;
  (P.kr || []).forEach(h => {
    if (!h.ticker) return;
    const d = RS_KR.data[h.ticker];
    const sid = rsSafeId(h.ticker);
    const sparkEl = document.getElementById("krspark_" + sid);
    const badgeEl = document.getElementById("krbadge_" + sid);
    const row = document.getElementById("krrow_" + sid);
    const priceEl = document.getElementById("krprice_" + sid);
    const dailyEl = document.getElementById("krdaily_" + sid);
    if (!sparkEl) return;

    // 스파크라인 (당일 5분봉 장중 차트)
    const sparkData = d?.intraday?.length > 2 ? d.intraday : null;
    if (sparkData) {
      sparkEl.innerHTML = mkSparkSVG(sparkData, 80, 26);
    } else if (d?.loading) {
      sparkEl.innerHTML = '<div class="kr-spark-placeholder"></div>';
    } else if (d?.error) {
      sparkEl.innerHTML = '<span style="font-size:8px;color:var(--mute)">—</span>';
    }

    // 현재가 + 일변동 + 수익률 + 평가금 업데이트 (RS 실시간 데이터)
    if (d?.loaded && d.price > 0) {
      const rsPrice = Math.round(d.price);
      // P 데이터 갱신
      h.cur = rsPrice;
      h.val = h.qty * rsPrice;
      h.pl = h.val - h.inv;
      h.plp = h.inv > 0 ? (h.pl / h.inv * 100) : 0;
      h.daily = typeof d.changePct === "number" ? d.changePct : h.daily;

      if (priceEl) {
        priceEl.querySelector(".kr-cur").textContent = rsPrice.toLocaleString();
      }
      if (dailyEl && typeof d.changePct === "number") {
        dailyEl.innerHTML = `<span class="${bc(d.changePct)}">${fP(d.changePct)}</span>`;
      }
      // 수익률 셀
      const plpEl = document.getElementById("krplp_" + sid);
      if (plpEl) {
        plpEl.style.color = pc(h.plp);
        plpEl.textContent = fP(h.plp);
      }
      // 평가금 셀
      const valEl = document.getElementById("krval_" + sid);
      if (valEl) {
        valEl.innerHTML = `<div style="font-weight:700;font-size:12px;color:var(--txt2)">${fK(h.val)}</div><div style="font-size:10px;color:${pc(h.pl)}">${h.pl >= 0 ? "+" : ""}${fK(h.pl)}</div>`;
      }
    }

    // 리스크 배지
    if (badgeEl) {
      const cnt = d?.risks?.length || 0;
      if (cnt > 0) {
        badgeEl.innerHTML = `<span class="rs-cnt-badge rs-cnt-risk" style="position:static;font-size:8px;min-width:15px;height:15px;border-radius:8px">${cnt}</span>`;
      } else if (d?.loaded) {
        badgeEl.innerHTML = `<span style="font-size:8px;color:var(--green);font-weight:700">✓</span>`;
      } else {
        badgeEl.innerHTML = '';
      }
    }

    // 행 발광 (critical 레벨만)
    if (row) {
      const hasCriticalRisk = d?.risks?.some(r => r.sev === "critical");
      if (hasCriticalRisk) {
        row.classList.add("kr-risk-glow");
      } else {
        row.classList.remove("kr-risk-glow");
      }
    }
  });

  // 포트폴리오 합계 재계산
  _recalcTotals();

  // KR 평가금액 요약 카드 업데이트
  const krValCards = document.querySelectorAll("#content .card .big");
  if (krValCards.length > 0 && P.krT) {
    const plp = P.krT.inv > 0 ? ((P.krT.val - P.krT.inv) / P.krT.inv * 100) : 0;
    const firstCard = document.querySelector("#content .card");
    if (firstCard) {
      const bigEl = firstCard.querySelector(".big");
      const midEl = firstCard.querySelector(".mid");
      if (bigEl) bigEl.textContent = fK(P.krT.val);
      if (midEl) {
        midEl.style.color = pc(plp);
        midEl.textContent = fP(plp);
      }
    }
  }

  // 상태 표시
  const statusEl = document.getElementById("krRiskStatus");
  if (statusEl) {
    const st = RS_KR.status;
    if (st.loading) {
      statusEl.innerHTML = `<span style="color:var(--amber)">리스크 분석중 ${st.loaded}/${st.total}...</span>`;
    } else if (st.lastUp) {
      const hasRisk = Object.values(RS_KR.data).some(d => d.risks?.length > 0);
      statusEl.innerHTML = `<span style="color:${hasRisk ? "var(--red)" : "var(--green)"}">${hasRisk ? "⚠ 리스크 감지" : "✓ 정상"}</span> · ${st.lastUp.toLocaleTimeString("ko-KR")}`;
    }
  }
}

/** US 테이블(지수/배당/성장)에 RS 데이터 점진 반영 */
function _updateUSTableRS() {
  const tabItems = { index: P.index, dividend: P.dividend, growth: P.growth };
  const items = tabItems[activeTab];
  if (!items) return;

  items.forEach(h => {
    if (!h.ticker) return;
    const d = RS_US.data[h.ticker];
    const sid = rsSafeId(h.ticker);
    const sparkEl = document.getElementById("usspark_" + sid);
    const badgeEl = document.getElementById("usbadge_" + sid);
    const row = document.getElementById("usrow_" + sid);
    const priceEl = document.getElementById("usprice_" + sid);
    const dailyEl = document.getElementById("usdaily_" + sid);
    if (!sparkEl) return;

    // 스파크라인 (US: 최근 40일 일봉)
    if (d?.closes?.length > 2) {
      sparkEl.innerHTML = mkSparkSVG(d.closes, 80, 26);
    } else if (d?.loading) {
      sparkEl.innerHTML = '<div class="kr-spark-placeholder"></div>';
    } else if (d?.error) {
      sparkEl.innerHTML = '<span style="font-size:8px;color:var(--mute)">—</span>';
    }

    // 현재가 + 일변동 + 수익률 + 평가금 업데이트
    if (d?.loaded && d.price > 0) {
      // P 데이터 갱신
      h.cur = d.price;
      h.val = h.qty * d.price;
      h.pl = h.val - h.inv;
      h.plp = h.inv > 0 ? (h.pl / h.inv * 100) : 0;
      h.daily = typeof d.changePct === "number" ? d.changePct : h.daily;

      if (priceEl) {
        priceEl.querySelector(".kr-cur").textContent = "$" + d.price.toFixed(2);
      }
      if (dailyEl && typeof d.changePct === "number") {
        dailyEl.innerHTML = `<span class="${bc(d.changePct)}">${fP(d.changePct)}</span>`;
      }
      // 수익률 셀
      const plpEl = document.getElementById("usplp_" + sid);
      if (plpEl) {
        plpEl.style.color = pc(h.plp);
        plpEl.textContent = fP(h.plp);
      }
      // 평가금 셀
      const valEl = document.getElementById("usval_" + sid);
      if (valEl) {
        valEl.innerHTML = `<div style="font-weight:700;font-size:12px;color:var(--txt2)">${fU(Math.round(h.val))}</div><div style="font-size:10px;color:${pc(h.pl)}">${h.pl >= 0 ? "+" : ""}${fU(Math.round(h.pl))}</div>`;
      }
    }

    // 리스크 배지
    if (badgeEl) {
      const cnt = d?.risks?.length || 0;
      if (cnt > 0) {
        badgeEl.innerHTML = `<span class="rs-cnt-badge rs-cnt-risk" style="position:static;font-size:8px;min-width:15px;height:15px;border-radius:8px">${cnt}</span>`;
      } else if (d?.loaded) {
        badgeEl.innerHTML = `<span style="font-size:8px;color:var(--green);font-weight:700">✓</span>`;
      } else {
        badgeEl.innerHTML = '';
      }
    }

    // 행 발광 (critical 레벨만)
    if (row) {
      const hasCriticalRisk = d?.risks?.some(r => r.sev === "critical");
      if (hasCriticalRisk) {
        row.classList.add("kr-risk-glow");
      } else {
        row.classList.remove("kr-risk-glow");
      }
    }
  });

  // 포트폴리오 합계 재계산
  _recalcTotals();

  // 탭별 요약 카드 업데이트
  _updateTabSummary();

  // US 리스크 상태 표시
  const statusEl = document.getElementById("usRiskStatus_" + activeTab);
  if (statusEl) {
    const st = RS_US.status;
    if (st.loading) {
      statusEl.innerHTML = `<span style="color:var(--amber)">리스크 분석중 ${st.loaded}/${st.total}...</span>`;
    } else if (st.lastUp) {
      const hasRisk = items.some(h => RS_US.data[h.ticker]?.risks?.length > 0);
      statusEl.innerHTML = `<span style="color:${hasRisk ? "var(--red)" : "var(--green)"}">${hasRisk ? "⚠ 리스크 감지" : "✓ 정상"}</span> · ${st.lastUp.toLocaleTimeString("ko-KR")}`;
    }
  }
}

/** 포트폴리오 합계 재계산 (실시간 가격 반영) */
function _recalcTotals() {
  const sum = (a, k) => a.reduce((s, h) => s + (h[k] || 0), 0);
  P.idxT = { inv: sum(P.index, "inv"), val: sum(P.index, "val") };
  P.divT = { inv: sum(P.dividend, "inv"), val: sum(P.dividend, "val") };
  P.groT = { inv: sum(P.growth, "inv"), val: sum(P.growth, "val") };
  P.krT = { inv: sum(P.kr, "inv"), val: sum(P.kr, "val") };
  P.usdAll = P.idxT.val + P.divT.val + P.groT.val;
  P.cashUsd = P.cash.rp + P.cash.usd;
  P.cashKrw = P.cash.krw || 0;
  P.cashAll = P.cashUsd;
  P.grand = P.usdAll + P.krT.val / P.rate + P.cashUsd + P.cashKrw / P.rate;

  // TotalBoard 갱신
  const rp = t => t.inv > 0 ? ((t.val - t.inv) / t.inv * 100) : 0;
  P.tb = {
    "지수형": { inv: P.idxT.inv, val: P.idxT.val, plp: rp(P.idxT) },
    "배당":   { inv: P.divT.inv, val: P.divT.val, plp: rp(P.divT) },
    "성장":   { inv: P.groT.inv, val: P.groT.val, plp: rp(P.groT) },
    "Total":  { inv: P.idxT.inv + P.divT.inv + P.groT.inv, val: P.usdAll, plp: rp({ inv: P.idxT.inv + P.divT.inv + P.groT.inv, val: P.usdAll }) },
    "국내":   { inv: P.krT.inv, val: P.krT.val, plp: rp(P.krT) },
  };

  // 그랜드 토탈 업데이트
  const gtEl = document.getElementById("grandTotal");
  if (gtEl) gtEl.textContent = fU(Math.round(P.grand));
}

/** 탭별 요약 카드 실시간 업데이트 */
function _updateTabSummary() {
  const tabTotals = { index: P.idxT, dividend: P.divT, growth: P.groT };
  const t = tabTotals[activeTab];
  if (!t) return;

  // "평가금액" 카드 내 .big 요소 (각 탭 렌더러에서 생성된 사이드카드)
  const sideCards = document.querySelectorAll(".side-cards .card");
  if (sideCards.length > 0) {
    const plp = t.inv > 0 ? ((t.val - t.inv) / t.inv * 100) : 0;
    const bigEl = sideCards[0].querySelector(".big");
    const midEl = sideCards[0].querySelector(".mid");
    if (bigEl) bigEl.textContent = fU(Math.round(t.val));
    if (midEl) {
      midEl.style.color = pc(plp);
      midEl.textContent = fP(plp);
    }
  }
}

/** US 탭 RS 데이터 자동 반영 타이머 */
let _usTabRefreshTimer = null;

function _startUSTabRefresh() {
  _stopUSTabRefresh();
  _usTabRefreshTimer = setInterval(() => {
    if (activeTab !== "index" && activeTab !== "dividend" && activeTab !== "growth") { _stopUSTabRefresh(); return; }
    _updateUSTableRS();
  }, 8000);
}

function _stopUSTabRefresh() {
  if (_usTabRefreshTimer) { clearInterval(_usTabRefreshTimer); _usTabRefreshTimer = null; }
}

/** 국내 탭 3분 장중 자동갱신 */
let _krTabRefreshTimer = null;

function _startKRTabRefresh() {
  _stopKRTabRefresh();
  // 8초마다 UI 점진 업데이트 (RS 백그라운드 로드 반영)
  _krTabRefreshTimer = setInterval(() => {
    if (activeTab !== "kr") { _stopKRTabRefresh(); return; }
    _updateKRTableRS();
  }, 8000);
}

function _stopKRTabRefresh() {
  if (_krTabRefreshTimer) { clearInterval(_krTabRefreshTimer); _krTabRefreshTimer = null; }
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

// ── data/macro.json에서 FRED 데이터 로드 (GitHub Actions가 10분마다 갱신) ──
async function _fetchFREDFromJSON() {
  try {
    const r = await fetch("data/macro.json?" + Date.now(), { signal: rsAbortSignal(10000) });
    if (!r.ok) return {};
    const j = await r.json();
    return j?.series || {};
  } catch { return {}; }
}

// ── Yahoo Finance fetch (보조 — 실시간 시세 + 30일 히스토리) ──
async function _fetchYahooQuote(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d&includePrePost=false`;
  for (const p of [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    `https://corsproxy.io/?${encodeURIComponent(u)}`
  ]) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(p, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) { r.body?.cancel().catch(() => {}); continue; }
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res) continue;
      const m = res.meta;
      const price = m?.regularMarketPrice;
      const prev = m?.chartPreviousClose || m?.previousClose;
      const chg = (price && prev) ? (price - prev) : null;
      // 히스토리 추출
      const timestamps = res.timestamp || [];
      const closes = res.indicators?.quote?.[0]?.close || [];
      const history = timestamps.map((ts, i) => {
        const d = new Date(ts * 1000).toISOString().slice(0, 10);
        return closes[i] != null ? { d, v: closes[i] } : null;
      }).filter(Boolean);
      return { value: price, prev, chg, date: new Date().toISOString().slice(0,10), history };
    } catch {}
  }
  return null;
}

// ── 전체 매크로 데이터 로드 ──
async function fetchMacroIndicators() {
  if (_macroCache.data && Date.now() - _macroCache.ts < 300000) return _macroCache.data;

  // FRED 데이터는 정적 JSON에서 로드
  const fredData = await _fetchFREDFromJSON();

  // Yahoo 보조 데이터는 실시간 fetch
  const results = { ...fredData };
  const yahooKeys = Object.keys(YAHOO_SYMBOLS);
  const yahooFetches = yahooKeys.map(async k => { results["Y_" + k] = await _fetchYahooQuote(YAHOO_SYMBOLS[k].sym); });
  await Promise.allSettled(yahooFetches);

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
    _updateMacroSummary(data);
  } catch { /* silent */ }
}


/* ═══════════════════════════════════════════════════════
   매크로 리스크 서머리 (메인 대시보드용) + 팝업
   ═══════════════════════════════════════════════════════ */

// ── 전체 매크로 위험 수준 계산 ──
function _calcMacroRiskLevel(data) {
  if (!data) return { level: "로딩중", color: "var(--mute)", danger: 0, warn: 0, ok: 0, total: 0 };
  let danger = 0, warn = 0, ok = 0, total = 0;
  for (const [k, info] of Object.entries(FRED_SERIES)) {
    const d = data[k];
    if (!d || d.value == null) continue;
    total++;
    const sig = _mSignal(d.value, info.danger);
    if (sig.level === "danger") danger++;
    else if (sig.level === "warn") warn++;
    else ok++;
  }
  for (const [k, info] of Object.entries(YAHOO_SYMBOLS)) {
    const d = data["Y_" + k];
    if (!d || d.value == null) continue;
    total++;
    const sig = _mSignal(d.value, info.danger);
    if (sig.level === "danger") danger++;
    else if (sig.level === "warn") warn++;
    else ok++;
  }
  let level, color;
  if (danger >= 3) { level = "위험"; color = "var(--red)"; }
  else if (danger >= 1 || warn >= 3) { level = "주의"; color = "var(--amber)"; }
  else { level = "양호"; color = "var(--green)"; }
  return { level, color, danger, warn, ok, total };
}

// ── 서머리 카드 HTML (메인 대시보드에 삽입) ──
function _macroSummaryHTML() {
  return `<div class="card macro-summary-card" id="macroSummaryCard" style="cursor:pointer;border-left:3px solid var(--mute);transition:border-color .3s" onclick="openMacroPopup()">
    <div class="topline" style="background:linear-gradient(90deg,var(--purple),var(--blue),transparent)"></div>
    <div class="lbl">매크로 리스크</div>
    <div id="macroSummLevel" class="big" style="color:var(--mute);font-size:24px">—</div>
    <div id="macroSummDetail" style="font-size:11px;color:var(--mute);margin-top:4px">데이터 로딩중...</div>
    <div style="font-size:9px;color:var(--mute);margin-top:6px">탭하여 상세보기 →</div>
  </div>`;
}

function _updateMacroSummary(data) {
  const r = _calcMacroRiskLevel(data);
  const el = document.getElementById("macroSummLevel");
  const det = document.getElementById("macroSummDetail");
  const card = document.getElementById("macroSummaryCard");
  if (!el) return;
  el.textContent = r.level;
  el.style.color = r.color;
  det.innerHTML = `<span style="color:var(--red)">위험 ${r.danger}</span> · <span style="color:var(--amber)">주의 ${r.warn}</span> · <span style="color:var(--green)">양호 ${r.ok}</span>`;
  if (card) card.style.borderLeftColor = r.color;
}

// ── 매크로 팝업 (차트 포함) ──
function openMacroPopup() {
  if (document.getElementById("macroPopupOverlay")) return;
  const data = _macroCache.data;

  const cats = [
    { id: "rate",   icon: "💵", title: "금리 & 유동성",       color: "#4d9aff" },
    { id: "econ",   icon: "🏭", title: "경기 & 펀더멘털",     color: "#2ee0a8" },
    { id: "credit", icon: "🔗", title: "신용 & 위험 프리미엄",  color: "#ffc05c" },
    { id: "senti",  icon: "🧠", title: "심리 & 시장",         color: "#ae82ff" },
  ];

  let catHTML = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px">` + cats.map(cat => {
    const fredItems = Object.entries(FRED_SERIES).filter(([,v]) => v.cat === cat.id);
    const yahooItems = Object.entries(YAHOO_SYMBOLS).filter(([,v]) => v.cat === cat.id);
    const items = [...fredItems.map(([k,info]) => ({ k, info, val: data?.[k] })),
                   ...yahooItems.map(([k,info]) => ({ k: "Y_"+k, info, val: data?.["Y_"+k] }))];

    return `<div style="background:var(--s1);border-radius:12px;padding:14px 16px;border:1px solid var(--bdr);border-left:3px solid ${cat.color}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:15px">${cat.icon}</span>
        <span style="font-size:12px;font-weight:800;color:${cat.color}">${cat.title}</span>
      </div>
      ${items.map(item => {
        const sig = item.val ? _mSignal(item.val.value, item.info.danger) : { color: "var(--mute)" };
        const hasHistory = item.val?.history?.length > 2;
        return `<div style="margin-bottom:10px;background:var(--card);border-radius:8px;padding:10px 12px;border:1px solid var(--bdr)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
              <span style="width:7px;height:7px;border-radius:50%;background:${sig.color};flex-shrink:0"></span>
              <span style="font-size:11px;font-weight:700;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.info.label}</span>
            </div>
            <div style="text-align:right;flex-shrink:0;margin-left:8px">
              <span style="font-size:14px;font-weight:800;color:var(--txt);font-family:'SF Mono',monospace">${item.val ? _mFmt(item.val.value, item.info.unit) : "—"}</span>
              ${item.val ? _mChgHTML(item.val.chg, item.info.unit) : ""}
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:8px;color:var(--mute)">${item.info.src}${item.val?.date ? " · " + item.val.date : ""}</span>
            <span style="font-size:8px;color:var(--mute)">⚠ ${item.info.danger}</span>
          </div>
          <div style="height:70px;background:rgba(4,8,15,0.4);border-radius:6px;padding:4px;overflow:hidden">
            ${hasHistory ? `<canvas id="mchart_${item.k}" style="width:100%;height:100%"></canvas>` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:9px;color:var(--mute)">히스토리 데이터 없음</div>`}
          </div>
        </div>`;
      }).join("")}
    </div>`;
  }).join("") + `</div>`;

  // 전체 리스크 요약
  const risk = _calcMacroRiskLevel(data);

  const overlay = document.createElement("div");
  overlay.id = "macroPopupOverlay";
  overlay.className = "rs-overlay";
  overlay.onclick = e => { if (e.target === overlay) closeMacroPopup(); };
  overlay.innerHTML = `<div class="rs-popup" style="max-width:960px">
    <div class="rs-popup-head">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">🌐</span>
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--txt)">매크로 리스크 대시보드</div>
          <div style="font-size:10px;color:var(--mute)">${Object.keys(FRED_SERIES).length + Object.keys(YAHOO_SYMBOLS).length}개 지표 · 추세 차트</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="text-align:center;padding:4px 12px;border-radius:8px;background:${risk.color}18;border:1px solid ${risk.color}40">
          <div style="font-size:16px;font-weight:900;color:${risk.color}">${risk.level}</div>
          <div style="font-size:8px;color:var(--mute)">종합 판단</div>
        </div>
        <button class="rs-popup-close" onclick="closeMacroPopup()">✕</button>
      </div>
    </div>
    <div class="rs-popup-body">
      ${catHTML}
      <div style="margin-top:14px;padding:8px 14px;background:rgba(31,58,98,0.12);border-radius:8px;font-size:9px;color:var(--mute);line-height:1.7;display:flex;gap:20px;flex-wrap:wrap">
        <span>📡 <b>FRED</b> — Federal Reserve Economic Data</span>
        <span>📈 <b>Yahoo Finance</b> — 실시간 시세 (~15분 지연)</span>
        <span>🔄 상태: <span style="color:var(--green)">●</span> 정상 <span style="color:var(--amber)">●</span> 주의 <span style="color:var(--red)">●</span> 위험</span>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // 차트 렌더링
  setTimeout(() => _renderMacroCharts(data), 50);
}

function closeMacroPopup() {
  const el = document.getElementById("macroPopupOverlay");
  if (el) { el.remove(); _macroPopupCharts.forEach(c => c.destroy()); _macroPopupCharts = []; }
}

let _macroPopupCharts = [];

function _renderMacroCharts(data) {
  if (!data) return;
  const allItems = [
    ...Object.entries(FRED_SERIES).map(([k, info]) => ({ k, info, val: data[k] })),
    ...Object.entries(YAHOO_SYMBOLS).map(([k, info]) => ({ k: "Y_"+k, info, val: data["Y_"+k] })),
  ];
  allItems.forEach(item => {
    const canvasEl = document.getElementById("mchart_" + item.k);
    if (!canvasEl || !item.val?.history?.length) return;
    const hist = item.val.history;
    const labels = hist.map(h => h.d.slice(5)); // MM-DD
    const values = hist.map(h => h.v);

    // 위험 임계선
    const dangerStr = item.info.danger.toLowerCase();
    let thresholdVal = null;
    if (dangerStr.includes(">")) {
      thresholdVal = parseFloat(dangerStr.replace(/[^0-9.\-]/g, ""));
    } else if (dangerStr.includes("< 0") || dangerStr.includes("역전")) {
      thresholdVal = 0;
    } else if (dangerStr.includes("< 50")) {
      thresholdVal = 50;
    }

    const datasets = [{
      data: values,
      borderColor: "#4d9aff",
      backgroundColor: "rgba(77,154,255,0.1)",
      fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
    }];
    if (thresholdVal !== null) {
      datasets.push({
        data: Array(values.length).fill(thresholdVal),
        borderColor: "rgba(255,107,120,0.5)",
        borderDash: [4, 3], pointRadius: 0, borderWidth: 1, fill: false,
      });
    }

    const chart = new Chart(canvasEl, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: ctx => ctx.datasetIndex === 0 ? _mFmt(ctx.raw, item.info.unit) : "임계선" }
        }},
        scales: {
          x: { display: false },
          y: { ticks: { color: "#5e82a8", font: { size: 8 }, maxTicksLimit: 3 }, grid: { color: "#1f3a6215" } }
        }
      }
    });
    _macroPopupCharts.push(chart);
  });
}


function _isKRMarketOpen() {
  // 한국시간(KST) 기준 월~금 09:00~15:30
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 3600000);
  const day = kst.getDay();
  if (day === 0 || day === 6) return false;
  const hm = kst.getHours() * 100 + kst.getMinutes();
  return hm >= 900 && hm <= 1530;
}

/* ═══════════════════════════════════════════════════════
   자동 새로고침 + 리사이즈 + 초기화
   ═══════════════════════════════════════════════════════ */

let _countdown = REFRESH_SEC;
let _resizeTimer;
let _autoRefreshTimer = null;

function startAutoRefresh() {
  stopAutoRefresh();
  _autoRefreshTimer = setInterval(() => {
    // 비활성 탭이면 카운트다운만 (fetch 안 함)
    if (!TabGuard.isVisible) return;
    _countdown--;
    const m = Math.floor(_countdown / 60), s = _countdown % 60;
    const el = document.getElementById("refreshTimer");
    if (el) el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    if (_countdown <= 0) {
      _countdown = REFRESH_SEC;
      // 리더 탭만 실제 데이터 fetch (holdings.json + market.json)
      if (TabGuard.isLeader) refreshMarketData();
    }
  }, 1000);
}

function stopAutoRefresh() {
  if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
}

window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!TabGuard.isVisible) return; // 비활성 탭이면 리사이즈 무시
    Object.values(charts).forEach(c => c.resize());
    if (activeTab === "overview") {
      if (P._tmUSD?.length) renderTreemap("tmUSD", P._tmUSD, fU);
      if (P._tmKRW?.length) renderTreemap("tmKRW", P._tmKRW, fK);
    }
  }, 300);
});

window.addEventListener("DOMContentLoaded", async () => {
  // TabGuard 초기화 — 멀티탭 리소스 충돌 방지
  TabGuard.init({
    onBecomeLeader: () => {
      console.log("[App] 리더 탭 → 데이터 fetch 시작");
      if (P.index) { _countdown = REFRESH_SEC; refreshMarketData(); }
    },
    onLoseLeader: () => {
      console.log("[App] 리더 양보 → fetch 일시 중단");
    },
    onVisibilityChange: (visible) => {
      if (visible) {
        if (activeTab) switchTab(activeTab);
      } else {
        _stopUSTabRefresh();
        _stopKRTabRefresh();
      }
    }
  });

  // 1) holdings.json + market.json 로드
  await loadFromData();
  // 2) 이후 10분 간격으로 market.json 갱신
  startAutoRefresh();
});

// ── Chrome 크래시 방지: SW 완전 초기화 + 캐시 전량 삭제 ──
(async function _initSW() {
  // 1) 기존 SW 전부 해제
  if ('serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        await reg.unregister();
        console.log('[SW] 해제:', reg.scope);
      }
    } catch (e) { console.warn('[SW] 해제 실패:', e); }
  }
  // 2) Cache Storage 전량 삭제
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      for (const k of keys) {
        await caches.delete(k);
        console.log('[Cache] 삭제:', k);
      }
    } catch (e) { console.warn('[Cache] 삭제 실패:', e); }
  }
  // 3) 새 SW 등록 (리더 탭만)
  if ('serviceWorker' in navigator) {
    // SW 등록은 지연 — TabGuard 초기화 후 리더만 등록
    setTimeout(() => {
      if (TabGuard.isLeader) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      }
    }, 2000);
  }
})();
