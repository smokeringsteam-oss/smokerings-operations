Smoke Rings BBQ Automation

1) Open new terminal and paste below command

npm run start-server

2) Open new terminal and paste below command

npm run dev

3) After step 2, open this in chrome

http://localhost:5173/
## Layout

Folders mirror the sidebar. Each UI section owns a folder on both sides of the
wire, so a screen and the endpoints behind it sit next to each other.

    src/pages/            server/
      ops/                  ops/
        b2c/                  b2c/       weekend flow: prep planner, service weeks
        b2b/                  b2b/       wholesale clients
        menu/                 menu/      menu catalog, recipes, Odoo CSV mirror
        shared/               shared/    used by both channels: purchasing,
                                         smoking, order packing
      sprint/               sprint/      sprint board + daily view
      marketing/            marketing/   ROI, tracked links & QR,
                                         Insta reels

`server/core/` holds the knowledge-base CSV plumbing and the meat/packaging
config every module reads; `server/integrations/` wraps the outside world
(Odoo, Gemini, GitHub Projects). `server/index.js` stays at the root as the
single Express entry point.

## Insta Reel Generator

Marketing > Insta Reel Generator. Upload the clips from a cook, order and trim
them, caption them, and export one vertical 1080x1920 mp4 — then either
download it or post it as a Story or Reel.

ffmpeg is not a prerequisite: `ffmpeg-static` and `ffprobe-static` come down
with `npm install`, and the editor and export work with nothing configured.
Uploads live in `server/uploads/reels/` and are swept after a week.

Posting to Instagram needs setting up once, and the walkthrough is in
`.env.example` under "Insta Reel Generator". The part worth knowing before you
start: the Graph API does not accept an upload — it fetches the video from a
public URL of ours — so a publish needs an Instagram Business/Creator account,
a long-lived token, and `PUBLIC_BASE_URL` pointing at a public HTTPS hostname.
On this machine that means bringing up a tunnel first:

    tailscale funnel 4000

`tailscale serve` is not enough; only Funnel is reachable from outside the
tailnet, which is where Meta's fetcher lives.
