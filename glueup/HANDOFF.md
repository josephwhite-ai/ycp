# Glue Up Automation Handoff

## Current Status

The `prepare` workflow is working end-to-end in GitHub Actions for June 2026. It successfully:

- Authenticates to Google Drive/Docs using `GOOGLE_SERVICE_ACCOUNT_JSON`.
- Finds the top-level events folder, year folder, and event folder.
- Supports event folder names like `06 - June 2026 - NHH`, where `06` is an event index.
- Finds `<Month> <Year> - Event Summary Sheet` inside the event folder.
- Extracts structured event data from the Google Doc table.
- Selects the approved Glue Up event blueprint.
- Lists image assets from the event folder.
- Generates event-template field briefs and campaign-template fill briefs.
- Uploads `glueup/runs/` as a workflow artifact.

Known successful workflow run used commit `18a7a35`; later cleanup commits refine the generated artifacts and docs.

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

These helpers build the request shape only. `create-draft` is wired into the CLI; campaign creation still needs a CLI command.

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

`create-draft` will use `GLUEUP_COOKIE` and `GLUEUP_CSRF_TOKEN` when set; otherwise it refreshes auth from the saved Playwright session headlessly. Use `--headed` if headless refresh fails.

## `create-draft` Command

```bash
npm run create-draft -- --run runs/2026-06
```

Behavior:

1. Reads `manifest.json` and `template-selection.json` from the run directory.
2. Uses `template-selection.selected.glueUp.eventType` and `.blueprintCode`.
3. Calls the draft-create AJAX helper with `GLUEUP_COOKIE`, `GLUEUP_CSRF_TOKEN`, and optional `GLUEUP_ORG_ID`.
4. Parses the response and persists the Glue Up event ID/URL into `manifest.json` under `glueUp`.
5. Writes the raw AJAX response to `draft-create-response.json`.
6. Does not create campaigns yet.

Dry run (no Glue Up auth required):

```bash
npm run create-draft -- --run runs/2026-06 --dry-run
```

This writes `draft-create-plan.json` with the blueprint and request shape that would be sent.

## Validation Notes

Missing `registrationUrl` is a warning, not an error, at prepare time. The event page URL is produced after Glue Up draft creation.

Campaign artifacts are fill briefs for approved Glue Up campaign templates, not standalone emails.
