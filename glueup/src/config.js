import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_EVENTS_FOLDER_ID = "1rhIJFpQASAzxso02Gu1tvnMxXlyFiuFE";
const DEFAULT_TIMEZONE = "America/New_York";

export function loadDotEnv(path = ".env") {
  const absPath = resolve(path);
  if (!existsSync(absPath)) return;

  const lines = readFileSync(absPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

export function getConfig(overrides = {}) {
  return {
    eventsFolderId:
      overrides.eventsFolderId ||
      process.env.GLUEUP_EVENTS_FOLDER_ID ||
      DEFAULT_EVENTS_FOLDER_ID,
    timezone: overrides.timezone || process.env.TIMEZONE || DEFAULT_TIMEZONE,
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"
  };
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

// An event is identified by its year and its index (a counter unique across the
// year, e.g. the 6th event of 2026). The slug keys the run dir, CI artifact, and
// active-event marker; the `evt-` prefix keeps it from being mistaken for YYYY-MM.
export function eventSlug(year, index) {
  return `evt-${year}-${String(index).padStart(3, "0")}`;
}

export function parseEvent(args = {}) {
  const event = args.event ?? args._?.[1];
  const { year } = args;
  if (event === undefined || event === true) {
    throw new Error("Missing event index. Example: npm run create-draft -- 6");
  }
  const index = Number(String(event).trim());
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid event index "${event}". Use a positive integer, e.g. 6.`);
  }

  const resolvedYear = year === undefined ? new Date().getFullYear() : Number(year);
  if (!Number.isInteger(resolvedYear) || resolvedYear < 2000 || resolvedYear > 9999) {
    throw new Error(`Invalid --year "${year}". Use a 4-digit year, e.g. 2026.`);
  }

  return { index, year: resolvedYear, slug: eventSlug(resolvedYear, index) };
}

export function eventInfoFromSlug(slug) {
  const match = /^evt-(\d{4})-(\d{1,})$/.exec(slug || "");
  if (!match) {
    throw new Error(`Invalid event slug "${slug}". Expected evt-YYYY-NNN.`);
  }
  return parseEvent({ event: Number(match[2]), year: Number(match[1]) });
}

// Pull the month out of a Drive event folder name like "06 - June 2026 - NHH".
// The leading number is the event index, not the month, so the month comes from
// the spelled-out month word — full or abbreviated ("Aug", "Sept").
export function monthInfoFromFolderName(name, year) {
  const lower = name.toLowerCase();
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  const monthIndex = MONTH_NAMES.findIndex((m) => {
    const month = m.toLowerCase();
    return (
      lower.includes(month) ||
      tokens.some((token) => token.length >= 3 && month.startsWith(token))
    );
  });
  if (monthIndex === -1) {
    throw new Error(`Could not find a month name in event folder "${name}".`);
  }
  return {
    year,
    month: monthIndex + 1,
    monthName: MONTH_NAMES[monthIndex]
  };
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}
