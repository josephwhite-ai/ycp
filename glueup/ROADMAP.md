# Glue Up agent roadmap

What the agent does today is described in [README.md](README.md). This page lists what's next.

**Today:** `prepare` turns the monthly event summary doc into proofread event content. `populate` fills the Glue Up draft's settings (title, dates, times, timezone), venue, tickets, public page content, speakers with headshots, the public tag and the event banner, plus the two invitation campaigns. `finalize` schedules the campaign emails after a person has reviewed and published the event.

## Next up

- **Verify the event banner end to end.** Choosing, converting and uploading the banner is implemented (`populate-banner`), but it hasn't been run against a live draft with a real `banner.jpg`. Gemini ranking of the candidate photos needs the `GEMINI_API_KEY` secret; without it, the newest photo is used.
- **Agenda/session rows.** The extractor already reads session tables (`event.sessions`: time, title, speakers, description). Write them to Glue Up's agenda when a doc has them.
- **Event type after creation.** `event.eventType` picks the template but isn't written back to the draft. Check whether any visible Glue Up field should reflect it.
- **Registration URL.** Decide whether a registration link in the doc should ever be written to Glue Up, or whether the URL Glue Up creates (`manifest.glueUp.eventUrl`) is only saved locally.

## Decisions needed

These fields are read from the summary doc but not used. Most are probably internal planning data; each needs a decision, and then either an implementation or a note saying it's intentionally ignored.

| Field | Likely answer |
| --- | --- |
| Food for event | Public page content, or internal only |
| Priest for confession | Public, for event types that offer confession |
| Community table | Sponsor/partner content, or internal only |
| Board member in attendance | Internal only |
| Chaplain in attendance | Internal only, unless a template shows chaplain attribution |
| Planning deadlines (webpage, social and bulletin ads, advertising start) | Internal only |

## Adding a new field

1. Capture Glue Up's real form names and request payloads on a disposable draft with the probe. It opens a visible browser with the saved session, blocks publish- and send-style actions, and redacts tokens unless `--capture-values` is passed. Reports go to the git-ignored `.glueup-debug/`.

   ```bash
   npm run probe-event-setup -- --event <eventId> --path '/events/{eventId}/publishing/content/venue/' --report venue-probe.json
   ```

2. Render any public copy in `prepare` (`src/generate/eventContent.js`), so the proofreading pass checks exactly what will be published. `populate` only transfers those prepared strings.
3. Keep the publish gate: `populate` may update draft content but must never publish the event.

Detailed implementation notes from earlier work, such as the banner endpoint payloads, are in this file's git history (it was previously `HANDOFF.md`).
