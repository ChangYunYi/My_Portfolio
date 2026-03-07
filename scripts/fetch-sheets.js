/**
 * Google Sheets JSONP 데이터 수집 스크립트
 * GitHub Actions에서 10분마다 실행되어 data/sheets.json 을 갱신합니다.
 */
const fs = require("fs");
const path = require("path");

const SID = "1b9GtLud9TDFm4AvUnCEfDGu_4CTqYfRU8oYFAh2VSxc";
const SHEETS = [
  "TotalBoard",
  "\uc9c0\uc218\ud615 \ud3ec\ud2b8\ud3f4\ub9ac\uc624",
  "\ubc30\ub2f9 \ud3ec\ud2b8\ud3f4\ub9ac\uc624",
  "\uc131\uc7a5 \ud3ec\ud2b8\ud3f4\ub9ac\uc624",
  "\uad6d\ub0b4 \ud3ec\ud2b8\ud3f4\ub9ac\uc624",
  "\ub370\uc774\ud130\uc2dc\ud2b8",
  "\ub370\uc774\ud130\uc2dc\ud2b82"
];

async function fetchSheet(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      console.warn(`  [WARN] ${sheetName}: HTTP ${r.status}`);
      return null;
    }
    const text = await r.text();
    // Google Sheets returns JSONP-like response: google.visualization.Query.setResponse({...})
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

async function main() {
  console.log(`Fetching ${SHEETS.length} Google Sheets...`);
  const results = {};
  let ok = 0;

  for (const name of SHEETS) {
    const table = await fetchSheet(name);
    if (table) {
      results[name] = table;
      ok++;
      console.log(`  [OK] ${name}: ${table.rows?.length || 0} rows`);
    }
  }

  const out = {
    updated: new Date().toISOString(),
    sheets: results
  };

  const outPath = path.join(__dirname, "..", "data", "sheets.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`\nSaved to ${outPath}`);
  console.log(`Updated: ${out.updated}`);
  console.log(`Success: ${ok}/${SHEETS.length}`);

  if (ok < 3) {
    console.error("Too few sheets fetched!");
    process.exit(1);
  }
}

main();
