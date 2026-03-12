/* ═══════════════════════════════════════════════════════
   KIS (한국투자증권) OpenAPI 클라이언트
   ▸ 브라우저에서 실시간 국내 주식 시세 조회
   ▸ CORS 프록시 경유 (Cloudflare Worker 권장)
   ▸ KIS 실패 시 Yahoo Finance 자동 폴백

   의존: config.js (KIS_APP_KEY, KIS_APP_SECRET, KIS_BASE_URL,
                    KIS_PROXY_URL, KIS_TICKER_MAP)
   ═══════════════════════════════════════════════════════ */

const KIS = (() => {

  let _token = null;
  let _tokenExpiry = 0;
  let _failCount = 0;        // 연속 실패 횟수 (과도한 재시도 방지)
  const FAIL_THRESHOLD = 3;  // 이 횟수 초과 시 세션 동안 KIS 비활성화


  /* ── 설정 확인 ── */

  function _hasLocalKeys() {
    return !!(typeof KIS_APP_KEY !== "undefined" && KIS_APP_KEY &&
              typeof KIS_APP_SECRET !== "undefined" && KIS_APP_SECRET);
  }

  function _hasProxy() {
    return !!(typeof KIS_PROXY_URL !== "undefined" && KIS_PROXY_URL);
  }

  /** Worker 프록시 설정만 있어도 동작 (키는 Worker에 저장) */
  function isReady() {
    if (_failCount > FAIL_THRESHOLD) return false;
    return _hasLocalKeys() || _hasProxy();
  }


  /* ── URL 구성 ── */

  function _base() {
    return typeof KIS_BASE_URL !== "undefined" && KIS_BASE_URL
      ? KIS_BASE_URL
      : "https://openapi.koreainvestment.com:9443";
  }

  function _proxy() {
    return typeof KIS_PROXY_URL !== "undefined" ? KIS_PROXY_URL : "";
  }

  function _url(path) {
    const p = _proxy();
    if (p) return p.replace(/\/+$/, "") + path;   // Worker 프록시 경유
    return _base() + path;                         // 직접 호출
  }


  /* ── 포트폴리오 티커 → KIS 종목코드 ── */

  function toKISCode(ticker) {
    if (!ticker) return null;
    ticker = ticker.trim();

    // 매핑 테이블 우선
    const map = typeof KIS_TICKER_MAP !== "undefined" ? KIS_TICKER_MAP : {};
    if (map[ticker]) return map[ticker];

    // 순수 6자리 숫자 → 그대로
    if (/^\d{6}$/.test(ticker)) return ticker;

    // 알파벳 포함 → 숫자만 추출 후 6자리면 사용
    const nums = ticker.replace(/[^0-9]/g, "");
    if (nums.length >= 6) return nums.slice(0, 6);

    return null;
  }


  /* ── AbortSignal 헬퍼 ── */

  function _sig(ms) {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
  }


  /* ── 액세스 토큰 발급 / 캐시 ── */

  async function getToken() {
    // 메모리 캐시
    if (_token && Date.now() < _tokenExpiry) return _token;

    // localStorage 캐시
    try {
      const cached = JSON.parse(localStorage.getItem("kis_token"));
      if (cached?.token && cached.expiry > Date.now()) {
        _token = cached.token;
        _tokenExpiry = cached.expiry;
        return _token;
      }
    } catch {}

    // 신규 발급 (프록시 모드: Worker가 키를 주입하므로 빈 값 허용)
    const body = { grant_type: "client_credentials" };
    if (_hasLocalKeys()) {
      body.appkey = KIS_APP_KEY;
      body.appsecret = KIS_APP_SECRET;
    }

    const r = await fetch(_url("/oauth2/tokenP"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: _sig(10000),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`KIS 토큰 발급 실패 (HTTP ${r.status}): ${txt.slice(0, 200)}`);
    }

    const d = await r.json();
    if (!d.access_token) throw new Error("KIS: access_token 없음");

    _token = d.access_token;
    _tokenExpiry = Date.now() + ((d.expires_in || 86400) - 120) * 1000;

    try {
      localStorage.setItem("kis_token", JSON.stringify({
        token: _token, expiry: _tokenExpiry,
      }));
    } catch {}

    console.log("[KIS] 토큰 발급 완료, 만료:", new Date(_tokenExpiry).toLocaleString("ko-KR"));
    return _token;
  }


  /* ── 현재가 조회 (raw) ── */

  async function fetchPrice(stockCode) {
    const token = await getToken();

    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: stockCode,
    });

    // 프록시 모드: Worker가 appkey/appsecret 헤더를 주입
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "authorization": "Bearer " + token,
      "tr_id": "FHKST01010100",
    };
    if (_hasLocalKeys()) {
      headers["appkey"] = KIS_APP_KEY;
      headers["appsecret"] = KIS_APP_SECRET;
    }

    const r = await fetch(_url("/uapi/domestic-stock/v1/quotations/inquire-price?" + params), {
      headers,
      signal: _sig(8000),
    });

    if (!r.ok) {
      r.body?.cancel?.().catch(() => {});
      throw new Error("KIS 시세 조회 실패 (HTTP " + r.status + ")");
    }

    const d = await r.json();
    if (d.rt_cd !== "0") throw new Error("KIS: " + (d.msg1 || d.msg_cd || "unknown error"));

    return d.output;
  }


  /* ── 현재가 → risk-sentinel 호환 포맷 ── */

  async function getQuote(portfolioTicker) {
    if (!isReady()) return null;

    const code = toKISCode(portfolioTicker);
    if (!code) {
      console.log("[KIS] 종목코드 변환 불가:", portfolioTicker, "→ Yahoo 폴백");
      return null;
    }

    try {
      const o = await fetchPrice(code);
      if (!o) return null;

      const price = parseFloat(o.stck_prpr);     // 현재가
      const prevClose = parseFloat(o.stck_sdpr);  // 전일 종가
      const high = parseFloat(o.stck_hgpr);       // 고가
      const low = parseFloat(o.stck_lwpr);        // 저가

      if (!price || price <= 0) return null;

      _failCount = 0;  // 성공 시 실패 카운터 리셋
      console.log("[KIS] " + portfolioTicker + "(" + code + "): " + price.toLocaleString("ko-KR") + "원");

      return {
        c: price,
        pc: prevClose || 0,
        h: high || price,
        l: low || price,
        // 추가 지표 (inquire-price 응답에 포함)
        per: parseFloat(o.per) || 0,
        pbr: parseFloat(o.pbr) || 0,
        eps: parseFloat(o.eps) || 0,
        bps: parseFloat(o.bps) || 0,
        mktCap: parseFloat(o.hts_avls) || 0,       // 시가총액 (억원)
        vol: parseInt(o.acml_vol) || 0,              // 누적 거래량
        volAmt: parseFloat(o.acml_tr_pbmn) || 0,    // 누적 거래대금
        w52h: parseFloat(o.stck_dryy_hgpr) || 0,    // 52주 최고
        w52l: parseFloat(o.stck_dryy_lwpr) || 0,    // 52주 최저
        _source: "kis",
      };
    } catch (e) {
      _failCount++;
      console.warn("[KIS] " + portfolioTicker + "(" + code + "): " + e.message +
        (_failCount > FAIL_THRESHOLD ? " → KIS 비활성화, Yahoo 폴백" : ""));
      return null;
    }
  }


  /* ── 일봉 차트 조회 (최근 100일) ── */

  async function getDailyChart(portfolioTicker) {
    if (!isReady()) return null;

    const code = toKISCode(portfolioTicker);
    if (!code) return null;

    try {
      const token = await getToken();

      // 종료일: 오늘, 시작일: 2년 전
      const now = new Date();
      const endDt = now.toISOString().slice(0, 10).replace(/-/g, "");
      const start = new Date(now);
      start.setFullYear(start.getFullYear() - 2);
      const startDt = start.toISOString().slice(0, 10).replace(/-/g, "");

      const allBars = [];
      let contKey = "";  // 연속조회 키

      // 최대 5회 페이지네이션 (100건 × 5 = 약 500거래일 ≈ 2년)
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({
          FID_COND_MRKT_DIV_CODE: "J",
          FID_INPUT_ISCD: code,
          FID_INPUT_DATE_1: startDt,
          FID_INPUT_DATE_2: endDt,
          FID_PERIOD_DIV_CODE: "D",
          FID_ORG_ADJ_PRC: "0",  // 수정주가
        });

        const headers = {
          "Content-Type": "application/json; charset=utf-8",
          "authorization": "Bearer " + token,
          "tr_id": "FHKST03010100",
        };
        if (_hasLocalKeys()) {
          headers["appkey"] = KIS_APP_KEY;
          headers["appsecret"] = KIS_APP_SECRET;
        }
        if (contKey) {
          headers["tr_cont"] = "N";
          params.set("FID_INPUT_DATE_2", contKey);
        }

        const r = await fetch(_url("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?" + params), {
          headers,
          signal: _sig(10000),
        });

        if (!r.ok) { r.body?.cancel?.().catch(() => {}); break; }
        const d = await r.json();
        if (d.rt_cd !== "0") break;

        const rows = d.output2;
        if (!rows || rows.length === 0) break;

        for (const row of rows) {
          const c = parseFloat(row.stck_clpr);
          if (!c || c <= 0) continue;
          allBars.push({
            dt: row.stck_bsop_date,
            o: parseFloat(row.stck_oprc) || c,
            h: parseFloat(row.stck_hgpr) || c,
            l: parseFloat(row.stck_lwpr) || c,
            c,
            v: parseInt(row.acml_vol) || 0,
          });
        }

        // 연속조회: 마지막 날짜 - 1일을 종료일로
        if (rows.length < 100) break;
        const lastDt = rows[rows.length - 1].stck_bsop_date;
        if (!lastDt || lastDt <= startDt) break;
        // 다음 페이지 종료일 = 마지막 날짜 하루 전
        const ld = new Date(lastDt.slice(0, 4) + "-" + lastDt.slice(4, 6) + "-" + lastDt.slice(6, 8));
        ld.setDate(ld.getDate() - 1);
        contKey = ld.toISOString().slice(0, 10).replace(/-/g, "");

        await new Promise(r => setTimeout(r, 100));  // API 부하 방지
      }

      if (allBars.length < 20) return null;

      // 날짜 오름차순 정렬 (오래된 → 최근)
      allBars.sort((a, b) => a.dt.localeCompare(b.dt));
      _failCount = 0;

      return {
        closes: allBars.map(b => b.c),
        ohlcv: allBars.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
      };
    } catch (e) {
      _failCount++;
      console.warn("[KIS] 일봉 " + portfolioTicker + ": " + e.message);
      return null;
    }
  }


  /* ── 분봉 차트 조회 (당일 30분봉) ── */

  async function getMinuteChart(portfolioTicker) {
    if (!isReady()) return null;

    const code = toKISCode(portfolioTicker);
    if (!code) return null;

    try {
      const token = await getToken();

      // 현재 시각 기준 HHMMSS (장 시작부터 현재까지)
      const now = new Date();
      const kst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
      const endTime = String(kst.getHours()).padStart(2, "0") +
                       String(kst.getMinutes()).padStart(2, "0") + "00";

      const params = new URLSearchParams({
        FID_ETC_CLS_CODE: "",
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: code,
        FID_INPUT_HOUR_1: endTime,
        FID_PW_DATA_INCU_YN: "N",
      });

      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": "Bearer " + token,
        "tr_id": "FHKST03010200",
      };
      if (_hasLocalKeys()) {
        headers["appkey"] = KIS_APP_KEY;
        headers["appsecret"] = KIS_APP_SECRET;
      }

      const r = await fetch(_url("/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?" + params), {
        headers,
        signal: _sig(8000),
      });

      if (!r.ok) { r.body?.cancel?.().catch(() => {}); return null; }
      const d = await r.json();
      if (d.rt_cd !== "0") return null;

      const rows = d.output2;
      if (!rows || rows.length < 3) return null;

      // 시간 오름차순 정렬 후 종가만 추출
      const sorted = rows
        .filter(row => parseFloat(row.stck_prpr) > 0)
        .reverse();

      const closes = sorted.map(row => parseFloat(row.stck_prpr));

      if (closes.length < 3) return null;
      _failCount = 0;
      console.log("[KIS] 분봉 " + portfolioTicker + ": " + closes.length + "건");
      return closes;
    } catch (e) {
      console.warn("[KIS] 분봉 " + portfolioTicker + ": " + e.message);
      return null;
    }
  }


  /* ── 투자자별 매매동향 조회 ── */

  async function getInvestorTrend(portfolioTicker) {
    if (!isReady()) return null;

    const code = toKISCode(portfolioTicker);
    if (!code) return null;

    try {
      const token = await getToken();

      const params = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: code,
      });

      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": "Bearer " + token,
        "tr_id": "FHKST01010900",
      };
      if (_hasLocalKeys()) {
        headers["appkey"] = KIS_APP_KEY;
        headers["appsecret"] = KIS_APP_SECRET;
      }

      const r = await fetch(_url("/uapi/domestic-stock/v1/quotations/inquire-investor?" + params), {
        headers,
        signal: _sig(8000),
      });

      if (!r.ok) { r.body?.cancel?.().catch(() => {}); return null; }
      const d = await r.json();
      if (d.rt_cd !== "0") return null;

      const rows = d.output;
      if (!rows || rows.length === 0) return null;

      // output은 투자자 구분별 데이터 배열
      // 각 row: prsn_ntby_qty(개인 순매수), frgn_ntby_qty(외국인 순매수),
      //         orgn_ntby_qty(기관 순매수) 등
      const today = rows[0]; // 최근(당일) 데이터
      const result = {
        frgn: parseInt(today.frgn_ntby_qty) || 0,   // 외국인 순매수 수량
        orgn: parseInt(today.orgn_ntby_qty) || 0,   // 기관 순매수 수량
        prsn: parseInt(today.prsn_ntby_qty) || 0,   // 개인 순매수 수량
      };

      _failCount = 0;
      const frgnDir = result.frgn >= 0 ? "+" : "";
      const orgnDir = result.orgn >= 0 ? "+" : "";
      console.log("[KIS] 투자자 " + portfolioTicker + ": 외인" + frgnDir + result.frgn.toLocaleString("ko-KR") +
        " 기관" + orgnDir + result.orgn.toLocaleString("ko-KR"));
      return result;
    } catch (e) {
      console.warn("[KIS] 투자자 " + portfolioTicker + ": " + e.message);
      return null;
    }
  }


  /* ── 토큰 초기화 ── */

  function clearToken() {
    _token = null;
    _tokenExpiry = 0;
    _failCount = 0;
    localStorage.removeItem("kis_token");
    console.log("[KIS] 토큰 초기화 완료");
  }


  /* ── 상태 확인 ── */

  function status() {
    return {
      configured: _hasLocalKeys(),
      hasProxy: _hasProxy(),
      hasToken: !!(_token && Date.now() < _tokenExpiry),
      failCount: _failCount,
      disabled: _failCount > FAIL_THRESHOLD,
    };
  }


  return { isReady, getQuote, getDailyChart, getMinuteChart, getInvestorTrend, clearToken, status };

})();
