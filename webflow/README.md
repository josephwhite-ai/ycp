# YCP Webflow

Two things for the YCP Central Connecticut chapter page on the national Webflow site
(https://www.youngcatholicprofessionals.org/chapter/central-connecticut):

- An embeddable leaders component that fills the "Our Leadership" and "Our Board & Chaplaincy" sections from a JSON API the chapter controls, in place of the Webflow CMS.
- A local copy of the page to test the component, and other layout and content ideas, without touching the national site.

## Leaders component

`component/leaders-embed.js` is a dependency-free browser script. The site admin replaces each CMS leader list with a Webflow Code Embed element containing:

```html
<div data-ycp-leaders data-src="https://josephwhite-ai.github.io/ycp/webflow/leaders.json" data-group="leadership"></div>
<script src="https://josephwhite-ai.github.io/ycp/webflow/leaders-embed.js" defer></script>
```

The second list uses `data-group="board"`. The script can be included once or with every embed; the data is fetched once per page either way.

- **Styling:** cards are built with the page's existing Webflow classes (`item_grid`, `team2_item`, `chapterpage_headshots` and so on), so they look the same as the CMS cards. If the national site renames those classes, the component needs updating.
- **Failure:** if the data cannot be loaded, the element keeps whatever content it already had and an error is logged to the console. The admin can put fallback content inside the `<div>`.
- **Safety:** names and titles are inserted as text, never as HTML, and only `http(s)` image URLs are used.

### Data format

`api/leaders.json` holds the leaders, seeded from the live page. Any replacement API must return the same shape, with CORS allowed for the YCP site (`Access-Control-Allow-Origin`):

```json
{
  "leaders": [
    { "name": "Jane Doe", "title": "President", "group": "leadership", "image": "https://example.org/jane.jpg" }
  ]
}
```

Leaders appear in array order. `group` is `leadership` or `board`. `image` may be relative to the JSON file's URL; a leader with no image gets an empty photo circle.

### Trying it locally

```bash
npm run embed
```

This swaps the two CMS leader lists in `site/index.html` for the embed, pointing at `/api/leaders.json` and `/component/leaders-embed.js` on the local server. Edit `api/leaders.json`, refresh, and the page follows.

### Hosting

`.github/workflows/webflow-pages.yml` publishes `api/leaders.json` and `component/leaders-embed.js` to GitHub Pages whenever either changes on `main`, after running the tests:

- https://josephwhite-ai.github.io/ycp/webflow/leaders.json
- https://josephwhite-ai.github.io/ycp/webflow/leaders-embed.js

To change a leader, edit `api/leaders.json` and merge to `main`. GitHub Pages lets browsers cache files for about 10 minutes, so a change can take that long to show. GitHub Pages allows requests from any site, so no CORS setup is needed.

To test the local copy against the hosted files, take a fresh snapshot and run:

```bash
npm run embed -- --data-url https://josephwhite-ai.github.io/ycp/webflow/leaders.json --script-url https://josephwhite-ai.github.io/ycp/webflow/leaders-embed.js
```

### Before handing it over

- The embed snippet hard-codes the GitHub Pages address. If the files move to another host later, the admin has to update the snippet.
- The leaders data still points at headshots on the national site's Webflow CDN. Moving the photos to your own host removes that dependency.
- Webflow's Code Embed element needs a paid site or workspace plan, which the national site has. A free staging site may not allow it; check before relying on one.

## Local page copy

Requires Node 20+. There are no dependencies to install.

```bash
npm run snapshot
```

```bash
npm run dev
```

Then open http://localhost:4173/.

- `npm run snapshot` downloads the live page into `site/index.html` and its stylesheet into `site/css/webflow.css`. It refuses to replace an existing copy; pass `-- --force` to overwrite it and lose local edits. `-- --url <page url>` snapshots a different page.
- `npm run dev` serves `site/` on port 4173 (`npm run dev -- 5000` for another port), plus `api/` and `component/` under those paths. Refresh the browser after editing; there is no auto-reload.
- `npm test` runs the tests.

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
