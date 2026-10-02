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

// A buzz long enough to be felt through an apron pocket, and long enough to
// still be going when a phone is picked up. Only used for `alarm` pushes — a
// task reminder gets the phone's ordinary one.
//
// Vibration is the one part of "make a noise" a service worker genuinely
// controls, and it is the part that matters most: on a phone in silent mode
// it is the ONLY thing left. The sound is not up to this file at all — Chrome
// ignores the Notification `sound` option, and a worker has no <audio> and no
// AudioContext. See the header of server/integrations/whatsappAlerts.js for
// where the actual noise comes from in each of the three cases.
//
// Roughly six seconds of on/off. Android caps what it will honour, and the
// notification channel's own vibration setting wins on Android 8 and up — so
// this is the request, not the guarantee, and ALARM-SETUP.md covers the
// channel setting that makes it stick.
const ALARM_VIBRATE = [600, 200, 600, 200, 600, 200, 600, 200, 600, 200, 900];

// The payload is the JSON built in server/sprint/taskReminders.js (reminders)
// or server/integrations/whatsappAlerts.js (alarms).
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

  const isAlarm = Boolean(data.alarm);
  const title = data.title || 'Smoke Rings BBQ';
  const options = {
    body: data.body || '',
    icon: '/notification-icon.png',
    // Android tints this to a flat silhouette for the status bar.
    badge: '/notification-badge.png',
    // Same tag replaces the previous notification instead of stacking under
    // it — one line per task, one for the digest, one per conversation.
    // renotify makes that replacement buzz, which is the point of a reminder.
    tag: data.tag || 'smokerings',
    renotify: true,
    // The reminder should sit in the shade until it is dealt with, rather than
    // disappearing after a few seconds while someone's hands are covered in rub.
    requireInteraction: true,
    data: { url: data.url || '/', alarm: data.alarm || null, channelId: data.channelId ?? null },
  };
  if (isAlarm) {
    options.vibrate = ALARM_VIBRATE;
    // Stated outright rather than left to the default. A notification that
    // Android has decided is silent gets no vibration either, and this is the
    // path that has to work with nothing open and the phone face-down in a
    // pocket — so nothing about it is left implicit.
    options.silent = false;
  }

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Every push must show a notification (Chrome enforces userVisibleOnly),
      // so the notification above is not optional even when a page is already
      // open. Telling the page as well is what turns a silent tile in the
      // shade into a sound: the kitchen tablet left on the dashboard is the
      // one surface that CAN play the file, and it only finds out from here.
      isAlarm ? startAlarmOnClients(data) : Promise.resolve(),
    ]),
  );
});

// Ask every open dashboard window to start the alarm.
//
// includeUncontrolled:true matters — a tab loaded before this worker took
// control is still a window that can play audio, and leaving it out is how
// this silently does nothing on exactly the long-lived kitchen tab it was
// written for.
function startAlarmOnClients(data) {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windows) => {
      for (const client of windows) {
        client.postMessage({
          type: 'whatsapp-alarm',
          channelId: data.channelId ?? null,
          customer: data.customer || data.title || '',
          body: data.body || '',
        });
      }
    })
    .catch(() => undefined);
}

// Tapping a reminder should land on the task list — reusing the window that is
// already open if there is one, so this doesn't accumulate a dozen dashboard
// tabs over a week.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || '/', self.location.origin);
  const isAlarm = Boolean(data.alarm);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        // Same origin is enough to reuse: navigating an already-open dashboard
        // is faster than a cold start, and this app is a single page anyway.
        if (new URL(client.url).origin === target.origin && 'focus' in client) {
          return client.focus().then((focused) => {
            // An alarm tap on an already-open window is told, not navigated.
            //
            // navigate() to ?alarm=… would reload the page, and a reload tears
            // down the <audio> element mid-laugh — so the one action that is
            // supposed to bring the alarm to the front would instead stop it.
            // A message does the same job and keeps the sound going.
            if (isAlarm && focused && 'postMessage' in focused) {
              focused.postMessage({
                type: 'whatsapp-alarm',
                channelId: data.channelId ?? null,
                customer: event.notification.title || '',
                body: event.notification.body || '',
                opened: true,
              });
              return focused;
            }
            if (focused && 'navigate' in focused && focused.url !== target.href) {
              return focused.navigate(target.href).catch(() => focused);
            }
            return focused;
          });
        }
      }
      // Nothing open — a cold start on the ?alarm= URL, which the page reads
      // on boot and turns straight back into the alarm.
      return self.clients.openWindow ? self.clients.openWindow(target.href) : undefined;
    }),
  );
});
