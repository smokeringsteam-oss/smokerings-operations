# The WhatsApp alarm — making the phone loud

A new customer message in Odoo now sets off an alarm: a push notification, and
the Voldemort laugh (`public/whatsapp-alert.mp3`) on loop until someone stops
it.

The push half works the moment the server restarts. **The loud half on a phone
with no page open needs one manual step on the handset**, and this file is
that step and why it exists.

## What works with the dashboard closed, and what doesn't

With the phone in a pocket and the shortcut closed:

| | Works closed? |
| --- | --- |
| Legion's own speakers | **Yes**, always — this is the only row that depends on nothing but the server. |
| The notification appearing | **Only while the browser process is alive.** See "the browser has to be running" below — this is the one that surprises people. |
| Vibrating, including on silent | **Yes**, if the notification arrives at all — a ~6 second pattern, as long as the site's notification channel has vibration on (step 4 below). |
| The Voldemort laugh on the phone | **Only** if you set it as the channel's ringtone — the manual step below. |

### The browser has to be running

Worth stating plainly, because "the notification never came" almost always
turns out to be this and it looks exactly like a bug:

**A web push is delivered by the browser process, not by the operating
system.** No browser running, no notification — and no `sw.js`, and therefore
no page told to play the file. Nothing in this repo can change that; it is the
push model working as designed.

What that means per device:

- **Desktop Chrome on Windows.** Closing the last Chrome window *exits Chrome*
  by default, and push stops with it. Fix: `chrome://settings/system` →
  **"Continue running background apps when Google Chrome is closed"** → on.
  Chrome then lives in the system tray and keeps receiving. Caveats: right-
  clicking the tray icon → **Exit** still kills it, and the machine must be
  awake.
- **Android Chrome.** Swiping Chrome away is survivable, but only if battery
  optimisation lets it be — see the numbered list further down, which is the
  same problem in a different costume.

This is why legion's own speakers exist, and why they are the first row of the
table above rather than a footnote: they are the only part of the alarm with no
browser anywhere in the chain.

### Why the phone's sound needs a manual step

The reason the sound needs a manual step, and vibration doesn't, is worth
knowing so it doesn't look like something left unfinished:

- A service worker cannot play an audio file. It has no `<audio>`, no
  `AudioContext`, and Chrome ignores the Notification `sound` option outright.
  There is no code that can fix this — the mp3 can only be played by a page,
  and with the shortcut closed there is no page.
- Vibration is different: the notification carries a vibrate pattern, and
  Android honours it with nothing open. That is why the buzz works closed and
  the laugh does not.
- So the laugh, with nothing open, has to be the **channel's ringtone** — set
  once, in Android, below. After that it plays for every alarm, closed or not.

Once a page *is* open (or the moment you tap the notification), the mp3 loops
at full volume and the page vibrates on its own timer until you press Stop.

## The Android app (APK)

The app is a Trusted Web Activity built from the `Website-Hoster` repo: it runs
this site inside Chrome's engine, and Chrome hands the site's notifications to
the app, so the same push shows under the app's name and icon. Nothing extra is
sent — it is the web push above, displayed by the app. Three things have to
line up or the notifications stay under Chrome:

- **The APK must be built with the URL the site is really served on**
  (`https://smokerings-ops.tail946602.ts.net/`). A domain that only redirects
  there does not count: the app is then on an origin it was not built for.
- **`public/.well-known/assetlinks.json` must carry that build's package name
  and signing fingerprint.** The build prints the JSON. Without a permanent
  signing key the fingerprint changes on every build, and this file has to be
  replaced each time.
- **Notifications must be switched on from inside the app** (Daily View), once.

Built with `alarm_sound` and `alarm_tag: whatsapp-`, the app puts the WhatsApp
alarm on its own **Alarms** channel with the laugh bundled as its sound — so in
the app the laugh plays closed, and the manual step below is only needed for
plain Chrome.

## The one manual step (about three minutes)

1. Copy `public/whatsapp-alert.mp3` to the phone, into its **`Ringtones`** or
   **`Notifications`** folder. (Anywhere else and Android won't offer it in the
   picker.)
2. Make sure the alarm has fired at least once, so the channel exists — Daily
   View → **🚨 Test alarm**.
3. On the phone: **Settings → Apps → Chrome → Notifications →
   `legion.tail946602.ts.net` → Sound** → pick the laugh.
4. While you're there, set **Importance / Behaviour** to *Urgent — make sound
   and pop on screen*, and turn **Override Do Not Disturb** on if you want it
   through DND.

Android keeps the sound per site, so this affects the WhatsApp alarm and the
daily task reminders equally. If you want the laugh for one and not the other,
that needs separate channels, which the Web Push API cannot set from the
server — it would mean splitting the two across two origins, which is not
worth it.

## When nothing arrives at all, with Chrome closed

This happened on the first handset here, and it is worth its own section
because it looks exactly like a broken alarm and is not one.

The giveaway is the server side: `POST /api/push/alarm-test` returns
`{"sent":2,"failed":0}`. That means legion built the push, signed it, and FCM
**accepted** it. Everything this repo controls worked. A notification that then
never appears is being dropped by Android, and there are three usual causes —
check them in this order, because the first is silent and the most common:

1. **Chrome's own Android notification permission (Android 13+).**
   Settings → Apps → Chrome → Notifications → the master toggle at the top.
   If that is off, *nothing* Chrome shows will ever appear, whatever the
   per-site setting says. Granting a site permission in the browser does not
   grant this one.

2. **Battery optimisation killing Chrome in the background.**
   Settings → Apps → Chrome → Battery → **Unrestricted**. Aggressive by
   default on Xiaomi, Oppo, Vivo, OnePlus and Samsung, and it stops web push
   dead once Chrome has been swiped away or idle for a while. On Xiaomi/Oppo
   also turn on **Autostart** for Chrome.

3. **The per-site channel disabled or silenced.**
   Settings → Apps → Chrome → Notifications → `legion.tail946602.ts.net`.
   On, and importance **Urgent**.

Daily View's **Troubleshoot** → **Test without push** splits the last two
apart definitively: it shows a notification straight from the service worker
with no push service involved. If *that* does not appear, the problem is 1 or
3 and nothing about delivery is worth investigating. If it does appear but a
real push does not, it is 2.

### If it still will not stay alive

Some handsets simply will not keep a web push subscription alive through
aggressive power management, and no amount of setting-changing fixes it for
good. That is what the next section is for.

## Legion's own speakers

The half of the alarm that needs no browser at all. Implemented in
`server/integrations/localAlarm.js`; on by default on Windows, nothing to set
up.

When a customer message is announced, legion plays `public/whatsapp-alert.mp3`
through its own audio output at the same moment it sends the push. The two run
together rather than one falling back to the other — which of them reaches
anybody depends on where they are standing, and the server cannot know that.

What to know about it:

- **It works with every browser on the property shut.** That is the entire
  point. It needs this process running, which it has to be anyway or there is
  nothing to notice the message in the first place.
- **It is audible only near the machine.** It does not replace the phone push;
  it covers the case where the phone push silently isn't arriving.
- **It stops on its own after five minutes** (`LOCAL_ALARM_MAX_MINUTES`).
  There is no Stop button in the room — the dashboard's Stop reaches it over
  the network, and the whole point of this path is that it works when no
  dashboard is open. So it always ends by itself.
- **Pressing Stop on the dashboard banner silences it too**, via
  `POST /api/push/alarm-stop`. One press stops both halves, which is what
  anybody pressing Stop means.
- **Loudness is Windows' own output volume.** The player Windows ships
  (`System.Media.SoundPlayer`) has no volume control of its own, so if it is
  too quiet the fix is the system volume mixer.
- **A restart does not strand it.** The server runs under `node --watch` and
  restarts on every backend edit; a shutdown hook stops the sound first, so a
  save mid-alarm cannot leave a laugh looping with no way to reach it.

### If legion is silent

`GET /api/push/status` now reports a `localAlarm` block — `enabled`, `running`
and, when it is off, a `reason`. The reasons are:

| `reason` | Meaning |
| --- | --- |
| `LOCAL_ALARM=off` | Switched off in `.env`. |
| `no local audio on <platform>` | Not Windows. PowerShell and SoundPlayer are both Windows-only. |

If it says `enabled` and you still hear nothing: check the system volume and
the output device. The test button's reply also distinguishes the two halves —
it says how many phones it reached *and* whether legion is sounding.

One degraded mode worth recognising: the mp3 is converted to WAV once (via the
`ffmpeg-static` the reel pipeline already depends on) and cached in the temp
directory. If that conversion cannot happen, the alarm falls back to looping
console beeps rather than going quiet, and the test button says so. Crude on
purpose — the situation where that fires is the one where nothing else in the
chain is working either.

## Testing it

Daily View has two buttons, and they prove different things:

- **Send now** — the daily digest. Proves *delivery*: VAPID keys, the
  subscription, the push service.
- **🚨 Test alarm** — proves the *noise*, both halves of it: legion's own
  speakers sound for 20 seconds, and a push goes out carrying the channel
  sound, the vibrate pattern and the flag that starts the audio loop on any
  open page. Its reply names them separately, e.g. *“Sent to 2 devices.
  Legion is sounding for 20s.”*

Reading the result:

| Legion sounds? | Phone sounds? | Where the fault is |
| --- | --- | --- |
| Yes | Yes | Nothing to fix. |
| Yes | No | The handset — the browser isn't running, or step 3 above, or media volume, or Do Not Disturb. Not legion. |
| No | Yes | The machine's audio, or `LOCAL_ALARM=off`. Check the `localAlarm` block in `/api/push/status`. |
| No | No | Legion isn't running, or the button never reached it. |

## What can turn it off

| Setting | Effect |
| --- | --- |
| `WHATSAPP_ALERTS=off` | Disables the alarm entirely, leaving task reminders alone. |
| `WHATSAPP_ALERT_GRACE_MINUTES` | How old a message may be and still alarm. Default 10. |
| `LOCAL_ALARM=off` | Silences legion's own speakers, leaving the push half alone. Set this on a second checkout of the repo. |
| `LOCAL_ALARM_MAX_MINUTES` | How long legion keeps sounding unattended. Default 5. |

## The limits worth knowing before relying on it

- **Legion must be awake** with `node server/index.js` running. A message that
  arrives while it is asleep is not alarmed late — it is not alarmed at all.
  It still shows on the WhatsApp Inbox badge. This is now the *only* shared
  dependency of the whole feature: everything else has two independent paths.
- **A browser must be running for the phone half**, on whichever device you
  expect the notification. Legion's speakers are the half that doesn't care.
- **Nothing older than the grace window alarms.** That is deliberate: without
  it, a restart in the evening would replay the whole day at once, and the
  first run on a fresh database would alarm for every message in the inbox.
- **Polling is once a minute**, the same beat as the inbox badge — so the
  worst case between a customer sending and the phone going off is about 60
  seconds plus WhatsApp's own delivery to Odoo.
- **Each message alarms once.** Claimed by Odoo's `mail.message` id in
  `push_delivery` before anything is sent, so overlapping ticks cannot double
  up.
