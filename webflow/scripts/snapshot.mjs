// Downloads the live chapter page into site/ as a local copy to experiment on.
// Usage: node scripts/snapshot.mjs [--force] [--url <page url>]
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_STYLESHEET_PATH, transformPage } from "../src/snapshot.js";

const DEFAULT_PAGE_URL = "https://www.youngcatholicprofessionals.org/chapter/central-connecticut";
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(projectDir, "site");

const args = process.argv.slice(2);
const force = args.includes("--force");
const urlIndex = args.indexOf("--url");
const pageUrl = urlIndex >= 0 ? args[urlIndex + 1] : DEFAULT_PAGE_URL;
if (!pageUrl) throw new Error("--url needs a value.");

async function exists(file) {
  return access(file).then(() => true, () => false);
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (ycp-webflow snapshot)" } });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}.`);
  return response.text();
}

const indexFile = path.join(siteDir, "index.html");
if (!force && (await exists(indexFile))) {
  console.error("site/index.html already exists. Re-run with --force to replace it and lose local edits.");
  process.exit(1);
}

const { html, stylesheetUrl, removed } = transformPage(await fetchText(pageUrl), { pageUrl });
const css = await fetchText(stylesheetUrl);

const stylesheetFile = path.join(siteDir, LOCAL_STYLESHEET_PATH);
await mkdir(path.dirname(stylesheetFile), { recursive: true });
await writeFile(indexFile, html);
await writeFile(stylesheetFile, css);

console.log(`Saved ${pageUrl}`);
console.log(`  site/index.html (${html.length} bytes)`);
console.log(`  site/${LOCAL_STYLESHEET_PATH} (${css.length} bytes)`);
console.log(`Removed ${removed.length} tracking or sign-in scripts:`);
for (const item of removed) console.log(`  - ${item}`);
