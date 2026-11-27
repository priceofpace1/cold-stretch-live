// The Price of Pace: a worker with one job. Phones only let a worker post a notification, so the page hands its
// signal alerts to this one, and a tap on an alert opens the game. It caches nothing and answers no requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '#/board';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.postMessage({ go: url }); return c.focus(); }
    return self.clients.openWindow(`./${url}`);
  }));
});
