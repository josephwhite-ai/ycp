// Pure renderers for the final public-facing content that gets published to
// Glue Up. These run in `prepare` (so the artifact carries the exact strings the
// content-review pass reviews) and the same module is the single source of truth
// for `populate`, which transfers the rendered strings verbatim. No Glue Up or
// network access here — everything is a pure function of the event/speakers.
import { parseEventAgenda, selectPublicAgenda, formatAgendaRange } from "../extract/agenda.js";

// Public event-page widget blocks that follow the summary + schedule blocks.
export const PUBLIC_PAGE_WIDGETS = [
  "speakersWidget",
  "agendaWidget",
  "venueWidget",
  "sponsorsWidget",
  "exhibitorsWidget",
  "ticketsWidget",
  "directoryWidget"
];

// Standard YCP "Join us" call-to-action appended under the schedule.
const YCP_JOIN_BLURB =
  '<p>&nbsp;</p><p><strong>Join us!</strong></p>' +
  "<p>Come belong to the nation’s largest young professional Catholic network. " +
  "Together we’ll learn to live and share our Catholic faith through our daily work. " +
  "Access member-exclusive events and more!</p><p>&nbsp;</p>" +
  '<p><a href="http://www.youngcatholicprofessionals.org/why-belong#Join-Now" ' +
  'rel="noopener noreferrer" target="_blank" class="text-color-blue"><strong>Learn more</strong></a></p>';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rawEventField(event, keys) {
  const rawFields = event?.rawFields || {};
  for (const key of keys) {
    const normalized = key.toLowerCase().replace(/[:*]/g, "").replace(/\s+/g, " ").trim();
    if (rawFields[normalized]) return rawFields[normalized];
  }
  return "";
}

// Does the event description already contain a schedule/run-of-show? True when it
// names a schedule/agenda with a time, or lists two or more clock times. Used to
// avoid adding a second schedule section that restates the summary.
function descriptionHasSchedule(event) {
  const text = String(event?.description || "");
  if (!text) return false;
  const clockTimes = text.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi) || [];
  if (clockTimes.length >= 2) return true;
  return /\b(?:schedule|agenda|run of show)\b/i.test(text) && clockTimes.length >= 1;
}

// "2026-07-31" -> "July 31".
function formatEventDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!match) return "";
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}`;
}

// "Venue Name – City, ST" from the event venue/address text, falling back to just
// the name when no city/state line is present.
function buildEventVenueLine(event) {
  const lines = String(event?.venue || "")
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const name = lines[0] || "";
  if (!name) return "";
  let locale = "";
  for (const line of lines) {
    const match = /^(.+?),?\s+([A-Z]{2})\s+\d{5}/.exec(line);
    if (match) {
      locale = `${match[1].replace(/,$/, "").trim()}, ${match[2]}`;
      break;
    }
  }
  if (!locale && event?.city) locale = String(event.city).trim();
  return locale ? `${escapeHtml(name)} &ndash; ${escapeHtml(locale)}` : escapeHtml(name);
}

// Compact "where/when" block for events without a multi-row schedule, e.g.:
//   📅 July 31 | 7:00–9:00 PM
//   📍 St. Thomas the Apostle – West Hartford, CT
function buildEventWhereWhenHtml(event, rows = []) {
  const parts = [];
  const date = formatEventDate(event?.eventDate);
  const range = rows.length
    ? formatAgendaRange({ startTime: rows[0].startTime, endTime: rows[rows.length - 1].endTime })
    : "";
  const when = [date, range].filter(Boolean).join(" | ");
  if (when) parts.push(`<p>📅 ${escapeHtml(when)}</p>`);
  const where = buildEventVenueLine(event);
  if (where) parts.push(`<p>📍 ${where}</p>`);
  return parts.join("");
}

// Block 1 of the public event page: a full "Schedule" section for a real
// multi-row run-of-show, otherwise the compact emoji where/when block, plus the
// YCP "Join us" CTA.
export function buildEventScheduleHtml(event, { includeJoinBlurb = true } = {}) {
  // `event.agenda` is only set at extraction time, so derive it from the raw
  // "time" field when missing (older artifacts), keeping the block populated.
  const agenda =
    Array.isArray(event?.agenda) && event.agenda.length
      ? event.agenda
      : parseEventAgenda(rawEventField(event, ["time", "schedule", "agenda", "run of show"]));
  const rows = selectPublicAgenda(agenda);
  const isMultiline = rows.length >= 2 && !descriptionHasSchedule(event);

  const parts = [];
  if (isMultiline) {
    parts.push("<p><strong>Schedule</strong></p>");
    for (const row of rows) {
      const range = formatAgendaRange(row);
      if (!range) continue;
      const label = row.label ? `&nbsp;&ndash;&nbsp;${escapeHtml(row.label)}` : "";
      parts.push(`<p><strong>${range}</strong>${label}</p>`);
    }
  } else {
    const whereWhen = buildEventWhereWhenHtml(event, rows);
    if (whereWhen) parts.push(whereWhen);
  }
  if (includeJoinBlurb) parts.push(YCP_JOIN_BLURB);
  return parts.join("");
}

// The summary HTML pushed to Glue Up: prefer the rich HTML captured straight
// from the Google Doc (bold/links/lists survive, like a copy-paste), falling
// back to rebuilding plain paragraphs for artifacts extracted before
// descriptionHtml existed.
export function eventSummaryHtml(event) {
  const html = typeof event?.descriptionHtml === "string" ? event.descriptionHtml.trim() : "";
  return html || descriptionToHtml(event?.description);
}

// Converts a plain-text description (blank-line separated) into the paragraph
// HTML the Glue Up Quill editor stores in the summary `about` field.
export function descriptionToHtml(description) {
  const text = typeof description === "string" ? description.trim() : "";
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// "Featured Speakers" HTML list for the invitation campaign email body. Takes the
// already-parsed speakers array; returns null when there are none.
export function buildCampaignSpeakersHtml(speakers) {
  const list = Array.isArray(speakers) ? speakers : [];
  if (!list.length) return null;
  const items = list
    .map((speaker) => {
      const name = escapeHtml(speaker.fullName);
      const detail = [speaker.position, speaker.company].filter(Boolean).join(", ");
      return `<li><strong>${name}</strong>${detail ? `&nbsp;&ndash;&nbsp;${escapeHtml(detail)}` : ""}</li>`;
    })
    .join("");
  return `<p><strong>Featured Speakers</strong></p><ul>${items}</ul>`;
}

// Renders every final published string into one bundle. `prepare` persists this
// as content-render.json so the content-review pass reviews exactly what gets
// published, and `populate` transfers these strings verbatim.
export function renderPublishedContent({ event, speakers = [] }) {
  return {
    renderedAt: new Date().toISOString(),
    summaryHtml: eventSummaryHtml(event),
    pageScheduleHtml: buildEventScheduleHtml(event),
    enableSpeakers: speakers.length > 0,
    campaignSpeakersHtml: buildCampaignSpeakersHtml(speakers),
    widgets: PUBLIC_PAGE_WIDGETS
  };
}
