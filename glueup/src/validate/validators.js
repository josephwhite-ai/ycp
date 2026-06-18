import { selectEventTemplate } from "../templates/eventTypes.js";

const REQUIRED_EVENT_FIELDS = ["eventName", "eventDate"];

export function validateEventRun({ event, artifacts, config }) {
  const errors = [];
  const warnings = [];
  const templateSelection = selectEventTemplate(event);

  for (const field of REQUIRED_EVENT_FIELDS) {
    if (!event[field]) errors.push(`Missing required event field: ${field}`);
  }

  if (!event.venue && !event.city) {
    warnings.push("Missing venue/city. This may be fine for virtual events, but should be checked.");
  }

  if (!event.registrationUrl) {
    warnings.push("Registration URL is not set yet; it should be filled after the Glue Up event draft is created.");
  }

  if (!templateSelection.selected) {
    errors.push("Could not confidently select an approved Glue Up event template.");
  } else if (!templateSelection.selected.glueUp?.blueprintCode) {
    warnings.push(
      `Selected template "${templateSelection.selected.label} / ${templateSelection.selected.variantLabel}", but its Glue Up blueprint code is not configured yet.`
    );
  }

  const requiredByTemplate = templateSelection.selected?.requiredFields || [];
  if (requiredByTemplate.includes("speakers") && !hasSpeakers(event)) {
    warnings.push(`Selected template expects speakers, but no speakers were extracted.`);
  }

  if (!artifacts?.webpage?.trim()) errors.push("Missing generated webpage draft.");
  if (!artifacts?.emails?.weekBefore?.trim()) errors.push("Missing week-before email draft.");
  if (!artifacts?.emails?.dayBefore?.trim()) errors.push("Missing day-before email draft.");

  for (const [name, content] of Object.entries({
    webpage: artifacts?.webpage || "",
    weekBefore: artifacts?.emails?.weekBefore || "",
    dayBefore: artifacts?.emails?.dayBefore || ""
  })) {
    if (content.includes("{{") || content.includes("TBD") || content.includes("[registration link needed]")) {
      warnings.push(`${name} contains placeholders or TBD text.`);
    }
  }

  const schedule = buildCampaignSchedule(event.eventDate, config.timezone);
  if (!schedule) {
    errors.push("Could not calculate campaign schedule because eventDate is invalid.");
  } else {
    const now = new Date();
    if (schedule.weekBefore.instant <= now) {
      warnings.push("Week-before send time is in the past for this event.");
    }
    if (schedule.dayBefore.instant <= now) {
      warnings.push("Day-before send time is in the past for this event.");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    schedule: schedule
      ? {
          weekBefore: schedule.weekBefore.label,
          dayBefore: schedule.dayBefore.label,
          timezone: config.timezone
        }
      : null,
    templateSelection
  };
}

export function buildCampaignSchedule(eventDateValue, timezone) {
  if (!eventDateValue) return null;
  const dateMatch = String(eventDateValue).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return null;

  const [, year, month, day] = dateMatch.map(Number);
  const eventDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (Number.isNaN(eventDate.getTime())) return null;

  return {
    weekBefore: zonedSendDate(eventDate, -7, timezone),
    dayBefore: zonedSendDate(eventDate, -1, timezone)
  };
}

function zonedSendDate(eventDate, dayOffset, timezone) {
  const sendDate = new Date(eventDate);
  sendDate.setUTCDate(sendDate.getUTCDate() + dayOffset);
  const year = sendDate.getUTCFullYear();
  const month = String(sendDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(sendDate.getUTCDate()).padStart(2, "0");
  const label = `${year}-${month}-${day} 04:00 ${timezone}`;

  return {
    label,
    instant: approximateLocalInstant(year, Number(month), Number(day), 4, timezone)
  };
}

function approximateLocalInstant(year, month, day, hour, timezone) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  const offsetMinutes = getTimezoneOffsetMinutes(utcGuess, timezone);
  return new Date(utcGuess.getTime() - offsetMinutes * 60_000);
}

function getTimezoneOffsetMinutes(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset"
  }).formatToParts(date);
  const value = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

export function validationReport(validation) {
  const lines = [`# Validation Report`, "", `Status: ${validation.ok ? "OK" : "Needs attention"}`, ""];

  if (validation.schedule) {
    lines.push("## Campaign Schedule", "");
    lines.push(`- Week before: ${validation.schedule.weekBefore}`);
    lines.push(`- Day before: ${validation.schedule.dayBefore}`);
    lines.push("");
  }

  if (validation.templateSelection) {
    lines.push("## Template Selection", "");
    lines.push(`Confidence: ${validation.templateSelection.confidence}`);
    if (validation.templateSelection.selected) {
      lines.push(
        `Selected: ${validation.templateSelection.selected.label} / ${validation.templateSelection.selected.variantLabel}`
      );
    } else {
      lines.push("Selected: none");
    }
    lines.push("");
  }

  if (validation.errors.length) {
    lines.push("## Errors", "");
    lines.push(...validation.errors.map((error) => `- ${error}`), "");
  }

  if (validation.warnings.length) {
    lines.push("## Warnings", "");
    lines.push(...validation.warnings.map((warning) => `- ${warning}`), "");
  }

  return `${lines.join("\n")}\n`;
}

function hasSpeakers(event) {
  return (event.speakers || []).length > 0 || (event.sessions || []).some((session) => session.speakers?.length);
}
