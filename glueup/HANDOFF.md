# Glue Up Populate Gap Todo

This handoff is a todo list for data already pulled from the Google Drive event summary sheet by the prepare/ensure flow, but not yet populated into the Glue Up event draft by `npm run populate`.

Current baseline:

- `ensure` pulls a prepared run artifact from GitHub Actions. The artifact contains `event.json`, generated briefs, photo recommendations, and the selected Glue Up blueprint.
- `event.json` is produced from the Google Doc event summary sheet by `extractEventFromGoogleDoc`.
- `populate` currently updates only the Glue Up draft's general settings for title, start/end date, start/end time, and timezone in `populateEventSettingsViaSettingsPage`.
- Campaign setup/content is handled separately and is not the same as populating the Glue Up event draft page.

## Already Populated By `populate`

- [x] Event title
  - Source: `event.rawFields["talk topic (if applicable)"]`, falling back to explicit event name/title fields only when the talk topic is blank
  - Current target: settings/general `input[name="title"]`
- [x] Event date
  - Source: `event.eventDate`
  - Current target: settings/general `startDate` and `endDate`
- [x] Event time
  - Source: `event.rawFields.time`, parsed by `parseEventTimes` via the shared `parseEventAgenda` (`src/extract/agenda.js`)
  - Current target: settings/general `startTime` and `endTime`
  - A multi-line `time` block is parsed into agenda rows; the event window spans the **public** rows only (first public start to last public end). Internal leadership rows are excluded so setup/cleanup never widen the window.
  - Internal rows are detected three ways (union): the **sandwich structure** (in a 3+ row agenda the first and last rows are always internal), a `(…leadership/staff/crew/team…)`-style parenthetical, OR setup/teardown keywords (set up, clean up, load in/out, tear down, strike).
  - The sandwich rule requires 3+ rows so a single overall time range or a two-item list is never hollowed out; the tag/keyword detection still covers those shorter cases.
  - The public rows are also stored on `event.agenda`, rendered as a `## Schedule` section in `webpage.md`, and exposed to the OpenAI generator as `event.publicSchedule` (with the raw internal rows stripped from the prompt).
- [x] Event timezone
  - Source: config timezone, default `America/New_York`
  - Current target: settings/general `venue.timezone` or `timezone`
- [x] Venue/location
  - Source: `event.venue`, from sheet keys `venue`, `location`, or `place`
  - Current target: `/events/<eventId>/publishing/content/venue/ajax`, action `EventVenueSubmit`
  - Geo coordinates are resolved through `/map/ajax`, action `search`, using the sheet venue/address text.
  - Can be run alone with `npm run populate-venue -- --event <index>` for repair/debug.
- [x] City
  - Source: `event.city`, or inferred from the final venue/address line when it looks like `City ST ZIP`
  - Current target: `cityName` in the `EventVenueSubmit` payload
  - Follow-up: if Glue Up exposes province/state separately in a required case, extend the venue payload beyond the currently-empty `address.provinceDropdown.us` object captured from the UI.
- [x] Speaker names and speaker details (implemented in `populateEventSpeakersViaAjax`)
  - Source: top-level `event.speakers`, extracted from `event.rawFields["speaker (if applicable)"]`, falling back to speaker/presenter variants.
  - Current target: `/events/<eventId>/publishing/content/speakers/ajax`, action `create-manual-speaker` (the same action the "add manually" UI fires; not `SpeakerStandardFormSubmit`).
  - Payload: envelope `action`/`token`/`orgID`/`currentPath`, plus `data` with `id:""`, `firstName`, `lastName`, `position`, `company`, `email`, `website`, `description`, `order.code:"-1"`, and a default-profile `image` object.
  - Parses newline/semicolon-delimited entries, skips `TBD`, splits names into `firstName`/`lastName`, and maps comma- or hyphen-delimited details into `position`/`company`.
  - Existing speakers are skipped by name (idempotent re-runs).
  - Headshots: `prepare` (in CI, where Drive creds exist) finds the event's speaker/bio subfolder, pulls each speaker's photo (the first inline image of their "Photo and Bio" Google Doc, or a plain image file) into `speaker-photos/` + `speaker-photos.json`. `populate` then uploads the matched headshot via the `UploadImageButton` flow (`POST /upload/images` with `files[]`/`token`/`orgID`/`currentPath`/`returnUrl`/`type`, then `?isCrop=true` for a centered square) and uses the resulting image object in `create-manual-speaker`; speakers without a photo keep the default avatar.
  - Can be run alone with `npm run populate-speakers -- --event <index>` for repair/debug.
- [x] Event description / summary (implemented in `populateEventSummaryViaSummaryPage`)
  - Source: `event.description`, from sheet keys `description`, `overview`, or `summary`
  - Also appears in generated `webpage.md`
  - Populates the event page body/overview (`about`) section in the approved Glue Up template.
  - Can be run alone with `npm run populate-summary -- --event <index>` for repair/debug.
  - Confirmed UI: `/events/<eventId>/publishing/content/summary/`, separate from settings/general and from venue.
  - Confirmed save endpoint: `/events/<eventId>/publishing/content/summary/ajax`, action `StandardFormSubmit`.
  - Confirmed `StandardFormSubmit` payload: envelope fields `action`, `token`, `orgID`, `currentPath`, plus `language` (e.g. `en`), `about`, and `submit: "save"`.
  - Field is named `about` and is rich-text HTML: the editor stores `<p style="text-align: center;">…</p>`, so plain-text `event.description` must be wrapped into `<p>` HTML before saving.
  - Response is JSON `{ code: 200, data.value.about, data.errors: [] }`, so the save is verifiable from `data.value.about` / empty `data.errors`.
  - The summary editor is a contenteditable widget (probe `forms: []` was empty), so replaying the AJAX with `token`/`orgID`/`currentPath` read from the page is more robust than driving the rich-text DOM.

## Todo: Event Draft Fields Not Yet Populated

- [ ] Event type/program type details
  - Source: `event.eventType`
  - Already used for template selection, but not written into the draft after creation.
  - Need to verify whether any visible Glue Up field should be updated from this after the blueprint is selected.

- [ ] Registration URL / event page URL round-trip
  - Source: `event.registrationUrl`, from sheet keys `registration url`, `registration link`, `link`, or `url`
  - Prepare treats a missing registration URL as a warning because Glue Up creates the event URL after draft creation.
  - Need to decide whether an existing registration URL from the sheet should ever be written into Glue Up, or whether Glue Up's generated `manifest.glueUp.eventUrl` should be written back only to local artifacts.

- [~] Event banner image (in progress — paused after Stage 1)
  - Goal: pick a relevant, recent photo from the shared "photo library" drive and set it as the Glue Up event banner.
  - Source drive: `GLUEUP_PHOTO_LIBRARY_FOLDER_ID` (default `0APt58RkpagPZUk9PVA`), a shared drive organized as `/<YEAR>/<event-or-date subfolder>/images`. Root also has utility folders to skip (`PDF Split Pages`, `Photo Organizer`, `EventData`, `Ads`, `Receipts`). The CI service account (`sheets@gen-lang-client-0848431620.iam.gserviceaccount.com`) has been granted access.
  - Most images are `.HEIC`/`.heif` (iPhone); some are designed graphics (PNG/JPEG). Listing a shared-drive root needs `corpora=drive&driveId=...` (see `listChildren({ driveId })`).
  - Decisions: rank candidates by **AI vision** (OpenAI, `detail: low`); **convert HEIC→JPEG** in CI via a `heic-convert` dependency (requires adding an `npm install`/`npm ci` step to `.github/workflows/glueup-monthly-prepare.yml`, which currently installs nothing — set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so the playwright dep doesn't pull browsers).
  - Stage 1 DONE: `gatherBannerCandidates(drive)` walks most-recent year → recent subfolders → newest images (cap `BANNER_CANDIDATE_LIMIT`); verified in CI on event 7 (returns the World Cup ad PNG/JPEG + recent April HEIC photos). Currently only logs candidates in `prepare` (the `bannerCandidates` block) — does not yet convert/rank/download.
  - Remaining: (2) HEIC→JPEG conversion + dep/workflow; (3) AI-vision ranking → pick one; (4) download + save banner to the run artifact (e.g. `banner.jpg` + `banner.json`).
  - Stage 5 DONE (upload implemented): `populate-banner` / `populateEventBannerViaDesignPage`. The banner is the **headerImage** on the Website→Design customizer, not a content page.
    - Probe (event 185176, `.glueup-debug/banner-probe.json`): page `/events/<eventId>/publishing/website/design/`; save `POST /events/<eventId>/publishing/website/design/ajax`, action `updateCustomizeSidebarGroupItemImage`.
    - Payload: envelope `action`/`token`/`orgID`/`currentPath` + `data` = `{ id: "headerImage", value: { styleString, croppedUrl, type:"fixed-width", uri, originalUri, html, alignment:"Center", size:1000, id, name } }`.
    - Upload reuses the speaker `/upload/images` flow (`postGlueUpUpload`) but with `type: "fixed-width"` (full-bleed header, no square crop). The fixed-width/orig URIs are assembled from the returned image id by the UI's convention: `uri=/resources/public/images/fixed-width/1000/<id>.<ext>`, `originalUri=/resources/public/images/orig/<id>.<ext>`, `srcset` uses the 1920 variant.
    - Response is JSON `code:200` with `data.value.images.headerImage.id` echoing the upload; verified via `assertNoAppError`.
    - `populate-banner` reads `banner.jpg`/`.jpeg`/`.png` from the run dir (`resolveBannerPath`) and skips gracefully if absent — so steps 2–4 just need to drop `banner.jpg` into the artifact. `populate` runs it after speakers and records `glueUp.bannerPopulatedAt`/`banner`.
    - NOT yet end-to-end verified against a live draft (no real `banner.jpg` produced yet); test by dropping a placeholder `banner.jpg` into `runs/<run>/` and running `npm run populate-banner -- --event 7`.
  - The `event` photos in the Drive event folder (`photos.json`/`photo-recommendations.json`) are a separate, older signal and are not the banner source.

- [ ] Webpage field brief
  - Source: `webpage.md`, generated from `event.json` and photos
  - Current `populate` does not read `webpage.md`.
  - Need to translate the brief into specific Glue Up template fields/blocks instead of leaving it as an operator reference.

- [ ] Agenda/session table rows
  - Source: `event.sessions`, when the Google Doc contains a non-key/value table
  - Current prepared sample has `sessions: []`, but the extractor supports `time`, `title`, `speakers`, and `description`.
  - Need to populate Glue Up agenda/session records when sessions are present.

- [ ] Food for event
  - Source: `event.rawFields["food for event"]`
  - Need to decide whether this is public event-page content, internal-only, or ignored.

- [ ] Priest for confession
  - Source: `event.rawFields["priest for confession"]`
  - Need to decide whether this belongs in public description/schedule content for event types that offer confession.

- [ ] Community table
  - Source: `event.rawFields["community table"]`
  - Need to determine whether this maps to sponsors, partners, exhibitor/community table content, or remains internal planning data.

- [ ] Board member in attendance
  - Source: `event.rawFields["board member in attendance"]`
  - Likely internal planning data. Confirm whether it should remain out of Glue Up public draft content.

- [ ] Chaplain in attendance
  - Source: `event.rawFields["chaplain in attendance"]`
  - Likely internal planning data unless a template section calls for chaplain/priest attribution.

- [ ] Planning deadlines
  - Sources include `webpage to be completed by`, `social media ads to be completed by`, `bulletin ads to be completed by`, and `advertising start date`
  - These are pulled into `event.rawFields` but should probably not populate the Glue Up draft. Confirm and document as intentionally ignored.

## Implementation Notes

- Before implementing each unchecked item, use a headed Playwright probe on a disposable draft to capture the actual Glue Up form names and AJAX payloads for the relevant setup page.
- Reusable event setup probe:

```bash
npm run probe-event-setup -- --event <eventId>
npm run probe-event-setup -- --event <eventId> --path '/events/{eventId}/publishing/content/venue/' --report venue-probe.json --capture-values
```

The probe opens a headed browser with the saved Glue Up session, snapshots form controls, records setup-related GETs and AJAX POST payload shapes, and blocks destructive publish/send-style actions. Reports stream to `.glueup-debug/` and are gitignored. Use `--capture-values` only when replayable values are needed; token/cookie/password-like fields remain redacted.
- Keep the publish gate unchanged: `populate` may update draft content, but it must never publish the event.
