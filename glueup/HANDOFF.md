# Glue Up Populate Gap Todo

This handoff is a todo list for data already pulled from the Google Drive event summary sheet by the prepare/ensure flow, but not yet populated into the Glue Up event draft by `npm run populate`.

Current baseline:

- `ensure` pulls a prepared run artifact from GitHub Actions. The artifact contains `event.json`, generated briefs, photo recommendations, and the selected Glue Up blueprint.
- `event.json` is produced from the Google Doc event summary sheet by `extractEventFromGoogleDoc`.
- `populate` currently updates only the Glue Up draft's general settings for title, start/end date, start/end time, and timezone in `populateEventSettingsViaSettingsPage`.
- Campaign setup/content is handled separately and is not the same as populating the Glue Up event draft page.

## Already Populated By `populate`

- [x] Event title
  - Source: `event.eventName`
  - Current target: settings/general `input[name="title"]`
- [x] Event date
  - Source: `event.eventDate`
  - Current target: settings/general `startDate` and `endDate`
- [x] Event time
  - Source: `event.rawFields.time`, parsed by `parseEventTimes`
  - Current target: settings/general `startTime` and `endTime`
- [x] Event timezone
  - Source: config timezone, default `America/New_York`
  - Current target: settings/general `venue.timezone` or `timezone`

## Todo: Event Draft Fields Not Yet Populated

- [ ] Venue/location
  - Source: `event.venue`, from sheet keys `venue`, `location`, or `place`
  - Example from `runs/evt-2026-007/event.json`: `St. Thomas the Apostle`, address, city/state/ZIP
  - Need to determine Glue Up target fields. Current code does not fill venue name, address, city, or map/location fields.

- [ ] City
  - Source: `event.city`, from sheet key `city`
  - Note: many sheets put city inside the multiline `location` value instead of the `city` field. Decide whether to parse city from `event.venue` when `event.city` is blank.
  - Need to determine whether Glue Up stores this separately from venue/address.

- [ ] Event description / summary
  - Source: `event.description`, from sheet keys `description`, `overview`, or `summary`
  - Also appears in generated `webpage.md`
  - Need to populate the event page body/overview section in the approved Glue Up template.

- [ ] Speaker names and speaker details
  - Source: `event.rawFields["speaker (if applicable)"]`
  - Example from `runs/evt-2026-007/event.json`: `Joseph Frissora III`, `Justin Murphy`, `TBD`
  - Need to decide whether to populate Glue Up speakers, agenda/session speaker blocks, or template content blocks. The extractor currently leaves these only in `rawFields`; it does not normalize them into a first-class `speakers` array unless they appear in a session table.

- [ ] Talk topic
  - Source: `event.rawFields["talk topic (if applicable)"]`, also used to normalize `event.eventName`
  - Need to determine whether the topic should populate a subtitle, agenda title, event headline, or only remain as the event title.

- [ ] Event type/program type details
  - Source: `event.eventType`
  - Already used for template selection, but not written into the draft after creation.
  - Need to verify whether any visible Glue Up field should be updated from this after the blueprint is selected.

- [ ] Registration URL / event page URL round-trip
  - Source: `event.registrationUrl`, from sheet keys `registration url`, `registration link`, `link`, or `url`
  - Prepare treats a missing registration URL as a warning because Glue Up creates the event URL after draft creation.
  - Need to decide whether an existing registration URL from the sheet should ever be written into Glue Up, or whether Glue Up's generated `manifest.glueUp.eventUrl` should be written back only to local artifacts.

- [ ] Recommended hero/event images
  - Source: `photos.json` and `photo-recommendations.json`, generated from images in the Drive event folder
  - Current `populate` does not upload or select images in the Glue Up draft.
  - Need to map approved template image slots, decide which recommended image becomes the hero/banner, and implement upload/selection.

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

- Main populate gap is in `src/cli.js`, `populateEventSettingsViaSettingsPage`.
- Current selectors are limited to general settings fields:
  - `title`
  - `startDate` / `start_date`
  - `endDate` / `end_date`
  - `startTime` / `start_time`
  - `endTime` / `end_time`
  - `venue.timezone` / `timezone`
- Before implementing each unchecked item, use a headed Playwright probe on a disposable draft to capture the actual Glue Up form names and AJAX payloads for the relevant setup page.
- Keep the publish gate unchanged: `populate` may update draft content, but it must never publish the event.
