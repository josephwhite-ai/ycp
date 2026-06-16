# Glue Up Automation Handoff

## Current Status

One operator entrypoint is working end-to-end for the pre-publish stage:

```bash
npm run create-draft -- 6
```

That local command treats GitHub Actions as the prepare backend, then uses the local saved Glue Up browser session for mutations. Avoid introducing a second normal operator path where users prepare in GitHub and then remember separate local follow-up commands; `create-draft` should stay the public interface.

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

**Draft creation (local).** `create-draft` runs the full 3-step Glue Up internal AJAX flow (AddEvent → blueprintSubmit → EventSessionSubmit) and produces a real event with an ID. Verified live: it created event `185166` with title, start/end date+time, and venue populated from `event.json`; a later run created event `185174` plus campaign drafts `508089` and `508090`. The draft step must run locally because Glue Up's login is behind Cloudflare (headless login is blocked; headless authenticated browsing and cookie-authenticated `fetch()` are allowed).

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

Copied cookies/tokens from browser devtools are examples only. Treat them like passwords. For this public repo, do not move Glue Up cookies/tokens into GitHub Actions secrets unless the deployment model changes to a private, locked-down runner with a clear rotation plan.

## Implemented Glue Up AJAX Helpers

- `src/glueup/draftCreate.js`
  - Creates an event draft from a blueprint through `/events/draft/create/ajax`.
- `src/glueup/campaignCreate.js`
  - `addCampaign` creates an invitation campaign draft through `/crm/people/ajax` action `AddCampaign`, and `parseAddCampaignResult` reads the new campaign ID out of the response redirect. `fetchCampaignCsrfToken` pulls a fresh per-page CSRF token.

`draftCreate.js` and `campaignCreate.js` are both wired into the CLI. `create-draft` now creates the event draft **and** two invitation campaign drafts (week-before, day-before), recording their IDs in `manifest.glueUp.campaigns`. Scheduling is the remaining gap (see below).

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

CREATING an invitation campaign draft works on an UNPUBLISHED event. SCHEDULING/sending is hard-gated: on an unpublished event Glue Up pops "Please publish your event" and blocks the send. So the publish gate sits **between create and schedule**, not before create — which is why `create-draft` stages event + campaign drafts pre-publish, and scheduling must be a separate post-publish step. Also: `EventInvitationCampaign` is only OFFERED as a type on upcoming events (a past event only offers `RegularEventCampaign`).

### Confirmed gap: campaign setup payloads

`AddCampaign` alone creates invitation campaign shells with no recipients. Steps 2–5 must be captured and replayed before scheduling:

- `recipientFiltersStandardFormSubmit`
- `negativeFiltersStandardFormSubmit`
- `SetupCampaignFormSubmit`
- `ContentFormSubmit`

Use `probe-campaign -- --event <eventId> --campaign <campaignId> --capture-values` against one of the existing draft campaigns to capture the real setup payloads into `.glueup-debug/campaign-probe.json`. Do not implement replay from the old value-free report, because it only contains key paths/types and would risk clobbering approved template content.

The captured setup pattern is now folded into `create-draft`. Each `AddCampaign` result is immediately followed by recipient filters, negative filters, setup, and content replay. The default recipient setup includes Contacts, and the default negative filter excludes all attendees for the same event.

The captured payload can still be replayed manually against every campaign in a run manifest for repair/debug:

```bash
npm run apply-campaign-setup -- --event 6 --headed
```

This rewrites event-specific filter keys to the manifest's Glue Up event ID, rewrites each setup `campaignName` from the manifest campaign title, normalizes the negative filters to exclude all attendees rather than invitees, posts the four setup/content actions, and records `setupAppliedAt` per campaign. It was run successfully for `evt-2026-006`, applying setup to campaigns `508089` and `508090`.

## Recommended Next Step

1. Run a fresh end-to-end `create-draft` test against event 7 and inspect the resulting campaign recipients/setup/content in Glue Up.
2. Add a post-publish `schedule-campaigns` CLI command: read `manifest.glueUp.campaigns` + the final published event date, then POST `schedule-campaign` for each at `sendTime: "04:00"` on the week-before / day-before `sendDate`. Reuse `fetchCampaignCsrfToken` and the `assertNoAppError` error handling. The schedule-campaign success/error response shape is unknown (never let through) — capture it on the first real run, and detect the "please publish" gate to fail gracefully if the event isn't published.

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
npm run create-draft -- 6                  # normal path: fresh prepare + create draft
npm run create-draft -- --event 6         # target a specific older event (syncs only if not already on disk)
npm run create-draft -- --event 6 --fresh # dispatch a new prepare run, wait for it, then create the draft
```

The event index is named once, positionally, for the normal fresh path. With no args, `create-draft` pulls the most recent successful prepare run and infers the event from the artifact name (`glueup-run-evt-<year>-<NNN>`), so the index is never repeated locally. Use `--event` only when intentionally targeting an older prepared run.

Behavior:

1. Resolves the run directory (pull-latest / `--event` / `--fresh` / `--run`).
2. Reads `manifest.json`, `template-selection.json`, and `event.json`.
3. Uses `template-selection.selected.glueUp.eventType` and `.blueprintCode`.
4. Runs AddEvent → blueprintSubmit → EventSessionSubmit, populating title, start/end date+time, and venue from `event.json`.
5. Creates two invitation campaign drafts (week-before, day-before) on the new event via `addCampaign`; failures are captured per-campaign so they don't lose the event.
6. Persists the event ID/URL and `glueUp.campaigns` (each `{ key, label, title, campaignId, campaignUrl }`) into `manifest.json`, and writes the raw event response to `draft-create-response.json`.
7. Does NOT schedule the campaigns — that is the post-publish step (see "Campaign flow" above).

`create-draft` requires the `gh` CLI (authenticated) to pull artifacts.

Standalone steps if you want to pre-stage or refresh auth separately:

```bash
npm run sync-run -- --event 6 [--fresh]   # download an artifact only
npm run glueup-login                      # refresh the saved browser session only
```

Treat these as debug/support commands. The preferred operator path remains `create-draft`.

Dry run (no Glue Up auth required):

```bash
npm run create-draft -- --event 6 --dry-run
```

This writes `draft-create-plan.json` with the blueprint and request shape that would be sent.

## Validation Notes

Missing `registrationUrl` is a warning, not an error, at prepare time. The event page URL is produced after Glue Up draft creation.

Campaign artifacts are fill briefs for approved Glue Up campaign templates, not standalone emails.
