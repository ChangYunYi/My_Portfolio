/* ═══════════════════════════════════════════════════════
   RISK SENTINEL ENGINE v2 — 미장 / 국장 완전 분리
   ▸ RS_US : 미국 종목 전용 (index + dividend + growth)
   ▸ RS_KR : 국내 종목 전용 (kr)
   ▸ 각 시장 독립 로드 · 상태 · UI 업데이트

   의존: config.js (FHKEY, KR_SECTORS)
         utils.js  (rsSafeId, fU, fK, fP, pc, isETF)
         app.js    (P, activeTab — 전역 상태)
   ═══════════════════════════════════════════════════════ */

const RSW = ms => new Promise(r => setTimeout(r, ms));

// ── 시장별 독립 상태 ──
const RS_US = { data: {}, status: { loading: false, loaded: 0, total: 0, lastUp: null } };
const RS_KR = { data: {}, status: { loading: false, loaded: 0, total: 0, lastUp: null } };


/* ═══════════════════════════════════════════════════════
   IndexedDB 캐시
   ═══════════════════════════════════════════════════════ */

const _rsDB = { inst: null };

function rsOpenDB() {
  return new Promise((res, rej) => {
    if (_rsDB.inst) { res(_rsDB.inst); return; }
    const req = indexedDB.open("PortfolioRiskDB_v2", 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      ['rsUS', 'rsKR'].forEach(n => {
        if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: "k" });
      });
    };
    req.onsuccess = e => { _rsDB.inst = e.target.result; res(_rsDB.inst); };
    req.onerror = e => rej(e.target.error);
  });
}

async function rsDbPut(store, k, v) {
  try {
    const db = await rsOpenDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put({ k, v, ts: Date.now() });
      tx.oncomplete = () => res();
      tx.onerror = e => rej(e);
    });
  } catch (e) { console.warn("rsDbPut", e); }
}

async function rsDbGetAll(store) {
  try {
    const db = await rsOpenDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = e => rej(e);
    });
  } catch (e) { return []; }
}


/* ═══════════════════════════════════════════════════════
   AbortSignal 폴리필
   ═══════════════════════════════════════════════════════ */

function rsAbortSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}


/* ═══════════════════════════════════════════════════════
   데이터 취득 — Yahoo Finance
   ═══════════════════════════════════════════════════════ */

async function rsYahooFetch(sym, range, interval) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval || "1d"}&includePrePost=false`;
  for (const p of [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    `https://corsproxy.io/?${encodeURIComponent(u)}`
  ]) {
    try {
      const r = await fetch(p, { signal: rsAbortSignal(12000) });
      if (r.ok) {
        const j = await r.json();
        if (j?.chart?.result?.[0]) return j;
      }
    } catch {}
  }
  return null;
}

function rsParseCandles(j) {
  try {
    return j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null && !isNaN(v)) || null;
  } catch { return null; }
}

function rsParseQuote(j) {
  try {
    const r = j?.chart?.result?.[0];
    if (!r) return null;
    const m = r.meta, q = r.indicators?.quote?.[0], ts = r.timestamp;
    if (!m || !q || !ts?.length) return null;
    const l = ts.length - 1;
    return { c: m.regularMarketPrice || q.close?.[l], pc: m.chartPreviousClose || m.previousClose, h: q.high?.[l], l: q.low?.[l] };
  } catch { return null; }
}


/* ═══════════════════════════════════════════════════════
   데이터 취득 — Finnhub (US 현재가)
   ═══════════════════════════════════════════════════════ */

async function rsFhQuote(sym) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FHKEY}`, { signal: rsAbortSignal(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.c > 0 || d.h > 0) ? { c: d.c, pc: d.pc, h: d.h, l: d.l } : null;
  } catch { return null; }
}


/* ═══════════════════════════════════════════════════════
   US / KR 시세 + 캔들 취득
   ═══════════════════════════════════════════════════════ */

async function rsUSQuote(sym) {
  const q = await rsFhQuote(sym);
  if (q?.c > 0) return q;
  const j = await rsYahooFetch(sym, "1d", "5m");
  return j ? rsParseQuote(j) : null;
}

async function rsUSCandles(sym) {
  const j = await rsYahooFetch(sym, "2y", "1d");
  return j ? rsParseCandles(j) : null;
}

/** KR 티커를 Yahoo 심볼로 변환 (예: "426030" → "426030.KS") */
function rsKRTicker(t) {
  if (!t) return t;
  t = t.trim();
  if (t.endsWith(".KS") || t.endsWith(".KQ")) return t;
  if (t.startsWith("KRX:")) return t.replace("KRX:", "") + ".KS";
  if (/^[0-9][A-Z0-9]{4,6}$/i.test(t)) return t + ".KS";
  return t;
}

async function rsKRQuote(sym) {
  for (const sfx of [sym, sym.replace(".KS", ".KQ")]) {
    const j = await rsYahooFetch(sfx, "1d", "5m");
    if (j) {
      const q = rsParseQuote(j);
      if (q?.c) {
        q.intraday = rsParseCandles(j);
        return q;
      }
    }
  }
  return null;
}

async function rsKRCandles(sym) {
  for (const sfx of [sym, sym.replace(".KS", ".KQ")]) {
    const j = await rsYahooFetch(sfx, "2y", "1d");
    if (j) { const c = rsParseCandles(j); if (c?.length > 20) return c; }
  }
  return null;
}


/* ═══════════════════════════════════════════════════════
   기술적 지표 계산
   ═══════════════════════════════════════════════════════ */

function rsSMA(c, p) {
  return c.length < p ? null : c.slice(-p).reduce((a, b) => a + b, 0) / p;
}

function rsRSI(c) {
  const p = 14;
  if (c.length < p + 1) return null;
  const r = c.slice(-(p + 1));
  let g = 0, l = 0;
  for (let i = 1; i < r.length; i++) {
    const d = r[i] - r[i - 1];
    d > 0 ? g += d : l -= d;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / p / (l / p));
}

function rsBB(c) {
  const p = 20;
  if (c.length < p) return null;
  const s = c.slice(-p), m = s.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  return { upper: m + 2 * std, middle: m, lower: m - 2 * std };
}

/** 리스크 신호 감지 */
function rsFindRisks(pr, prevClose, ind) {
  const R = [];
  if (!pr || !ind) return R;

  // 급락 감지
  if (prevClose > 0) {
    const ch = ((pr - prevClose) / prevClose) * 100;
    if (ch <= -3) R.push({ type: "DROP", sev: "critical", msg: `일간 ${ch.toFixed(2)}% 급락` });
  }

  // 이동평균선 이탈/터치
  for (const [k, lb] of [["ma50", "50일"], ["ma100", "100일"], ["ma200", "200일"], ["ma300", "300일"]]) {
    const v = ind[k];
    if (v == null) continue;
    const d = ((pr - v) / v) * 100;
    if (Math.abs(d) <= 0.5) R.push({ type: "MA_T", sev: "high", msg: `${lb}선 터치` });
    else if (d < -0.5 && d > -3) R.push({ type: "MA_B", sev: "critical", msg: `${lb}선 이탈(${d.toFixed(1)}%)` });
  }

  // RSI 과매수/과매도
  if (ind.rsi != null) {
    if (ind.rsi >= 75) R.push({ type: "RSI_OB", sev: "medium", msg: `RSI ${ind.rsi.toFixed(0)} 과매수` });
    else if (ind.rsi <= 25) R.push({ type: "RSI_OS", sev: "high", msg: `RSI ${ind.rsi.toFixed(0)} 과매도` });
  }

  // 볼린저밴드
  if (ind.bb) {
    if (pr > ind.bb.upper) R.push({ type: "BB_U", sev: "medium", msg: "BB 상단돌파" });
    if (pr < ind.bb.lower) R.push({ type: "BB_D", sev: "high", msg: "BB 하단이탈" });
  }

  return R;
}


/* ═══════════════════════════════════════════════════════
   단일 종목 처리 + 시장별 독립 로드
   ═══════════════════════════════════════════════════════ */

async function rsProcessOne(mkt, portTicker, isKR) {
  const store = isKR ? RS_KR : RS_US;
  const dbStore = isKR ? "rsKR" : "rsUS";
  store.data[portTicker] = { ...(store.data[portTicker] || {}), loading: true };

  const fetchTicker = isKR ? rsKRTicker(portTicker) : portTicker;
  const q = isKR ? await rsKRQuote(fetchTicker) : await rsUSQuote(fetchTicker);
  await RSW(130);
  const cl = isKR ? await rsKRCandles(fetchTicker) : await rsUSCandles(fetchTicker);
  await RSW(130);

  if (!q || !(q.c > 0)) { store.data[portTicker] = { loading: false, error: true }; return; }

  const pr = q.c, prevClose = q.pc || 0;
  const hasC = cl && cl.length > 20;
  const ind = hasC
    ? { ma50: rsSMA(cl, 50), ma100: rsSMA(cl, 100), ma200: rsSMA(cl, 200), ma300: rsSMA(cl, 300), rsi: rsRSI(cl), bb: rsBB(cl) }
    : { ma50: null, ma100: null, ma200: null, ma300: null, rsi: null, bb: null };

  store.data[portTicker] = {
    loading: false, loaded: true, loadedAt: Date.now(),
    price: pr, prevClose, changePct: prevClose > 0 ? ((pr - prevClose) / prevClose) * 100 : 0,
    closes: hasC ? cl : null, intraday: (isKR && q.intraday?.length > 2) ? q.intraday : null,
    ind, risks: rsFindRisks(pr, prevClose, ind)
  };
  store.status.loaded++;
  rsDbPut(dbStore, portTicker, store.data[portTicker]);

  rsUpdateStatus(mkt);
  if (isKR) {
    if (activeTab === "kr" && typeof _updateKRTableRS === "function") _updateKRTableRS();
  } else {
    if (["index", "dividend", "growth"].includes(activeTab) && typeof _updateUSTableRS === "function") _updateUSTableRS();
  }
}

async function rsLoadUS() {
  if (RS_US.status.loading) return;
  RS_US.status.loading = true;
  RS_US.status.loaded = 0;
  const stocks = [...P.index, ...P.dividend, ...P.growth].filter(h => h.ticker && h.ticker.trim() !== "");
  RS_US.status.total = stocks.length;
  rsUpdateStatus("us");
  for (const h of stocks) await rsProcessOne("us", h.ticker, false);
  RS_US.status.loading = false;
  RS_US.status.lastUp = new Date();
  rsUpdateStatus("us");
  if (["index", "dividend", "growth"].includes(activeTab) && typeof _updateUSTableRS === "function") _updateUSTableRS();
}

async function rsLoadKR() {
  if (RS_KR.status.loading) return;
  RS_KR.status.loading = true;
  RS_KR.status.loaded = 0;
  const stocks = (P.kr || []).filter(h => h.ticker && h.ticker.trim() !== "");
  RS_KR.status.total = stocks.length;
  rsUpdateStatus("kr");
  for (const h of stocks) await rsProcessOne("kr", h.ticker, true);
  RS_KR.status.loading = false;
  RS_KR.status.lastUp = new Date();
  rsUpdateStatus("kr");
  if (activeTab === "kr" && typeof _updateKRTableRS === "function") _updateKRTableRS();
}


/* ═══════════════════════════════════════════════════════
   엔진 시작
   ═══════════════════════════════════════════════════════ */

async function startRSSentinel() {
  if (!P || !P.index || !P.dividend || !P.growth || !P.kr) {
    console.warn("[RS] P 미준비, 500ms 재시도");
    setTimeout(startRSSentinel, 500);
    return;
  }

  // DB 캐시 복원
  const [cachedUS, cachedKR] = await Promise.all([rsDbGetAll("rsUS"), rsDbGetAll("rsKR")]);
  cachedUS.forEach(r => { if (r.k && r.v?.loaded) RS_US.data[r.k] = r.v; });
  cachedKR.forEach(r => { if (r.k && r.v?.loaded) RS_KR.data[r.k] = r.v; });
  if (activeTab === "kr" && typeof _updateKRTableRS === "function") _updateKRTableRS();

  // 양쪽 동시 백그라운드 로딩
  rsLoadUS();
  rsLoadKR();

  // 3분마다 자동 갱신 (2초 오프셋으로 API 충돌 방지)
  setInterval(rsLoadUS, 180000);
  setInterval(rsLoadKR, 182000);

  // 8초마다 UI 점진적 갱신
  setInterval(() => {
    rsUpdateStatus("us");
    rsUpdateStatus("kr");
    if (activeTab === "kr" && typeof _updateKRTableRS === "function") _updateKRTableRS();
    if (["index", "dividend", "growth"].includes(activeTab) && typeof _updateUSTableRS === "function") _updateUSTableRS();
  }, 8000);
}


/* ═══════════════════════════════════════════════════════
   UI — 상태바 업데이트
   ═══════════════════════════════════════════════════════ */

function rsUpdateStatus(mkt) {
  const isUS = mkt === "us";
  const st = isUS ? RS_US.status : RS_KR.status;
  const data = isUS ? RS_US.data : RS_KR.data;
  const el = document.getElementById(isUS ? "rsStatusUS" : "rsStatusKR");
  if (!el) return;

  if (st.loading) {
    el.innerHTML = `<span class="rs-dot-load"></span><span style="font-size:9px;color:var(--amber);font-weight:700">갱신중 ${st.loaded}/${st.total}</span>`;
  } else if (st.lastUp) {
    const hasRisk = Object.values(data).some(d => d.risks?.length > 0);
    const sec = Math.round((Date.now() - st.lastUp.getTime()) / 1000);
    el.innerHTML = `<span class="rs-dot-live"></span><span style="font-size:9px;color:${hasRisk ? "var(--red)" : "var(--green)"};font-weight:700">${hasRisk ? "⚠ 리스크 감지" : "✓ 정상"}</span><span style="font-size:8px;color:var(--mute);margin-left:5px">${st.lastUp.toLocaleTimeString("ko-KR")} (${sec}s전)</span>`;
  }
}


/* ═══════════════════════════════════════════════════════
   UI — 스파크라인 SVG
   ═══════════════════════════════════════════════════════ */

function mkSparkSVG(closes, w, h) {
  w = w || 160; h = h || 28;
  if (!closes || closes.length < 2) return '';
  const d = closes.slice(-40);
  const mn = Math.min(...d) * .998, mx = Math.max(...d) * 1.002, rng = mx - mn || 1;
  const Y = v => 2 + ((mx - v) / rng) * (h - 4);
  const X = i => (i / (d.length - 1)) * w;
  const pts = d.map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const up = d[d.length - 1] >= d[0], c = up ? "#2ee0a8" : "#ff6b78";
  const gid = `rsg${w}x${h}`;
  return `<svg width="${w}" height="${h}" style="display:block"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${c}" stop-opacity=".15"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></linearGradient></defs><path d="${pts} L${w},${h} L0,${h} Z" fill="url(#${gid})"/><path d="${pts}" fill="none" stroke="${c}" stroke-width="1.6"/><circle cx="${X(d.length - 1)}" cy="${Y(d[d.length - 1])}" r="2.5" fill="${c}"/></svg>`;
}


/* ═══════════════════════════════════════════════════════
   UI — 리스크 배지 HTML
   ═══════════════════════════════════════════════════════ */

function mkRiskBadgesHTML(risks) {
  if (!risks?.length) return '';
  const cls = { critical: "rs-crit", high: "rs-high", medium: "rs-med" };
  return risks.slice(0, 2).map(r =>
    `<span class="rs-badge ${cls[r.sev] || 'rs-med'}">${r.msg.length > 13 ? r.msg.slice(0, 13) + "…" : r.msg}</span>`
  ).join("") + (risks.length > 2 ? `<span style="font-size:7px;color:var(--mute)"> +${risks.length - 2}</span>` : "");
}


/* ═══════════════════════════════════════════════════════
   상세 팝업 — 큰 차트 SVG
   ═══════════════════════════════════════════════════════ */

function mkBigChartSVG(closes, maLines, bb, w, h, fmtShort) {
  w = w || 560; h = h || 180;
  if (!closes || closes.length < 5) return '<div style="text-align:center;padding:40px;color:var(--mute);font-size:12px">차트 데이터 없음</div>';
  const d = closes.slice(-252);

  // ma키 숫자값만 추출 (rsi/bb 오브젝트 제외)
  const maOnly = {};
  if (maLines) Object.entries(maLines).forEach(([k, v]) => {
    if (k.startsWith('ma') && typeof v === 'number' && v > 0) maOnly[k] = v;
  });

  // 전체 값 범위 계산 (ma숫자값만 포함)
  const allV = [...d];
  Object.values(maOnly).forEach(v => allV.push(v));
  if (bb && typeof bb.upper === 'number' && typeof bb.lower === 'number') {
    allV.push(bb.upper, bb.lower);
  }

  const mn = Math.min(...allV) * .997, mx = Math.max(...allV) * 1.003, rng = mx - mn || 1;
  if (!isFinite(mn) || !isFinite(mx)) {
    return '<div style="text-align:center;padding:40px;color:var(--mute);font-size:12px">차트 스케일 오류</div>';
  }

  const pL = 56, pR = 18, pT = 10, pB = 6, cw = w - pL - pR, ch = h - pT - pB;
  const Y = v => pT + ((mx - v) / rng) * ch;
  const X = i => pL + (i / (d.length - 1)) * cw;
  const pts = d.map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const up = d[d.length - 1] >= d[0], clr = up ? "#2ee0a8" : "#ff6b78";
  const maC = { ma50: "#4d9aff", ma100: "#ae82ff", ma200: "#ffc05c", ma300: "#ff6bb5" };
  const maLb = { ma50: "50D", ma100: "100D", ma200: "200D", ma300: "300D" };
  let els = "";

  // 그리드 라인 + Y축 레이블
  for (let i = 0; i <= 4; i++) {
    const v = mx - (rng / 4) * i;
    els += `<line x1="${pL}" y1="${Y(v).toFixed(1)}" x2="${w - pR}" y2="${Y(v).toFixed(1)}" stroke="#1e293b" stroke-width=".5"/>`;
    els += `<text x="${pL - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" fill="#5e82a8" font-size="9" font-family="monospace">${String(fmtShort(v))}</text>`;
  }

  // BB 영역
  if (bb && typeof bb.upper === 'number' && typeof bb.lower === 'number') {
    const yu = Y(bb.upper), yl = Y(bb.lower);
    if (yu < yl) {
      els += `<rect x="${pL}" y="${yu.toFixed(1)}" width="${cw}" height="${(yl - yu).toFixed(1)}" fill="rgba(234,179,8,.06)"/>`;
      els += `<line x1="${pL}" y1="${yu.toFixed(1)}" x2="${w - pR}" y2="${yu.toFixed(1)}" stroke="#eab308" stroke-width=".7" stroke-dasharray="4,3" opacity=".5"/>`;
      els += `<line x1="${pL}" y1="${yl.toFixed(1)}" x2="${w - pR}" y2="${yl.toFixed(1)}" stroke="#eab308" stroke-width=".7" stroke-dasharray="4,3" opacity=".5"/>`;
    }
  }

  // 이동평균선
  Object.entries(maOnly).forEach(([k, v]) => {
    if (v < mn || v > mx) return;
    els += `<line x1="${pL}" y1="${Y(v).toFixed(1)}" x2="${w - pR}" y2="${Y(v).toFixed(1)}" stroke="${maC[k]}" stroke-width="1.1" stroke-dasharray="6,3" opacity=".65"/>`;
    els += `<text x="${w - pR + 3}" y="${(Y(v) + 3).toFixed(1)}" fill="${maC[k]}" font-size="8" font-family="monospace" font-weight="700">${maLb[k]}</text>`;
  });

  // 가격선 + 그라디언트
  const gid = `bc${Math.random().toString(36).slice(2, 6)}`;
  els += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${clr}" stop-opacity=".18"/><stop offset="100%" stop-color="${clr}" stop-opacity="0"/></linearGradient></defs>`;
  els += `<path d="${pts} L${X(d.length - 1).toFixed(1)},${(h - pB).toFixed(1)} L${pL},${(h - pB).toFixed(1)} Z" fill="url(#${gid})"/>`;
  els += `<path d="${pts}" fill="none" stroke="${clr}" stroke-width="2"/>`;
  els += `<circle cx="${X(d.length - 1).toFixed(1)}" cy="${Y(d[d.length - 1]).toFixed(1)}" r="4" fill="${clr}" stroke="#0d1525" stroke-width="2"/>`;

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">${els}</svg>`;
}


/* ═══════════════════════════════════════════════════════
   상세 팝업 — rsShowDetail(ticker, isKR)
   ═══════════════════════════════════════════════════════ */

function rsShowDetail(ticker, isKR) {
  document.getElementById("rsDetailOverlay")?.remove();

  const store = isKR ? RS_KR : RS_US;
  const d = store.data[ticker];
  const portList = isKR ? P.kr : [...P.index, ...P.dividend, ...P.growth];
  const portItem = portList.find(h => h.ticker === ticker) || {};

  const dispTicker = ticker.startsWith("KRX:") ? ticker.replace("KRX:", "") : ticker;
  const name = portItem.name || dispTicker;
  const hasData = d?.loaded;
  const price = d?.price;
  const up = (d?.changePct || 0) >= 0;
  const clr = up ? "var(--green)" : "var(--red)";
  const priceFmt = isKR ? (v => "₩" + Math.round(v).toLocaleString("ko-KR")) : (v => "$" + v.toFixed(2));
  const shortFmt = isKR ? (v => "₩" + (Math.round(v / 100) * 100).toLocaleString("ko-KR")) : (v => "$" + v.toFixed(0));
  const sevColor = { critical: "#ef4444", high: "#f97316", medium: "#eab308", low: "#2ee0a8" };
  const sevLabel = { critical: "CRITICAL", high: "HIGH", medium: "MEDIUM", low: "LOW" };
  const sevBorderL = { critical: "#ef4444", high: "#f97316", medium: "#eab308", low: "#334155" };

  function indCell(label, val, color) {
    return `<div class="rs-ind-cell"><div class="rs-ind-label">${label}</div><div class="rs-ind-val" style="color:${color || "var(--txt2)"}">${val != null ? val : "—"}</div></div>`;
  }

  const ind = d?.ind || {};
  const rsiColor = ind.rsi >= 70 ? "#ef4444" : ind.rsi <= 30 ? "#2ee0a8" : "var(--txt2)";

  const riskRows = (d?.risks || []).map(r => `
    <div class="rs-risk-row" style="border-left:3px solid ${sevBorderL[r.sev] || "#334155"}">
      <span style="font-size:8px;font-weight:800;color:${sevColor[r.sev]};min-width:54px">${sevLabel[r.sev]}</span>
      <span style="font-size:12px;color:var(--txt2)">${r.msg}</span>
    </div>`).join("");

  const portCells = [
    { l: "보유수량", v: portItem.qty ? (isKR ? portItem.qty + "주" : portItem.qty % 1 ? portItem.qty.toFixed(2) + "주" : portItem.qty + "주") : "—", c: "var(--txt)" },
    { l: "평균단가", v: portItem.avg ? priceFmt(portItem.avg) : "—", c: "var(--sub)" },
    { l: "평가금액", v: portItem.val ? (isKR ? fK(portItem.val) : fU(Math.round(portItem.val))) : "—", c: "var(--txt)" },
    { l: "수익률", v: portItem.plp != null ? fP(portItem.plp) : "—", c: portItem.plp >= 0 ? "var(--green)" : "var(--red)" },
    { l: "배당수익률", v: portItem.divY > 0 ? portItem.divY.toFixed(2) + "%" : "—", c: "var(--green)" },
    { l: "MDD", v: portItem.mdd != null ? portItem.mdd.toFixed(1) + "%" : "—", c: Math.abs(portItem.mdd || 0) >= 10 ? "var(--red)" : Math.abs(portItem.mdd || 0) >= 5 ? "var(--amber)" : "var(--green)" },
  ].map(x => `<div class="rs-port-cell"><div style="font-size:8px;color:var(--mute);font-weight:700;margin-bottom:4px">${x.l}</div><div style="font-size:13px;font-weight:800;color:${x.c}">${x.v}</div></div>`).join("");

  const overlay = document.createElement("div");
  overlay.className = "rs-overlay";
  overlay.id = "rsDetailOverlay";
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
  <div class="rs-popup" onclick="event.stopPropagation()">
    <div class="rs-popup-head">
      <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
        <div style="min-width:0">
          <div style="font-size:16px;font-weight:900;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
          <div style="font-size:10px;color:var(--sub);margin-top:2px;font-family:monospace">${dispTicker}${isKR ? " · KRX" : ""}</div>
        </div>
        ${hasData && price ? `
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:22px;font-weight:900;color:${clr};font-family:monospace;line-height:1">${priceFmt(price)}</div>
          <div style="font-size:11px;color:${clr};font-weight:700;margin-top:2px">${up ? "▲" : "▼"}${Math.abs(d.changePct || 0).toFixed(2)}%</div>
        </div>` : ""}
      </div>
      <button class="rs-popup-close" onclick="document.getElementById('rsDetailOverlay').remove()">✕</button>
    </div>
    <div class="rs-popup-body">
      ${hasData && d.closes ? `
      <div style="background:var(--s1);border-radius:10px;padding:12px 8px 6px;margin-bottom:14px;border:1px solid var(--bdr)">
        ${mkBigChartSVG(d.closes, d.ind, d.ind?.bb, 560, 175, shortFmt)}
        <div style="display:flex;gap:12px;justify-content:center;margin-top:8px;flex-wrap:wrap">
          ${[["50D", "#4d9aff"], ["100D", "#ae82ff"], ["200D", "#ffc05c"], ["300D", "#ff6bb5"], ["BB", "#eab308"]].map(([l, c]) => `
          <div style="display:flex;align-items:center;gap:4px">
            <div style="width:14px;height:2px;background:${c};opacity:.8"></div>
            <span style="font-size:8px;color:var(--mute)">${l}</span>
          </div>`).join("")}
        </div>
      </div>` : `
      <div style="background:var(--s1);border-radius:10px;padding:28px;text-align:center;margin-bottom:14px;color:var(--mute);font-size:12px">
        ${d?.loading ? "📡 차트 데이터 로딩 중..." : d?.error ? "⚠ 데이터를 불러올 수 없습니다" : "📡 데이터 대기 중..."}
      </div>`}

      ${d?.risks?.length ? `
      <div style="margin-bottom:14px">
        <div style="font-size:10px;font-weight:800;color:var(--red);letter-spacing:.5px;margin-bottom:8px">⚠ 감지된 리스크 신호 (${d.risks.length}개)</div>
        ${riskRows}
      </div>` : (hasData ? `<div style="padding:10px 14px;background:rgba(46,224,168,.07);border-radius:8px;border:1px solid rgba(46,224,168,.18);color:var(--green);font-size:12px;font-weight:700;margin-bottom:14px;text-align:center">✓ 현재 감지된 리스크 신호 없음</div>` : "")}

      <div style="margin-bottom:14px">
        <div style="font-size:10px;font-weight:800;color:var(--mute);letter-spacing:.5px;margin-bottom:8px">기술적 지표</div>
        <div class="rs-ind-grid">
          ${indCell("현재가", hasData ? priceFmt(price) : null, clr)}
          ${indCell("전일종가", hasData && d.prevClose ? priceFmt(d.prevClose) : null, "var(--sub)")}
          ${indCell("RSI(14)", ind.rsi != null ? ind.rsi.toFixed(1) : null, rsiColor)}
          ${indCell("50일선", ind.ma50 != null ? shortFmt(ind.ma50) : null, "#4d9aff")}
          ${indCell("100일선", ind.ma100 != null ? shortFmt(ind.ma100) : null, "#ae82ff")}
          ${indCell("200일선", ind.ma200 != null ? shortFmt(ind.ma200) : null, "#ffc05c")}
          ${indCell("300일선", ind.ma300 != null ? shortFmt(ind.ma300) : null, "#ff6bb5")}
          ${indCell("BB상단", ind.bb?.upper != null ? shortFmt(ind.bb.upper) : null, "#eab308")}
          ${indCell("BB중심", ind.bb?.middle != null ? shortFmt(ind.bb.middle) : null, "#eab308")}
          ${indCell("BB하단", ind.bb?.lower != null ? shortFmt(ind.bb.lower) : null, "#eab308")}
          ${indCell("BB(20)", portItem.bb20 || null, "var(--txt2)")}
          ${indCell("BB(252)", portItem.bb252 || null, "var(--txt2)")}
        </div>
      </div>

      ${portItem.qty ? `
      <div>
        <div style="font-size:10px;font-weight:800;color:var(--mute);letter-spacing:.5px;margin-bottom:8px">포트폴리오 현황</div>
        <div class="rs-port-grid">${portCells}</div>
      </div>` : ""}

      <div style="margin-top:16px;text-align:center;font-size:9px;color:var(--mute)">
        ${d?.loadedAt ? `마지막 업데이트: ${new Date(d.loadedAt).toLocaleString("ko-KR")}` : "데이터 미수신"}
        · 클릭 외부 또는 ✕ 버튼으로 닫기
      </div>
    </div>
  </div>`;

  document.body.appendChild(overlay);
}
