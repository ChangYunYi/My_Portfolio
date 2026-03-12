/**
 * Google Sheets → holdings.json 동기화 스크립트
 * GitHub Actions에서 하루 1회 실행 → data/holdings.json 갱신
 *
 * 구글시트에서 보유수량(qty)과 평단가(avg)를 가져와 holdings.json을 업데이트합니다.
 * 환율, 현금 정보도 데이터시트에서 가져옵니다.
 */
const fs = require("fs");
const path = require("path");

const SID = "1b9GtLud9TDFm4AvUnCEfDGu_4CTqYfRU8oYFAh2VSxc";

// 포트폴리오 시트 매핑 (시트명 → holdings.json 키)
const PORTFOLIO_SHEETS = [
  { sheet: "지수형 포트폴리오", key: "index", isKR: false },
  { sheet: "배당 포트폴리오",   key: "dividend", isKR: false },
  { sheet: "성장 포트폴리오",   key: "growth", isKR: false },
  { sheet: "국내 포트폴리오",   key: "kr", isKR: true },
];

// 건너뛸 이름 (현금 등)
const SKIP_NAMES = new Set([
  "환율", "Total", "합계", "삼성RP", "예수금", "원화",
  "CMA", "RP", "MMF", "현금", "달러", "목표투자금", ""
]);

/** Google Sheets JSONP 데이터 가져오기 */
async function fetchSheet(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      console.warn(`  [WARN] ${sheetName}: HTTP ${r.status}`);
      return null;
    }
    const text = await r.text();
    const match = text.match(/google\.visualization\.Query\.setResponse\(({[\s\S]*})\);?\s*$/);
    if (!match) {
      console.warn(`  [WARN] ${sheetName}: unexpected response format`);
      return null;
    }
    const data = JSON.parse(match[1]);
    if (data.status !== "ok" || !data.table) {
      console.warn(`  [WARN] ${sheetName}: status=${data.status}`);
      return null;
    }
    return data.table;
  } catch (e) {
    console.warn(`  [ERR] ${sheetName}: ${e.message}`);
    return null;
  }
}

/** 시트 테이블 → 컬럼 인덱스 매핑 */
function findColumns(table) {
  const cols = (table.cols || []).map(c => (c.label || c.id || "").trim());
  const map = {};
  cols.forEach((label, i) => {
    const l = label.toLowerCase();
    if (l === "종목" || l === "종목명") map.name = i;
    if (l === "티커" || l === "ticker") map.ticker = i;
    if (l === "보유수" || l === "보유수량" || l === "qty") map.qty = i;
    if (l === "평단가" || l === "avg" || l === "매수평단가") map.avg = i;
  });
  return map;
}

/** 시트에서 포트폴리오 종목 추출 */
function parsePortfolio(table, isKR) {
  const colMap = findColumns(table);
  if (colMap.name == null || colMap.ticker == null || colMap.qty == null || colMap.avg == null) {
    console.warn("  필수 컬럼 누락:", colMap);
    return null;
  }

  const items = [];
  for (const row of (table.rows || [])) {
    const cells = row.c || [];
    const name = String(cells[colMap.name]?.v || "").trim();
    const ticker = String(cells[colMap.ticker]?.v || "").trim();
    const qty = parseFloat(cells[colMap.qty]?.v) || 0;
    const avg = parseFloat(cells[colMap.avg]?.v) || 0;

    if (!name || !ticker || qty <= 0 || avg <= 0) continue;
    if (SKIP_NAMES.has(name)) continue;

    items.push({ name, ticker, qty, avg: isKR ? Math.round(avg) : +avg.toFixed(6) });
  }
  return items;
}

/** 데이터시트에서 환율/현금 정보 추출 */
async function fetchMeta() {
  const table = await fetchSheet("데이터시트");
  if (!table) return null;

  let rate = 0, rp = 0, usd = 0, krw = 0;

  for (const row of (table.rows || [])) {
    const cells = row.c || [];
    const label = String(cells[0]?.v || "").trim();

    // 데이터시트 E열(index 4)에 환율이 있음 (첫 행)
    if (label === "자산포트폴리오" && cells[4]?.v) {
      rate = parseFloat(cells[4].v) || 0;
    }

    // 현금 항목 탐색
    const lLower = label.toLowerCase();
    if (lLower.includes("삼성rp") || lLower === "rp") {
      rp = parseFloat(cells[2]?.v) || 0;
    }
    if (lLower.includes("달러") || lLower === "usd" || lLower.includes("예수금")) {
      // 달러 현금
      const val = parseFloat(cells[2]?.v) || 0;
      if (val > 0 && val < 1000000) usd = val; // 합리적인 달러 범위
    }
    if (lLower.includes("원화") || lLower === "krw") {
      krw = parseFloat(cells[2]?.v) || 0;
    }
  }

  return { rate, cash: { rp, usd, krw } };
}

async function main() {
  console.log("=== Google Sheets → holdings.json 동기화 ===\n");

  // 기존 holdings.json 로드 (폴백용)
  const holdingsPath = path.join(__dirname, "..", "data", "holdings.json");
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(holdingsPath, "utf8"));
  } catch {}

  // 메타데이터 (환율, 현금) 가져오기
  const meta = await fetchMeta();
  const rate = meta?.rate || existing.rate || 1450;
  const cash = meta?.cash?.rp || meta?.cash?.usd || meta?.cash?.krw
    ? meta.cash
    : (existing.cash || { rp: 0, usd: 0, krw: 0 });

  console.log(`환율: ${rate}`);
  console.log(`현금: RP=${cash.rp}, USD=${cash.usd}, KRW=${cash.krw}\n`);

  // 포트폴리오별 종목 가져오기
  const portfolios = {};
  let totalItems = 0;

  for (const { sheet, key, isKR } of PORTFOLIO_SHEETS) {
    console.log(`[${sheet}] 가져오는 중...`);
    const table = await fetchSheet(sheet);
    if (!table) {
      console.warn(`  [FAIL] 시트 로드 실패 → 기존 데이터 유지`);
      portfolios[key] = existing.portfolios?.[key] || [];
      continue;
    }

    const items = parsePortfolio(table, isKR);
    if (!items || items.length === 0) {
      console.warn(`  [FAIL] 종목 파싱 실패 → 기존 데이터 유지`);
      portfolios[key] = existing.portfolios?.[key] || [];
      continue;
    }

    portfolios[key] = items;
    totalItems += items.length;
    console.log(`  [OK] ${items.length}종목`);
    items.forEach(h => console.log(`    ${h.name} (${h.ticker}): ${h.qty}주 × ${h.avg}`));
  }

  if (totalItems === 0) {
    console.error("\n모든 포트폴리오가 비어있습니다. 기존 파일 유지.");
    process.exit(1);
  }

  // holdings.json 저장
  const result = {
    updated: new Date().toISOString().slice(0, 10),
    rate: +rate.toFixed(2),
    cash,
    portfolios,
  };

  fs.mkdirSync(path.dirname(holdingsPath), { recursive: true });
  fs.writeFileSync(holdingsPath, JSON.stringify(result, null, 2) + "\n");

  console.log(`\nSaved: ${holdingsPath}`);
  console.log(`Updated: ${result.updated}`);
  console.log(`Rate: ${result.rate}`);
  console.log(`Total: ${totalItems} items across ${Object.keys(portfolios).length} portfolios`);
}

main();
