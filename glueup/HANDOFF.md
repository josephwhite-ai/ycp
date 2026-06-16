# Glue Up Automation Handoff

## Current Status

The operator workflow is local and intentionally three-step:

```bash
npm run ensure -- 6
npm run populate -- --event 6
# human reviews and manually publishes in Glue Up
npm run finalize -- --event 6 --confirm
```

`ensure` treats GitHub Actions as the prepare backend, then uses the local saved Glue Up browser session to ensure the draft and campaign shells exist. `populate` updates those existing Glue Up objects. The script never publishes an event; publish remains a manual irreversible review step. `finalize` schedules campaign emails after publish.

Under the hood, two halves are working:

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

**Glue Up mutation (local).** `ensure` reuses or creates a draft, ensures campaign shells, and records IDs in the manifest. Draft creation runs the full 3-step Glue Up internal AJAX flow (AddEvent → blueprintSubmit → EventSessionSubmit) when reuse is not possible. Verified live: it created event `185166` with title, start/end date+time, and venue populated from `event.json`; a later run created event `185174` plus campaign drafts `508089` and `508090`. Glue Up mutation must run locally because Glue Up's login is behind Cloudflare (headless login is blocked; headless authenticated browsing and cookie-authenticated `fetch()` are allowed).

The runs are keyed by an event slug `evt-<year>-<NNN>` (e.g. `evt-2026-006`), used for the `runs/` subdir and the CI artifact name.

## Important Product Rules

Glue Up already has approved templates. Do not generate event pages or email campaigns from scratch.

The automation should:

1. Select the approved Glue Up event template.
2. Reuse or create a Glue Up event draft from the selected blueprint.
3. Fill the draft using structured event data and Drive images.
4. After the event page exists, reuse or create campaigns from approved Glue Up campaign templates.
5. Never publish automatically; a human reviews and publishes manually.
6. Schedule those campaigns for one week before and one day before the event at 4:00 AM.

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

Copied cookies/tokens from browser devtools are examples only. Treat them like passwords. For this public repo, do not move Glue Up cookies/tokens into GitHub Actions secrets unless the deployment model changes to a private, locked-down runner with a clear rotation plan.

## Implemented Glue Up AJAX Helpers

- `src/glueup/draftCreate.js`
  - Creates an event draft from a blueprint through `/events/draft/create/ajax`.
- `src/glueup/campaignCreate.js`
  - `addCampaign` creates an invitation campaign draft through `/crm/people/ajax` action `AddCampaign`, and `parseAddCampaignResult` reads the new campaign ID out of the response redirect. `fetchCampaignCsrfToken` pulls a fresh per-page CSRF token.

`draftCreate.js` and `campaignCreate.js` are both wired into the CLI. `ensure` now records the event draft ID and two invitation campaign draft IDs (week-before, day-before) in `manifest.glueUp.campaigns`. `populate` applies event/campaign setup, and `finalize` schedules campaigns after manual publish.

## Campaign flow — reverse-engineered via probe (2026-06-15)

`scripts/probe-campaign.mjs` (`npm run probe-campaign`) is a headed Playwright probe that records campaign AJAX **value-free by default** and **aborts** any action matching `send|schedule|dispatch|deliver|publish|remind` before it reaches Glue Up, so the destructive `schedule-campaign` request can be captured without firing. Reports stream to `.glueup-debug/campaign-probe.json` (gitignored). Probe only against a known test event; never let a real send through.

When replayable setup payloads are needed, run the probe with explicit value capture. Token/cookie/password-like fields are still redacted, but recipient/setup/content values are written to the gitignored report:

```bash
npm run probe-campaign -- --event 185174 --campaign 508089 --capture-values
```

Then use the browser to save recipients, exclusions, setup, content, and finally click through scheduling. The schedule/send action remains blocked by the default block pattern.

The admin UI's campaign wizard, as captured, is:

1. **`AddCampaign`** → POST `/crm/people/ajax`
   - data: `{ id: null, eventId: "<id>" (plain string), campaignType: "EventInvitationCampaign", title }`
   - response `redirect` = `/events/<eventId>/promote/campaigns/<campaignId>/` — **the only place the new campaign ID appears.**
   - NOTE: a `RegularEventCampaign` (the wrong type, from a mis-click on a past event) sent `campaignType: "RegularEventCampaign"`; an invitation campaign on a draft event sent NO `campaignType` field. `campaignCreate.js` sends `EventInvitationCampaign` explicitly as a plain string. Verify this is honored on the first live run.
2. **`recipientFiltersStandardFormSubmit`** → POST `/events/<eventId>/promote/campaigns/<campaignId>/ajax` — recipient audience (booleans per member/attendee/subscriber list).
3. **`negativeFiltersStandardFormSubmit`** → same URL — exclusion audience.
4. **`SetupCampaignFormSubmit`** → same URL — `{ setup.senderEmail.code, subject, preheader, language.code:"en", campaignName, ... }`.
5. **`ContentFormSubmit`** (fires twice) → same URL — email body `blocks` (array; modules like `organizationLogo`, `detailsHeader`).
6. **`schedule-campaign`** → same URL — `{ id: null, isNotificationEnabled, timezone.code: "America/New_York", sendTime: "HH:mm" (e.g. "04:00"), sendDate: "YYYY-MM-DD" }`. **This is the step we never let through.**

### Publish gate (confirmed)

CREATING an invitation campaign draft works on an UNPUBLISHED event. SCHEDULING/sending is hard-gated: on an unpublished event Glue Up pops "Please publish your event" and blocks the send. So the publish gate sits **between ensure/populate and finalize**, not before campaign shell creation. Also: `EventInvitationCampaign` is only OFFERED as a type on upcoming events (a past event only offers `RegularEventCampaign`).

### Confirmed gap: campaign setup payloads

`AddCampaign` alone creates invitation campaign shells with no recipients. Steps 2–5 must be captured and replayed before scheduling:

- `recipientFiltersStandardFormSubmit`
- `negativeFiltersStandardFormSubmit`
- `SetupCampaignFormSubmit`
- `ContentFormSubmit`

Use `probe-campaign -- --event <eventId> --campaign <campaignId> --capture-values` against one of the existing draft campaigns to capture the real setup payloads into `.glueup-debug/campaign-probe.json`. Do not implement replay from the old value-free report, because it only contains key paths/types and would risk clobbering approved template content.

The captured setup pattern is now folded into `populate`. The default recipient setup includes Contacts, and the default negative filter excludes all attendees for the same event.

The captured payload can still be replayed manually against every campaign in a run manifest for repair/debug:

```bash
npm run apply-campaign-setup -- --event 6 --headed
```

This rewrites event-specific filter keys to the manifest's Glue Up event ID, rewrites each setup `campaignName` from the manifest campaign title, normalizes the negative filters to exclude all attendees rather than invitees, posts the four setup/content actions, and records `setupAppliedAt` per campaign. It was run successfully for `evt-2026-006`, applying setup to campaigns `508089` and `508090`.

## Recommended Next Step

Run a fresh end-to-end `ensure`, `populate`, manual review/publish, and `finalize` test against the next event. Inspect the resulting campaign recipients/setup/content in Glue Up before publishing.

## Junk Draft Cleanup

Actual draft deletion was probed against event `185176`, but the draft list only rendered `Manage`, `View Event Website`, and `Duplicate`, and likely internal `DeleteEvent` AJAX actions were no-ops. Use the soft cleanup command instead:

```bash
npm run mark-ignore -- --event 7 --headed
```

This renames the draft event and each campaign's setup title/subject to exactly `PLEASE IGNORE`.

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

Auth resolution order for local Glue Up commands (`ensureGlueUpAuth`): `GLUEUP_COOKIE` + `GLUEUP_CSRF_TOKEN` from the environment → a still-valid saved `.glueup-session/` (probed headlessly, non-interactive, fails fast) → a headed login that opens a visible browser only when the saved session is missing or expired. The happy path never prompts.

## Ensure / populate / finalize commands

The Glue Up workflow is split so existing drafts can be reused instead of renamed `PLEASE IGNORE`.

```bash
npm run ensure -- 6                  # pull event data, ensure session, draft, and campaigns
npm run populate -- --event 6        # update existing draft/campaigns
npm run finalize -- --event 6 --confirm # post-publish scheduling
```

With no args, `ensure` pulls the most recent successful prepare run and infers the event from the artifact name (`glueup-run-evt-<year>-<NNN>`), so the index is never repeated locally. Use `--event` only when intentionally targeting an older prepared run.

Behavior:

1. Resolves the run directory (pull-latest / `--event` / `--fresh` / `--run`).
2. Reads `manifest.json`, `template-selection.json`, and `event.json`.
3. Uses `template-selection.selected.glueUp.eventType` and `.blueprintCode`.
4. `ensure` reuses `manifest.glueUp.eventId` when present and template-compatible. If there is no current event ID, it scans known `runs/*/manifest.json` records for a reusable draft with the same selected Glue Up `blueprintCode`; pass `--poll-artifacts` to download recent successful prepare artifacts before scanning.
5. `ensure` reuses existing campaign IDs by key and creates only missing week-before/day-before campaign shells.
6. `populate` updates the existing draft's basic event settings through the settings page and applies the default recipients/setup/content payloads to existing campaign IDs.
7. The human reviews and publishes manually in Glue Up.
8. `finalize` posts `schedule-campaign` after publish and requires `--confirm`; use `--dry-run` to write `campaign-schedule-plan.json`.

`ensure` requires the `gh` CLI (authenticated) to pull artifacts.

Standalone steps if you want to pre-stage or refresh auth separately:

```bash
npm run sync-run -- --event 6 [--fresh]   # download an artifact only
npm run glueup-login                      # refresh the saved browser session only
```

Treat these as debug/support commands. The preferred operator path is `ensure`, `populate`, manual publish, then `finalize`.

Dry run (no Glue Up auth required):

```bash
npm run ensure -- --event 6 --dry-run
```

This writes `draft-create-plan.json` with the blueprint and request shape that would be sent.

## Validation Notes

Missing `registrationUrl` is a warning, not an error, at prepare time. The event page URL is produced after Glue Up draft creation.

Campaign artifacts are fill briefs for approved Glue Up campaign templates, not standalone emails.
