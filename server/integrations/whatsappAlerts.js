// The loud half of the WhatsApp inbox: a customer message that arrives while
// nobody is looking at a screen.
//
// The badge in the sidebar (useWhatsappAttention.ts) already answers "is
// anyone waiting", but it only answers it to someone who is looking at the
// dashboard. Mid-service, with the smoker running and a phone in a pocket,
// that is nobody. This module is the other direction: legion notices the
// message and goes and finds you.
//
// It deliberately reuses the inbox rather than querying Odoo again, so an
// alert can never describe a message the WhatsApp Inbox screen doesn't show.
// One source of truth, two ways of finding out about it.
//
// ---- What actually makes noise, and where ------------------------------
//
// This is worth writing down because it is the part that surprises people. A
// service worker CANNOT play an audio file. It has no <audio>, no
// AudioContext, and Chrome ignores the Notification `sound` option outright.
// So "play the alarm" has three different answers depending on where the
// phone or tablet is at that moment, and all three are wired up:
//
//   1. NO PAGE OPEN (phone in a pocket, home-screen shortcut closed) — the
//      only sound available is the one Android's notification channel is set
//      to. The push therefore carries a long `vibrate` pattern and
//      requireInteraction, and the custom file is installed once, by hand, as
//      the channel's ringtone. See ALARM-SETUP.md — it is a three-minute job
//      on the handset and it is what makes this audible from another room.
//
//   2. A PAGE IS OPEN (kitchen tablet, desktop left on the dashboard) — the
//      worker postMessages every open client and the page loops the real file
//      at full volume until it is dismissed. See src/lib/whatsappAlarm.ts.
//
//   3. THE NOTIFICATION IS TAPPED — the worker opens the dashboard with
//      ?alarm= on it, and the page starts the same loop on arrival. Chrome
//      allows unmuted autoplay for a site launched from the home screen, and
//      the tap is a user gesture regardless, so this one always works.
//
//   4. NO BROWSER RUNNING AT ALL — legion plays the file through its own
//      speakers. See localAlarm.js. This is the only one of the four that
//      does not depend on a browser process being alive somewhere: 1, 2 and 3
//      all begin with a push, and a push is delivered BY the browser, not by
//      the OS. Chrome fully closed on the desktop, or swiped away and
//      battery-restricted on the phone, and none of them happen. Audible only
//      near the machine, but it never silently stops working.
//
// ---- Not firing twice ---------------------------------------------------
//
// Same mechanism as the daily reminders: every message id is claimed in
// push_delivery before anything is sent, so a one-minute timer cannot send
// sixty copies. See claimDelivery() in core/pushNotify.js.
//
// What that alone does not solve is the cold start. push_delivery is pruned
// after three weeks, and on a database that has never run this, NO message id
// has been claimed — so the first tick would find every customer message in
// the last month "new" and set off a dozen alarms at once. Rather than add a
// high-water-mark table for it, an alert has to be RECENT as well as
// unclaimed: anything older than ALERT_GRACE_MINUTES is treated as news that
// has already been missed. That bounds the cold start to at most a few
// minutes of real messages, and it is the same reasoning (and roughly the same
// code) as the grace window in sprint/taskReminders.js — a message that landed
// while legion was asleep is not worth an alarm at 2am; it is worth a badge,
// which it already has.
import { claimDelivery, sendToAll, subscriptionCount } from '../core/pushNotify.js';
import { isLocalAlarmEnabled, startLocalAlarm } from './localAlarm.js';
import { fetchWhatsappThreads } from './odooWhatsapp.js';

// How late a message may be and still set off the alarm. Ten minutes is about
// one poll cycle plus a restart: long enough that `node server/index.js`
// coming back up doesn't silently swallow the message that arrived during it,
// short enough that legion waking after a night off doesn't replay the night.
const DEFAULT_GRACE_MINUTES = 10;

// The notification body, on one line. Android collapses it to roughly this
// much anyway, and the full text is on the screen the tap leads to.
const MAX_PREVIEW = 120;

function previewOf(text) {
  const oneLine = String(text || '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!oneLine) return 'Sent a message.';
  return oneLine.length > MAX_PREVIEW ? `${oneLine.slice(0, MAX_PREVIEW - 1)}…` : oneLine;
}

function parseAt(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The alerts that are due right now, one per conversation.
 *
 * Pure: it sends nothing and writes nothing, which is what lets the firing
 * rules be tested without a push service or an Odoo. Takes the inbox exactly
 * as fetchWhatsappThreads() returns it.
 *
 * Each alert carries EVERY new message id in `keys`, not just the one being
 * announced. Two messages landing in the same thread between ticks are one
 * notification — a phone buzzing twice for one customer typing twice is noise
 * — but both ids still get claimed, so the older one cannot come back as its
 * own alarm on the next pass.
 */
function dueAlerts(inbox, now = new Date(), options = {}) {
  const { graceMinutes = DEFAULT_GRACE_MINUTES } = options;
  if (!inbox?.available || !Array.isArray(inbox.threads)) return [];

  const floor = now.getTime() - graceMinutes * 60000;
  const out = [];

  for (const thread of inbox.threads) {
    const fresh = (thread.messages || [])
      .filter((message) => message.from === 'customer')
      .map((message) => ({ message, at: parseAt(message.at) }))
      // A message with no parseable timestamp is skipped rather than assumed
      // recent: the alternative is an alarm for something that might be from
      // last March.
      .filter((entry) => entry.at && entry.at.getTime() >= floor)
      .sort((a, b) => a.at - b.at);

    if (!fresh.length) continue;

    const latest = fresh[fresh.length - 1].message;
    const extra = fresh.length - 1;

    out.push({
      // Keyed by mail.message id, which is Odoo's own primary key — stable,
      // never reused, and the same id the inbox screen is showing.
      keys: fresh.map((entry) => `wa-msg:${entry.message.id}`),
      channelId: thread.channelId,
      payload: {
        title: thread.customer || 'WhatsApp',
        body: extra
          ? `${previewOf(latest.text)}\n+ ${extra} more message${extra === 1 ? '' : 's'}`
          : previewOf(latest.text),
        // One tag per conversation: a second message from the same customer
        // replaces the first in the shade rather than stacking under it, and
        // renotify (set in sw.js) makes that replacement buzz again.
        tag: `whatsapp-${thread.channelId}`,
        // There is no router in this app — the path is ignored and the query
        // is what the page reads on boot. See whatsappAlarm.ts.
        url: `/?alarm=whatsapp&channel=${thread.channelId}`,
        // The flag the service worker and the page both key off. Everything
        // else this server pushes (the daily digest, task nudges) leaves it
        // unset and stays quiet.
        alarm: 'whatsapp',
        channelId: thread.channelId,
        customer: thread.customer || '',
      },
    });
  }

  return out;
}

/**
 * One pass of the timer: read the inbox, work out what is new, claim it, send.
 *
 * Never throws. This is called from a setInterval, and an unhandled rejection
 * in a timer takes the whole process down with it — which on legion means the
 * dashboard, the daily reminders and this all stop together.
 */
async function runWhatsappAlertTick(now = new Date(), options = {}) {
  try {
    // Nothing to deliver TO means nothing can be delivered, and a claim taken
    // now would permanently mark this message as alerted for a notification
    // nobody ever got. Same reasoning as runReminderTick: a claim is a record
    // of a delivery, so there is nothing to record until there is somewhere to
    // deliver to.
    //
    // legion's own speakers count as somewhere. That is the whole point of
    // them — they are what is left when no phone is subscribed or no browser
    // is running to receive a push — so a machine that can make a noise is
    // never "nothing subscribed", and this must not short-circuit on the one
    // configuration the local alarm exists for.
    if (!subscriptionCount() && !isLocalAlarmEnabled()) {
      return { considered: 0, sent: 0, skipped: 'no subscriptions' };
    }

    const inbox = await fetchWhatsappThreads();
    // An unconfigured Odoo, or one without the WhatsApp module, comes back
    // well-formed and unavailable rather than throwing — so this is a quiet
    // no-op on a machine that hasn't finished being wired up, not a console
    // full of 503s once a minute.
    if (!inbox.available) return { considered: 0, sent: 0, skipped: inbox.reason || 'unavailable' };

    const due = dueAlerts(inbox, now, options);
    if (!due.length) return { considered: 0, sent: 0 };

    let sent = 0;
    let announced = 0;
    for (const alert of due) {
      // Claim every id first, and only then decide whether to announce. Doing
      // it in this order means a thread whose ids were all already claimed
      // sends nothing, while a thread with one genuinely new message among
      // three old ones still buzzes once.
      const claimed = alert.keys.filter((key) => claimDelivery(key));
      if (!claimed.length) continue;
      announced += 1;
      // Legion's speakers first, and not awaited. It is the half that works
      // with every browser on the property shut, and spawning it costs a few
      // milliseconds — whereas sendToAll goes over the network to a push
      // service, and making the noise in this room wait on that is backwards.
      startLocalAlarm({ customer: alert.payload.customer, body: alert.payload.body });
      const result = await sendToAll(alert.payload);
      sent += result.sent || 0;
    }

    return { considered: due.length, announced, sent };
  } catch (err) {
    console.error('[whatsapp-alert] tick failed —', err.message);
    return { considered: 0, sent: 0, error: err.message };
  }
}

/**
 * The "test the alarm" button: one alarm-flagged push, right now, with no
 * claim taken so it can be pressed as many times as it takes to get the
 * Android channel sound set up.
 *
 * Its own tag, for the reason sendPendingDigestNow() documents: sharing a tag
 * with the real thing makes a test replace whatever is in the shade, in place
 * and possibly silently, which is the least useful outcome a test can have.
 */
// How long the test sounds on legion itself. Long enough to walk to the door
// and hear whether it carries, short enough that a test pressed by mistake
// stops on its own before it becomes a nuisance — the real alarm's five
// minutes are for a message worth interrupting service over, which a test is
// not.
const TEST_LOCAL_SECONDS = 20;

async function sendAlarmTest(now = new Date()) {
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // The local half is started first and reported separately below, because the
  // two halves fail independently: legion's speakers working tells you nothing
  // about whether the phone will buzz, and vice versa. A single "Sent." would
  // hide exactly the distinction the test exists to draw.
  const local = startLocalAlarm({
    customer: 'Test',
    body: 'Alarm test',
    seconds: TEST_LOCAL_SECONDS,
  });
  const result = await sendToAll({
    title: `WhatsApp alarm test ${clock}`,
    body: 'If a page is open it should be sounding now. Tap this to open the dashboard and hear it.',
    tag: 'whatsapp-alarm-test',
    url: '/?alarm=whatsapp&test=1',
    alarm: 'whatsapp',
    customer: 'Test',
  });
  const pushPart = result.sent
    ? `Sent to ${result.sent} device${result.sent === 1 ? '' : 's'}.`
    : 'No subscribed devices — turn notifications on first.';
  const localPart = local.started
    ? ` Legion is sounding for ${TEST_LOCAL_SECONDS}s${local.sound === 'beep' ? ' (beeps — the sound file could not be prepared)' : ''}.`
    : ` Legion is silent: ${local.reason || 'unavailable'}.`;

  return { ...result, local, message: `${pushPart}${localPart}` };
}

export { dueAlerts, runWhatsappAlertTick, sendAlarmTest, DEFAULT_GRACE_MINUTES, TEST_LOCAL_SECONDS };
