/* 佩剑训练手账 Service Worker - v3 自我注销兜底 */
/* 此版本不缓存任何内容，加载后立即注销自己并清理所有缓存 */
/* 目的：清除手机上残留的旧版 SW，避免缓存导致页面不更新 */

const CACHE_PREFIX = 'sabre-journal';

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([
      // 清理所有相关缓存
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k.includes(CACHE_PREFIX)).map(k => caches.delete(k)))
      ),
      // 立即跳过等待
      self.skipWaiting()
    ])
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      // 再次清理所有缓存
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k.includes(CACHE_PREFIX)).map(k => caches.delete(k)))
      ),
      self.clients.claim(),
      // 通知所有客户端刷新
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.navigate(c.url))
      )
    ])
  );
});

// 不拦截任何 fetch 请求，全部透传
self.addEventListener('fetch', () => {});
