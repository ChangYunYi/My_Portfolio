/**
 * KIS OpenAPI CORS Proxy — Cloudflare Worker
 *
 * 배포 방법 (5분 소요):
 * ──────────────────────────────────────────────
 * 1. https://dash.cloudflare.com 접속 → 회원가입/로그인
 * 2. 왼쪽 사이드바 → "Compute (Workers)" → "Workers & Pages"
 * 3. "Create" 버튼 클릭
 * 4. "Start with Hello World!" 옆 "Get started" 클릭
 * 5. Worker 이름 입력 (예: kis-proxy) → "Deploy" 클릭
 * 6. "Edit code" 클릭 → 에디터에서 기본 코드 전체 삭제
 * 7. 이 파일(kis-proxy.js) 내용 전체 복사+붙여넣기
 * 8. 오른쪽 상단 "Deploy" 클릭
 * 9. 뒤로 나가서 Worker 상세 페이지 → "Settings" 탭
 * 10. "Variables and Secrets" 에서 "Add" 클릭:
 *     - Type: "Secret" 선택
 *     - Variable name: KIS_APP_KEY  / Value: 발급받은 앱키
 *     - "Add" 한 번 더 클릭
 *     - Variable name: KIS_APP_SECRET / Value: 발급받은 앱시크릿
 *     → "Deploy" 클릭
 * 11. Worker URL 복사 (예: https://kis-proxy.yourname.workers.dev)
 * 12. config.js의 KIS_PROXY_URL에 해당 URL 입력
 *
 * ⚡ 이 방식의 장점:
 *    - API 키가 Worker에만 저장됨 (브라우저 노출 없음!)
 *    - Cloudflare 무료 플랜: 일 100,000 요청
 *    - CORS 문제 완전 해결
 *    - 응답 속도 빠름 (Cloudflare 엣지 네트워크)
 * ──────────────────────────────────────────────
 */

const KIS_BASE = "https://openapi.koreainvestment.com:9443";

// 허용할 오리진 (GitHub Pages URL로 변경)
const ALLOWED_ORIGINS = [
  "https://changyunyi.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, authorization, appkey, appsecret, tr_id, tr_cont, custtype",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname + url.search;

      // KIS API로 프록시
      const kisUrl = KIS_BASE + path;

      // 요청 헤더 구성 (Worker의 환경변수에서 키 주입)
      const headers = new Headers(request.headers);
      if (env.KIS_APP_KEY) headers.set("appkey", env.KIS_APP_KEY);
      if (env.KIS_APP_SECRET) headers.set("appsecret", env.KIS_APP_SECRET);

      // POST 요청 (토큰 발급)인 경우 body에도 키 주입
      let body = null;
      if (request.method === "POST") {
        const original = await request.json().catch(() => ({}));
        body = JSON.stringify({
          ...original,
          appkey: env.KIS_APP_KEY || original.appkey,
          appsecret: env.KIS_APP_SECRET || original.appsecret,
        });
        headers.set("Content-Type", "application/json");
      }

      const resp = await fetch(kisUrl, {
        method: request.method,
        headers,
        body,
      });

      // 응답에 CORS 헤더 추가
      const respHeaders = new Headers(resp.headers);
      Object.entries(cors).forEach(([k, v]) => respHeaders.set(k, v));

      return new Response(resp.body, {
        status: resp.status,
        headers: respHeaders,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};
