/**
 * US 시장 데이터 수집 스크립트
 * GitHub Actions에서 10분마다 실행 → data/market.json 갱신
 *
 * 데이터 소스:
 *   - FMP (Financial Modeling Prep): 펀더멘탈 (PER, PBR, 배당률, 시가총액 등)
 *   - Yahoo Finance v8 chart: 현재가, 일변동, 60일 히스토리
 *
 * 기술지표 (히스토리 기반 서버 계산):
 *   - RSI(14), BB%(20), BB%(252), MDD
 */
const fs = require("fs");
const path = require("path");

const FMP_KEY = process.env.FMP_API_KEY || "nJmHhWv6XOVTWKGGoLNpiTh0JYUCtbjr";

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

// ── 메인 ──
async function main() {
  const tickers = loadTickers();
  console.log(`Fetching market data for ${tickers.length} US tickers: ${tickers.join(", ")}`);

  // 기존 market.json 로드 (프로필 데이터 캐시용)
  const outPath = path.join(__dirname, "..", "data", "market.json");
  let existing = {};
  try {
    const old = JSON.parse(fs.readFileSync(outPath, "utf8"));
    existing = old.tickers || {};
  } catch {}

  // FMP 배치 호출 (quote + profile)
  const [fmpQuotes, fmpProfiles] = await Promise.all([
    fetchFmpQuotes(tickers),
    fetchFmpProfiles(tickers),
  ]);

  // Yahoo 히스토리 (순차, 레이트리밋 방지)
  const yahooData = {};
  for (const ticker of tickers) {
    yahooData[ticker] = await fetchYahooChart(ticker);
    if (yahooData[ticker]) {
      console.log(`  [Yahoo] ${ticker}: ${yahooData[ticker].history.length} days`);
    }
    // Yahoo 레이트리밋 방지
    await new Promise(ok => setTimeout(ok, 300));
  }

  // 데이터 병합
  const result = {};
  for (const ticker of tickers) {
    const fq = fmpQuotes[ticker] || {};
    const fp = fmpProfiles[ticker] || {};
    const yh = yahooData[ticker] || {};
    const old = existing[ticker] || {};

    // 가격: FMP quote > Yahoo > 기존
    const price = fq.price || yh.price || old.price || 0;
    const prevClose = fq.prevClose || yh.prevClose || old.prevClose || 0;

    // 히스토리: Yahoo (최근 60일만 저장하여 용량 절약)
    const fullHistory = yh.history || old.history || [];
    const history = fullHistory.slice(-60);
    const allCloses = fullHistory.map(h => h.p);

    // 기술지표 계산 (전체 히스토리 기반)
    const rsi = calcRSI(allCloses);
    const bb20 = calcBBPct(allCloses, 20);
    const bb252 = calcBBPct(allCloses, 252);
    const mdd = calcMDD(allCloses);

    // 일변동
    const changePct = fq.changePct || (prevClose > 0 ? +((price - prevClose) / prevClose * 100).toFixed(2) : 0);

    result[ticker] = {
      price,
      prevClose,
      change: fq.change || +(price - prevClose).toFixed(4),
      changePct,
      dayHigh: fq.dayHigh || null,
      dayLow: fq.dayLow || null,
      volume: fq.volume || null,
      // 펀더멘탈
      per: fq.per || old.per || null,
      eps: fq.eps || old.eps || null,
      pbr: fp.pbr || old.pbr || null,
      divYield: fp.divYield || old.divYield || 0,
      marketCap: fq.marketCap || old.marketCap || null,
      sector: fp.sector || old.sector || null,
      beta: fp.beta || old.beta || null,
      isETF: fp.isETF || old.isETF || false,
      // 기술지표
      rsi,
      bb20,
      bb252,
      mdd,
      // 히스토리 (최근 60일)
      history,
    };
  }

  const out = {
    updated: new Date().toISOString(),
    tickers: result,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`\nSaved to ${outPath}`);
  console.log(`Updated: ${out.updated}`);
  console.log(`Tickers: ${Object.keys(result).length}`);

  const ok = Object.values(result).filter(t => t.price > 0).length;
  console.log(`With price data: ${ok}/${tickers.length}`);
  if (ok === 0) { console.error("No price data fetched!"); process.exit(1); }
}

main();
