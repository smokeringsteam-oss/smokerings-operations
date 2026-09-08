// The service worker, and deliberately nothing more than a push receiver.
//
// It has NO fetch handler, on purpose. A service worker that intercepts fetch
// is how a PWA goes offline, but it is also how it starts serving yesterday's
// JavaScript — and in this project it would sit directly in the path of Vite's
// dev server and HMR. Notifications need none of that: a push handler and a
// click handler are the whole requirement. If offline support is ever wanted,
// it belongs in a separate, versioned cache strategy rather than bolted on
// here, because the failure mode of getting it wrong is a dashboard that shows
// stale numbers with no indication that it is doing so.
//
// Served from public/, so Vite hands it out at /sw.js in dev and copies it to
// dist/ on build. That root path matters: a worker's scope cannot rise above
// its own URL, and this one has to cover the whole app.

// Take over immediately rather than waiting for every tab to close. Without
// these two, a change here would sit unused until the phone's last dashboard
// tab was closed, which on a home-screen shortcut can be weeks.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The payload is the JSON built in server/sprint/taskReminders.js.
//
// Every field is defended, because this runs on a phone with no console anyone
// will ever read: a malformed or bodyless push must still produce a visible
// notification rather than throwing inside the worker and showing nothing.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data && event.data.text ? event.data.text() : '' };
  }

  const title = data.title || 'Smoke Rings BBQ';
  const options = {
    body: data.body || '',
    icon: '/notification-icon.png',
    // Android tints this to a flat silhouette for the status bar.
    badge: '/notification-badge.png',
    // Same tag replaces the previous notification instead of stacking under
    // it — one line per task, one for the digest. renotify makes that
    // replacement buzz, which is the point of a reminder.
    tag: data.tag || 'smokerings',
    renotify: true,
    // The reminder should sit in the shade until it is dealt with, rather than
    // disappearing after a few seconds while someone's hands are covered in rub.
    requireInteraction: true,
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a reminder should land on the task list — reusing the window that is
// already open if there is one, so this doesn't accumulate a dozen dashboard
// tabs over a week.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        // Same origin is enough to reuse: navigating an already-open dashboard
        // is faster than a cold start, and this app is a single page anyway.
        if (new URL(client.url).origin === target.origin && 'focus' in client) {
          return client.focus().then((focused) => {
            if (focused && 'navigate' in focused && focused.url !== target.href) {
              return focused.navigate(target.href).catch(() => focused);
            }
            return focused;
          });
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target.href) : undefined;
    }),
  );
});
