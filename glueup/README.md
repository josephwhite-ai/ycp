# Glue Up Agent

Local-first automation for preparing monthly Glue Up webpage and campaign drafts from Google Drive event data.

## First milestone

The current implementation intentionally stops before mutating Glue Up. It:

1. Finds the monthly event folder under the top-level Drive events folder.
2. Finds `<Month> <Year> - Event Summary Sheet`.
3. Reads the Google Doc structure through the Drive/Docs APIs.
4. Extracts table data into `event.json`.
5. Selects the approved Glue Up template profile for the event type.
6. Lists likely photo assets.
7. Generates local field/copy drafts for filling the approved template.
8. Writes a validation report.

The agent should not design new event pages from scratch. Glue Up is treated as the source of approved templates; this repo prepares structured content, selects the right template, fills fields, and verifies the result.

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

Glue Up draft creation currently uses the same internal AJAX endpoint the admin UI calls. Store session values only in environment variables:

```bash
export GLUEUP_ORG_ID=5828
export GLUEUP_COOKIE="..."
export GLUEUP_CSRF_TOKEN="..."
```

Session cookies and CSRF tokens are intentionally not stored in source files. They expire and should be treated like passwords.

## Auth

Use whichever Google auth path is least painful today:

- `GOOGLE_ACCESS_TOKEN`: fastest one-off path.
- `GOOGLE_APPLICATION_CREDENTIALS`: best for cloud deployments if the Drive folder is shared with the service account.
- `gcloud auth print-access-token`: convenient local fallback if the right account is logged into `gcloud`.

The connected Codex Google Drive account currently did not list the shared folder, so this code uses direct Google APIs instead of relying on `gws`.

### Fast local token test

If you can get a token from the correct Google account, run:

```bash
export GOOGLE_ACCESS_TOKEN="paste-token-here"
npm run prepare -- --month 2026-06
```

For a durable setup, use the service account `sheets@gen-lang-client-0848431620.iam.gserviceaccount.com`, enable the Google Drive API and Google Docs API in its project, download its JSON key, share the top-level events folder with the service account email, then run:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
npm run prepare -- --month 2026-06
```

If using local Google Application Default Credentials, make sure the token includes Drive and Docs read scopes:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/documents.readonly
```

If `gcloud` is not visible in this shell but exists in another terminal, run the command there; it writes to `~/.config/gcloud/application_default_credentials.json`, which this CLI reads directly.

## Commands

```bash
npm run prepare -- --month 2026-06
npm run validate -- --run runs/2026-06
npm run check
```

Useful options:

```bash
npm run prepare -- --month 2026-06 --dry-run
npm run prepare -- --month 2026-06 --events-folder-id 1rhIJFpQASAzxso02Gu1tvnMxXlyFiuFE
npm run prepare -- --month 2026-06 --event-type NHH
npm run prepare -- --month 2026-06 --event-index 06
```

## Event folder naming

Year folders contain event folders named like `06 - June 2026 - NHH`: event index, month/year, and event type abbreviation. If multiple events exist for a month, use `--event-type` or `--event-index` to select the intended event folder.

## Deployment direction

Start local, then move the same CLI to GitHub Actions on a monthly cron. If Glue Up browser automation becomes central or more robustness is needed, run it in Cloud Run triggered by Cloud Scheduler.

## GitHub Actions setup

The included workflow is `.github/workflows/monthly-prepare.yml`.

Add these repository secrets/variables:

- Secret `GOOGLE_SERVICE_ACCOUNT_JSON`: full service account JSON.
- Secret `OPENAI_API_KEY`: optional; deterministic templates work without it.
- Variable `GLUEUP_EVENTS_FOLDER_ID`: optional override for the top-level Drive folder.

The scheduled workflow prepares drafts and uploads `runs/` as an artifact. Publishing to Glue Up should be a later command after draft generation and validation are stable.

## Campaign creation

After a Glue Up event draft exists, campaign drafts can be created through the internal AJAX endpoint used by the admin UI:

- Endpoint: `/crm/people/ajax`
- Action: `AddCampaign`
- Campaign type: `EventInvitationCampaign`
- Required inputs: Glue Up event ID and campaign title

Session cookies and CSRF tokens must come from fresh environment variables or a Playwright-authenticated browser session. Do not store copied cookies or tokens in source.
