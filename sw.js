/* 佩剑训练手账 Service Worker - network-first + 离线回退 */
const CACHE = 'sabre-journal-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 安装：预缓存 + 立即激活
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存 + 立即接管
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll().then(clients => clients.forEach(c => c.navigate(c.url))))
  );
});

// fetch：network-first（优先拿最新版本，离线时才用缓存）
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        // 成功拿到网络响应，更新缓存
        if (resp && resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => {
        // 网络失败，回退到缓存
        return caches.match(e.request).then(cached => cached || caches.match('./index.html'));
      })
  );
});