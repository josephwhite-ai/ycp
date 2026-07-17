# Glue Up Populate Gap Todo

This handoff is a todo list for data already pulled from the Google Drive event summary sheet by the prepare/ensure flow, but not yet populated into the Glue Up event draft by `npm run populate`.

Current baseline:

- `ensure` pulls a prepared run artifact from GitHub Actions. The artifact contains `event.json`, generated briefs, photo recommendations, and the selected Glue Up blueprint.
- `event.json` is produced from the Google Doc event summary sheet by `extractEventFromGoogleDoc`.
- `populate` currently updates only the Glue Up draft's general settings for title, start/end date, start/end time, and timezone in `populateEventSettingsViaSettingsPage`.
- Campaign setup/content is handled separately and is not the same as populating the Glue Up event draft page.
- `prepare` runs a conservative Gemini proofreading pass over public event fields,
  speaker details, and generated copy. It writes `content-review.json`, surfaces
  findings in `validation-report.md`, and treats HIGH-confidence issues as errors.
  Normal ensure/populate/finalize paths block on those issues unless an operator
  explicitly passes `--allow-content-review-issues` after manual review.

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

- [x] Public event page content blocks (implemented in `populateEventPageContentViaDesignPage`)
  - The public event page (Website → Design "home" page) is an ordered array of content blocks saved via `publicPageSubmit` → `POST /events/<eventId>/publishing/website/pages/ajax`.
  - `populate` now writes the page so it reads: block 0 `summary` (event details / description) → block 1 `html` (schedule built from `event.agenda` public rows via `buildEventScheduleHtml`, plus the standard YCP "Join us" CTA) → the blueprint widgets (`speakersWidget`, `agendaWidget`, `venueWidget`, `sponsorsWidget`, `exhibitorsWidget`, `ticketsWidget`, `directoryWidget`).
  - **Key technique:** posting blocks with empty `id:""` makes Glue Up mint fresh ids and **replace** the whole page content (stays 9 blocks, no duplication), so we never need to read the per-event block ids first. Re-runnable.
  - **Token gotcha:** the `publishing/website/*` endpoints reject the cookie CSRF token; they require the page-embedded token (reuse `fetchGlueUpPageCsrfToken`, same as the banner step). The cookie token still works for `/map/ajax`, venue, speakers, etc.
  - Reordering the blocks programmatically was abandoned: the customizer keeps block state in an in-memory model inside a preview iframe that never appears in any HTTP response, and block ids are per-event. Overwriting the two content blocks (above) is the supported path instead.
  - Can be run alone with `npm run populate-page -- --event <index>`.
- [x] Speaker details in invitation campaigns
  - `buildDefaultCampaignSetupPayloads` inserts a "Featured Speakers" `html` block (name — position, company, built by `buildCampaignSpeakersHtml`) after the `summary` block in the `ContentFormSubmit` email body. Applied to both the week-before and day-before campaigns.
- [x] Special event templates (`templates/<keyword>/template.json`)
  - Matched by keyword against the summary sheet during `prepare` (or backfilled/refreshed during `ensure` while unresolved). Can carry static page blocks (`pageTemplate.content`, `{{scheduleHtml}}` substituted per event at populate time), a pinned blueprint (`glueUp.eventType`/`blueprintCode`, applied to `template-selection.json` and validation so event types outside the taxonomy still select a blueprint), and a banner (`banner.sourceUrl`, downloaded into the run dir during local `ensure`; manual banner drops without `banner.json` are left alone).
  - **Why static blocks:** the Yard Goats model event 145378 predates the org's v2 site templates — its admin design page 302s to the template chooser, so it can never be resolved live (`resolveGlueUpPageTemplateReference` finds no content). Live resolution via `pageTemplate.sourceUrl` still works for v2-era source events.
  - `populate-page` refuses to run while a matched special template is unresolved (prevents silently publishing generic blocks).
  - Verified live on draft 188278 (evt-2026-008): static blocks + substituted schedule landed via `populate-page`; blueprint pin and Dunkin' Park banner download verified via `ensure`.
  - **Open item:** the banner *upload* (`populate-banner`) hit a Glue Up-side `/upload/images` outage on 2026-07-17 — every variant returns `{code:504, "Sorry, an error occurred"}` including the real design-customizer UI driven by browser (and the previously-working speaker upload path with a fresh page token). Nothing wrong with the payload; re-run `npm run populate-banner -- --run runs/evt-2026-008` once Glue Up recovers.

## Architecture: prepare renders the final content, populate transfers it

To make the content-review pass cover exactly what gets published, all final
public-facing strings are rendered in `prepare` and carried in the artifact;
`populate` is a dumb transfer agent that pushes them verbatim.

- `src/generate/eventContent.js` is the single source of truth for rendered
  content (pure functions, no Glue Up/network): `renderPublishedContent({ event, speakers })`
  returns `{ summaryHtml, pageScheduleHtml, enableSpeakers, campaignSpeakersHtml, widgets }`.
  It owns the schedule/where-when/venue-line/date builders, the YCP "Join us"
  CTA, `descriptionToHtml`, and `buildCampaignSpeakersHtml`.
- `prepare` renders from the **normalized** event (`normalizeEventFields` — the
  same normalization `populate` applies), writes `content-render.json` into the
  run, then passes the bundle to `proofreadEventContent` (which strips tags via
  `htmlToText` and reviews `publishedSummary`/`publishedSchedule`/`publishedCampaignSpeakers`).
- `populate` loads the bundle via `loadRenderedContent(runDir, event)` and pushes
  it: `populateEventSummaryViaSummaryPage({ summaryHtml })`,
  `populateEventPageContentViaDesignPage({ scheduleHtml, enableSpeakers, widgets })`,
  and `buildDefaultCampaignSetupPayloads({ speakersHtml })`. These no longer
  author content — they only transfer it.
- **Fallback:** if `content-render.json` is absent (older artifacts / local
  debugging), `loadRenderedContent` renders once via the same module and logs it.
  Same code, not a second author, so there is no drift.
- **Parity requirement:** `prepare` and the fallback both render from
  `normalizeEventFields(event)`, so proofread strings match what is pushed.
  Anything inherently populate-time (venue geo from `/map/ajax`, speaker upsert
  ids, image uploads) is non-text and out of the proofreader's scope.

## Implemented: Tavily headshot fallback for speakers without a Drive photo

Goal: when a speaker has no photo in the Google Drive bio folder, find a source-linked image via the **Tavily Search API** instead of leaving the default avatar. Google Custom Search JSON API was removed because Google closed it to new customers in 2026 and returned 403 for this project.

Implementation note: the fallback runs automatically when `TAVILY_API_KEY` and
`GEMINI_API_KEY` are configured and Drive has no usable photo. Results must pass
source-page name/company metadata confidence plus size/type/aspect checks; Gemini
then confirms only that the image is a plausible single-person professional
headshot. Source URLs and confidence reasons appear in the validation report.
Drive photos always take precedence.

Context already in place (reuse, don't rebuild):
- `gatherSpeakerPhotos` (in `prepare`, `src/cli.js`) pulls Drive headshots into `runs/<run>/speaker-photos/` + writes `speaker-photos.json` (entries: `fullName`, `firstName`, `lastName`, `position`, `company`, `photoFile`, `source`). Speakers missing here are the fallback candidates.
- `normalizeEventSpeakers(event)` yields the parsed speakers (`fullName`, `position`, `company`, …).
- `populateEventSpeakersViaAjax` already **upserts by id**: `findExistingSpeakerId(html, fullName)` parses the existing speaker's 24-hex id from the speakers page, and `create-manual-speaker` with that id updates (used to attach a photo to a speaker created in an earlier run). So once a fallback image lands in the run as a `speaker-photos.json` entry with a `photoFile`, the existing populate/update path uploads it via `uploadGlueUpSpeakerImage` with no further changes.

Setup the operator must provision once:
- Create a Tavily API key at app.tavily.com.
- Add repo secret `TAVILY_API_KEY`; the existing `GEMINI_API_KEY` performs the plausibility check.

API call:
- `POST https://api.tavily.com/search` with `include_images`, `include_image_descriptions`, and `exact_match` enabled.
- Query string: `"<fullName>" <position> at <company>` (drop empty parts). Example that worked manually: `Joseph Frissora III Associate Financial Professional at Paragon Financial Group`.
- Response: source results with `results[].{title,url,content,images}`. Require corroborating page metadata, prefer roughly square/portrait images above 200px, and use Gemini to reject obvious logos, groups, and graphics.

Implementation steps:
1. `src/generate/speakerImageSearch.js` exports `findSpeakerHeadshot({ speaker })`, which runs Tavily, validates identity evidence and image bytes, calls Gemini, and returns `{ bytes, ext, sourceUrl, contextUrl, confidence }` or null.
2. `gatherSpeakerPhotos` calls it for each speaker with no Drive match, writes `speaker-photos/<slug>.<ext>`, and records `source: "tavily-image-search:<sourceUrl>"`. The existing upload/update path handles Glue Up.
3. **Correctness guard (implemented):** never take result #1 on rank alone. Require corroborating result metadata: exact/all-token name plus company evidence, or an exact distinctive name on a recognized professional-profile source. Preserve the image URL, context page, score, and reasons in `speaker-photos.json` and surface them in the validation report. Gemini is not used because it cannot verify identity.
4. Edge cases: no creds → skip silently (default avatar). Quota/429 → log and skip. Non-image/oversized → skip. Names with no company → still query name + position.

For event 7 specifically: only Joseph Frissora III lacks a Drive photo (Justin Murphy has one and is now populated). The quickest unblock without the API is to drop a verified image into `runs/evt-2026-007/speaker-photos/joseph-frissora-iii.jpg` + add a `speaker-photos.json` entry, then `npm run populate-speakers -- --run runs/evt-2026-007` (the upsert path attaches it to the existing speaker).

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
  - Decisions: rank candidates by **Gemini vision** (reusing the Google service account — no separate AI vendor key); **convert HEIC→JPEG** via a `heic-convert` dependency.
  - Key design: **choose first, then convert.** We do NOT bulk-convert HEIC. Ranking runs on Drive's server-generated JPEG **thumbnails** (`thumbnailLink`, exists even for HEIC), so `heic-convert` runs at most once — only on the single chosen winner.
  - Why Gemini, not OpenAI: the prior draft used OpenAI (`OPENAI_API_KEY`), which likely isn't set in CI and adds a second vendor. The project already authenticates to Google with a service account; that same key mints a `cloud-platform`-scoped token to call the Generative Language API. Stays in the Google ecosystem.
  - Stage 1 DONE: `gatherBannerCandidates(drive)` walks most-recent year → recent subfolders → newest images (cap `BANNER_CANDIDATE_LIMIT`); now also requests each image's `thumbnailLink`.
  - Stages 2–4 DONE: `selectBannerCandidate` (`src/generate/bannerSelector.js`) downloads the candidates' upsized thumbnails (`=s800`) and ranks them with Gemini `generateContent` (`config.geminiModel`, default `gemini-2.5-flash-lite`, `responseSchema` JSON `chosenId`+`ranking`), authing via `googleAccessToken(GENAI_SCOPES)`. `prepareBannerImage` (in `prepare`) downloads only the winner's original, converts via `toBannerImage` (HEIC→JPEG with lazily-imported `heic-convert`; PNG kept; else `.jpg`), and writes `banner.jpg` (or `.png`) + `banner.json` (sourceId/name/folder/reason/ranking) into the run. Falls back to the newest candidate when ranking is unavailable (no creds / no thumbnails) so a banner is still produced. All non-fatal — failure logs and continues.
  - Auth plumbing: `googleDriveClient.js` now exposes `googleAccessToken(scopes)` + `GENAI_SCOPES`; the service-account/ADC paths mint any requested scope, so one key serves both Drive (readonly) and Gemini (cloud-platform). Pre-supplied `GOOGLE_ACCESS_TOKEN` or gcloud login carry fixed scopes (best-effort).
  - Dependency/workflow: `heic-convert` added to `package.json`; `.github/workflows/glueup-monthly-prepare.yml` now runs `npm ci` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` before check/prepare.
  - Verified end-to-end in CI (event 7, run 27825155129): prepare produced `banner.png` (the World Cup ad) + `banner.json` via the fallback and uploaded them in the artifact.
  - **Service-account OAuth does NOT work for `generateContent`** — it 403s on `generativelanguage.googleapis.com` (AI Studio project `gen-lang-client-0848431620`). Decision: use a **Google AI Studio API key** instead. `selectBannerCandidate` now prefers `config.geminiApiKey` (`GEMINI_API_KEY`, sent as `x-goog-api-key`) and only falls back to SA OAuth. Workflow passes `GEMINI_API_KEY` from secrets; create the key at aistudio.google.com/apikey and add it as repo secret `GEMINI_API_KEY`. Until that secret exists, ranking stays on the newest-candidate fallback.
  - Stage 5 DONE (upload implemented): `populate-banner` / `populateEventBannerViaDesignPage`. The banner is the **headerImage** on the Website→Design customizer, not a content page.
    - Probe (event 185176, `.glueup-debug/banner-probe.json`): page `/events/<eventId>/publishing/website/design/`; save `POST /events/<eventId>/publishing/website/design/ajax`, action `updateCustomizeSidebarGroupItemImage`.
    - Payload: envelope `action`/`token`/`orgID`/`currentPath` + `data` = `{ id: "headerImage", value: { styleString, croppedUrl, type:"fixed-width", uri, originalUri, html, alignment:"Center", size:1000, id, name } }`.
    - Upload reuses the speaker `/upload/images` flow (`postGlueUpUpload`) but with `type: "fixed-width"` (full-bleed header, no square crop). The fixed-width/orig URIs are assembled from the returned image id by the UI's convention: `uri=/resources/public/images/fixed-width/1000/<id>.<ext>`, `originalUri=/resources/public/images/orig/<id>.<ext>`, `srcset` uses the 1920 variant.
    - Response is JSON `code:200` with `data.value.images.headerImage.id` echoing the upload; verified via `assertNoAppError`.
    - `populate-banner` reads `banner.jpg`/`.jpeg`/`.png` from the run dir (`resolveBannerPath`) and skips gracefully if absent — so steps 2–4 just need to drop `banner.jpg` into the artifact. `populate` runs it after speakers and records `glueUp.bannerPopulatedAt`/`banner`.
    - NOT yet end-to-end verified against a live draft (no real `banner.jpg` produced yet); test by dropping a placeholder `banner.jpg` into `runs/<run>/` and running `npm run populate-banner -- --event 7`.
  - The `event` photos in the Drive event folder (`photos.json`/`photo-recommendations.json`) are a separate, older signal and are not the banner source.

- [~] Webpage field brief
  - Source: `webpage.md`, generated from `event.json` and photos
  - `populate` does not read `webpage.md` directly, but the public page content it produces (summary + schedule blocks, see "Public event page content blocks" above) now covers the brief's main content. `webpage.md` remains an operator reference.

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
