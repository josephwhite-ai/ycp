# Glue Up Automation Handoff

## Current Status

Two halves are working end-to-end:

**Prepare (GitHub Actions).** The `Glue Up Prepare` workflow (`glueup-monthly-prepare.yml`, dispatch-only) runs against a single event identified by its index. It:

- Authenticates to Google Drive/Docs using `GOOGLE_SERVICE_ACCOUNT_JSON`.
- Finds the top-level events folder, year folder, and event folder.
- Supports event folder names like `06 - June 2026 - NHH`, where `06` is the event index (a counter unique across the year). The month is read back from the folder name to locate the summary doc.
- Finds `<Month> <Year> - Event Summary Sheet` inside the event folder.
- Extracts structured event data from the Google Doc table.
- Selects the approved Glue Up event blueprint.
- Lists image assets from the event folder.
- Generates event-template field briefs and campaign-template fill briefs.
- Uploads `glueup/runs/<slug>/` as the artifact `glueup-run-evt-<year>-<NNN>`.

**Draft creation (local).** `create-draft` runs the full 3-step Glue Up internal AJAX flow (AddEvent → blueprintSubmit → EventSessionSubmit) and produces a real event with an ID. Verified live: it created event `185166` with title, start/end date+time, and venue populated from `event.json`. The draft step must run locally because Glue Up's login is behind Cloudflare (headless login is blocked; headless authenticated browsing and cookie-authenticated `fetch()` are allowed).

The runs are keyed by an event slug `evt-<year>-<NNN>` (e.g. `evt-2026-006`), used for the `runs/` subdir and the CI artifact name.

## Important Product Rules

Glue Up already has approved templates. Do not generate event pages or email campaigns from scratch.

The automation should:

1. Select the approved Glue Up event template.
2. Create a Glue Up event draft from the selected blueprint.
3. Fill the draft using structured event data and Drive images.
4. After the event page exists, create campaigns from approved Glue Up campaign templates.
5. Schedule those campaigns for one week before and one day before the event at 4:00 AM.

## Event Types and Blueprints

- `SJS`: St Joseph Saturdays, Offline blueprint `90664`
- `ESS`: Executive Speaker Series, Offline blueprint `90655`
- `EPD` public: Executive Panel Discussion, Offline blueprint `90667`
- `EPD` members-only: Executive Panel Discussion, Offline blueprint `90666`
- `NHH` public: Networking Happy Hour, Offline blueprint `90663`
- `NHH` members-only: Networking Happy Hour, Offline blueprint `90662`

Events default to public unless the source explicitly says members-only/private.

## Auth and Secrets

GitHub Actions uses the service account stored in the secret `GOOGLE_SERVICE_ACCOUNT_JSON`.

Glue Up browser/session values must not be committed. The current low-level AJAX helpers expect fresh values from environment variables or a future Playwright-authenticated session:

- `GLUEUP_ORG_ID`, default `5828`
- `GLUEUP_COOKIE`
- `GLUEUP_CSRF_TOKEN`

Copied cookies/tokens from browser devtools are examples only. Treat them like passwords.

## Implemented Glue Up AJAX Helpers

- `src/glueup/draftCreate.js`
  - Creates an event draft from a blueprint through `/events/draft/create/ajax`.
- `src/glueup/campaignCreate.js`
  - Creates a campaign draft through `/crm/people/ajax` with action `AddCampaign` and campaign type `EventInvitationCampaign`.

`draftCreate.js` is fully wired into the CLI and runs the live 3-step create flow. `campaignCreate.js` still builds the request shape only and needs a CLI command.

## Recommended Next Step

Wire campaign creation into a CLI command that reuses the Playwright session layer and the existing `campaignCreate.js` helper.

## Playwright Session Auth

Glue Up draft creation normally starts from `https://ycp.glueup.com/events/draft`. The Playwright layer uses that page as the authenticated workspace.

```bash
npm run glueup-login
```

Behavior:

1. Opens a browser profile saved under `.glueup-session/` (gitignored).
2. Navigates to `https://ycp.glueup.com/events/draft`.
3. Signs in manually, or with `GLUEUP_EMAIL` / `GLUEUP_PASSWORD` when Glue Up shows a login form.
4. Waits until `/events/draft` is loaded, then captures cookies and the CSRF token from the page.

Auth resolution order for `create-draft` (`ensureGlueUpAuth`): `GLUEUP_COOKIE` + `GLUEUP_CSRF_TOKEN` from the environment → a still-valid saved `.glueup-session/` (probed headlessly, non-interactive, fails fast) → a headed login that opens a visible browser only when the saved session is missing or expired. The happy path never prompts.

## `create-draft` Command

`create-draft` is effectively one command. It bridges the CI prepare half and the local draft half: pulls the prepared artifact, ensures a Glue Up session, and runs the 3-step create flow.

```bash
npm run create-draft                      # pull the LATEST successful prepare run from CI, infer the event, create the draft
npm run create-draft -- --event 6         # target a specific older event (syncs only if not already on disk)
npm run create-draft -- --event 6 --fresh # dispatch a new prepare run, wait for it, then create the draft
```

The event index is named once — on GitHub. With no args, `create-draft` pulls the most recent successful prepare run and infers the event from the artifact name (`glueup-run-evt-<year>-<NNN>`), so the index is never repeated locally. `--fresh` is the one place you name the index for a brand-new prepare.

Behavior:

1. Resolves the run directory (pull-latest / `--event` / `--fresh` / `--run`).
2. Reads `manifest.json`, `template-selection.json`, and `event.json`.
3. Uses `template-selection.selected.glueUp.eventType` and `.blueprintCode`.
4. Runs AddEvent → blueprintSubmit → EventSessionSubmit, populating title, start/end date+time, and venue from `event.json`.
5. Persists the Glue Up event ID/URL into `manifest.json` under `glueUp` and writes the raw response to `draft-create-response.json`.
6. Does not create campaigns yet.

`create-draft` requires the `gh` CLI (authenticated) to pull artifacts.

Standalone steps if you want to pre-stage or refresh auth separately:

```bash
npm run sync-run -- --event 6 [--fresh]   # download an artifact only
npm run glueup-login                      # refresh the saved browser session only
```

Dry run (no Glue Up auth required):

```bash
npm run create-draft -- --event 6 --dry-run
```

This writes `draft-create-plan.json` with the blueprint and request shape that would be sent.

## Validation Notes

Missing `registrationUrl` is a warning, not an error, at prepare time. The event page URL is produced after Glue Up draft creation.

Campaign artifacts are fill briefs for approved Glue Up campaign templates, not standalone emails.
