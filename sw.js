/* =====================================================================
 * 서비스워커 — 앱 껍데기를 캐시해 오프라인에서도 화면이 열리게 한다.
 *
 * 전략: 코드 파일(html/css/js)은 "네트워크 우선 + 3초 안에 응답 없으면 캐시".
 *   - 온라인이면 항상 최신 코드를 받는다 (고친 내용이 바로 반영된다)
 *   - 오프라인이면 즉시 캐시로 넘어가 앱이 그대로 열린다
 * 아이콘·manifest 처럼 잘 안 바뀌는 것은 캐시 우선으로 빠르게 준다.
 *
 * 데이터(Apps Script POST 호출)는 캐시하지 않는다.
 * 오프라인 저장은 app.js 의 IndexedDB 대기열이 담당한다.
 * ===================================================================== */

const CACHE = 'expense-shell-v2';
const NET_TIMEOUT = 3000;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/** 코드 파일인가? (자주 바뀌므로 네트워크를 먼저 본다) */
function isCode(url) {
  return /\.(html|css|js)$/i.test(url.pathname) || url.pathname.endsWith('/');
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // 하나라도 실패하면 전체가 실패하므로 개별로 담는다
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putCache(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                                // API 호출(POST)은 손대지 않는다
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // 외부 요청도 통과

  if (isCode(url)) {
    // 네트워크 우선 — 느리거나 끊기면 캐시로
    e.respondWith(
      new Promise(resolve => {
        let settled = false;
        const done = r => { if (!settled) { settled = true; resolve(r); } };

        const timer = setTimeout(() => {
          caches.match(req).then(hit => { if (hit) done(hit); });
        }, NET_TIMEOUT);

        fetch(req, { cache: 'no-store' })
          .then(res => { clearTimeout(timer); done(putCache(req, res)); })
          .catch(() => {
            clearTimeout(timer);
            caches.match(req).then(hit => done(hit || Response.error()));
          });
      })
    );
    return;
  }

  // 그 밖(아이콘 등)은 캐시 우선
  e.respondWith(
    caches.match(req).then(hit =>
      hit || fetch(req).then(res => putCache(req, res)).catch(() => hit))
  );
});
