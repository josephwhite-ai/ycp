# Glue Up Agent

Automation for preparing monthly Glue Up event-page inputs from Google Drive event data, selecting the approved Glue Up event template, and producing campaign-template fill briefs for later campaign creation.

## First milestone

The current implementation intentionally stops before mutating Glue Up. It:

1. Finds the monthly event folder under the top-level Drive events folder.
2. Finds `<Month> <Year> - Event Summary Sheet`.
3. Reads the Google Doc structure through the Drive/Docs APIs.
4. Extracts table data into `event.json`.
5. Selects the approved Glue Up template profile for the event type.
6. Lists likely photo assets.
7. Generates local event-template field briefs and campaign-template fill briefs.
8. Writes a validation report.

The agent should not design new event pages or email campaigns from scratch. Glue Up is treated as the source of approved event and campaign templates; this repo prepares structured content, selects the right template, fills fields, and verifies the result.

Current approved template taxonomy:

- St Joseph Saturdays: Glue Up Offline blueprint `90664`
- Executive Speaker Series: Glue Up Offline blueprint `90655`
- Executive Panel Discussion / Members Only: Glue Up Offline blueprint `90666`
- Executive Panel Discussion / Open to the Public: Glue Up Offline blueprint `90667`
- Networking Happy Hour / Members Only: Glue Up Offline blueprint `90662`
- Networking Happy Hour / Open to the Public: Glue Up Offline blueprint `90663`

The event summary sheet commonly uses these abbreviations:

- `ESS`: Executive Speaker Series
- `EPD`: Executive Panel Discussion
- `NHH`: Networking Happy Hour
- `SJS`: St Joseph Saturdays

Events default to public unless the source data explicitly says members-only/private.

## Glue Up draft creation

Glue Up draft creation uses the same internal AJAX endpoint the admin UI calls when you start from `https://ycp.glueup.com/events/draft`.

### End-to-end flow

Each run targets one event, identified by its index — a counter unique across the year (the leading number in a folder like `06 - June 2026 - NHH`). The year defaults to the current year.

Content prep (Google Drive parsing) runs in GitHub Actions; the Glue Up draft step must run locally because Glue Up's login is behind Cloudflare. `create-draft` bridges both halves in one command: it pulls the prepared run artifact from CI, ensures a Glue Up session (opening a visible browser to log in **only** when the saved session is missing or expired), and runs the create flow.

`create-draft` stages everything that can be done **before publishing**: it creates the event draft and then two invitation campaign drafts (one to send a week before, one a day before), recording their IDs in `manifest.json` under `glueUp.campaigns`. You then review the event and both campaigns together and publish the event in Glue Up — a deliberate manual step, since publishing is effectively irreversible. Scheduling the campaigns is gated on publish and runs as a separate post-publish step (not yet wired into the CLI).

With no arguments, `create-draft` pulls the **latest successful prepare run** from CI and infers which event it is from the artifact name — so the event index is named once, on GitHub, and never repeated locally:

```bash
npm run create-draft                      # latest prepared event + login if needed + create draft
```

Name an index locally only to target a specific older event, or with `--fresh` to dispatch a new prepare run (the one place the index is named for a fresh run). Add `--year 2025` for a past year:

```bash
npm run create-draft -- --event 6         # target a specific older event
npm run create-draft -- --event 6 --fresh # dispatch a new prepare, wait, then create the draft
```

`create-draft` requires the `gh` CLI (authenticated) to pull the artifact. Auth resolves in this order: `GLUEUP_COOKIE` + `GLUEUP_CSRF_TOKEN` from the environment, then a still-valid saved session under `.glueup-session/` (probed headlessly), then a headed login. The saved session is reused across events, so the browser rarely opens.

The standalone steps are still available if you want to pre-stage or refresh auth separately:

```bash
npm run sync-run -- --event 6   # download the artifact only
npm run glueup-login            # refresh the saved browser session only
```

Manual env override still works:

```bash
export GLUEUP_ORG_ID=5828
export GLUEUP_COOKIE="..."
export GLUEUP_CSRF_TOKEN="..."
```

Optional automated sign-in during `glueup-login`:

```bash
export GLUEUP_EMAIL="..."
export GLUEUP_PASSWORD="..."
npm run glueup-login
```

Glue Up's login sits behind Cloudflare bot management, so headless/CI login is blocked — `glueup-login` must run with a visible browser (the default). There is no CI login workflow. For automation, capture `GLUEUP_COOKIE` and `GLUEUP_CSRF_TOKEN` from a local `glueup-login` and export them (or store as repo secrets), refreshing when the session expires.

Session cookies and CSRF tokens are intentionally not stored in source files. They expire and should be treated like passwords.

## Auth

Production/GitHub Actions uses a Google service account. The current service account is:

```text
sheets@gen-lang-client-0848431620.iam.gserviceaccount.com
```

Required setup:

1. Enable Google Drive API and Google Docs API in the service account project.
2. Share the top-level events Drive folder with the service account as a viewer.
3. Store the full service account JSON in the GitHub Actions secret `GOOGLE_SERVICE_ACCOUNT_JSON`.

The workflow writes that secret to `credentials/google-service-account.json` and runs with:

```bash
GOOGLE_APPLICATION_CREDENTIALS=../credentials/google-service-account.json
```

Local auth options are still supported for debugging:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
npm run monthly-prepare -- --event 6
```

You can also use `GOOGLE_ACCESS_TOKEN` or local Google ADC, but those are fallback/debug paths. The direct Google APIs are used instead of `gws`.

## Commands

```bash
npm run monthly-prepare -- --event 6
npm run validate -- --run runs/evt-2026-006
npm run create-draft -- --event 6
npm run glueup-login
npm run check
```

Useful options:

```bash
npm run monthly-prepare -- --event 6 --dry-run
npm run monthly-prepare -- --event 6 --year 2025
npm run monthly-prepare -- --event 6 --events-folder-id 1rhIJFpQASAzxso02Gu1tvnMxXlyFiuFE
```

## Event folder naming

Year folders contain event folders named like `06 - June 2026 - NHH`: event index, month/year, and event type abbreviation. The leading number is the event index — a counter unique across the year — and is the only thing needed to select an event (`--event 6`). The month is read back from the folder name to locate that month's summary doc.

## Deployment direction

Start local, then move the same CLI to GitHub Actions. If Glue Up browser automation becomes central or more robustness is needed, run it in Cloud Run triggered by Cloud Scheduler.

## GitHub Actions setup

The included workflow is `.github/workflows/glueup-monthly-prepare.yml`, run on demand via `workflow_dispatch` (inputs: `event`, optional `year`). `create-draft --fresh` and `sync-run --fresh` dispatch it for you.

Add these repository secrets/variables:

- Secret `GOOGLE_SERVICE_ACCOUNT_JSON`: full service account JSON.
- Secret `OPENAI_API_KEY`: optional; deterministic template fill briefs work without it.
- Variable `GLUEUP_EVENTS_FOLDER_ID`: optional override for the top-level Drive folder.

The workflow prepares event-template field briefs, campaign-template fill briefs, validation output, and uploads `glueup/runs/` as an artifact named `glueup-run-evt-<year>-<index>`. Creating or publishing Glue Up objects happens in later workflow stages.

## Campaign creation

After a Glue Up event draft exists, campaign drafts can be created through the internal AJAX endpoint used by the admin UI:

- Endpoint: `/crm/people/ajax`
- Action: `AddCampaign`
- Campaign type: `EventInvitationCampaign`
- Required inputs: Glue Up event ID and campaign title

Session cookies and CSRF tokens must come from fresh environment variables or a Playwright-authenticated browser session. Do not store copied cookies or tokens in source.
