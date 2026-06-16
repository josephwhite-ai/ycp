#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  getConfig,
  loadDotEnv,
  parseArgs,
  parseEvent,
  eventInfoFromSlug,
  monthInfoFromFolderName
} from "./config.js";
import { GoogleDriveClient } from "./drive/googleDriveClient.js";
import { extractEventFromGoogleDoc } from "./extract/docsTableExtractor.js";
import { generateArtifacts } from "./generate/contentGenerator.js";
import { validateEventRun, validationReport } from "./validate/validators.js";
import { selectEventTemplate } from "./templates/eventTypes.js";
import { buildDraftCreateRequest, createDraftFromBlueprint } from "./glueup/draftCreate.js";
import { addCampaign } from "./glueup/campaignCreate.js";
import { ensureGlueUpAuth, loginGlueUp } from "./glueup/session.js";

// Two invitation campaigns per event — one to send a week before, one a day
// before. They're created as drafts now (pre-publish) so they can be reviewed
// alongside the event; scheduling happens in a later post-publish step.
const CAMPAIGN_PLAN = [
  { key: "week-before", label: "1 week before" },
  { key: "day-before", label: "1 day before" }
];

loadDotEnv();

const PREPARE_WORKFLOW = "glueup-monthly-prepare.yml";
const ARTIFACT_PREFIX = "glueup-run-";

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
  const eventInfo = parseEvent(args);
  const config = getConfig({
    eventsFolderId: args.eventsFolderId,
    timezone: args.timezone
  });
  const runDir = args.run || join("runs", eventInfo.slug);

  await mkdir(runDir, { recursive: true });

  if (args.dryRun) {
    const plan = {
      event: eventInfo,
      eventsFolderId: config.eventsFolderId,
      runDir,
      note: "The month and summary doc are resolved from the Drive event folder at run time."
    };
    await writeJson(join(runDir, "plan.json"), plan);
    console.log(`Wrote dry-run plan to ${join(runDir, "plan.json")}`);
    return;
  }

  const drive = new GoogleDriveClient();
  const { yearFolder, eventFolder } = await drive.findEventFolder(config.eventsFolderId, {
    year: eventInfo.year,
    index: eventInfo.index
  });
  const monthInfo = monthInfoFromFolderName(eventFolder.name, eventInfo.year);
  const expectedDocName = `${monthInfo.monthName} ${monthInfo.year} - Event Summary Sheet`;
  const docFile = await drive.findChildFile(eventFolder.id, expectedDocName);
  if (!docFile) {
    throw new Error(`Could not find "${expectedDocName}" in ${eventFolder.name}.`);
  }

  const [doc, photos] = await Promise.all([
    drive.getGoogleDoc(docFile.id),
    drive.listImagesRecursive(eventFolder.id)
  ]);
  const event = extractEventFromGoogleDoc(doc);
  const artifacts = await generateArtifacts({ event, photos, config });
  const validation = validateEventRun({ event, artifacts, config });

  const manifest = {
    preparedAt: new Date().toISOString(),
    event: eventInfo,
    month: monthInfo,
    source: {
      eventsFolderId: config.eventsFolderId,
      yearFolder,
      eventFolder,
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

  console.log(`Prepared event ${eventInfo.index} (${monthInfo.monthName} ${monthInfo.year}) in ${runDir}`);
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
  const runDir = await prepareRunForDraft(args);

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

  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  const authNotes = {
    env: "Using GLUEUP_COOKIE/CSRF from the environment.",
    session: "Using saved Glue Up session.",
    login: "Logged in to Glue Up."
  };
  if (authNotes[auth.source]) console.log(authNotes[auth.source]);

  const result = await createDraftFromBlueprint({
    templateSelection,
    event,
    timezone: config.timezone,
    cookie: auth.cookie,
    csrfToken: process.env.GLUEUP_CSRF_TOKEN,
    orgId: auth.orgId
  });
  const createdAt = new Date().toISOString();

  const campaigns = await createInvitationCampaigns({
    eventId: result.eventId,
    event,
    cookie: auth.cookie,
    orgId: auth.orgId
  });

  manifest.glueUp = {
    ...(manifest.glueUp || {}),
    eventId: result.eventId,
    eventUrl: result.eventUrl,
    draftCreatedAt: createdAt,
    blueprintCode: selected.glueUp.blueprintCode,
    eventType: selected.glueUp.eventType,
    campaigns
  };
  manifest.status = "draft_created";

  await Promise.all([
    writeJson(join(runDir, "manifest.json"), manifest),
    writeJson(join(runDir, "draft-create-response.json"), result.raw)
  ]);

  console.log(`Created Glue Up draft for ${runDir}`);
  if (result.eventId) console.log(`Event ID: ${result.eventId}`);
  if (result.eventUrl) console.log(`Event URL: ${result.eventUrl}`);
  for (const campaign of campaigns) {
    if (campaign.campaignId) {
      console.log(`Campaign (${campaign.label}): ${campaign.campaignUrl}`);
    } else {
      console.log(`Campaign (${campaign.label}) FAILED: ${campaign.error}`);
    }
  }
  console.log(`\nReview the event and campaigns, then publish the event in Glue Up to enable scheduling.`);
}

// Create the invitation campaign drafts on the freshly-created event. Each is
// independent: one failing must not lose the event or the other campaign, so
// failures are captured per-campaign rather than thrown.
async function createInvitationCampaigns({ eventId, event, cookie, orgId }) {
  if (!eventId) {
    throw new Error("Cannot create campaigns without a Glue Up event ID.");
  }
  const baseTitle = event?.eventName || event?.sourceDocumentTitle || "Event";

  const results = [];
  for (const { key, label } of CAMPAIGN_PLAN) {
    const title = `${baseTitle} — Invitation (${label})`;
    try {
      const created = await addCampaign({ eventId, title, cookie, orgId });
      results.push({ key, label, title, campaignId: created.campaignId, campaignUrl: created.campaignUrl });
    } catch (error) {
      results.push({ key, label, title, campaignId: null, error: error?.message || String(error) });
    }
  }
  return results;
}

async function glueupLogin(args) {
  const auth = await loginGlueUp({ headless: args.headless ?? false });
  console.log(`Session saved. Org ID: ${auth.orgId}`);
  console.log(`Draft workspace: https://ycp.glueup.com/events/draft`);
}

async function syncRun(args) {
  const eventInfo = parseEvent(args);
  await syncEvent(eventInfo, { fresh: args.fresh });
  console.log("Next: npm run create-draft");
}

async function syncEvent(eventInfo, { fresh = false } = {}) {
  if (fresh) {
    await triggerPrepare(eventInfo);
  }

  const { slug } = eventInfo;
  const artifact = `${ARTIFACT_PREFIX}${slug}`;
  console.log(`Downloading artifact ${artifact} into runs/ ...`);
  gh(["run", "download", "-n", artifact, "-D", "runs"]);

  const manifestPath = join("runs", slug, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Synced artifact did not contain ${manifestPath}. No prepared run for ${slug} was found — pass --fresh to generate it.`
    );
  }
}

// Pull the most recent successful prepare run and infer which event it is from
// the artifact name (glueup-run-evt-<year>-<index>). This is the default path
// for create-draft: the index is named once, on GitHub, not again locally.
async function syncLatestEvent() {
  const runs = JSON.parse(
    ghCapture([
      "run",
      "list",
      "--workflow",
      PREPARE_WORKFLOW,
      "--status",
      "success",
      "--limit",
      "1",
      "--json",
      "databaseId,displayTitle,createdAt"
    ])
  );
  if (!runs.length) {
    throw new Error(
      `No successful ${PREPARE_WORKFLOW} run found. Dispatch one with: npm run create-draft -- --event <index> --fresh`
    );
  }

  const runId = runs[0].databaseId;
  const artifacts = JSON.parse(
    ghCapture([
      "api",
      `repos/{owner}/{repo}/actions/runs/${runId}/artifacts`,
      "--jq",
      ".artifacts"
    ])
  );
  const artifact = artifacts.find((a) => a.name.startsWith(ARTIFACT_PREFIX));
  if (!artifact) {
    throw new Error(`Latest prepare run #${runId} has no ${ARTIFACT_PREFIX}* artifact.`);
  }

  const slug = artifact.name.slice(ARTIFACT_PREFIX.length);
  const eventInfo = eventInfoFromSlug(slug);
  console.log(`Pulling latest prepared event ${eventInfo.index} (${eventInfo.year}) from run #${runId} ...`);
  gh(["run", "download", String(runId), "-n", artifact.name, "-D", "runs"]);

  const manifestPath = join("runs", slug, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Synced artifact did not contain ${manifestPath}.`);
  }

  return slug;
}

async function triggerPrepare(eventInfo) {
  console.log(`Dispatching ${PREPARE_WORKFLOW} for ${eventInfo.slug} ...`);
  const before = new Set(listPrepareRunIds());
  gh([
    "workflow",
    "run",
    PREPARE_WORKFLOW,
    "-f",
    `event=${eventInfo.index}`,
    "-f",
    `year=${eventInfo.year}`
  ]);

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

// Resolve the run for create-draft. With no flags it pulls the latest successful
// prepare run from CI and infers the event — the index is named once, on GitHub.
// --fresh dispatches a new prepare (the one place you name the index locally);
// --event N targets a specific older event; --run path uses a local run as-is.
async function prepareRunForDraft(args) {
  if (args.run) return args.run;

  if (args.fresh) {
    const eventInfo = parseEvent(args);
    await syncEvent(eventInfo, { fresh: true });
    return join("runs", eventInfo.slug);
  }

  if (args.event !== undefined) {
    const eventInfo = parseEvent(args);
    const runDir = join("runs", eventInfo.slug);
    if (!existsSync(join(runDir, "manifest.json"))) {
      await syncEvent(eventInfo, { fresh: false });
    }
    return runDir;
  }

  const slug = await syncLatestEvent();
  return join("runs", slug);
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
        `Missing run file "${path}". Prepare the run first with:\n  npm run monthly-prepare -- --event 6\nOr download the glueup-run artifact from GitHub Actions into glueup/runs/.`
      );
    }
    throw error;
  }
}

function usage() {
  console.log(`Glue Up Agent

Usage:
  npm run create-draft                      # pull the latest prepared event from CI + create the draft
  npm run create-draft -- --event 6         # target a specific older event
  npm run create-draft -- --event 6 --fresh # dispatch a new prepare run, then create the draft

Other commands:
  npm run sync-run -- --event 6 [--fresh]   # pre-stage an artifact only
  npm run glueup-login                      # refresh the saved browser session only
  npm run monthly-prepare -- --event 6
  npm run validate -- --run runs/evt-2026-006

Options:
  --event N          Event index (counter unique across the year)
  --year YYYY        Defaults to the current year
  --run path
  --events-folder-id id
  --timezone America/New_York
  --dry-run
  --fresh            Dispatch the prepare workflow and wait for it before downloading
  --headed           (Unused now; login always opens a visible browser when needed)
`);
}
