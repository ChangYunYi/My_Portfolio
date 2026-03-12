const CACHE_NAME = 'portfolio-v12';
const MAX_CACHE_ITEMS = 20; // 캐시 항목 수 제한
const ASSETS = [
  './index.html',
  './stock.html',
  './css/style.css',
  './js/config.js',
  './js/utils.js',
  './js/treemap.js',
  './js/tab-guard.js',
  './js/app.js',
  './js/kis-api.js',
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

// 활성화: 이전 버전 캐시 전부 삭제
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 캐시 항목 수 제한 (오래된 것부터 삭제)
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    await cache.delete(keys[0]);
    return trimCache(cacheName, maxItems);
  }
}

// 네트워크 우선, 실패 시 캐시 (앱 셸만 캐시, 외부 API 제외)
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // 외부 API 요청은 SW가 개입하지 않음
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
          caches.open(CACHE_NAME).then(cache => {
            cache.put(e.request, clone);
            trimCache(CACHE_NAME, MAX_CACHE_ITEMS);
          });
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
