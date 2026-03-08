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

// ── Sentinel 타이머 관리 (중복 방지) ──
let _rsSentinelStarted = false;
const _rsIntervals = [];


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

async function rsDbDel(store, k) {
  try {
    const db = await rsOpenDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(k);
      tx.oncomplete = () => res();
      tx.onerror = e => rej(e);
    });
  } catch (e) { console.warn("rsDbDel", e); }
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
      if (!r.ok) { r.body?.cancel().catch(() => {}); continue; } // body 해제로 연결 정리
      const j = await r.json();
      if (j?.chart?.result?.[0]) return j;
    } catch {}
  }
  return null;
}

function rsParseCandles(j) {
  try {
    return j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null && !isNaN(v)) || null;
  } catch { return null; }
}

/** OHLCV 전체 파싱 — 기술적 지표 계산용 */
function rsParseOHLCV(j) {
  try {
    const r = j?.chart?.result?.[0];
    if (!r) return null;
    const q = r.indicators?.quote?.[0];
    if (!q) return null;
    const len = q.close?.length || 0;
    const bars = [];
    for (let i = 0; i < len; i++) {
      const c = q.close?.[i], h = q.high?.[i], l = q.low?.[i], o = q.open?.[i], v = q.volume?.[i];
      if (c != null && !isNaN(c)) bars.push({ o: o || c, h: h || c, l: l || c, c, v: v || 0 });
    }
    return bars.length > 20 ? bars : null;
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
    if (!r.ok) { r.body?.cancel().catch(() => {}); return null; }
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
  if (!j) return { closes: null, ohlcv: null };
  return { closes: rsParseCandles(j), ohlcv: rsParseOHLCV(j) };
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
    if (j) {
      const c = rsParseCandles(j);
      if (c?.length > 20) return { closes: c, ohlcv: rsParseOHLCV(j) };
    }
  }
  return { closes: null, ohlcv: null };
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

/** EMA 계산 (내부 헬퍼) */
function rsEMA(arr, p) {
  if (!arr || arr.length < p) return [];
  const k = 2 / (p + 1);
  const ema = [arr.slice(0, p).reduce((a, b) => a + b, 0) / p];
  for (let i = p; i < arr.length; i++) ema.push(arr[i] * k + ema[ema.length - 1] * (1 - k));
  return ema;
}

/** MACD (12,26,9) */
function rsMACD(closes) {
  if (!closes || closes.length < 35) return null;
  const e12 = rsEMA(closes, 12), e26 = rsEMA(closes, 26);
  const offset = e12.length - e26.length;
  const macdLine = [];
  for (let i = 0; i < e26.length; i++) macdLine.push(e12[i + offset] - e26[i]);
  const signal = rsEMA(macdLine, 9);
  const hLen = signal.length;
  if (hLen < 1) return null;
  const ml = macdLine[macdLine.length - 1];
  const sl = signal[signal.length - 1];
  const hist = ml - sl;
  const prevHist = macdLine.length >= 2 && signal.length >= 2
    ? macdLine[macdLine.length - 2] - signal[signal.length - 2] : null;
  return { macd: ml, signal: sl, hist, prevHist };
}

/** 스토캐스틱 (%K 14, %D 3) */
function rsStochastic(ohlcv) {
  if (!ohlcv || ohlcv.length < 17) return null;
  const p = 14, dp = 3;
  const kVals = [];
  for (let i = p - 1; i < ohlcv.length; i++) {
    const slice = ohlcv.slice(i - p + 1, i + 1);
    const hh = Math.max(...slice.map(b => b.h));
    const ll = Math.min(...slice.map(b => b.l));
    kVals.push(hh === ll ? 50 : ((ohlcv[i].c - ll) / (hh - ll)) * 100);
  }
  if (kVals.length < dp) return null;
  const dVals = [];
  for (let i = dp - 1; i < kVals.length; i++) {
    dVals.push(kVals.slice(i - dp + 1, i + 1).reduce((a, b) => a + b, 0) / dp);
  }
  const k = kVals[kVals.length - 1];
  const d = dVals[dVals.length - 1];
  const prevK = kVals.length >= 2 ? kVals[kVals.length - 2] : null;
  const prevD = dVals.length >= 2 ? dVals[dVals.length - 2] : null;
  return { k, d, prevK, prevD };
}

/** OBV (On Balance Volume) */
function rsOBV(ohlcv) {
  if (!ohlcv || ohlcv.length < 20) return null;
  let obv = 0;
  const obvArr = [0];
  for (let i = 1; i < ohlcv.length; i++) {
    if (ohlcv[i].c > ohlcv[i - 1].c) obv += ohlcv[i].v;
    else if (ohlcv[i].c < ohlcv[i - 1].c) obv -= ohlcv[i].v;
    obvArr.push(obv);
  }
  // OBV 추세: 최근 20일 OBV SMA vs 현재 OBV
  const recent = obvArr.slice(-20);
  const obvSma = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { current: obv, sma20: obvSma, trend: obv > obvSma ? "up" : "down" };
}

/** 거래량 이동평균 (20일) 대비 현재 거래량 비율 */
function rsVolMA(ohlcv) {
  if (!ohlcv || ohlcv.length < 21) return null;
  const vols = ohlcv.map(b => b.v);
  const avg20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const last = vols[vols.length - 1];
  return avg20 > 0 ? { vol: last, avg20, ratio: last / avg20 } : null;
}

/** 데드크로스/골든크로스 감지 (50일/200일 MA 기반, 최근 5일 이내 발생) */
function rsCrossDetect(closes) {
  if (!closes || closes.length < 205) return null;
  // 최근 6일 간 50MA/200MA 계산
  const results = [];
  for (let d = 0; d < 6; d++) {
    const end = closes.length - d;
    const ma50 = closes.slice(end - 50, end).reduce((a, b) => a + b, 0) / 50;
    const ma200 = closes.slice(end - 200, end).reduce((a, b) => a + b, 0) / 200;
    results.push({ ma50, ma200 });
  }
  // 현재 상태
  const now = results[0], prev = results[1];
  if (now.ma50 < now.ma200 && prev.ma50 >= prev.ma200)
    return { type: "dead", msg: "데드크로스 발생 (50MA↓200MA)" };
  if (now.ma50 > now.ma200 && prev.ma50 <= prev.ma200)
    return { type: "golden", msg: "골든크로스 발생 (50MA↑200MA)" };
  if (now.ma50 < now.ma200)
    return { type: "bearish", msg: "데드크로스 구간 (50MA < 200MA)" };
  return null;
}

/** 차트 패턴 감지 (간소화된 피크/밸리 기반) */
function rsPatternDetect(closes) {
  if (!closes || closes.length < 60) return [];
  const patterns = [];
  const d = closes.slice(-60);

  // 피크/밸리 찾기 (±2일 로컬 극값)
  const peaks = [], valleys = [];
  for (let i = 2; i < d.length - 2; i++) {
    if (d[i] > d[i - 1] && d[i] > d[i - 2] && d[i] > d[i + 1] && d[i] > d[i + 2]) peaks.push({ i, v: d[i] });
    if (d[i] < d[i - 1] && d[i] < d[i - 2] && d[i] < d[i + 1] && d[i] < d[i + 2]) valleys.push({ i, v: d[i] });
  }

  // 더블탑: 최근 2개 피크가 비슷한 높이 (2% 이내), 사이에 밸리
  if (peaks.length >= 2) {
    const [p1, p2] = peaks.slice(-2);
    const diff = Math.abs(p1.v - p2.v) / Math.max(p1.v, p2.v);
    const midValley = valleys.find(v => v.i > p1.i && v.i < p2.i);
    if (diff < 0.02 && midValley && d[d.length - 1] < p2.v * 0.98) {
      patterns.push({ type: "DOUBLE_TOP", sev: "high", msg: "더블탑 패턴 감지" });
    }
  }

  // 헤드앤숄더: 3개 피크 중 가운데가 가장 높고, 양쪽 어깨가 비슷
  if (peaks.length >= 3) {
    const [s1, head, s2] = peaks.slice(-3);
    if (head.v > s1.v && head.v > s2.v) {
      const shoulderDiff = Math.abs(s1.v - s2.v) / Math.max(s1.v, s2.v);
      if (shoulderDiff < 0.03 && d[d.length - 1] < s2.v * 0.98) {
        patterns.push({ type: "HEAD_SHOULDERS", sev: "critical", msg: "헤드앤숄더 패턴 감지" });
      }
    }
  }

  // 갭다운: 최근 5일 내 전일 저가 > 당일 고가인 하락 갭
  const recent = closes.slice(-6);
  for (let i = 1; i < recent.length; i++) {
    // 간이 갭 감지: 전일 대비 -2% 이상 하락 시작
    if (i >= 1 && recent[i] < recent[i - 1] * 0.98) {
      patterns.push({ type: "GAP_DOWN", sev: "high", msg: "하락 갭 감지" });
      break;
    }
  }

  return patterns;
}

/** 리스크 신호 감지 (확장) */
function rsFindRisks(pr, prevClose, ind) {
  const R = [];
  if (!pr || !ind) return R;

  // ── 급락 감지 ──
  if (prevClose > 0) {
    const ch = ((pr - prevClose) / prevClose) * 100;
    if (ch <= -3) R.push({ type: "DROP", sev: "critical", msg: `일간 ${ch.toFixed(2)}% 급락` });
  }

  // ── 이동평균선 이탈/터치 ──
  for (const [k, lb] of [["ma50", "50일"], ["ma100", "100일"], ["ma200", "200일"], ["ma300", "300일"]]) {
    const v = ind[k];
    if (v == null) continue;
    const d = ((pr - v) / v) * 100;
    if (Math.abs(d) <= 0.5) R.push({ type: "MA_T", sev: "high", msg: `${lb}선 터치` });
    else if (d < -0.5 && d > -3) R.push({ type: "MA_B", sev: "critical", msg: `${lb}선 이탈(${d.toFixed(1)}%)` });
  }

  // ── RSI 과매수/과매도 + 다이버전스 ──
  if (ind.rsi != null) {
    if (ind.rsi >= 70) R.push({ type: "RSI_OB", sev: "medium", msg: `RSI ${ind.rsi.toFixed(0)} 과매수` });
    else if (ind.rsi <= 30) R.push({ type: "RSI_OS", sev: "high", msg: `RSI ${ind.rsi.toFixed(0)} 과매도` });
  }

  // ── 볼린저밴드 ──
  if (ind.bb) {
    if (pr > ind.bb.upper) R.push({ type: "BB_U", sev: "medium", msg: "BB 상단돌파" });
    if (pr < ind.bb.lower) R.push({ type: "BB_D", sev: "high", msg: "BB 하단이탈" });
  }

  // ── MACD ──
  if (ind.macd) {
    const m = ind.macd;
    // 시그널선 하향 돌파 (bearish crossover)
    if (m.prevHist != null && m.prevHist > 0 && m.hist <= 0)
      R.push({ type: "MACD_BEAR", sev: "high", msg: "MACD 시그널 하향돌파" });
    // 히스토그램 축소 (약세 전환 경고)
    if (m.prevHist != null && m.hist > 0 && m.hist < m.prevHist * 0.5)
      R.push({ type: "MACD_WEAK", sev: "medium", msg: "MACD 히스토그램 급축소" });
  }

  // ── 스토캐스틱 ──
  if (ind.stoch) {
    const s = ind.stoch;
    if (s.k > 80 && s.d > 80)
      R.push({ type: "STOCH_OB", sev: "medium", msg: `스토캐스틱 과매수 (K:${s.k.toFixed(0)})` });
    else if (s.k < 20 && s.d < 20)
      R.push({ type: "STOCH_OS", sev: "high", msg: `스토캐스틱 과매도 (K:${s.k.toFixed(0)})` });
    // %K가 %D 하향 돌파
    if (s.prevK != null && s.prevD != null && s.prevK > s.prevD && s.k <= s.d)
      R.push({ type: "STOCH_CROSS", sev: "high", msg: "%K↓%D 하향돌파" });
  }

  // ── OBV 다이버전스 ──
  if (ind.obv && prevClose > 0) {
    const priceUp = pr > prevClose;
    if (priceUp && ind.obv.trend === "down")
      R.push({ type: "OBV_DIV", sev: "high", msg: "OBV 다이버전스 (가격↑ OBV↓)" });
  }

  // ── 거래량 급증 (하락 시) ──
  if (ind.volMA && prevClose > 0) {
    const priceDown = pr < prevClose;
    if (priceDown && ind.volMA.ratio > 2.0)
      R.push({ type: "VOL_SPIKE", sev: "high", msg: `하락+거래량 ${ind.volMA.ratio.toFixed(1)}배 급증` });
  }

  // ── VIX (시장 레벨) ──
  if (RS_MARKET.vix?.value > 30)
    R.push({ type: "VIX_HIGH", sev: "critical", msg: `VIX ${RS_MARKET.vix.value.toFixed(1)} 극도공포` });
  else if (RS_MARKET.vix?.value > 25)
    R.push({ type: "VIX_WARN", sev: "medium", msg: `VIX ${RS_MARKET.vix.value.toFixed(1)} 경계` });

  // ── 데드크로스/골든크로스 ──
  if (ind.cross) {
    if (ind.cross.type === "dead")
      R.push({ type: "DEAD_X", sev: "critical", msg: ind.cross.msg });
    else if (ind.cross.type === "bearish")
      R.push({ type: "BEAR_ZONE", sev: "high", msg: ind.cross.msg });
  }

  // ── 차트 패턴 ──
  if (ind.patterns?.length) {
    ind.patterns.forEach(p => R.push(p));
  }

  return R;
}


/* ═══════════════════════════════════════════════════════
   시장 레벨 지표 — VIX (^VIX)
   ═══════════════════════════════════════════════════════ */

const RS_MARKET = { vix: null, vixLoading: false };

async function rsLoadVIX() {
  if (RS_MARKET.vixLoading) return;
  RS_MARKET.vixLoading = true;
  try {
    const j = await rsYahooFetch("^VIX", "5d", "1d");
    if (j) {
      const q = rsParseQuote(j);
      if (q?.c > 0) RS_MARKET.vix = { value: q.c, prevClose: q.pc || 0, ts: Date.now() };
    }
  } catch {}
  RS_MARKET.vixLoading = false;
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
  const candleResult = isKR ? await rsKRCandles(fetchTicker) : await rsUSCandles(fetchTicker);
  await RSW(130);

  if (!q || !(q.c > 0)) { store.data[portTicker] = { loading: false, error: true }; return; }

  const pr = q.c, prevClose = q.pc || 0;
  const cl = candleResult?.closes;
  const ohlcv = candleResult?.ohlcv;
  const hasC = cl && cl.length > 20;
  const ind = hasC
    ? {
        ma50: rsSMA(cl, 50), ma100: rsSMA(cl, 100), ma200: rsSMA(cl, 200), ma300: rsSMA(cl, 300),
        rsi: rsRSI(cl), bb: rsBB(cl),
        macd: rsMACD(cl),
        stoch: ohlcv ? rsStochastic(ohlcv) : null,
        obv: ohlcv ? rsOBV(ohlcv) : null,
        volMA: ohlcv ? rsVolMA(ohlcv) : null,
        cross: rsCrossDetect(cl),
        patterns: rsPatternDetect(cl)
      }
    : { ma50: null, ma100: null, ma200: null, ma300: null, rsi: null, bb: null, macd: null, stoch: null, obv: null, volMA: null, cross: null, patterns: [] };

  store.data[portTicker] = {
    loading: false, loaded: true, loadedAt: Date.now(),
    price: pr, prevClose, changePct: prevClose > 0 ? ((pr - prevClose) / prevClose) * 100 : 0,
    closes: hasC ? cl.slice(-252) : null,  // 차트용 최근 1년만 보존 (메모리 절약, ohlcv 미저장)
    intraday: (isKR && q.intraday?.length > 2) ? q.intraday : null,
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

/** US → KR 직렬 로딩 (동시 fetch 폭주 방지) */
let _rsSeqRunning = false;
async function _rsLoadSequential() {
  if (_rsSeqRunning) return;
  _rsSeqRunning = true;
  try {
    await rsLoadUS();
    await rsLoadKR();
  } finally { _rsSeqRunning = false; }
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

let _rsRetryCount = 0;
async function startRSSentinel() {
  if (!P || !P.index || !P.dividend || !P.growth || !P.kr) {
    if (++_rsRetryCount > 10) { console.error("[RS] P 로드 실패, 재시도 중단"); return; }
    console.warn("[RS] P 미준비, 500ms 재시도 (" + _rsRetryCount + "/10)");
    setTimeout(startRSSentinel, 500);
    return;
  }
  _rsRetryCount = 0;

  // 이미 시작된 경우 데이터만 재로드 (타이머 중복 방지)
  if (_rsSentinelStarted) {
    console.log("[RS] 이미 실행중, 데이터만 재로드");
    rsLoadVIX();
    _rsLoadSequential();
    return;
  }
  _rsSentinelStarted = true;

  // DB 캐시 복원 (1시간 이내 데이터만, 오래된 항목은 삭제)
  const _cacheMaxAge = 3600000; // 1시간
  const [cachedUS, cachedKR] = await Promise.all([rsDbGetAll("rsUS"), rsDbGetAll("rsKR")]);
  cachedUS.forEach(r => {
    if (r.k && r.v?.loaded && r.ts && (Date.now() - r.ts < _cacheMaxAge)) {
      RS_US.data[r.k] = r.v;
    } else if (r.k) { rsDbDel("rsUS", r.k); }
  });
  cachedKR.forEach(r => {
    if (r.k && r.v?.loaded && r.ts && (Date.now() - r.ts < _cacheMaxAge)) {
      RS_KR.data[r.k] = r.v;
    } else if (r.k) { rsDbDel("rsKR", r.k); }
  });
  if (activeTab === "kr" && typeof _updateKRTableRS === "function") _updateKRTableRS();

  // VIX + 직렬 로딩 (US→KR 순차, 동시 fetch 폭주 방지)
  rsLoadVIX();
  _rsLoadSequential();

  // VIX 10분마다 갱신
  _rsIntervals.push(setInterval(rsLoadVIX, 600000));

  // 장중 3분 / 장외 30분 적응형 갱신 (US+KR 직렬, 단일 스케줄러)
  let _rsRefreshId = null;
  function _scheduleRefresh() {
    if (_rsRefreshId) clearTimeout(_rsRefreshId);
    const now = new Date(), utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const et = new Date(utc - 5 * 3600000);
    const kst = new Date(utc + 9 * 3600000);
    const usOpen = et.getDay() >= 1 && et.getDay() <= 5 && (et.getHours() * 100 + et.getMinutes()) >= 930 && (et.getHours() * 100 + et.getMinutes()) <= 1600;
    const krOpen = kst.getDay() >= 1 && kst.getDay() <= 5 && (kst.getHours() * 100 + kst.getMinutes()) >= 900 && (kst.getHours() * 100 + kst.getMinutes()) <= 1530;
    const anyOpen = usOpen || krOpen;
    const delay = anyOpen ? 180000 : 1800000; // 장중 3분, 장외 30분
    _rsRefreshId = setTimeout(async () => {
      await _rsLoadSequential();
      _scheduleRefresh();
    }, delay);
  }
  _scheduleRefresh();

  // 15초마다 상태바만 갱신 (탭별 테이블 갱신은 app.js에서 담당)
  _rsIntervals.push(setInterval(() => {
    rsUpdateStatus("us");
    rsUpdateStatus("kr");
  }, 15000));
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
  const macdColor = ind.macd ? (ind.macd.hist > 0 ? "#2ee0a8" : "#ef4444") : "var(--txt2)";
  const stochColor = ind.stoch ? (ind.stoch.k > 80 ? "#ef4444" : ind.stoch.k < 20 ? "#2ee0a8" : "var(--txt2)") : "var(--txt2)";
  const obvColor = ind.obv ? (ind.obv.trend === "up" ? "#2ee0a8" : "#ef4444") : "var(--txt2)";
  const crossColor = ind.cross ? (ind.cross.type === "dead" || ind.cross.type === "bearish" ? "#ef4444" : "#2ee0a8") : "var(--txt2)";

  const riskDesc = {
    DROP: "하루 만에 3% 이상 급락한 상태로, 악재·공매도·패닉셀 가능성이 있습니다. 추가 하락 여부를 확인하세요.",
    MA_T: "주가가 이동평균선에 근접한 상태입니다. 지지 또는 저항으로 작용할 수 있어 방향 전환 가능성이 있습니다.",
    MA_B: "주가가 이동평균선 아래로 이탈했습니다. 추세 약화 신호로, 하락 지속 가능성에 유의하세요.",
    RSI_OB: "RSI가 70 이상으로 과매수 구간입니다. 단기 과열로 조정이 올 수 있습니다.",
    RSI_OS: "RSI가 30 이하로 과매도 구간입니다. 반등 가능성이 있으나 추세적 하락일 수도 있습니다.",
    BB_U: "볼린저밴드 상단을 돌파했습니다. 강한 상승세이나 되돌림 가능성도 있습니다.",
    BB_D: "볼린저밴드 하단을 이탈했습니다. 과매도 상태로 반등 또는 추가 하락에 주의하세요.",
    MACD_BEAR: "MACD가 시그널선을 하향 돌파하여 매도 신호가 발생했습니다. 하락 추세 전환 가능성이 있습니다.",
    MACD_WEAK: "MACD 히스토그램이 급격히 줄어들고 있습니다. 상승 모멘텀이 약화되고 있다는 경고입니다.",
    STOCH_OB: "스토캐스틱이 80 이상 과매수 구간입니다. 단기 고점 부근일 수 있습니다.",
    STOCH_OS: "스토캐스틱이 20 이하 과매도 구간입니다. 바닥 부근일 수 있으나 확인이 필요합니다.",
    STOCH_CROSS: "%K가 %D를 하향 돌파하여 단기 매도 신호가 발생했습니다.",
    OBV_DIV: "가격은 오르는데 거래량 흐름(OBV)은 하락 중입니다. 상승이 허약할 수 있다는 경고입니다.",
    VOL_SPIKE: "하락과 함께 평소 대비 2배 이상 거래량이 폭증했습니다. 투매 또는 큰 매도세가 유입된 신호입니다.",
    VIX_HIGH: "공포지수(VIX)가 30을 초과하여 시장 전체가 극도의 불안 상태입니다.",
    VIX_WARN: "공포지수(VIX)가 25를 초과하여 시장 경계 구간입니다.",
    DEAD_X: "50일 이동평균이 200일 이동평균을 하향 돌파한 강력한 하락 추세 신호입니다.",
    BEAR_ZONE: "50일선이 200일선 아래에 위치한 약세 구간으로, 하락 추세가 지속 중입니다.",
    DOUBLE_TOP: "비슷한 고점이 두 번 형성된 패턴으로, 저항 돌파 실패 시 하락 전환 가능성이 높습니다.",
    HEAD_SHOULDERS: "세 개의 봉우리 중 가운데가 가장 높은 강력한 하락 반전 패턴입니다.",
    GAP_DOWN: "전일 대비 큰 폭의 갭 하락이 발생했습니다. 악재 반영 또는 수급 붕괴 신호일 수 있습니다."
  };

  const riskRows = (d?.risks || []).map((r, idx) => {
    const desc = riskDesc[r.type] || "";
    const tipId = `rstip_${idx}`;
    return `
    <div class="rs-risk-row" style="border-left:3px solid ${sevBorderL[r.sev] || "#334155"}">
      <span style="font-size:8px;font-weight:800;color:${sevColor[r.sev]};min-width:54px">${sevLabel[r.sev]}</span>
      <span style="font-size:12px;color:var(--txt2);flex:1">${r.msg}</span>
      ${desc ? `<span class="rs-tip-btn" data-tip="${tipId}">?</span>
      <div id="${tipId}" class="rs-tip-bubble" style="display:none">${desc}</div>` : ""}
    </div>`;
  }).join("");

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
          ${indCell("MACD", ind.macd ? ind.macd.macd.toFixed(2) : null, macdColor)}
          ${indCell("Signal", ind.macd ? ind.macd.signal.toFixed(2) : null, macdColor)}
          ${indCell("Histogram", ind.macd ? ind.macd.hist.toFixed(2) : null, ind.macd ? (ind.macd.hist > 0 ? "#2ee0a8" : "#ef4444") : "var(--txt2)")}
          ${indCell("%K(14)", ind.stoch ? ind.stoch.k.toFixed(1) : null, stochColor)}
          ${indCell("%D(3)", ind.stoch ? ind.stoch.d.toFixed(1) : null, stochColor)}
          ${indCell("OBV추세", ind.obv ? (ind.obv.trend === "up" ? "▲ 매집" : "▼ 분산") : null, obvColor)}
          ${indCell("거래량비", ind.volMA ? ind.volMA.ratio.toFixed(1) + "x" : null, ind.volMA?.ratio > 2 ? "#ef4444" : ind.volMA?.ratio > 1.5 ? "#eab308" : "var(--txt2)")}
          ${indCell("MA크로스", ind.cross ? (ind.cross.type === "dead" ? "데드" : ind.cross.type === "bearish" ? "약세구간" : ind.cross.type === "golden" ? "골든" : "강세") : null, crossColor)}
          ${indCell("VIX", RS_MARKET.vix ? RS_MARKET.vix.value.toFixed(1) : null, RS_MARKET.vix?.value > 30 ? "#ef4444" : RS_MARKET.vix?.value > 25 ? "#eab308" : "#2ee0a8")}
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

  // 말풍선 토글 이벤트 바인딩
  overlay.querySelectorAll(".rs-tip-btn").forEach(btn => {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      const tipEl = document.getElementById(this.getAttribute("data-tip"));
      if (tipEl) tipEl.style.display = tipEl.style.display === "none" ? "block" : "none";
    });
  });
}
