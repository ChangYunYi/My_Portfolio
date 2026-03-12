/**
 * US 시장 데이터 수집 스크립트
 * GitHub Actions에서 30분마다 실행 → data/market.json 갱신
 *
 * 모드:
 *   - "quote"   (기본): FMP quote + Yahoo chart (30분마다)
 *   - "profile": FMP profile 펀더멘탈 보충 (하루 2회, 0시/12시 UTC)
 *
 * 사용법:
 *   node scripts/fetch-market.js           # quote 모드
 *   node scripts/fetch-market.js profile   # profile 모드
 */
const fs = require("fs");
const path = require("path");

const FMP_KEY = process.env.FMP_API_KEY || "nJmHhWv6XOVTWKGGoLNpiTh0JYUCtbjr";
const MODE = process.argv[2] || "quote";

// ── holdings.json에서 US 티커 추출 ──
function loadTickers() {
  const hp = path.join(__dirname, "..", "data", "holdings.json");
  const h = JSON.parse(fs.readFileSync(hp, "utf8"));
  const tickers = new Set();
  for (const cat of ["index", "dividend", "growth"]) {
    (h.portfolios[cat] || []).forEach(item => {
      if (item.ticker && /[A-Z]/.test(item.ticker)) tickers.add(item.ticker.toUpperCase());
    });
  }
  return [...tickers];
}

// ── HTTP fetch with timeout + retry ──
async function safeFetch(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(ok => setTimeout(ok, 1000 * (i + 1)));
    }
  }
}

// ── FMP: 배치 quote (현재가 + 기본 메트릭) ──
async function fetchFmpQuotes(tickers) {
  const map = {};
  try {
    const symbols = tickers.join(",");
    const data = await safeFetch(
      `https://financialmodelingprep.com/api/v3/quote/${symbols}?apikey=${FMP_KEY}`
    );
    if (Array.isArray(data)) {
      data.forEach(q => {
        map[q.symbol] = {
          price: q.price,
          prevClose: q.previousClose,
          change: q.change,
          changePct: q.changesPercentage,
          dayHigh: q.dayHigh,
          dayLow: q.dayLow,
          volume: q.volume,
          marketCap: q.marketCap,
          per: q.pe,
          eps: q.eps,
          name: q.name,
        };
      });
      console.log(`  [FMP quote] ${data.length} tickers OK`);
    }
  } catch (e) {
    console.warn(`  [FMP quote] FAIL: ${e.message}`);
  }
  return map;
}

// ── FMP: 배치 profile (PBR, ROE, 배당률, 섹터 등) ──
async function fetchFmpProfiles(tickers) {
  const map = {};
  try {
    const symbols = tickers.join(",");
    const data = await safeFetch(
      `https://financialmodelingprep.com/stable/profile?symbol=${symbols}&apikey=${FMP_KEY}`
    );
    if (Array.isArray(data)) {
      data.forEach(p => {
        map[p.symbol] = {
          pbr: p.priceToBook || null,
          roe: p.returnOnEquity || null,
          divYield: p.lastDiv && p.price ? +(p.lastDiv / p.price * 100).toFixed(2) : null,
          sector: p.sector || null,
          industry: p.industry || null,
          beta: p.beta || null,
          isETF: p.isEtf || false,
        };
      });
      console.log(`  [FMP profile] ${data.length} tickers OK`);
    }
  } catch (e) {
    console.warn(`  [FMP profile] FAIL: ${e.message}`);
  }
  return map;
}

// ── Yahoo Finance v8 chart: 60일 히스토리 + 현재가 ──
async function fetchYahooChart(ticker) {
  try {
    // 252거래일 ≈ 1년 (BB252 계산용)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d`;
    const data = await safeFetch(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const closes = q.close || [];
    const volumes = q.volume || [];

    // 히스토리 배열 (날짜, 종가)
    const history = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      history.push({ d, p: +c.toFixed(4), v: volumes[i] || 0 });
    }

    return {
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose || meta.previousClose,
      history,
    };
  } catch (e) {
    console.warn(`  [Yahoo] ${ticker}: ${e.message}`);
    return null;
  }
}

// ── 기술지표 계산 ──

/** RSI (14일) */
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

/** 볼린저밴드 %B (n일) */
function calcBBPct(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  if (std === 0) return 50;
  const cur = prices[prices.length - 1];
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  return +((cur - lower) / (upper - lower) * 100).toFixed(1);
}

/** MDD (최대 낙폭 %) — 최근 252거래일 기준 */
function calcMDD(prices) {
  if (prices.length < 2) return 0;
  const recent = prices.slice(-252);
  let peak = recent[0], maxDD = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > peak) peak = recent[i];
    const dd = (recent[i] - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  }
  return +maxDD.toFixed(2);
}

// ── 공통: 기존 market.json 로드 ──
function loadExisting() {
  const outPath = path.join(__dirname, "..", "data", "market.json");
  try {
    return JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch { return { tickers: {} }; }
}

function saveResult(out) {
  const outPath = path.join(__dirname, "..", "data", "market.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`\nSaved to ${outPath}`);
  console.log(`Updated: ${out.updated}`);
  console.log(`Tickers: ${Object.keys(out.tickers).length}`);
}

// ── quote 모드: FMP quote + Yahoo chart (30분마다) ──
async function runQuote() {
  const tickers = loadTickers();
  console.log(`[quote] ${tickers.length} US tickers: ${tickers.join(", ")}`);

  const old = loadExisting();
  const existing = old.tickers || {};

  // FMP batch quote (1 API call)
  const fmpQuotes = await fetchFmpQuotes(tickers);

  // Yahoo 히스토리 (순차, 레이트리밋 방지)
  const yahooData = {};
  for (const ticker of tickers) {
    yahooData[ticker] = await fetchYahooChart(ticker);
    if (yahooData[ticker]) {
      console.log(`  [Yahoo] ${ticker}: ${yahooData[ticker].history.length} days`);
    }
    await new Promise(ok => setTimeout(ok, 300));
  }

  // 데이터 병합 (profile 필드는 기존 값 유지)
  const result = {};
  for (const ticker of tickers) {
    const fq = fmpQuotes[ticker] || {};
    const yh = yahooData[ticker] || {};
    const prev = existing[ticker] || {};

    const price = fq.price || yh.price || prev.price || 0;
    const prevClose = fq.prevClose || yh.prevClose || prev.prevClose || 0;

    const fullHistory = yh.history || prev.history || [];
    const history = fullHistory.slice(-60);
    const allCloses = fullHistory.map(h => h.p);

    const rsi = calcRSI(allCloses);
    const bb20 = calcBBPct(allCloses, 20);
    const bb252 = calcBBPct(allCloses, 252);
    const mdd = calcMDD(allCloses);

    const changePct = fq.changePct || (prevClose > 0 ? +((price - prevClose) / prevClose * 100).toFixed(2) : 0);

    result[ticker] = {
      price, prevClose,
      change: fq.change || +(price - prevClose).toFixed(4),
      changePct,
      dayHigh: fq.dayHigh || null,
      dayLow: fq.dayLow || null,
      volume: fq.volume || null,
      // 펀더멘탈: quote에서 얻을 수 있는 것 + 기존 profile 유지
      per: fq.per || prev.per || null,
      eps: fq.eps || prev.eps || null,
      pbr: prev.pbr || null,
      divYield: prev.divYield || 0,
      marketCap: fq.marketCap || prev.marketCap || null,
      sector: prev.sector || null,
      beta: prev.beta || null,
      isETF: prev.isETF || false,
      // 기술지표
      rsi, bb20, bb252, mdd,
      // 히스토리
      history,
    };
  }

  saveResult({ updated: new Date().toISOString(), tickers: result });

  const ok = Object.values(result).filter(t => t.price > 0).length;
  console.log(`With price data: ${ok}/${tickers.length}`);
  if (ok === 0) { console.error("No price data fetched!"); process.exit(1); }
}

// ── profile 모드: FMP profile 펀더멘탈 보충 (하루 2회) ──
async function runProfile() {
  const tickers = loadTickers();
  console.log(`[profile] ${tickers.length} US tickers: ${tickers.join(", ")}`);

  const old = loadExisting();
  const existing = old.tickers || {};

  // FMP batch profile (1 API call)
  const fmpProfiles = await fetchFmpProfiles(tickers);

  // 기존 데이터에 profile 필드만 덮어쓰기
  const result = {};
  for (const ticker of tickers) {
    const fp = fmpProfiles[ticker] || {};
    const prev = existing[ticker] || {};

    result[ticker] = {
      ...prev,
      pbr: fp.pbr || prev.pbr || null,
      divYield: fp.divYield || prev.divYield || 0,
      sector: fp.sector || prev.sector || null,
      beta: fp.beta || prev.beta || null,
      isETF: fp.isETF || prev.isETF || false,
    };
  }

  saveResult({ updated: old.updated || new Date().toISOString(), profileUpdated: new Date().toISOString(), tickers: result });
  console.log(`Profile updated for ${Object.keys(fmpProfiles).length} tickers`);
}

// ── 실행 ──
console.log(`Mode: ${MODE}`);
if (MODE === "profile") {
  runProfile();
} else {
  runQuote();
}
