// Lets phones install Cohort as an app. Nothing is cached: pages always come from the server,
// and when the phone is offline the app says so instead of showing a browser error.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Offline</title><body style="font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 20px;color:#131A2C;background:#F2F4F7">'
    + '<h1 style="font-size:22px;margin:0 0 8px">You are offline</h1><p style="margin:0">Connect to the internet, then reopen Cohort.</p></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )));
});
