// Replaces the CMS leader lists in site/index.html with the embed component.
// Edits the existing copy in place, so other local changes are kept.
// Usage: node scripts/use-embed.mjs [--data-url <url>] [--script-url <url>]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceLeaderLists } from "../src/embed.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexFile = path.join(projectDir, "site", "index.html");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} needs a value.`);
  return process.argv[index + 1];
}

const dataUrl = option("--data-url", "/api/leaders.json");
const scriptUrl = option("--script-url", "/component/leaders-embed.js");

const original = await readFile(indexFile, "utf8").catch(() => {
  console.error("No snapshot yet. Run: npm run snapshot");
  process.exit(1);
});
const { html, replaced } = replaceLeaderLists(original, { dataUrl, scriptUrl });
if (replaced === 0) {
  const already = original.includes("data-ycp-leaders");
  console.log(already ? "The embed is already in place; nothing changed." : "No CMS leader lists found; nothing changed.");
  process.exit(already ? 0 : 1);
}
await writeFile(indexFile, html);
console.log(`Replaced ${replaced} CMS leader lists in site/index.html with the embed.`);
console.log(`  data:   ${dataUrl}`);
console.log(`  script: ${scriptUrl}`);
