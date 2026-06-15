#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfig, loadDotEnv, parseArgs, parseMonth } from "./config.js";
import { GoogleDriveClient } from "./drive/googleDriveClient.js";
import { extractEventFromGoogleDoc } from "./extract/docsTableExtractor.js";
import { generateArtifacts } from "./generate/contentGenerator.js";
import { validateEventRun, validationReport } from "./validate/validators.js";
import { selectEventTemplate } from "./templates/eventTypes.js";

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

try {
  if (command === "prepare") {
    await prepare(args);
  } else if (command === "validate") {
    await validate(args);
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

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function usage() {
  console.log(`Glue Up Agent

Usage:
  npm run prepare -- --month 2026-06
  npm run validate -- --run runs/2026-06

Options:
  --month YYYY-MM
  --run path
  --events-folder-id id
  --timezone America/New_York
  --event-type NHH
  --event-index 06
  --dry-run
`);
}
