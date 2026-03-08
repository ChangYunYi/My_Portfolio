const CACHE_NAME = 'portfolio-v10';
const ASSETS = [
  './index.html',
  './stock.html',
  './css/style.css',
  './js/config.js',
  './js/utils.js',
  './js/treemap.js',
  './js/app.js',
  './js/risk-sentinel.js',
  './js/stock-detail.js',
  './data/sheets.json'
];

// 설치: 앱 셸 캐시
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 활성화: 이전 버전 캐시 삭제
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 네트워크 우선, 실패 시 캐시 (앱 셸만 캐시, 외부 API 제외)
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // 외부 API 요청은 SW가 개입하지 않음 (Yahoo, CORS프록시, Finnhub, FRED 등)
  if (url.includes('docs.google.com') ||
      url.includes('yahoo.com') ||
      url.includes('allorigins.win') ||
      url.includes('corsproxy.io') ||
      url.includes('finnhub.io') ||
      url.includes('api.stlouisfed.org')) return;

  // 같은 오리진(앱 셸)만 캐시
  if (!url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
