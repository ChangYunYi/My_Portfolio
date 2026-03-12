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

  function isReady() {
    if (_failCount > FAIL_THRESHOLD) return false;
    return !!(
      typeof KIS_APP_KEY !== "undefined" && KIS_APP_KEY &&
      typeof KIS_APP_SECRET !== "undefined" && KIS_APP_SECRET
    );
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

    // 신규 발급
    const r = await fetch(_url("/oauth2/tokenP"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET,
      }),
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

    const r = await fetch(_url("/uapi/domestic-stock/v1/quotations/inquire-price?" + params), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": "Bearer " + token,
        "appkey": KIS_APP_KEY,
        "appsecret": KIS_APP_SECRET,
        "tr_id": "FHKST01010100",
      },
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
        _source: "kis",
      };
    } catch (e) {
      _failCount++;
      console.warn("[KIS] " + portfolioTicker + "(" + code + "): " + e.message +
        (_failCount > FAIL_THRESHOLD ? " → KIS 비활성화, Yahoo 폴백" : ""));
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
      configured: !!(typeof KIS_APP_KEY !== "undefined" && KIS_APP_KEY),
      hasProxy: !!_proxy(),
      hasToken: !!(_token && Date.now() < _tokenExpiry),
      failCount: _failCount,
      disabled: _failCount > FAIL_THRESHOLD,
    };
  }


  return { isReady, getToken, fetchPrice, getQuote, toKISCode, clearToken, status };

})();
