/* ═══════════════════════════════════════════════════════
   config.js — 전역 상수 및 설정
   ═══════════════════════════════════════════════════════ */

/** Google Sheets 문서 ID (공개 읽기 전용) */
const SID = "1b9GtLud9TDFm4AvUnCEfDGu_4CTqYfRU8oYFAh2VSxc";

/** 로드할 시트 이름 목록 */
const SHEETS = [
  "TotalBoard",
  "지수형 포트폴리오",
  "배당 포트폴리오",
  "성장 포트폴리오",
  "국내 포트폴리오",
  "데이터시트",
  "데이터시트2"
];

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

/** 국내 시장 섹터 분류 (국장 Risk 탭용) */
const KR_SECTORS = [
  { id: "kr-index",    label: "지수형 INDEX",    icon: "📊", color: "var(--blue)",   tickers: ["0137V0","426030","0019K0","484790"] },
  { id: "kr-growth",   label: "성장형 GROWTH",   icon: "🚀", color: "var(--purple)", tickers: ["465580","0041D0"] },
  { id: "kr-dividend", label: "배당형 DIVIDEND",  icon: "💰", color: "var(--green)",  tickers: ["0144L0","441640","0049M0","161510"] },
];
