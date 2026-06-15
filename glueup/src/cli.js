#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getConfig, loadDotEnv, parseArgs, parseMonth } from "./config.js";
import { GoogleDriveClient } from "./drive/googleDriveClient.js";
import { extractEventFromGoogleDoc } from "./extract/docsTableExtractor.js";
import { generateArtifacts } from "./generate/contentGenerator.js";
import { validateEventRun, validationReport } from "./validate/validators.js";
import { selectEventTemplate } from "./templates/eventTypes.js";
import { buildDraftCreateRequest, createDraftFromBlueprint } from "./glueup/draftCreate.js";
import { loginGlueUp, resolveGlueUpAuth } from "./glueup/session.js";

loadDotEnv();

const PREPARE_WORKFLOW = "glueup-monthly-prepare.yml";
const ACTIVE_MONTH_FILE = join("runs", ".active-month");

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

try {
  if (command === "prepare") {
    await prepare(args);
  } else if (command === "validate") {
    await validate(args);
  } else if (command === "create-draft") {
    await createDraft(args);
  } else if (command === "glueup-login") {
    await glueupLogin(args);
  } else if (command === "sync-run") {
    await syncRun(args);
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}

async function prepare(args) {
  const monthInfo = parseMonth(args.month);
  const config = getConfig({
    eventsFolderId: args.eventsFolderId,
    timezone: args.timezone
  });
  const runDir = args.run || join("runs", monthInfo.slug);
  const expectedDocName = `${monthInfo.monthName} ${monthInfo.year} - Event Summary Sheet`;
  const eventFolderFilters = {
    eventType: args.eventType,
    eventIndex: args.eventIndex
  };

  await mkdir(runDir, { recursive: true });

  if (args.dryRun) {
    const plan = {
      month: monthInfo,
      eventsFolderId: config.eventsFolderId,
      expectedDocName,
      eventFolderFilters,
      runDir
    };
    await writeJson(join(runDir, "plan.json"), plan);
    console.log(`Wrote dry-run plan to ${join(runDir, "plan.json")}`);
    return;
  }

  const drive = new GoogleDriveClient();
  const { yearFolder, monthFolder } = await drive.findMonthlyFolder(
    config.eventsFolderId,
    monthInfo,
    eventFolderFilters
  );
  const docFile = await drive.findChildFile(monthFolder.id, expectedDocName);
  if (!docFile) {
    throw new Error(`Could not find "${expectedDocName}" in ${monthFolder.name}.`);
  }

  const [doc, photos] = await Promise.all([
    drive.getGoogleDoc(docFile.id),
    drive.listImagesRecursive(monthFolder.id)
  ]);
  const event = extractEventFromGoogleDoc(doc);
  const artifacts = await generateArtifacts({ event, photos, config });
  const validation = validateEventRun({ event, artifacts, config });

  const manifest = {
    preparedAt: new Date().toISOString(),
    month: monthInfo,
    source: {
      eventsFolderId: config.eventsFolderId,
      yearFolder,
      monthFolder,
      summaryDoc: docFile
    },
    status: validation.ok ? "prepared" : "needs_attention"
  };

  await writeJson(join(runDir, "manifest.json"), manifest);
  await writeJson(join(runDir, "event.json"), event);
  await writeJson(join(runDir, "photos.json"), photos);
  await writeJson(join(runDir, "template-selection.json"), selectEventTemplate(event));
  await writeJson(join(runDir, "photo-recommendations.json"), artifacts.photoRecommendations || []);
  await writeFile(join(runDir, "webpage.md"), artifacts.webpage || "", "utf8");
  await writeFile(join(runDir, "email-week-before.md"), artifacts.emails?.weekBefore || "", "utf8");
  await writeFile(join(runDir, "email-day-before.md"), artifacts.emails?.dayBefore || "", "utf8");
  await writeFile(join(runDir, "validation-report.md"), validationReport(validation), "utf8");

  if (artifacts.generationWarning) {
    await writeFile(join(runDir, "generation-warning.txt"), artifacts.generationWarning, "utf8");
  }

  console.log(`Prepared ${monthInfo.monthName} ${monthInfo.year} run in ${runDir}`);
  console.log(`Validation: ${validation.ok ? "OK" : "needs attention"}`);
}

async function validate(args) {
  const runDir = args.run;
  if (!runDir) throw new Error("Missing --run path.");

  const config = getConfig({ timezone: args.timezone });
  const [event, webpage, weekBefore, dayBefore] = await Promise.all([
    readJson(join(runDir, "event.json")),
    readFile(join(runDir, "webpage.md"), "utf8"),
    readFile(join(runDir, "email-week-before.md"), "utf8"),
    readFile(join(runDir, "email-day-before.md"), "utf8")
  ]);

  const validation = validateEventRun({
    event,
    artifacts: {
      webpage,
      emails: { weekBefore, dayBefore }
    },
    config
  });

  await writeFile(join(runDir, "validation-report.md"), validationReport(validation), "utf8");
  console.log(validationReport(validation));
  if (!validation.ok) process.exitCode = 1;
}

async function createDraft(args) {
  const runDir = await resolveRunDir(args);

  const [manifest, templateSelection, event] = await Promise.all([
    readJson(join(runDir, "manifest.json")),
    readJson(join(runDir, "template-selection.json")),
    readJson(join(runDir, "event.json"))
  ]);
  const config = getConfig({ timezone: args.timezone });

  const selected = templateSelection?.selected;
  if (!selected?.glueUp?.eventType || !selected?.glueUp?.blueprintCode) {
    throw new Error("template-selection.json is missing a selected Glue Up blueprint.");
  }

  if (args.dryRun) {
    const request = buildDraftCreateRequest({
      templateSelection,
      csrfToken: process.env.GLUEUP_CSRF_TOKEN || "<missing>"
    });
    const plan = {
      runDir,
      blueprintCode: selected.glueUp.blueprintCode,
      eventType: selected.glueUp.eventType,
      template: {
        key: selected.key,
        label: selected.label,
        variantKey: selected.variantKey,
        variantLabel: selected.variantLabel
      },
      request: {
        method: request.method,
        url: request.url,
        headers: request.headers
      }
    };
    await writeJson(join(runDir, "draft-create-plan.json"), plan);
    console.log(`Wrote draft create plan to ${join(runDir, "draft-create-plan.json")}`);
    return;
  }

  const auth = await resolveGlueUpAuth({ headless: !args.headed });
  if (auth.source === "playwright") {
    console.log("Using Playwright session from .glueup-session");
  }

  const result = await createDraftFromBlueprint({
    templateSelection,
    event,
    timezone: config.timezone,
    cookie: auth.cookie,
    csrfToken: process.env.GLUEUP_CSRF_TOKEN,
    orgId: auth.orgId
  });
  const createdAt = new Date().toISOString();

  manifest.glueUp = {
    ...(manifest.glueUp || {}),
    eventId: result.eventId,
    eventUrl: result.eventUrl,
    draftCreatedAt: createdAt,
    blueprintCode: selected.glueUp.blueprintCode,
    eventType: selected.glueUp.eventType
  };
  manifest.status = "draft_created";

  await Promise.all([
    writeJson(join(runDir, "manifest.json"), manifest),
    writeJson(join(runDir, "draft-create-response.json"), result.raw)
  ]);

  console.log(`Created Glue Up draft for ${runDir}`);
  if (result.eventId) console.log(`Event ID: ${result.eventId}`);
  if (result.eventUrl) console.log(`Event URL: ${result.eventUrl}`);
}

async function glueupLogin(args) {
  const auth = await loginGlueUp({ headless: args.headless ?? false });
  console.log(`Session saved. Org ID: ${auth.orgId}`);
  console.log(`Draft workspace: https://ycp.glueup.com/events/draft`);
}

async function syncRun(args) {
  const { slug } = parseMonth(args.month);

  if (args.fresh) {
    await triggerPrepare(slug);
  }

  const artifact = `glueup-run-${slug}`;
  console.log(`Downloading artifact ${artifact} into runs/ ...`);
  gh(["run", "download", "-n", artifact, "-D", "runs"]);

  const manifestPath = join("runs", slug, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Synced artifact did not contain ${manifestPath}. No prepared run for ${slug} was found — run with --fresh to generate it.`
    );
  }

  await writeFile(ACTIVE_MONTH_FILE, `${slug}\n`, "utf8");
  console.log(`Active month set to ${slug}. Next: npm run glueup-login && npm run create-draft`);
}

async function triggerPrepare(slug) {
  console.log(`Dispatching ${PREPARE_WORKFLOW} for ${slug} ...`);
  const before = new Set(listPrepareRunIds());
  gh(["workflow", "run", PREPARE_WORKFLOW, "-f", `month=${slug}`]);

  const runId = await waitForNewRun(before);
  console.log(`Watching run ${runId} (this takes a few minutes) ...`);
  gh(["run", "watch", String(runId), "--exit-status"]);
}

function listPrepareRunIds() {
  const out = ghCapture([
    "run",
    "list",
    "--workflow",
    PREPARE_WORKFLOW,
    "--event",
    "workflow_dispatch",
    "--limit",
    "20",
    "--json",
    "databaseId"
  ]);
  return JSON.parse(out).map((r) => r.databaseId);
}

async function waitForNewRun(before) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const current = listPrepareRunIds();
    const fresh = current.find((id) => !before.has(id));
    if (fresh) return fresh;
  }
  throw new Error("Timed out waiting for the dispatched prepare run to appear.");
}

function gh(argv) {
  execFileSync("gh", argv, { stdio: "inherit" });
}

function ghCapture(argv) {
  return execFileSync("gh", argv, { encoding: "utf8" });
}

async function readActiveMonth() {
  try {
    return (await readFile(ACTIVE_MONTH_FILE, "utf8")).trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveRunDir(args) {
  if (args.run) return args.run;

  const active = await readActiveMonth();
  if (args.month) {
    const { slug } = parseMonth(args.month);
    if (active && slug !== active) {
      throw new Error(
        `--month ${slug} does not match the active month ${active} from the last sync-run. Re-run sync-run to switch months.`
      );
    }
    return join("runs", slug);
  }

  if (active) return join("runs", active);
  throw new Error("No active month. Run: npm run sync-run -- --month YYYY-MM");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Missing run file "${path}". Prepare the run first with:\n  npm run monthly-prepare -- --month 2026-06\nOr download the glueup-run artifact from GitHub Actions into glueup/runs/.`
      );
    }
    throw error;
  }
}

function usage() {
  console.log(`Glue Up Agent

Usage:
  npm run sync-run -- --month 2026-06 [--fresh]
  npm run glueup-login
  npm run create-draft
  npm run monthly-prepare -- --month 2026-06
  npm run validate -- --run runs/2026-06

Options:
  --month YYYY-MM
  --run path
  --events-folder-id id
  --timezone America/New_York
  --event-type NHH
  --event-index 06
  --dry-run
  --fresh           sync-run: dispatch the prepare workflow and wait before downloading
  --headed          Use a visible browser when refreshing Playwright auth for create-draft
`);
}
