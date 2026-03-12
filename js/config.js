/* ═══════════════════════════════════════════════════════
   config.js — 전역 상수 및 설정
   ═══════════════════════════════════════════════════════ */

/** 데이터 소스: data/holdings.json + data/market.json + data/macro.json */
/** (메인 대시보드는 Google Sheets 직접 로딩 제거 → GitHub Actions가 market.json 갱신) */

/** Google Sheets 문서 ID (stock-detail.js 호환용) */
const SID = "1b9GtLud9TDFm4AvUnCEfDGu_4CTqYfRU8oYFAh2VSxc";

/** 대시보드 탭 정의 */
const TABS = [
  { id: "overview",  label: "전체 개요",  icon: "◎" },
  { id: "index",     label: "지수형",     icon: "📊" },
  { id: "dividend",  label: "배당",       icon: "💰" },
  { id: "growth",    label: "성장",       icon: "🚀" },
  { id: "kr",        label: "국내",       icon: "🇰🇷" },
];

/** ETF 티커 목록 (isETF 판별용) */
const ETF_TICKERS = new Set([
  "QQQ","QQQM","SPYM","SPY","VOO","VGK","VTI","VEA","VWO",
  "SCHD","TLT","DGRW","JEPI","JEPQ","IVV","AGG","BND","VNQ",
  "XLF","XLK","XLE","DIA","IWM","EFA","EEM","GLD","SLV",
  "ARKK","TQQQ","SQQQ","SOXX","SMH","HUMN"
]);

/** 차트 라인 색상 팔레트 */
const LINE_COLORS = [
  "#4d9aff", "#ae82ff", "#2ee0a8", "#ffc05c",
  "#ff6bb5", "#14e0f5", "#ff6b78", "#8b5cf6"
];

/** Finnhub API 키 (Risk Sentinel 실시간 시세 조회용) */
const FHKEY = "d6jpur9r01qkvh5qt67gd6jpur9r01qkvh5qt680";

/** FRED API 키는 GitHub Actions Secrets에 저장 (FRED_API_KEY) */

/** CORS 프록시 (stock.html 뉴스 RSS 등) */
const PROXY = "https://api.allorigins.win/raw?url=";

/** 포트폴리오별 투자 목표금액 ($) */
const TARGET_INDEX    = 200000;
const TARGET_DIVIDEND = 300000;
const TARGET_GROWTH   = 50000;

/** 자동 새로고침 주기 (초) */
const REFRESH_SEC = 600;

/* ── KIS (한국투자증권) OpenAPI 설정 ──────────────────
   Cloudflare Worker 프록시 사용 시:
     → KIS_PROXY_URL만 입력하면 됨 (키는 Worker에 저장)
     → KIS_APP_KEY / KIS_APP_SECRET는 비워두세요
   직접 호출 시: 키를 아래에 입력 (⚠ 브라우저 소스에 노출)
   ─────────────────────────────────────────────────── */

/** KIS 앱키 (Worker 프록시 사용 시 비워두기) */
const KIS_APP_KEY = "";

/** KIS 앱시크릿 (Worker 프록시 사용 시 비워두기) */
const KIS_APP_SECRET = "";

/** KIS API 베이스 URL (Worker 프록시 사용 시 무시됨)
 *  실전투자: "https://openapi.koreainvestment.com:9443"
 *  모의투자: "https://openapivts.koreainvestment.com:29443" */
const KIS_BASE_URL = "https://openapi.koreainvestment.com:9443";

/** KIS CORS 프록시 URL ← 여기만 입력하면 끝!
 *  workers/kis-proxy.js를 Cloudflare에 배포 후 URL 입력.
 *  예: "https://kis-proxy.yourname.workers.dev" */
const KIS_PROXY_URL = "";

/** 포트폴리오 티커 → KIS 종목코드(6자리) 매핑
 *  holdings.json의 티커가 표준 6자리 숫자가 아닌 경우 여기서 매핑.
 *  순수 6자리 숫자(465580 등)는 자동 인식되므로 매핑 불필요. */
const KIS_TICKER_MAP = {
  // "0137V0": "473700",  // KWM SPMO → 실제 KRX 종목코드
  // "0041D0": "494300",  // Kdx AI소프트10 → 실제 KRX 종목코드
  // "0144L0": "490600",  // Kdx QDVO.A → 실제 KRX 종목코드
  // "0049M0": "495000",  // ACE DGRW+CCA → 실제 KRX 종목코드
  // "0019K0": "490100",  // TF NQ100+채권혼합 → 실제 KRX 종목코드
};

/** 국내 시장 섹터 분류 (국장 Risk 탭용) */
const KR_SECTORS = [
  { id: "kr-index",    label: "지수형 INDEX",    icon: "📊", color: "var(--blue)",   tickers: ["0137V0","426030","0019K0","484790"] },
  { id: "kr-growth",   label: "성장형 GROWTH",   icon: "🚀", color: "var(--purple)", tickers: ["465580","0041D0"] },
  { id: "kr-dividend", label: "배당형 DIVIDEND",  icon: "💰", color: "var(--green)",  tickers: ["0144L0","441640","0049M0","161510"] },
];
