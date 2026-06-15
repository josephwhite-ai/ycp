import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini"
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

export function parseMonth(value) {
  if (!value) {
    const now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      monthName: MONTH_NAMES[now.getMonth()],
      slug: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
    };
  }

  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid --month "${value}". Use YYYY-MM, for example 2026-06.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid --month "${value}". Month must be between 01 and 12.`);
  }

  return {
    year,
    month,
    monthName: MONTH_NAMES[month - 1],
    slug: `${year}-${String(month).padStart(2, "0")}`
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

export function resolveRunDir(runArg) {
  if (!runArg) throw new Error("Missing --run path.");

  if (/^\d{4}-\d{2}$/.test(runArg)) {
    return join("runs", runArg);
  }

  if (!existsSync(runArg) && existsSync(join("runs", runArg))) {
    return join("runs", runArg);
  }

  return runArg;
}
