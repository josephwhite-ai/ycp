// Headed Playwright probe for reverse-engineering Glue Up's campaign + schedule
// AJAX. By default it records every campaign-related request value-free (action
// names, data key paths, value types/lengths — never token/cookie values, since
// this repo is public) and ABORTS any request whose action matches BLOCK_PATTERN
// before it reaches Glue Up. That lets you click "schedule"/"send" to capture
// the payload shape while nothing actually fires server-side.
//
// Pass --capture-values only when you need replayable setup payloads. The report
// is still written to gitignored .glueup-debug/, and token/cookie/password-like
// fields remain redacted, but normal recipient/setup/content values are kept.
//
// Usage:
//   node scripts/probe-campaign.mjs                 # default test event 176762
//   node scripts/probe-campaign.mjs --event 176762
//   node scripts/probe-campaign.mjs --event 185174 --campaign 508089 --capture-values
//   node scripts/probe-campaign.mjs --block 'send|schedule|dispatch|deliver|publish'
//
// Constraint: probe only against a known-published TEST event, and never let an
// actual send go through. The block list is the safety valve — keep it broad.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE_URL = "https://ycp.glueup.com";
const DEFAULT_SESSION_DIR = ".glueup-session";
const DEFAULT_EVENT = "176762";
const DEFAULT_BLOCK = "send|schedule|dispatch|deliver|publish|remind";
const DEBUG_DIR = ".glueup-debug";
const AJAX_HINT = /\/ajax(\?|$)/i;
// GETs worth recording: the editor/content fetches that pre-populate an
// invitation campaign. Keeps the noise of asset/static GETs out of the report.
const GET_HINT = /\/(promote|campaigns)\//i;
// Keys whose VALUES are safe to record (non-secret identifiers). Everything else
// is recorded as type+length only. Tokens/cookies are never recorded at all.
const SAFE_VALUE_KEYS = /^(id|code|eventid|campaignid|campaigntype|status|type|name|title)$/i;
const SECRET_KEYS = /token|cookie|csrf|password|secret|auth/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

// Walk a parsed JSON body and collect key paths with value type/length. Records
// actual values only for SAFE_VALUE_KEYS; never for anything matching SECRET_KEYS.
function describeData(value, prefix = "") {
  const out = [];
  const visit = (val, path) => {
    if (val === null || typeof val !== "object") {
      const leaf = path.split(".").pop() || "";
      const entry = { path, type: val === null ? "null" : typeof val };
      if (typeof val === "string") entry.length = val.length;
      if (SECRET_KEYS.test(leaf)) {
        entry.redacted = true;
      } else if (SAFE_VALUE_KEYS.test(leaf)) {
        entry.value = val;
      }
      out.push(entry);
      return;
    }
    if (Array.isArray(val)) {
      out.push({ path, type: "array", length: val.length });
      val.slice(0, 2).forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(val)) {
      visit(v, path ? `${path}.${k}` : k);
    }
  };
  visit(value, prefix);
  return out;
}

function redactSensitiveValues(value) {
  const visit = (val, key = "") => {
    if (SECRET_KEYS.test(key)) return "<redacted>";
    if (val === null || typeof val !== "object") return val;
    if (Array.isArray(val)) return val.map((item) => visit(item, key));
    return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, visit(v, k)]));
  };
  return visit(value);
}

function parseBody(request) {
  const raw = request.postData() || "";
  try {
    const params = new URLSearchParams(raw);
    const action = params.get("action");
    let data = null;
    let dataValue = null;
    const dataRaw = params.get("data");
    if (dataRaw) {
      try {
        const parsedData = JSON.parse(dataRaw);
        data = describeData(parsedData);
        dataValue = redactSensitiveValues(parsedData);
      } catch {
        data = [{ path: "data", type: "unparsed", length: dataRaw.length }];
      }
    }
    const fields = [...params.keys()].filter((k) => k !== "data");
    return { action, fields, data, dataValue };
  } catch {
    return { action: null, fields: [], data: null, dataValue: null, rawLength: raw.length };
  }
}

function describeResponseBody(text) {
  try {
    const json = JSON.parse(text);
    return describeData(json);
  } catch {
    return [{ path: "<non-json>", type: "text", length: text.length }];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventId = String(args.event || DEFAULT_EVENT);
  const campaignId = args.campaign ? String(args.campaign) : null;
  const captureValues = Boolean(args.captureValues || args["capture-values"]);
  const blockPattern = new RegExp(String(args.block || DEFAULT_BLOCK), "i");
  const sessionDir = resolve(args.sessionDir || process.env.GLUEUP_SESSION_DIR || DEFAULT_SESSION_DIR);

  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || (await context.newPage());

  const captured = [];
  const blocked = [];
  const gets = [];

  // Intercept mutating AJAX so we can block destructive actions before they ship.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    const isAjax = AJAX_HINT.test(url) && method === "POST";

    // Record campaign-related GETs (content/editor fetches) without altering them.
    if (method === "GET" && GET_HINT.test(url)) {
      try {
        const response = await route.fetch();
        const text = await response.text();
        const contentType = response.headers()["content-type"] || "";
        const record = {
          at: new Date().toISOString(),
          method,
          url: url.replace(BASE_URL, ""),
          status: response.status(),
          contentType
        };
        if (contentType.includes("json")) {
          record.body = describeResponseBody(text);
        } else {
          record.bodyLength = text.length;
        }
        gets.push(record);
        writeReport();
        await route.fulfill({ response });
      } catch {
        await route.continue();
      }
      return;
    }

    if (!isAjax) {
      await route.continue();
      return;
    }

    const parsed = parseBody(request);
    const action = parsed.action || "<none>";
    const shouldBlock = blockPattern.test(action) || blockPattern.test(url);

    const record = {
      at: new Date().toISOString(),
      method,
      url: url.replace(BASE_URL, ""),
      action,
      fields: parsed.fields,
      data: parsed.data,
      blocked: shouldBlock
    };
    if (captureValues && parsed.dataValue !== null) {
      record.dataValue = parsed.dataValue;
    }

    if (shouldBlock) {
      blocked.push(record);
      console.log(`\n  BLOCKED (not sent): action="${action}"  ${record.url}`);
      writeReport();
      await route.abort();
      return;
    }

    // Let safe actions through, then record the response shape (value-free).
    try {
      const response = await route.fetch();
      const text = await response.text();
      record.response = {
        status: response.status(),
        body: describeResponseBody(text)
      };
      captured.push(record);
      console.log(`  captured: action="${action}" -> ${response.status()}`);
      writeReport();
      await route.fulfill({ response });
    } catch (error) {
      record.error = error?.message || String(error);
      captured.push(record);
      writeReport();
      await route.continue();
    }
  });

  const dir = resolve(DEBUG_DIR);
  mkdirSync(dir, { recursive: true });
  const reportPath = resolve(dir, "campaign-probe.json");

  function writeReport() {
    const report = {
      eventId,
      campaignId,
      blockPattern: blockPattern.source,
      captureValues,
      capturedCount: captured.length,
      blockedCount: blocked.length,
      getCount: gets.length,
      captured,
      blocked,
      gets
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  writeReport();
  console.log(`\nProbe ready. Block pattern: /${blockPattern.source}/i`);
  console.log(`Test event: ${eventId}`);
  console.log(`${captureValues ? "Value-capturing" : "Value-free"} report streams to ${reportPath}`);
  if (captureValues) {
    console.log(`Sensitive fields matching /${SECRET_KEYS.source}/i are still redacted.`);
  }
  console.log(`\nIn the browser: open or create an invitation campaign, then click`);
  console.log(`through recipients, exclusions, setup, content, and scheduling.`);
  console.log(`Destructive actions are aborted, not sent.`);
  console.log(`Close the browser window when done.\n`);

  const startPath = campaignId
    ? `/events/${eventId}/promote/campaigns/${campaignId}/`
    : `/events/${eventId}/dashboard/`;
  await page.goto(`${BASE_URL}${startPath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  // Persistent contexts don't reliably emit "close" when the window is closed,
  // which orphaned the browser and locked the profile. Resolve on either the
  // context closing or the last page closing, then tear down and exit hard.
  await new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    context.on("close", finish);
    for (const p of context.pages()) p.on("close", finish);
    context.on("page", (p) => p.on("close", finish));
  });

  writeReport();
  console.log(`\nProbe complete. Captured ${captured.length}, blocked ${blocked.length}, GETs ${gets.length}.`);
  console.log(`Report: ${reportPath}`);
  await context.close().catch(() => {});
  process.exit(0);
}

main().catch((error) => {
  console.error(`\nProbe failed: ${error?.message || error}`);
  process.exit(1);
});
