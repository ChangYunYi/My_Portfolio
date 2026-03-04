// ═══════════════════════════════════════════════════════════════
// 📊 Portfolio Cache v4 - US Only
// Yahoo (crumb auth) + FMP (fallback)
// ═══════════════════════════════════════════════════════════════

var FMP_KEY = "nJmHhWv6XOVTWKGGoLNpiTh0JYUCtbjr";

var CONFIG = {
  METRICS_INTERVAL: 60,
  HOLDINGS_INTERVAL: 1440,
  FINANCIALS_INTERVAL: 1440,
  TAB_METRICS: "StockCache",
  TAB_HOLDINGS: "HoldingsCache",
  TAB_FINANCIALS: "FinCache",
  TAB_PRICES: "PriceCache",
  PORTFOLIO_TABS: ["지수형 포트폴리오", "배당 포트폴리오", "성장 포트폴리오"]
};

var US_ETF_SET = {
  "QQQ":1,"QQQM":1,"SPYM":1,"SPY":1,"VOO":1,"VGK":1,"VTI":1,"VEA":1,"VWO":1,
  "SCHD":1,"TLT":1,"DGRW":1,"JEPI":1,"JEPQ":1,"IVV":1,"AGG":1,"BND":1,"VNQ":1,
  "XLF":1,"XLK":1,"XLE":1,"DIA":1,"IWM":1,"EFA":1,"EEM":1,"GLD":1,"SLV":1,
  "ARKK":1,"TQQQ":1,"SQQQ":1,"SOXX":1,"SMH":1,"HUMN":1
};

var SKIP_NAMES = {"환율":1,"Total":1,"합계":1,"삼성RP":1,"예수금":1,"원화":1,"CMA":1,"RP":1,"MMF":1,"현금":1,"달러":1};

// ═══ Yahoo 인증 전역 변수 ═══
var _yCookie = "";
var _yCrumb = "";
var _yAuthOK = false;


// ═══════════════════════════════════════════════════════════════
// 1. Yahoo Crumb 인증 (서버사이드 = 가능)
// ═══════════════════════════════════════════════════════════════
function initYahooAuth() {
  try {
    // Step 1: fc.yahoo.com → Set-Cookie 받기
    var r1 = UrlFetchApp.fetch("https://fc.yahoo.com", {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    });

    var allHeaders = r1.getAllHeaders();
    var setCookies = allHeaders["Set-Cookie"];
    if (!setCookies) setCookies = allHeaders["set-cookie"];

    if (setCookies) {
      if (typeof setCookies === "string") setCookies = [setCookies];
      var parts = [];
      setCookies.forEach(function(c) { parts.push(c.split(";")[0]); });
      _yCookie = parts.join("; ");
    }

    // Step 2: crumb 요청
    var r2 = UrlFetchApp.fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "Cookie": _yCookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      muteHttpExceptions: true
    });

    if (r2.getResponseCode() === 200) {
      _yCrumb = r2.getContentText().trim();
      if (_yCrumb && _yCrumb.length > 3) {
        _yAuthOK = true;
        Logger.log("✅ Yahoo 인증 성공 (crumb=" + _yCrumb.substring(0, 6) + "...)");
        return;
      }
    }
    Logger.log("⚠️ Yahoo crumb 응답: " + r2.getResponseCode() + " [" + r2.getContentText().substring(0, 50) + "]");
  } catch(e) {
    Logger.log("❌ Yahoo 인증 실패: " + e.message);
  }
  _yAuthOK = false;
}

function yFetch(url) {
  var fullUrl = url + (url.indexOf("?") >= 0 ? "&" : "?") + "crumb=" + encodeURIComponent(_yCrumb);
  var res = UrlFetchApp.fetch(fullUrl, {
    headers: {
      "Cookie": _yCookie,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 400) throw new Error("Yahoo HTTP " + code);
  return JSON.parse(res.getContentText());
}


// ═══════════════════════════════════════════════════════════════
// 2. 메인
// ═══════════════════════════════════════════════════════════════
function updateAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tickers = extractTickers(ss);
  Logger.log("📊 종목 수: " + tickers.length);

  // Yahoo 인증 (한번만)
  initYahooAuth();

  updateMetrics(ss, tickers);
  updateHoldings(ss, tickers);
  updateFinancials(ss, tickers);
  updatePrices(ss, tickers);

  Logger.log("✅ 완료: " + new Date().toLocaleString("ko-KR"));
}


// ═══════════════════════════════════════════════════════════════
// 3. 티커 추출
// ═══════════════════════════════════════════════════════════════
function extractTickers(ss) {
  var tickers = [], seen = {};

  CONFIG.PORTFOLIO_TABS.forEach(function(tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();

    var headerRow = -1, tickerCol = -1, nameCol = -1;
    for (var r = 0; r < Math.min(data.length, 5); r++) {
      for (var c = 0; c < data[r].length; c++) {
        var h = String(data[r][c]).trim();
        if (h === "티커" || h === "Ticker") { tickerCol = c; headerRow = r; }
        if (h === "종목" || h === "종목명") { nameCol = c; }
      }
      if (headerRow >= 0) break;
    }
    if (headerRow < 0) return;
    Logger.log("📋 " + tabName + ": 헤더=" + headerRow + "행");

    for (var r = headerRow + 1; r < data.length; r++) {
      var ticker = String(data[r][tickerCol] || "").trim().toUpperCase();
      var name = String(data[r][nameCol] || "").trim();
      if (!ticker || SKIP_NAMES[name]) continue;
      if (/^\d/.test(ticker)) continue;  // 숫자로 시작 = 현금
      if (!/[A-Z]/.test(ticker)) continue;  // 영문자 필수
      if (seen[ticker]) continue;
      seen[ticker] = true;

      var isETF = !!US_ETF_SET[ticker];
      tickers.push({ ticker: ticker, isETF: isETF, name: name });
      Logger.log("  ✓ " + ticker + " (" + (isETF?"ETF":"Stock") + ") " + name);
    }
  });
  return tickers;
}


// ═══════════════════════════════════════════════════════════════
// 4. StockCache - 메트릭
//    1차: Yahoo v7 batch (crumb 인증, 1회 호출)
//    2차: FMP profile 보충
// ═══════════════════════════════════════════════════════════════
function updateMetrics(ss, tickers) {
  var sheet = getOrCreateSheet(ss, CONFIG.TAB_METRICS, [
    "ticker","type","name","per","pbr","roe","eps","mktcap","divyield",
    "debtratio","opmargin","expenseratio","aum","sector","updated"
  ]);
  var existing = sheetToMap(sheet, 0);
  var now = new Date(), rows = [];

  // ─── Yahoo v7 batch quote (crumb 인증) ───
  var yQuotes = {};
  if (_yAuthOK) {
    try {
      var symbols = tickers.map(function(t){return t.ticker}).join(",");
      var data = yFetch("https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + symbols);
      var quotes = data && data.quoteResponse && data.quoteResponse.result;
      if (quotes) {
        quotes.forEach(function(q) { yQuotes[q.symbol] = q; });
        Logger.log("✅ Yahoo v7 batch: " + quotes.length + "종목");
      }
    } catch(e) {
      Logger.log("❌ Yahoo v7 batch 실패: " + e.message);
    }
  }

  // ─── Yahoo 실패 시 v8 chart meta로 폴백 ───
  if (Object.keys(yQuotes).length === 0) {
    Logger.log("⚠️ Yahoo v7 실패 → v8 chart meta 폴백");
    tickers.forEach(function(t) {
      try {
        var d = fetchJSON("https://query1.finance.yahoo.com/v8/finance/chart/" + t.ticker + "?range=5d&interval=1d");
        var meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
        if (meta) yQuotes[t.ticker] = { symbol: t.ticker, regularMarketPrice: meta.regularMarketPrice, shortName: meta.shortName || meta.symbol };
      } catch(e2) {}
    });
    Logger.log("  v8 폴백: " + Object.keys(yQuotes).length + "종목 (가격만)");
  }

  // ─── 종목별 데이터 빌드 ───
  tickers.forEach(function(t) {
    var old = existing[t.ticker];
    if (old && old.updated && (now - new Date(old.updated))/60000 < CONFIG.METRICS_INTERVAL) {
      rows.push(old._row); return;
    }

    var d = {};

    // Yahoo v7 데이터
    var q = yQuotes[t.ticker];
    if (q) {
      d.per = q.trailingPE || "";
      d.pbr = q.priceToBook || "";
      d.eps = q.epsTrailingTwelveMonths || "";
      d.mktcap = q.marketCap || "";
      d.sector = q.sector || "";
      d.name = q.shortName || t.name;
      // dividendYield: Yahoo는 0.0052 형태 (=0.52%)
      if (q.dividendYield) d.divyield = r2(q.dividendYield * 100);
      else if (q.trailingAnnualDividendYield) d.divyield = r2(q.trailingAnnualDividendYield * 100);
    }

    // Yahoo v10 상세 (Stock만, crumb 인증 있을 때)
    if (!t.isETF && _yAuthOK && !d.roe) {
      try {
        Utilities.sleep(300);
        var sm = yFetch("https://query2.finance.yahoo.com/v10/finance/quoteSummary/" + t.ticker +
                        "?modules=defaultKeyStatistics,financialData,summaryProfile");
        var r0 = sm && sm.quoteSummary && sm.quoteSummary.result && sm.quoteSummary.result[0];
        if (r0) {
          var fd = r0.financialData || {};
          var ks = r0.defaultKeyStatistics || {};
          var sp = r0.summaryProfile || {};
          if (fd.returnOnEquity) d.roe = r2(rawVal(fd.returnOnEquity) * 100);
          if (fd.debtToEquity) d.debtratio = r2(rawVal(fd.debtToEquity));
          if (fd.operatingMargins) d.opmargin = r2(rawVal(fd.operatingMargins) * 100);
          if (!d.per && ks.forwardPE) d.per = rawVal(ks.forwardPE);
          if (!d.pbr && ks.priceToBook) d.pbr = rawVal(ks.priceToBook);
          if (!d.sector && sp.sector) d.sector = sp.sector;
          Logger.log("  Yahoo v10 ✓ " + t.ticker + " ROE=" + d.roe + " Debt=" + d.debtratio);
        }
      } catch(e) {
        Logger.log("  Yahoo v10 ✗ " + t.ticker + " " + e.message);
      }
    }

    // Yahoo v10 상세 (ETF용: AUM, 보수율, 배당률)
    if (t.isETF && _yAuthOK) {
      try {
        Utilities.sleep(300);
        var sm = yFetch("https://query2.finance.yahoo.com/v10/finance/quoteSummary/" + t.ticker +
                        "?modules=defaultKeyStatistics,summaryDetail,fundProfile");
        var r0 = sm && sm.quoteSummary && sm.quoteSummary.result && sm.quoteSummary.result[0];
        if (r0) {
          var ks = r0.defaultKeyStatistics || {};
          var sd = r0.summaryDetail || {};
          var fp = r0.fundProfile || {};

          // AUM (순자산)
          if (ks.totalAssets) d.aum = rawVal(ks.totalAssets);
          // 배당률
          if (!d.divyield && sd["yield"]) d.divyield = r2(rawVal(sd["yield"]) * 100);
          if (!d.divyield && sd.trailingAnnualDividendYield) d.divyield = r2(rawVal(sd.trailingAnnualDividendYield) * 100);
          // 보수율
          var fees = fp.feesAndExpenses;
          if (fees) {
            var er = fees.annualReportExpenseRatio || fees.netExpenseRatio || fees.totalExpenseRatio;
            if (er != null) d.expenseratio = r2(rawVal(er) * 100);
          }
          // 카테고리 → 섹터
          if (!d.sector && ks.category) d.sector = rawVal(ks.category) || ks.category;
          if (!d.sector && fp.categoryName) d.sector = fp.categoryName;
          // 시가총액 (ETF는 AUM으로 대체)
          if (!d.mktcap && d.aum) d.mktcap = d.aum;

          Logger.log("  Yahoo v10 ETF ✓ " + t.ticker + " AUM=" + d.aum + " ER=" + d.expenseratio + " DivY=" + d.divyield + " Cat=" + d.sector);
        }
      } catch(e) {
        Logger.log("  Yahoo v10 ETF ✗ " + t.ticker + " " + e.message);
      }
    }

    // FMP profile 보충 (Yahoo에서 못 가져온 항목만)
    if (!d.mktcap || !d.name || !d.sector) {
      try {
        Utilities.sleep(400);
        var p = fetchJSON("https://financialmodelingprep.com/stable/profile?symbol=" + t.ticker + "&apikey=" + FMP_KEY);
        p = Array.isArray(p) ? p[0] : p;
        if (p) {
          if (!d.mktcap) d.mktcap = p.mktCap || p.marketCap || "";
          if (!d.name) d.name = p.companyName || "";
          if (!d.sector) d.sector = p.sector || "";
          if (t.isETF && !d.aum) d.aum = p.mktCap || p.marketCap || "";
        }
      } catch(e) {}
    }

    // FMP etf-info (보수율 폴백 - Yahoo 실패 시만)
    if (t.isETF && !d.expenseratio) {
      try {
        Utilities.sleep(400);
        var ei = fetchJSON("https://financialmodelingprep.com/stable/etf-info?symbol=" + t.ticker + "&apikey=" + FMP_KEY);
        var e0 = Array.isArray(ei) ? ei[0] : ei;
        if (e0) {
          var er = e0.expenseRatio || e0.netExpenseRatio;
          if (er != null) d.expenseratio = er < 1 ? r2(er * 100) : er;
        }
      } catch(e) {}
    }

    // FMP ratios 폴백 (Yahoo v10 실패 시 Stock만)
    if (!t.isETF && !d.roe) {
      try {
        Utilities.sleep(600);
        var rt = fetchJSON("https://financialmodelingprep.com/stable/ratios-ttm?symbol=" + t.ticker + "&apikey=" + FMP_KEY);
        rt = Array.isArray(rt) ? rt[0] : rt;
        if (rt) {
          if (!d.roe && rt.returnOnEquityTTM) d.roe = r2(rt.returnOnEquityTTM * 100);
          if (!d.debtratio && rt.debtEquityRatioTTM) d.debtratio = r2(rt.debtEquityRatioTTM);
          if (!d.opmargin && rt.operatingProfitMarginTTM) d.opmargin = r2(rt.operatingProfitMarginTTM * 100);
          Logger.log("  FMP ratios ✓ " + t.ticker);
        }
      } catch(e) { Logger.log("  FMP ratios ✗ " + t.ticker + " " + e.message); }
    }

    var logParts = [];
    if (d.per) logParts.push("PER=" + d.per);
    if (d.roe) logParts.push("ROE=" + d.roe);
    if (d.mktcap) logParts.push("MCap=✓");
    Logger.log("  📊 " + t.ticker + ": " + (logParts.length ? logParts.join(" ") : "데이터 없음"));

    rows.push([
      t.ticker, t.isETF ? "etf" : "stock", d.name||t.name||"",
      d.per||"", d.pbr||"", d.roe||"", d.eps||"",
      d.mktcap||"", d.divyield||"", d.debtratio||"", d.opmargin||"",
      d.expenseratio||"", d.aum||"", d.sector||"",
      now.toISOString()
    ]);
  });

  writeSheet(sheet, rows);
}


// ═══════════════════════════════════════════════════════════════
// 5. HoldingsCache (ETF만, FMP)
// ═══════════════════════════════════════════════════════════════
function updateHoldings(ss, tickers) {
  var sheet = getOrCreateSheet(ss, CONFIG.TAB_HOLDINGS, ["ticker","rank","holdname","holdticker","weight","updated"]);
  var existingRows = sheet.getDataRange().getValues();
  var lastUpdated = {};
  for (var i = 1; i < existingRows.length; i++) { var tk = existingRows[i][0]; if (tk && !lastUpdated[tk]) lastUpdated[tk] = existingRows[i][5]; }

  var now = new Date(), allRows = [], refreshNeeded = {};
  tickers.forEach(function(t) {
    if (!t.isETF) return;
    var last = lastUpdated[t.ticker];
    if (last && (now - new Date(last))/60000 < CONFIG.HOLDINGS_INTERVAL) return;
    refreshNeeded[t.ticker] = t;
  });
  for (var i = 1; i < existingRows.length; i++) { var tk = existingRows[i][0]; if (tk && !refreshNeeded[tk]) allRows.push(existingRows[i]); }

  Object.keys(refreshNeeded).forEach(function(ticker) {
    Logger.log("🔄 Holdings: " + ticker);
    var holdings = [];

    // 1차: FMP (5초 딜레이)
    try {
      Utilities.sleep(5000);
      var data = fetchJSON("https://financialmodelingprep.com/stable/etf/holdings?symbol=" + ticker + "&apikey=" + FMP_KEY);
      if (data && data.length > 0) {
        data.slice(0, 10).forEach(function(h) {
          holdings.push({ name: h.name||h.asset||"", ticker: h.asset||h.symbol||"", weight: h.weightPercentage||h.weight||0 });
        });
        Logger.log("  FMP ✓ " + holdings.length + " holdings");
      }
    } catch(e) {
      Logger.log("  FMP ✗ " + e.message);
    }

    // 2차: Yahoo Finance 페이지 스크래핑 (FMP 실패 시)
    if (holdings.length === 0) {
      try {
        Utilities.sleep(1000);
        var html = UrlFetchApp.fetch("https://finance.yahoo.com/quote/" + ticker + "/holdings/", {
          muteHttpExceptions: true,
          headers: {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        }).getContentText();

        // "Top 10 Holdings" 영역에서 종목명+비중 추출
        var rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
        rows.forEach(function(row) {
          if (holdings.length >= 10) return;
          var tds = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
          if (!tds || tds.length < 3) return;
          var cells = tds.map(function(td) { return td.replace(/<[^>]+>/g, "").trim() });
          // 일반 패턴: [이름, 심볼, 비중%]
          var name = cells[0], sym = cells[1] || "", pct = parseFloat((cells[2]||"").replace("%",""));
          if (!name || name.length < 2 || isNaN(pct) || pct <= 0 || pct > 100) return;
          if (/^\d/.test(name)) return; // 숫자로 시작하면 헤더
          holdings.push({ name: name, ticker: sym, weight: pct });
        });
        if (holdings.length > 0) Logger.log("  Yahoo 스크래핑 ✓ " + holdings.length + " holdings");
      } catch(e2) {
        Logger.log("  Yahoo 스크래핑 ✗ " + e2.message);
      }
    }

    // 3차: Yahoo v10 topHoldings (crumb 인증)
    if (holdings.length === 0 && _yAuthOK) {
      try {
        Utilities.sleep(500);
        var sm = yFetch("https://query2.finance.yahoo.com/v10/finance/quoteSummary/" + ticker + "?modules=topHoldings");
        var th = sm && sm.quoteSummary && sm.quoteSummary.result && sm.quoteSummary.result[0] && sm.quoteSummary.result[0].topHoldings;
        if (th && th.holdings) {
          th.holdings.slice(0, 10).forEach(function(h) {
            var w = rawVal(h.holdingPercent);
            if (w != null) holdings.push({ name: h.holdingName || "", ticker: h.symbol || "", weight: r2(w * 100) });
          });
          if (holdings.length > 0) Logger.log("  Yahoo v10 topHoldings ✓ " + holdings.length);
        }
      } catch(e3) {
        Logger.log("  Yahoo v10 topHoldings ✗ " + e3.message);
      }
    }

    if (holdings.length > 0) {
      holdings.forEach(function(h, i) { allRows.push([ticker, i+1, h.name, h.ticker, h.weight, now.toISOString()]); });
    } else {
      Logger.log("  ⚠️ 모든 소스 실패, 기존 데이터 유지");
      for (var i = 1; i < existingRows.length; i++) { if (existingRows[i][0] === ticker) allRows.push(existingRows[i]); }
    }
  });
  writeSheet(sheet, allRows);
}


// ═══════════════════════════════════════════════════════════════
// 6. FinCache (Stock만)
//    1차: Yahoo v10 earnings (crumb 인증)
//    2차: FMP income-statement (폴백)
// ═══════════════════════════════════════════════════════════════
function updateFinancials(ss, tickers) {
  var sheet = getOrCreateSheet(ss, CONFIG.TAB_FINANCIALS, ["ticker","year","revenue","opincome","netincome","eps","totalassets","totaldebt","equity","updated"]);
  var existingRows = sheet.getDataRange().getValues();
  var lastUpdated = {};
  for (var i = 1; i < existingRows.length; i++) { var tk = existingRows[i][0]; if (tk && !lastUpdated[tk]) lastUpdated[tk] = existingRows[i][9]; }

  var now = new Date(), allRows = [], refreshNeeded = {};
  tickers.forEach(function(t) {
    if (t.isETF) return;
    var last = lastUpdated[t.ticker];
    if (last && (now - new Date(last))/60000 < CONFIG.FINANCIALS_INTERVAL) return;
    refreshNeeded[t.ticker] = t;
  });
  for (var i = 1; i < existingRows.length; i++) { if (existingRows[i][0] && !refreshNeeded[existingRows[i][0]]) allRows.push(existingRows[i]); }

  Object.keys(refreshNeeded).forEach(function(ticker) {
    Logger.log("🔄 Financials: " + ticker);
    var gotData = false;
    var yahooRows = []; // Yahoo에서 가져온 행들 (EPS 보충용)

    // 1차: Yahoo v10 incomeStatementHistory (crumb)
    if (_yAuthOK) {
      try {
        Utilities.sleep(500);
        var sm = yFetch("https://query2.finance.yahoo.com/v10/finance/quoteSummary/" + ticker +
                        "?modules=incomeStatementHistory,balanceSheetHistory,earnings");
        var r0 = sm && sm.quoteSummary && sm.quoteSummary.result && sm.quoteSummary.result[0];

        if (r0) {
          // incomeStatementHistory (최근 4년 상세)
          var ish = r0.incomeStatementHistory && r0.incomeStatementHistory.incomeStatementHistory;
          var bsh = r0.balanceSheetHistory && r0.balanceSheetHistory.balanceSheetStatements;

          if (ish && ish.length > 0) {
            ish.forEach(function(d, idx) {
              var b = (bsh && bsh[idx]) || {};
              var yr = d.endDate ? new Date(rawVal(d.endDate) * 1000).getFullYear() : "";

              yahooRows.push([
                ticker, String(yr),
                rawVal(d.totalRevenue) || 0,
                rawVal(d.operatingIncome) || 0,
                rawVal(d.netIncome) || 0,
                0, // EPS는 FMP에서 보충 예정
                rawVal(b.totalAssets) || 0,
                rawVal(b.totalLiab) || rawVal(b.totalDebt) || 0,
                rawVal(b.totalStockholderEquity) || 0,
                now.toISOString()
              ]);
            });
            gotData = true;
            Logger.log("  Yahoo v10 ✓ " + ish.length + " years");
          }

          // earnings (간소화 - 연간 매출+이익만, incomeStatementHistory 실패 시)
          if (!gotData) {
            var earn = r0.earnings && r0.earnings.financialsChart && r0.earnings.financialsChart.yearly;
            if (earn && earn.length > 0) {
              earn.forEach(function(d) {
                yahooRows.push([ticker, String(d.date), rawVal(d.revenue)||0, 0, rawVal(d.earnings)||0, 0, 0, 0, 0, now.toISOString()]);
              });
              gotData = true;
              Logger.log("  Yahoo earnings ✓ " + earn.length + " years");
            }
          }
        }
      } catch(e) {
        Logger.log("  Yahoo v10 ✗ " + e.message);
      }
    }

    // 2차: FMP income-statement
    // - Yahoo 실패 시: 전체 데이터 소스로 사용
    // - Yahoo 성공 시: EPS만 보충
    if (gotData) {
      // ═══ Yahoo 성공 → FMP에서 누락 필드 보충 (EPS, 영업이익, 자산, 부채) ═══
      try {
        Utilities.sleep(1500);
        var inc = fetchJSON("https://financialmodelingprep.com/stable/income-statement?symbol=" + ticker + "&limit=5&apikey=" + FMP_KEY);
        var bal = [];
        try { Utilities.sleep(800); bal = fetchJSON("https://financialmodelingprep.com/stable/balance-sheet-statement?symbol=" + ticker + "&limit=5&apikey=" + FMP_KEY) || []; } catch(e2) {}

        if (inc && inc.length > 0) {
          // FMP 연도별 데이터 맵 구축
          var fmpMap = {};
          inc.forEach(function(d, idx) {
            var yr = d.calendarYear || (d.date||"").slice(0,4);
            var b = (bal && bal[idx]) || {};
            var eps = d.epsdiluted || d.eps || 0;
            if (Math.abs(eps) > 1000) eps = 0;
            fmpMap[yr] = {
              eps: eps,
              opincome: d.operatingIncome || 0,
              assets: b.totalAssets || 0,
              debt: b.totalDebt || b.totalLiabilities || 0,
              equity: b.totalStockholdersEquity || b.totalEquity || 0
            };
          });
          Logger.log("  FMP 보충 데이터: " + Object.keys(fmpMap).join(","));

          // Yahoo 행에 빈 필드 채우기
          // [0:ticker, 1:year, 2:revenue, 3:opincome, 4:netincome, 5:eps, 6:assets, 7:debt, 8:equity, 9:updated]
          yahooRows.forEach(function(row) {
            var yr = row[1];
            var fm = fmpMap[yr];
            if (!fm) return;
            if (row[3] === 0 && fm.opincome !== 0) row[3] = fm.opincome;  // 영업이익
            if (row[5] === 0 && fm.eps !== 0)      row[5] = fm.eps;       // EPS
            if (row[6] === 0 && fm.assets !== 0)   row[6] = fm.assets;    // 총자산
            if (row[7] === 0 && fm.debt !== 0)      row[7] = fm.debt;      // 총부채
            if (row[8] === 0 && fm.equity !== 0)    row[8] = fm.equity;    // 자기자본
          });
        }
      } catch(e) {
        Logger.log("  FMP 보충 ✗ " + e.message);
      }

      // Yahoo 행 → allRows에 추가
      yahooRows.forEach(function(row) { allRows.push(row); });

    } else {
      // ═══ Yahoo 실패 → FMP 전체 데이터 소스 ═══
      try {
        Utilities.sleep(1500);
        var inc = fetchJSON("https://financialmodelingprep.com/stable/income-statement?symbol=" + ticker + "&limit=5&apikey=" + FMP_KEY);
        if (inc && inc.length > 0) {
          var bal = [];
          try { Utilities.sleep(800); bal = fetchJSON("https://financialmodelingprep.com/stable/balance-sheet-statement?symbol=" + ticker + "&limit=5&apikey=" + FMP_KEY); } catch(e2) {}

          inc.forEach(function(d, idx) {
            var b = (bal && bal[idx]) || {};
            var fmpEps = d.epsdiluted || d.eps || 0;
            if (Math.abs(fmpEps) > 1000) fmpEps = 0;
            allRows.push([
              ticker, d.calendarYear || (d.date||"").slice(0,4),
              d.revenue||0, d.operatingIncome||0, d.netIncome||0, fmpEps,
              b.totalAssets||0, b.totalDebt||b.totalLiabilities||0, b.totalStockholdersEquity||b.totalEquity||0,
              now.toISOString()
            ]);
          });
          gotData = true;
          Logger.log("  FMP 전체 ✓ " + inc.length + " years");
        }
      } catch(e) {
        Logger.log("  FMP ✗ " + e.message);
      }
    }

    // 완전 실패 → 기존 데이터 유지
    if (!gotData) {
      Logger.log("  ⚠️ 모든 소스 실패, 기존 데이터 유지");
      for (var i = 1; i < existingRows.length; i++) { if (existingRows[i][0] === ticker) allRows.push(existingRows[i]); }
    }
  });
  writeSheet(sheet, allRows);
}


// ═══════════════════════════════════════════════════════════════
// 7. PriceCache (Yahoo v8 - 인증 불필요)
// ═══════════════════════════════════════════════════════════════
function updatePrices(ss, tickers) {
  var sheet = getOrCreateSheet(ss, CONFIG.TAB_PRICES, ["ticker","date","close","open","high","low"]);
  var existingRows = sheet.getDataRange().getValues();
  var lastDates = {};
  for (var i = 1; i < existingRows.length; i++) {
    var tk = existingRows[i][0], dt = existingRows[i][1];
    if (tk && dt) { var ds = dtStr(dt); if (!lastDates[tk] || ds > lastDates[tk]) lastDates[tk] = ds; }
  }

  var now = new Date(), allRows = [];
  var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 1300); var cutS = cutoff.toISOString().slice(0,10);
  for (var i = 1; i < existingRows.length; i++) { if (dtStr(existingRows[i][1]) >= cutS) allRows.push(existingRows[i]); }

  tickers.forEach(function(t) {
    var lastDate = lastDates[t.ticker], today = now.toISOString().slice(0,10);
    if (lastDate && lastDate >= today) return;
    var needFull = !lastDate;
    Logger.log("🔄 Prices: " + t.ticker + (needFull ? " (full)" : " (inc)"));

    try {
      var range = needFull ? "5y" : "1mo";
      var data = fetchJSON("https://query1.finance.yahoo.com/v8/finance/chart/" + t.ticker + "?range=" + range + "&interval=1d");
      var res = data && data.chart && data.chart.result && data.chart.result[0];
      if (!res || !res.timestamp) { Logger.log("  ✗ 빈 응답"); return; }

      var ts = res.timestamp, q = res.indicators.quote[0], nc = 0;
      for (var i = 0; i < ts.length; i++) {
        var c = q.close[i]; if (c == null || isNaN(c)) continue;
        var d = new Date(ts[i]*1000).toISOString().slice(0,10);
        if (!lastDate || d > lastDate) { allRows.push([t.ticker, d, r2(c), r2(q.open[i]||c), r2(q.high[i]||c), r2(q.low[i]||c)]); nc++; }
      }
      Logger.log("  ✓ " + nc + " new prices");
    } catch(e) { Logger.log("  ✗ " + e.message); }
    Utilities.sleep(300);
  });
  writeSheet(sheet, allRows);
}


// ═══════════════════════════════════════════════════════════════
// 8. 유틸리티
// ═══════════════════════════════════════════════════════════════
function fetchJSON(url) {
  var res = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  var code = res.getResponseCode();
  if (code >= 400) throw new Error("HTTP " + code);
  return JSON.parse(res.getContentText());
}

function rawVal(obj) {
  if (!obj) return null;
  if (typeof obj === "number") return obj;
  if (obj.raw != null) return obj.raw;
  if (obj.fmt != null) return parseFloat(String(obj.fmt).replace(/,/g, ""));
  return null;
}

function r2(v) { return Math.round(v * 100) / 100; }
function dtStr(dt) { return (dt instanceof Date) ? dt.toISOString().slice(0,10) : String(dt||"").slice(0,10); }

function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) { sheet = ss.insertSheet(name); sheet.appendRow(headers); sheet.getRange(1,1,1,headers.length).setFontWeight("bold").setBackground("#091428").setFontColor("#4d9aff"); }
  return sheet;
}

function sheetToMap(sheet, keyCol) {
  var data = sheet.getDataRange().getValues(), headers = data[0], map = {};
  for (var r = 1; r < data.length; r++) { var key = data[r][keyCol]; if (!key) continue; var obj = { _row: data[r] }; headers.forEach(function(h, c) { obj[h] = data[r][c] }); map[key] = obj; }
  return map;
}

function writeSheet(sheet, rows) {
  if (!rows.length) return;
  var headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  var numCols = headers.length;
  // 열 수 정규화: 기존 행과 신규 행의 열 수가 다를 수 있으므로 헤더 기준으로 맞춤
  var normalized = rows.map(function(r) {
    if (r.length === numCols) return r;
    if (r.length > numCols) return r.slice(0, numCols);
    var padded = r.slice();
    while (padded.length < numCols) padded.push("");
    return padded;
  });
  var maxR = Math.max(sheet.getLastRow(), 2);
  if (maxR > 1) sheet.getRange(2,1,maxR-1,numCols).clearContent();
  sheet.getRange(2,1,normalized.length,numCols).setValues(normalized);
}


// ═══════════════════════════════════════════════════════════════
// 9. 트리거
// ═══════════════════════════════════════════════════════════════
function setupTrigger() { removeTrigger(); ScriptApp.newTrigger("updateAll").timeBased().everyMinutes(10).create(); Logger.log("⏰ 트리거 설정"); updateAll(); }
function removeTrigger() { ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction()==="updateAll") ScriptApp.deleteTrigger(t); }); }
function forceUpdateAll() { CONFIG.METRICS_INTERVAL=0; CONFIG.HOLDINGS_INTERVAL=0; CONFIG.FINANCIALS_INTERVAL=0; updateAll(); }
function testExtractTickers() { extractTickers(SpreadsheetApp.getActiveSpreadsheet()).forEach(function(t) { Logger.log(t.ticker+" | "+(t.isETF?"ETF":"Stock")+" | "+t.name); }); }
function testYahooAuth() { initYahooAuth(); Logger.log("Auth OK: " + _yAuthOK + ", Crumb: " + _yCrumb); }
