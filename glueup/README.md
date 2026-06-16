# Glue Up Agent

Automation for preparing Glue Up event-page inputs from Google Drive event data, selecting the approved Glue Up event template, creating local Glue Up drafts, and staging invitation campaign drafts for review.

## Operator workflow

For normal use, run one local command from this directory:

```bash
npm run create-draft -- 6
```

That command dispatches the GitHub Actions prepare workflow, downloads the resulting artifact, ensures a local Glue Up session, creates the event draft from the approved Glue Up blueprint, creates the two invitation campaign drafts, and applies the standard recipient/setup/content payload. The event index is the leading number in a Drive folder like `06 - June 2026 - NHH`.

If the prepare workflow was already run successfully, omit `--fresh` and let the local command pull the latest prepared event:

```bash
npm run create-draft
```

The GitHub Actions workflow is the prepare backend, not a separate end-user workflow. Glue Up mutation stays local because Glue Up login is behind Cloudflare and requires a browser-backed session.

## What It Does

The current implementation:

1. Finds the monthly event folder under the top-level Drive events folder.
2. Finds `<Month> <Year> - Event Summary Sheet`.
3. Reads the Google Doc structure through the Drive/Docs APIs.
4. Extracts table data into `event.json`.
5. Selects the approved Glue Up template profile for the event type.
6. Lists likely photo assets.
7. Generates local event-template field briefs and campaign-template fill briefs.
8. Writes a validation report.
9. Creates a Glue Up event draft from the selected approved blueprint.
10. Creates and sets up two invitation campaign drafts, one for the week-before send and one for the day-before send.

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

Content prep (Google Drive parsing) runs in GitHub Actions; the Glue Up draft step runs locally because Glue Up's login is behind Cloudflare. `create-draft` bridges both halves in one command: it pulls the prepared run artifact from CI, ensures a Glue Up session (opening a visible browser to log in **only** when the saved session is missing or expired), and runs the create flow.

`create-draft` stages everything that can be done **before publishing**: it creates the event draft and then two invitation campaign drafts (one to send a week before, one a day before), applies recipients/setup/content, and records their IDs in `manifest.json` under `glueUp.campaigns`. You then review the event and both campaigns together and publish the event in Glue Up — a deliberate manual step, since publishing is effectively irreversible. Scheduling the campaigns is gated on publish and runs as a separate post-publish step (not yet wired into the CLI).

With no arguments, `create-draft` pulls the **latest successful prepare run** from CI and infers which event it is from the artifact name — so the event index is named once, on GitHub, and never repeated locally:

```bash
npm run create-draft                      # latest prepared event + login if needed + create draft
```

Name an index positionally for the normal fresh path. Use `--event` only to target a specific older prepared run. Add `--year 2025` for a past year:

```bash
npm run create-draft -- 6                  # normal path: fresh prepare + create draft
npm run create-draft -- --event 6         # target a specific older event
npm run create-draft -- --event 6 --fresh # dispatch a new prepare, wait, then create the draft
```

`create-draft` requires the `gh` CLI (authenticated) to pull the artifact. Auth resolves in this order: `GLUEUP_COOKIE` + `GLUEUP_CSRF_TOKEN` from the environment, then a still-valid saved session under `.glueup-session/` (probed headlessly), then a headed login. The saved session is reused across events, so the browser rarely opens.

The standalone steps are still available if you want to pre-stage or refresh auth separately:

```bash
npm run sync-run -- --event 6   # download the artifact only
npm run mark-ignore -- --event 6 --headed # mark a junk draft and its campaigns as PLEASE IGNORE
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

Glue Up's login sits behind Cloudflare bot management, so headless/CI login is blocked — `glueup-login` must run with a visible browser (the default). There is no CI login workflow, and Glue Up cookies/tokens should not be stored as repository secrets for this public repo. The normal path is to reuse the gitignored local `.glueup-session/` browser profile, refreshing it with `npm run glueup-login` when it expires.

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
npm run create-draft -- 6
npm run create-draft
npm run glueup-login
npm run check
```

Debug/backend commands:

```bash
npm run monthly-prepare -- --event 6
npm run sync-run -- --event 6 --fresh
npm run validate -- --run runs/evt-2026-006
npm run monthly-prepare -- --event 6 --dry-run
npm run monthly-prepare -- --event 6 --year 2025
npm run monthly-prepare -- --event 6 --events-folder-id 1rhIJFpQASAzxso02Gu1tvnMxXlyFiuFE
```

## Event folder naming

Year folders contain event folders named like `06 - June 2026 - NHH`: event index, month/year, and event type abbreviation. The leading number is the event index — a counter unique across the year — and is the only thing needed to select an event (`--event 6`). The month is read back from the folder name to locate that month's summary doc.

## Deployment Model

Use one normal entrypoint: the local `create-draft` command. It treats GitHub Actions as a remote prepare worker, then performs Glue Up mutations locally with the saved browser session. This keeps the Google Drive service-account work reproducible in CI while avoiding a brittle second Glue Up login path in the cloud.

If the local browser requirement becomes painful later, the next deployment target should be a small always-on browser runner with a persisted session, not a second public GitHub Actions mutation workflow.

## GitHub Actions setup

The included workflow is `.github/workflows/glueup-monthly-prepare.yml`, run on demand via `workflow_dispatch` (inputs: `event`, optional `year`). `create-draft --fresh` and `sync-run --fresh` dispatch it for you.

Add these repository secrets/variables:

- Secret `GOOGLE_SERVICE_ACCOUNT_JSON`: full service account JSON.
- Secret `OPENAI_API_KEY`: optional; deterministic template fill briefs work without it.
- Variable `GLUEUP_EVENTS_FOLDER_ID`: optional override for the top-level Drive folder.

The workflow prepares event-template field briefs, campaign-template fill briefs, validation output, and uploads `glueup/runs/` as an artifact named `glueup-run-evt-<year>-<index>`. Creating, publishing, or scheduling Glue Up objects does not happen in GitHub Actions.

## Campaign creation

After a Glue Up event draft exists, campaign drafts can be created through the internal AJAX endpoint used by the admin UI:

- Endpoint: `/crm/people/ajax`
- Action: `AddCampaign`
- Campaign type: `EventInvitationCampaign`
- Required inputs: Glue Up event ID and campaign title

Session cookies and CSRF tokens must come from fresh environment variables or a Playwright-authenticated browser session. Do not store copied cookies or tokens in source.
