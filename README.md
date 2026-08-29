Reddit Automation

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
      marketing/            marketing/   LinkedIn, Reddit, AI SEO
      tools/                             CSV editor

`server/core/` holds the knowledge-base CSV plumbing and the meat/packaging
config every module reads; `server/integrations/` wraps the outside world
(Odoo, Gemini, GitHub Projects). `server/index.js` stays at the root as the
single Express entry point.
