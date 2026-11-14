# YCP Webflow

A local copy of the YCP Central Connecticut chapter page, for trying out layout and content ideas without touching the national Webflow site:
https://www.youngcatholicprofessionals.org/chapter/central-connecticut

## Usage

Requires Node 20+. There are no dependencies to install.

```bash
npm run snapshot
```

```bash
npm run dev
```

Then open http://localhost:4173/.

- `npm run snapshot` downloads the live page into `site/index.html` and its stylesheet into `site/css/webflow.css`. It refuses to replace an existing copy; pass `-- --force` to overwrite it and lose local edits. `-- --url <page url>` snapshots a different page.
- `npm run dev` serves `site/` on port 4173 (`npm run dev -- 5000` for another port). Refresh the browser after editing; there is no auto-reload.
- `npm test` runs the tests for the HTML clean-up.

## Where to make changes

- `overrides.css` is for style experiments. It loads after the Webflow stylesheet, so its rules win. It is tracked in git.
- `site/index.html` is for structure and content experiments: reorder cards, change titles, add sections.
- `site/css/webflow.css` is the national site's full stylesheet. Prefer `overrides.css` so your changes stay separate from theirs.

`site/` is ignored by git. This repository is public, and the copy is the national organization's markup and stylesheet, so it stays on your machine. Only `overrides.css` records your ideas in the repo; keep a note of any `site/index.html` edits you want to carry over.

## What the snapshot changes

- Removes analytics and sign-in scripts (Google Tag Manager, Google Analytics, Facebook Pixel, Microsoft Clarity, ActiveCampaign site tracking, the member sign-in bundle), so local previews do not show up in the national site's statistics.
- Points the page at the downloaded stylesheet and adds `overrides.css`.
- Rewrites root-relative links such as `/about` to the live site, so navigation still goes somewhere real.

Images, fonts, Webflow's own scripts, the Glue Up events widget and the ActiveCampaign newsletter form still load from their original hosts, so the copy needs an internet connection. The newsletter form is live: submitting it locally submits a real sign-up.

## What we know about the live page

- The site is built on Webflow. The chapter page is a CMS template page for the item with slug `central-connecticut`.
- The leader cards under "Our Leadership" and "Our Board & Chaplaincy" are Webflow collection lists rendered into the page HTML on the server. The browser makes no API call for them.
- Headshots are Webflow CMS assets served from `cdn.prod.website-files.com/6363ec521262866fbfc333c0/`.
- The Events section is separate: it is filled in by Glue Up's `eb-widgets.min.js` widget.
- Changing a leader's photo, name or title on the real page means editing the item in the Webflow CMS and republishing. Anything prototyped here has to be redone there by someone with access.
