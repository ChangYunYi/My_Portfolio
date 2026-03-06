/**
 * FRED 매크로 데이터 수집 스크립트
 * GitHub Actions에서 10분마다 실행되어 data/macro.json 을 갱신합니다.
 */
const fs = require("fs");
const path = require("path");

const FRED_KEY = process.env.FRED_API_KEY;
if (!FRED_KEY) { console.error("FRED_API_KEY 환경변수가 설정되지 않았습니다."); process.exit(1); }

const SERIES = [
  "DGS10","DGS2","T10Y2Y","DFEDTARU","DFII10","WM2NS",
  "MPMISM","UMCSENT","UNRATE","CPIAUCSL","SP500",
  "BAMLH0A0HYM2","TEDRATE","DTWEXBGS","BAMLC0A4CBBB",
  "VIXCLS","DCOILWTICO","GOLDAMGBD228NLBM"
];

async function fetchSeries(id) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=2`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.warn(`  [WARN] ${id}: HTTP ${r.status}`); return null; }
    const j = await r.json();
    const obs = j?.observations?.filter(o => o.value !== ".");
    if (!obs?.length) { console.warn(`  [WARN] ${id}: no observations`); return null; }
    const cur = { value: parseFloat(obs[0].value), date: obs[0].date };
    const prev = obs.length > 1 ? { value: parseFloat(obs[1].value), date: obs[1].date } : null;
    const chg = prev ? +(cur.value - prev.value).toFixed(4) : null;
    return { value: cur.value, date: cur.date, prev: prev?.value ?? null, chg };
  } catch (e) {
    console.warn(`  [ERR] ${id}: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`Fetching ${SERIES.length} FRED series...`);
  const results = {};
  const promises = SERIES.map(async id => {
    results[id] = await fetchSeries(id);
    if (results[id]) console.log(`  [OK] ${id}: ${results[id].value} (${results[id].date})`);
  });
  await Promise.allSettled(promises);

  const out = {
    updated: new Date().toISOString(),
    series: results
  };

  const outPath = path.join(__dirname, "..", "data", "macro.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved to ${outPath}`);
  console.log(`Updated: ${out.updated}`);

  const ok = Object.values(results).filter(Boolean).length;
  console.log(`Success: ${ok}/${SERIES.length}`);
  if (ok === 0) { console.error("No data fetched!"); process.exit(1); }
}

main();
