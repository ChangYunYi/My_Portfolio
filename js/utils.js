/* ═══════════════════════════════════════════════════════
   utils.js — 공용 헬퍼 함수
   index.html + stock.html 모두에서 사용
   ═══════════════════════════════════════════════════════ */

// ── Google Sheets 셀 접근 헬퍼 ──

/** 셀 값 반환 (raw value) */
function V(t, r, c) {
  const cell = t?.rows?.[r]?.c?.[c];
  return cell ? cell.v : null;
}

/** 셀 값을 숫자로 반환 (통화·퍼센트 기호 제거) */
function Vn(t, r, c) {
  const v = V(t, r, c);
  if (typeof v === "number") return v;
  if (v == null) return 0;
  return parseFloat(String(v).replace(/[₩$,%▲▼\s]/g, "").replace(/,/g, "")) || 0;
}

/** 셀의 포맷팅된 값(f) 또는 원시값(v)을 문자열로 반환 */
function Vf(t, r, c) {
  const cell = t?.rows?.[r]?.c?.[c];
  if (!cell) return "";
  return cell.f != null ? String(cell.f) : (cell.v != null ? String(cell.v) : "");
}

/** 셀 값을 문자열로 반환 */
function Vs(t, r, c) {
  return String(V(t, r, c) || "");
}


// ── 숫자 변환 ──

/** 소수(0~1)를 백분율로 변환. 이미 백분율이면 그대로 반환 */
function p100(v) {
  return typeof v === "number" ? (Math.abs(v) < 1 ? v * 100 : v) : 0;
}


// ── 통화 포맷팅 ──

/** 달러 정수 포맷: $12,345 */
function fU(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** 달러 소수점 포맷: $12,345.67 */
function fUd(n) {
  return "$" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 원화 축약 포맷: 1.2억 / 5,000만 / 12,345원 */
function fK(n) {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(1) + "억";
  if (a >= 1e4) return Math.round(n / 1e4).toLocaleString() + "만";
  return Math.round(n).toLocaleString() + "원";
}

/** 퍼센트 포맷: +12.34% */
function fP(n) {
  return (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "%";
}

/** 큰 금액 축약 ($): $1.2T / $3.4B / $56M */
function fB(v) {
  const a = Math.abs(v);
  if (a >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9)  return "$" + (v / 1e9).toFixed(1) + "B";
  if (a >= 1e6)  return "$" + (v / 1e6).toFixed(0) + "M";
  return "$" + v.toLocaleString();
}


// ── 색상 유틸 ──

/** 양수=초록, 음수=빨강 CSS 변수 반환 */
function pc(n) {
  return n >= 0 ? "var(--green)" : "var(--red)";
}

/** 양수=b-up, 음수=b-dn 클래스명 반환 */
function bc(n) {
  return n >= 0 ? "b-up" : "b-dn";
}


// ── ETF 판별 ──

/** 티커가 ETF인지 판별 */
function isETF(ticker) {
  if (!ticker) return false;
  if (ticker.startsWith("KRX:")) return true;
  return ETF_TICKERS.has(ticker.toUpperCase());
}


// ── Risk Sentinel ID 정규화 ──

/** 티커/라벨을 DOM-safe ID로 변환 */
function rsSafeId(t) {
  return (t || '').replace(/[^a-zA-Z0-9]/g, '_');
}
