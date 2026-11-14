// Builds the published leaders data from the leaders Google Sheet.
//
// Usage: node scripts/sync-leaders.mjs --out <dir> [--sheet <id>] [--skip-if-live <leaders.json url>]
//
// Writes <dir>/leaders.json and <dir>/photos/*.jpg. With --skip-if-live, stops
// before downloading photos when the sheet matches what is already published.
// In GitHub Actions it reports changed=true|false as a step output.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDriveClient } from "../src/google.js";
import { parseCsv, rowsToLeaders } from "../src/sheet.js";
import { buildPhotos, leadersDocument, planPhotos, serialize } from "../src/sync.js";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

async function report(changed) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

function fail(title, errors) {
  console.error(`${title}\n${errors.map(error => `  - ${error}`).join("\n")}`);
  console.error("Nothing was published; the website keeps showing the last good version.");
  process.exit(1);
}

async function downloadUrl(url) {
  const response = await fetch(url, { headers: { "user-agent": "ycp-webflow leaders sync" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const outDir = option("--out");
const sheetId = option("--sheet") || process.env.LEADERS_SHEET_ID;
const liveUrl = option("--skip-if-live");
if (!outDir) throw new Error("--out is required.");
if (!sheetId) throw new Error("Pass --sheet <id> or set LEADERS_SHEET_ID.");

const drive = createDriveClient();
const { leaders, errors } = rowsToLeaders(parseCsv(await drive.exportSheetCsv(sheetId)));
if (errors.length) fail("The leaders sheet has problems:", errors);

const { planned, errors: photoErrors } = await planPhotos(leaders, drive);
if (photoErrors.length) fail("Some photos could not be used:", photoErrors);
const json = serialize(leadersDocument(planned));

if (liveUrl) {
  const live = await fetch(liveUrl, { cache: "no-store" }).then(response => (response.ok ? response.text() : ""), () => "");
  if (live === json) {
    console.log(`The sheet matches what is published at ${liveUrl}; nothing to do.`);
    await report(false);
    process.exit(0);
  }
}

const { processImage } = await import("../src/images.js");
const { files, errors: buildErrors } = await buildPhotos(planned, { downloadDrive: drive.downloadDrive, downloadUrl, processImage });
if (buildErrors.length) fail("Some photos could not be used:", buildErrors);

await mkdir(path.join(outDir, "photos"), { recursive: true });
await Promise.all(files.map(file => writeFile(path.join(outDir, file.path), file.bytes)));
await writeFile(path.join(outDir, "leaders.json"), json);
console.log(`Wrote ${leaders.length} leaders and ${files.length} photos to ${outDir}.`);
await report(true);
