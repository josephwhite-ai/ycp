// Reusable headed Playwright probe for reverse-engineering Glue Up event setup
// forms. It opens any event setup path, snapshots visible form controls, records
// setup-related GETs, captures AJAX POST payload shapes, and blocks destructive
// publish/send-style actions before they reach Glue Up.
//
// Usage:
//   node scripts/probe-event-setup.mjs --event 185176
//   node scripts/probe-event-setup.mjs --event 185176 --path '/events/{eventId}/publishing/content/venue/'
//   node scripts/probe-event-setup.mjs --event 185176 --report venue-probe.json --capture-values
//
// Close the browser window when done. Reports stream to .glueup-debug/.

import { resolve } from "node:path";
import {
  BASE_URL,
  DEFAULT_BLOCK,
  DEFAULT_SESSION_DIR,
  SECRET_KEYS,
  debugPath,
  installAjaxProbe,
  parseArgs,
  resolvePathTemplate,
  snapshotForms,
  waitForBrowserClose
} from "./lib/probeCore.mjs";

const DEFAULT_EVENT = "185176";
const DEFAULT_PATH = "/events/{eventId}/setup/settings/general/";
const DEFAULT_GET_HINT = /\/events\/\d+\/(setup|publishing)\//i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventId = String(args.event || DEFAULT_EVENT);
  const captureValues = Boolean(args.captureValues);
  const blockPattern = new RegExp(String(args.block || DEFAULT_BLOCK), "i");
  const getHint = args.getHint ? new RegExp(String(args.getHint), "i") : DEFAULT_GET_HINT;
  const sessionDir = resolve(args.sessionDir || process.env.GLUEUP_SESSION_DIR || DEFAULT_SESSION_DIR);
  const startPath = resolvePathTemplate(args.path || DEFAULT_PATH, { eventId });
  const reportPath = debugPath(String(args.report || "event-setup-probe.json"));
  const extraState = { forms: [], finalUrl: null };

  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || (await context.newPage());

  const probe = await installAjaxProbe({
    context,
    reportPath,
    metadata: {
      kind: "event-setup",
      eventId,
      startPath,
      getHint: getHint.source
    },
    captureValues,
    blockPattern,
    getHint,
    extraState
  });

  console.log(`\nEvent setup probe ready. Block pattern: /${blockPattern.source}/i`);
  console.log(`Event: ${eventId}`);
  console.log(`Start path: ${startPath}`);
  console.log(`${captureValues ? "Value-capturing" : "Value-free"} report streams to ${reportPath}`);
  if (captureValues) console.log(`Sensitive fields matching /${SECRET_KEYS.source}/i are still redacted.`);
  console.log("\nIn the browser: navigate to the setup form, edit/save the fields you want to reverse-engineer.");
  console.log("The report will update as forms and AJAX requests are observed.");
  console.log("Close the browser window when done.\n");

  await page.goto(`${BASE_URL}${startPath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  extraState.finalUrl = page.url().replace(BASE_URL, "");
  extraState.forms = await snapshotForms(page).catch((error) => [{ error: error?.message || String(error) }]);
  probe.writeReport();

  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    extraState.finalUrl = page.url().replace(BASE_URL, "");
    extraState.forms = await snapshotForms(page).catch((error) => [{ error: error?.message || String(error) }]);
    probe.writeReport();
  });

  await waitForBrowserClose(context);

  extraState.finalUrl = page.url().replace(BASE_URL, "");
  extraState.forms = await snapshotForms(page).catch(() => extraState.forms);
  probe.writeReport();
  console.log(
    `\nProbe complete. Captured ${probe.captured.length}, blocked ${probe.blocked.length}, GETs ${probe.gets.length}.`
  );
  console.log(`Report: ${reportPath}`);
  await context.close().catch(() => {});
  process.exit(0);
}

main().catch((error) => {
  console.error(`\nProbe failed: ${error?.message || error}`);
  process.exit(1);
});
