// Headed Playwright probe for reverse-engineering Glue Up's campaign + schedule
// AJAX. By default it records campaign-related requests value-free and ABORTS
// send/schedule-style actions before they reach Glue Up.
//
// Pass --capture-values only when you need replayable setup payloads. The report
// is still written to gitignored .glueup-debug/, and token/cookie/password-like
// fields remain redacted, but normal recipient/setup/content values are kept.
//
// Usage:
//   node scripts/probe-campaign.mjs
//   node scripts/probe-campaign.mjs --event 176762
//   node scripts/probe-campaign.mjs --event 185174 --campaign 508089 --capture-values
//   node scripts/probe-campaign.mjs --block 'send|schedule|dispatch|deliver|publish'

import { resolve } from "node:path";
import {
  BASE_URL,
  DEFAULT_BLOCK,
  DEFAULT_SESSION_DIR,
  SECRET_KEYS,
  debugPath,
  installAjaxProbe,
  parseArgs,
  waitForBrowserClose
} from "./lib/probeCore.mjs";

const DEFAULT_EVENT = "176762";
const GET_HINT = /\/(promote|campaigns)\//i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventId = String(args.event || DEFAULT_EVENT);
  const campaignId = args.campaign ? String(args.campaign) : null;
  const captureValues = Boolean(args.captureValues);
  const blockPattern = new RegExp(String(args.block || DEFAULT_BLOCK), "i");
  const sessionDir = resolve(args.sessionDir || process.env.GLUEUP_SESSION_DIR || DEFAULT_SESSION_DIR);
  const reportPath = debugPath("campaign-probe.json");

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
      kind: "campaign",
      eventId,
      campaignId
    },
    captureValues,
    blockPattern,
    blockUrls: true,
    getHint: GET_HINT
  });

  console.log(`\nProbe ready. Block pattern: /${blockPattern.source}/i`);
  console.log(`Test event: ${eventId}`);
  console.log(`${captureValues ? "Value-capturing" : "Value-free"} report streams to ${reportPath}`);
  if (captureValues) console.log(`Sensitive fields matching /${SECRET_KEYS.source}/i are still redacted.`);
  console.log("\nIn the browser: open or create an invitation campaign, then click");
  console.log("through recipients, exclusions, setup, content, and scheduling.");
  console.log("Destructive actions are aborted, not sent.");
  console.log("Close the browser window when done.\n");

  const startPath = campaignId
    ? `/events/${eventId}/promote/campaigns/${campaignId}/`
    : `/events/${eventId}/dashboard/`;
  await page.goto(`${BASE_URL}${startPath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await waitForBrowserClose(context);

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
