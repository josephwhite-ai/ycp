#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  getConfig,
  loadDotEnv,
  parseArgs,
  parseEvent,
  eventInfoFromSlug,
  monthInfoFromFolderName
} from "./config.js";
import { GoogleDriveClient } from "./drive/googleDriveClient.js";
import { extractEventFromGoogleDoc, normalizeEventFields } from "./extract/docsTableExtractor.js";
import { generateArtifacts } from "./generate/contentGenerator.js";
import { buildCampaignSchedule, validateEventRun, validationReport } from "./validate/validators.js";
import { selectEventTemplate } from "./templates/eventTypes.js";
import { assertNoAppError, buildDraftCreateRequest, createDraftFromBlueprint, parseEventTimes } from "./glueup/draftCreate.js";
import {
  addCampaign,
  applyCampaignSetup,
  buildDefaultCampaignSetupPayloads,
  extractCampaignSetupPayloads,
  scheduleCampaign
} from "./glueup/campaignCreate.js";
import { ensureGlueUpAuth, GLUEUP_BASE_URL, loginGlueUp } from "./glueup/session.js";

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
const DEFAULT_REUSE_ARTIFACT_LIMIT = 20;
const CURRENT_RUN_FILE = ".glueup-current-run";
// Declared before the top-level dispatch below so dispatched functions don't hit
// a temporal-dead-zone error referencing them mid module-evaluation.
const SPEAKER_FOLDER_RE = /speaker|bio|pic|photo|headshot|presenter|profile/i;
const GLUEUP_DEFAULT_SPEAKER_IMAGE_URI = "/images/defaults/default-profile.svg";
// Shared "photo library" drive for event banners, organized as /<YEAR>/<event>/images.
const PHOTO_LIBRARY_FOLDER_ID = process.env.GLUEUP_PHOTO_LIBRARY_FOLDER_ID || "0APt58RkpagPZUk9PVA";
const BANNER_SKIP_FOLDER_RE = /pdf split|organizer|eventdata|receipt|^ads$/i;
const BANNER_CANDIDATE_LIMIT = 8;

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

try {
  if (command === "prepare") {
    await prepare(args);
  } else if (command === "validate") {
    await validate(args);
  } else if (command === "ensure") {
    await ensureWorkflow(args);
  } else if (command === "populate") {
    await populateWorkflow(args);
  } else if (command === "populate-venue") {
    await populateVenueWorkflow(args);
  } else if (command === "populate-summary") {
    await populateSummaryWorkflow(args);
  } else if (command === "populate-speakers") {
    await populateSpeakersWorkflow(args);
  } else if (command === "populate-banner") {
    await populateBannerWorkflow(args);
  } else if (command === "finalize") {
    await finalizeWorkflow(args);
  } else if (command === "apply-campaign-setup") {
    await applyCapturedCampaignSetup(args);
  } else if (command === "mark-ignore") {
    await markIgnore(args);
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
  const speakerPhotos = await gatherSpeakerPhotos({ drive, eventFolder, event, runDir }).catch((error) => {
    console.log(`Speaker photo gathering failed (non-fatal): ${error.message}`);
    return [];
  });
  const bannerCandidates = await gatherBannerCandidates(drive).catch((error) => {
    console.log(`Banner candidate scan failed (non-fatal): ${error.message}`);
    return [];
  });
  console.log(`Banner candidates found: ${bannerCandidates.length}`);
  for (const c of bannerCandidates) console.log(`  ${c.year}/${c.folder}/${c.name} [${c.mimeType}] (${(c.modifiedTime || "").slice(0, 10)})`);
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
  await writeJson(join(runDir, "speaker-photos.json"), speakerPhotos);
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

// Downloads a headshot for each parsed speaker from the event's speaker/bio
// subfolder and writes it into the run's speaker-photos/ directory. Headshots are
// usually embedded in a per-speaker Google Doc ("… Photo and Bio"); plain image
// files are also supported. Speakers with no matching photo are skipped (partial
// coverage is expected). Returns [{ fullName, firstName, lastName, position,
// company, photoFile }] for matched speakers; photoFile is relative to runDir.
// Collects recent banner candidate images from the shared photo-library drive,
// walking most-recent year -> most-recent event subfolders (skipping utility
// folders) and taking the newest images first, up to a small candidate cap.
async function gatherBannerCandidates(drive, { limit = BANNER_CANDIDATE_LIMIT } = {}) {
  const driveId = PHOTO_LIBRARY_FOLDER_ID;
  const byRecent = (a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || ""));
  const isFolder = (f) => f.mimeType?.includes("folder");

  const root = await drive.listChildren(driveId, { driveId });
  const years = root.filter((f) => isFolder(f) && /^\d{4}$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));

  const candidates = [];
  for (const year of years) {
    if (candidates.length >= limit) break;
    const subfolders = (await drive.listChildren(year.id, { driveId }))
      .filter((f) => isFolder(f) && !BANNER_SKIP_FOLDER_RE.test(f.name))
      .sort(byRecent);
    for (const sub of subfolders) {
      if (candidates.length >= limit) break;
      const images = (await drive.listChildren(sub.id, { driveId }))
        .filter((f) => f.mimeType?.startsWith("image/"))
        .sort(byRecent);
      for (const img of images) {
        candidates.push({ id: img.id, name: img.name, mimeType: img.mimeType, modifiedTime: img.modifiedTime, year: year.name, folder: sub.name });
        if (candidates.length >= limit) break;
      }
    }
  }
  return candidates;
}

async function gatherSpeakerPhotos({ drive, eventFolder, event, runDir }) {
  const speakers = normalizeEventSpeakers(event);
  if (!speakers.length) return [];

  const subfolders = (await drive.listChildren(eventFolder.id)).filter((f) =>
    f.mimeType?.includes("folder")
  );
  const speakerFolder = subfolders.find((f) => SPEAKER_FOLDER_RE.test(f.name));
  if (!speakerFolder) {
    console.log("No speaker/bio subfolder found in the event folder; skipping speaker photos.");
    return [];
  }

  const files = await drive.listChildren(speakerFolder.id);
  const outDir = join(runDir, "speaker-photos");
  await mkdir(outDir, { recursive: true });

  const results = [];
  for (const speaker of speakers) {
    const file = matchSpeakerFile(files, speaker);
    if (!file) {
      console.log(`No photo file matched for speaker "${speaker.fullName}".`);
      continue;
    }
    const image = await extractSpeakerImage(drive, file).catch((error) => {
      console.log(`Could not extract photo for "${speaker.fullName}": ${error.message}`);
      return null;
    });
    if (!image) continue;

    const photoFile = join("speaker-photos", `${slugify(speaker.fullName)}.${image.ext}`);
    await writeFile(join(runDir, photoFile), image.bytes);
    results.push({
      fullName: speaker.fullName,
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      position: speaker.position,
      company: speaker.company,
      photoFile,
      source: file.name
    });
    console.log(`Saved speaker photo: ${speaker.fullName} -> ${photoFile} (from "${file.name}")`);
  }
  return results;
}

// Finds the file in the speaker folder that best matches a speaker, by last name
// then first name (case/space-insensitive). Prefers Docs/images over other types.
function matchSpeakerFile(files, speaker) {
  const candidates = files.filter((f) => {
    const name = f.name.toLowerCase();
    return (
      (speaker.lastName && name.includes(speaker.lastName.toLowerCase())) ||
      (speaker.firstName && name.includes(speaker.firstName.toLowerCase()))
    );
  });
  const rank = (f) =>
    f.mimeType === "application/vnd.google-apps.document" ? 0 : f.mimeType?.startsWith("image/") ? 1 : 2;
  return candidates.sort((a, b) => rank(a) - rank(b))[0] || null;
}

// Pulls image bytes from a matched file: the first inline image of a Google Doc,
// or the raw bytes of an image file. The extension is sniffed from the bytes
// (a Doc's inline image is often JPEG regardless of name). Returns { bytes, ext }.
async function extractSpeakerImage(drive, file) {
  let bytes = null;
  if (file.mimeType === "application/vnd.google-apps.document") {
    const doc = await drive.getGoogleDoc(file.id);
    const uri = firstDocInlineImageUri(doc);
    if (!uri) return null;
    bytes = await drive.downloadContentUri(uri);
  } else if (file.mimeType?.startsWith("image/")) {
    bytes = await drive.downloadFile(file.id);
  } else {
    return null;
  }
  return { bytes, ext: sniffImageExt(bytes) };
}

function firstDocInlineImageUri(doc) {
  const objects = doc?.inlineObjects || {};
  for (const id of Object.keys(objects)) {
    const props = objects[id]?.inlineObjectProperties?.embeddedObject?.imageProperties;
    if (props?.contentUri) return props.contentUri;
  }
  return null;
}

// Detects the image type from magic bytes (more reliable than the source name).
function sniffImageExt(bytes) {
  if (!bytes || bytes.length < 12) return "img";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  const head = bytes.toString("ascii", 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  return "img";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "speaker";
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

async function ensureWorkflow(args) {
  const runDir = await prepareRunForDraft(args);
  await writeCurrentRun(runDir);
  const auth = args.dryRun ? null : await ensureGlueUpAuth({ headless: !args.headed });
  if (auth) printAuthNote(auth);

  const ensured = await ensureDraft({ ...args, run: runDir }, { returnManifest: true, auth });
  if (args.dryRun) return;

  await ensureCampaigns({ ...args, run: ensured.runDir }, { auth });
  const updated = await readJson(join(ensured.runDir, "manifest.json"));
  console.log(`\nGlue Up shells are ensured for ${ensured.runDir}.`);
  if (updated?.glueUp?.eventUrl) console.log(`Event URL: ${updated.glueUp.eventUrl}`);
  console.log("Next: npm run populate");
}

async function populateWorkflow(args) {
  const runDir = resolveRunDir(args);
  await writeCurrentRun(runDir);
  await assertRunEventIsDraft({ runDir, args });
  await populateDraft({ ...args, run: runDir });
  await populateCampaigns({ ...args, run: runDir });
  const updated = await readJson(join(runDir, "manifest.json"));
  console.log(`\nGlue Up draft and campaigns are populated for ${runDir}.`);
  if (updated?.glueUp?.eventUrl) console.log(`Review event: ${updated.glueUp.eventUrl}`);
  console.log("After manual review and publish in Glue Up, run: npm run finalize");
}

async function finalizeWorkflow(args) {
  const runDir = resolveRunDir(args);
  await writeCurrentRun(runDir);
  await scheduleCampaigns({ ...args, run: runDir });
}

async function populateVenueWorkflow(args) {
  const runDir = resolveRunDir(args);
  await writeCurrentRun(runDir);
  await assertRunEventIsDraft({ runDir, args });
  await populateVenue({ ...args, run: runDir });
}

async function populateSummaryWorkflow(args) {
  const runDir = resolveRunDir(args);
  await writeCurrentRun(runDir);
  await assertRunEventIsDraft({ runDir, args });
  await populateSummary({ ...args, run: runDir });
}

async function populateSpeakersWorkflow(args) {
  const runDir = resolveRunDir(args);
  await writeCurrentRun(runDir);
  await assertRunEventIsDraft({ runDir, args });
  await populateSpeakers({ ...args, run: runDir });
}

async function populateBannerWorkflow(args) {
  const runDir = resolveRunDir(args);
  await writeCurrentRun(runDir);
  await assertRunEventIsDraft({ runDir, args });
  await populateBanner({ ...args, run: runDir });
}

async function ensureDraft(args, options = {}) {
  const runDir = await prepareRunForDraft(args);

  const [manifest, templateSelection, rawEvent] = await Promise.all([
    readJson(join(runDir, "manifest.json")),
    readJson(join(runDir, "template-selection.json")),
    readJson(join(runDir, "event.json"))
  ]);
  const event = normalizeEventFields(rawEvent);
  if (event.eventName !== rawEvent.eventName) {
    await writeJson(join(runDir, "event.json"), event);
    console.log(`Normalized event title: ${event.eventName}`);
  }
  const config = getConfig({ timezone: args.timezone });

  const selected = templateSelection?.selected;
  if (!selected?.glueUp?.eventType || !selected?.glueUp?.blueprintCode) {
    throw new Error("template-selection.json is missing a selected Glue Up blueprint.");
  }
  const selectedGlueUp = selected.glueUp;
  let localAuth = options.auth || null;
  const getAuth = async () => {
    if (localAuth) return localAuth;
    localAuth = await ensureGlueUpAuth({ headless: !args.headed });
    printAuthNote(localAuth);
    return localAuth;
  };

  if (manifest?.glueUp?.eventId) {
    assertGlueUpTemplateCompatible({
      actual: manifest.glueUp,
      expected: selectedGlueUp,
      source: join(runDir, "manifest.json")
    });
    if (!args.dryRun) {
      await assertGlueUpEventIsDraft({
        eventId: manifest.glueUp.eventId,
        cookie: (await getAuth()).cookie,
        source: join(runDir, "manifest.json")
      });
    }
    console.log(`Using existing Glue Up draft for ${runDir}`);
    console.log(`Event ID: ${manifest.glueUp.eventId}`);
    if (manifest.glueUp.eventUrl) console.log(`Event URL: ${manifest.glueUp.eventUrl}`);
    if (options.returnManifest) return { runDir, manifest };
    return;
  }

  let reusable = await findReusableDraftForTemplate({
    runDir,
    selectedGlueUp,
    auth: args.dryRun ? null : await getAuth()
  });
  if (!reusable) {
    await syncRecentPreparedArtifacts({
      limit: DEFAULT_REUSE_ARTIFACT_LIMIT,
      optional: true
    });
    reusable = await findReusableDraftForTemplate({
      runDir,
      selectedGlueUp,
      auth: args.dryRun ? null : await getAuth()
    });
  }
  if (reusable) {
    if (args.dryRun) {
      await writeJson(join(runDir, "draft-reuse-plan.json"), {
        runDir,
        reusableRunDir: reusable.runDir,
        eventId: reusable.manifest.glueUp.eventId,
        eventUrl: reusable.manifest.glueUp.eventUrl,
        blueprintCode: selectedGlueUp.blueprintCode,
        eventType: selectedGlueUp.eventType,
        sourceStatus: reusable.manifest.status || null
      });
      console.log(`Wrote draft reuse plan to ${join(runDir, "draft-reuse-plan.json")}`);
      if (options.returnManifest) return { runDir, manifest };
      return;
    }
    manifest.glueUp = {
      ...(manifest.glueUp || {}),
      ...reusableGlueUpSnapshot(reusable.manifest.glueUp),
      reusedFrom: {
        runDir: reusable.runDir,
        event: reusable.manifest.event || null,
        status: reusable.manifest.status || null,
        reusedAt: new Date().toISOString()
      }
    };
    manifest.status = "draft_reused";
    await writeJson(join(runDir, "manifest.json"), manifest);
    console.log(`Reusing Glue Up draft from ${reusable.runDir} (${selectedGlueUp.blueprintCode})`);
    console.log(`Event ID: ${manifest.glueUp.eventId}`);
    if (manifest.glueUp.eventUrl) console.log(`Event URL: ${manifest.glueUp.eventUrl}`);
    if (options.returnManifest) return { runDir, manifest };
    return;
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
    if (options.returnManifest) return { runDir, manifest };
    return;
  }

  const auth = await getAuth();

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
  manifest.status = "draft_ensured";

  await Promise.all([
    writeJson(join(runDir, "manifest.json"), manifest),
    writeJson(join(runDir, "draft-create-response.json"), result.raw)
  ]);

  console.log(`Created Glue Up draft for ${runDir}`);
  if (result.eventId) console.log(`Event ID: ${result.eventId}`);
  if (result.eventUrl) console.log(`Event URL: ${result.eventUrl}`);
  if (options.returnManifest) return { runDir, manifest };
}

// Create the invitation campaign drafts on the freshly-created event. Each is
// independent: one failing must not lose the event or the other campaign, so
// failures are captured per-campaign rather than thrown.
async function createInvitationCampaigns({ eventId, event, cookie, orgId, plan = CAMPAIGN_PLAN }) {
  if (!eventId) {
    throw new Error("Cannot create campaigns without a Glue Up event ID.");
  }
  const results = [];
  for (const item of plan) {
    const { key, label } = item;
    const title = campaignTitleForPlan(event, item);
    try {
      const created = await addCampaign({ eventId, title, cookie, orgId });
      results.push({ key, label, title, campaignId: created.campaignId, campaignUrl: created.campaignUrl });
    } catch (error) {
      results.push({ key, label, title, campaignId: null, error: error?.message || String(error) });
    }
  }
  return results;
}

async function ensureCampaigns(args, options = {}) {
  const runDir = resolveRunDir(args);
  const [manifest, rawEvent] = await Promise.all([readJson(join(runDir, "manifest.json")), readJson(join(runDir, "event.json"))]);
  const eventId = manifest?.glueUp?.eventId;
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId. Run ensure first.`);

  const existingCampaigns = Array.isArray(manifest?.glueUp?.campaigns) ? manifest.glueUp.campaigns : [];
  const existingByKey = new Map(
    existingCampaigns.filter((campaign) => campaign.campaignId).map((campaign) => [campaign.key, campaign])
  );
  const missing = CAMPAIGN_PLAN.filter((campaign) => !existingByKey.has(campaign.key));
  if (!missing.length) {
    console.log(`Using existing Glue Up campaign drafts for ${runDir}`);
    return;
  }

  const auth = options.auth || (await ensureGlueUpAuth({ headless: !args.headed }));
  if (!options.auth) printAuthNote(auth);
  const event = normalizeEventFields(rawEvent);
  const created = await createInvitationCampaigns({
    eventId,
    event,
    cookie: auth.cookie,
    orgId: auth.orgId,
    plan: missing
  });
  const merged = mergeCampaigns(existingCampaigns, created);
  manifest.status = "campaigns_ensured";
  manifest.glueUp = {
    ...(manifest.glueUp || {}),
    campaigns: merged
  };
  await writeJson(join(runDir, "manifest.json"), manifest);
  for (const campaign of created) {
    if (campaign.campaignId) console.log(`Created campaign (${campaign.label}): ${campaign.campaignUrl}`);
    else console.log(`Campaign (${campaign.label}) FAILED: ${campaign.error}`);
  }
}

async function populateDraft(args) {
  const runDir = resolveRunDir(args);
  const [manifest, rawEvent] = await Promise.all([readJson(join(runDir, "manifest.json")), readJson(join(runDir, "event.json"))]);
  const eventId = manifest?.glueUp?.eventId;
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId. Run ensure first.`);

  const event = normalizeEventFields(rawEvent);
  await populateEventSettingsViaSettingsPage({
    eventId,
    event,
    timezone: getConfig({ timezone: args.timezone }).timezone,
    headless: !args.headed
  });
  const summaryResult = await populateSummary({ ...args, run: runDir }, { manifest, event, eventId });
  const venueResult = await populateVenue({ ...args, run: runDir }, { manifest, event, eventId });
  const speakersResult = await populateSpeakers({ ...args, run: runDir }, { manifest, event, eventId });
  const bannerResult = await populateBanner({ ...args, run: runDir }, { manifest, eventId });
  manifest.status = "draft_populated";
  manifest.glueUp = {
    ...(manifest.glueUp || {}),
    draftPopulatedAt: new Date().toISOString(),
    ...(summaryResult ? { summaryPopulatedAt: summaryResult.populatedAt } : {}),
    ...(venueResult ? { venuePopulatedAt: venueResult.populatedAt, venue: venueResult.venue } : {}),
    ...(speakersResult ? { speakersPopulatedAt: speakersResult.populatedAt, speakers: speakersResult.speakers } : {}),
    ...(bannerResult ? { bannerPopulatedAt: bannerResult.populatedAt, banner: bannerResult.banner } : {})
  };
  await writeJson(join(runDir, "manifest.json"), manifest);
  console.log(`Populated Glue Up draft ${eventId} from ${runDir}`);
  if (!summaryResult) {
    console.log("No event description in event.json; left the Glue Up summary unchanged.");
  }
}

async function populateVenue(args, options = {}) {
  const runDir = resolveRunDir(args);
  const manifest = options.manifest || (await readJson(join(runDir, "manifest.json")));
  const event = options.event || normalizeEventFields(await readJson(join(runDir, "event.json")));
  const eventId = options.eventId || manifest?.glueUp?.eventId;
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId. Run ensure first.`);

  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  const venue = await populateEventVenueViaAjax({
    eventId,
    event,
    cookie: auth.cookie,
    csrfToken: auth.csrfToken,
    orgId: auth.orgId
  });
  if (!venue) return null;

  const populatedAt = new Date().toISOString();
  if (!options.manifest) {
    manifest.status = "venue_populated";
    manifest.glueUp = {
      ...(manifest.glueUp || {}),
      venuePopulatedAt: populatedAt,
      venue
    };
    await writeJson(join(runDir, "manifest.json"), manifest);
  }
  return { populatedAt, venue };
}

async function populateSummary(args, options = {}) {
  const runDir = resolveRunDir(args);
  const manifest = options.manifest || (await readJson(join(runDir, "manifest.json")));
  const event = options.event || normalizeEventFields(await readJson(join(runDir, "event.json")));
  const eventId = options.eventId || manifest?.glueUp?.eventId;
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId. Run ensure first.`);

  const populated = await populateEventSummaryViaSummaryPage({
    eventId,
    event,
    headless: !args.headed
  });
  if (!populated) return null;

  const populatedAt = new Date().toISOString();
  if (!options.manifest) {
    manifest.status = "summary_populated";
    manifest.glueUp = {
      ...(manifest.glueUp || {}),
      summaryPopulatedAt: populatedAt
    };
    await writeJson(join(runDir, "manifest.json"), manifest);
  }
  return { populatedAt };
}

async function populateSpeakers(args, options = {}) {
  const runDir = resolveRunDir(args);
  const manifest = options.manifest || (await readJson(join(runDir, "manifest.json")));
  const event = options.event || normalizeEventFields(await readJson(join(runDir, "event.json")));
  const eventId = options.eventId || manifest?.glueUp?.eventId;
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId. Run ensure first.`);

  const speakers = normalizeEventSpeakers(event);
  if (!speakers.length) {
    console.log("Skipping speaker populate: no non-TBD speakers were found.");
    return null;
  }

  // Attach any headshot gathered by prepare (speaker-photos.json) so the upload
  // step can replace the default avatar.
  const photoEntries = await readJson(join(runDir, "speaker-photos.json")).catch(() => []);
  const photoByName = new Map((photoEntries || []).map((p) => [p.fullName, p.photoFile]));
  const speakersWithPhotos = speakers.map((speaker) => ({
    ...speaker,
    photoPath: photoByName.has(speaker.fullName) ? join(runDir, photoByName.get(speaker.fullName)) : null
  }));

  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  const populated = await populateEventSpeakersViaAjax({
    eventId,
    speakers: speakersWithPhotos,
    cookie: auth.cookie,
    csrfToken: auth.csrfToken,
    orgId: auth.orgId
  });
  if (!populated.length) return null;

  const populatedAt = new Date().toISOString();
  if (!options.manifest) {
    manifest.status = "speakers_populated";
    manifest.glueUp = {
      ...(manifest.glueUp || {}),
      speakersPopulatedAt: populatedAt,
      speakers: populated
    };
    await writeJson(join(runDir, "manifest.json"), manifest);
  }
  return { populatedAt, speakers: populated };
}

async function populateBanner(args, options = {}) {
  const runDir = resolveRunDir(args);
  const manifest = options.manifest || (await readJson(join(runDir, "manifest.json")));
  const eventId = options.eventId || manifest?.glueUp?.eventId;
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId. Run ensure first.`);

  const bannerPath = resolveBannerPath(runDir);
  if (!bannerPath) {
    console.log("Skipping banner populate: no banner image in run artifact (expected banner.jpg).");
    return null;
  }

  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  const value = await populateEventBannerViaDesignPage({
    eventId,
    bannerPath,
    cookie: auth.cookie,
    csrfToken: auth.csrfToken,
    orgId: auth.orgId
  });
  if (!value) return null;

  const populatedAt = new Date().toISOString();
  const banner = { id: value.id, uri: value.uri };
  if (!options.manifest) {
    manifest.status = "banner_populated";
    manifest.glueUp = {
      ...(manifest.glueUp || {}),
      bannerPopulatedAt: populatedAt,
      banner
    };
    await writeJson(join(runDir, "manifest.json"), manifest);
  }
  return { populatedAt, banner };
}

// Locates the banner image saved into the run artifact (produced by the prepare
// HEIC-convert/AI-rank pipeline, or dropped in manually for testing).
function resolveBannerPath(runDir) {
  for (const name of ["banner.jpg", "banner.jpeg", "banner.png"]) {
    const candidate = join(runDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function populateCampaigns(args) {
  const runDir = resolveRunDir(args);
  const [manifest, event] = await Promise.all([readJson(join(runDir, "manifest.json")), readJson(join(runDir, "event.json"))]);
  const eventId = manifest?.glueUp?.eventId;
  const campaigns = manifest?.glueUp?.campaigns || [];
  const targetCampaigns = campaigns.filter((campaign) => campaign.campaignId);
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId. Run ensure first.`);
  if (!targetCampaigns.length) throw new Error(`${join(runDir, "manifest.json")} has no campaign IDs. Run ensure first.`);

  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  printAuthNote(auth);
  const normalizedEvent = normalizeEventFields(event);
  for (const campaign of targetCampaigns) {
    const planned = CAMPAIGN_PLAN.find((item) => item.key === campaign.key);
    if (planned) {
      campaign.label = planned.label;
      campaign.title = campaignTitleForPlan(normalizedEvent, planned);
    }
    await applyCampaignSetup({
      eventId,
      campaignId: campaign.campaignId,
      payloads: buildDefaultCampaignSetupPayloads({ eventId, event: normalizedEvent, campaign }),
      cookie: auth.cookie,
      orgId: auth.orgId
    });
    campaign.setupAppliedAt = new Date().toISOString();
    console.log(`Populated campaign: ${campaign.label} (${campaign.campaignId})`);
  }

  manifest.status = "campaigns_populated";
  manifest.glueUp = {
    ...(manifest.glueUp || {}),
    campaigns: targetCampaigns.length === campaigns.length ? targetCampaigns : campaigns
  };
  await writeJson(join(runDir, "manifest.json"), manifest);
}

async function scheduleCampaigns(args) {
  const runDir = resolveRunDir(args);
  const [manifest, event] = await Promise.all([readJson(join(runDir, "manifest.json")), readJson(join(runDir, "event.json"))]);
  const eventId = manifest?.glueUp?.eventId;
  const allCampaigns = manifest?.glueUp?.campaigns || [];
  const campaigns = allCampaigns.filter((campaign) => campaign.campaignId);
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId.`);
  if (!campaigns.length) throw new Error(`${join(runDir, "manifest.json")} has no campaign IDs to schedule.`);
  const config = getConfig({ timezone: args.timezone });
  const schedule = buildCampaignSchedule(event.eventDate, config.timezone);
  if (!schedule) throw new Error(`Could not calculate campaign schedule from eventDate "${event.eventDate}".`);

  const scheduled = [];
  for (const campaign of campaigns) {
    const send = schedule[camelCampaignKey(campaign.key)];
    if (!send) throw new Error(`No schedule mapping exists for campaign key "${campaign.key}".`);
    const sendDate = send.label.slice(0, 10);
    scheduled.push({ campaign, sendDate, sendTime: "04:00" });
  }

  if (args.dryRun) {
    await writeJson(
      join(runDir, "campaign-schedule-plan.json"),
      scheduled.map(({ campaign, sendDate, sendTime }) => ({
        key: campaign.key,
        campaignId: campaign.campaignId,
        sendDate,
        sendTime,
        timezone: config.timezone
      }))
    );
    console.log(`Wrote campaign schedule plan to ${join(runDir, "campaign-schedule-plan.json")}`);
    return;
  }

  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  printAuthNote(auth);
  await assertGlueUpEventIsPublished({
    eventId,
    cookie: auth.cookie,
    source: join(runDir, "manifest.json")
  });
  for (const item of scheduled) {
    await scheduleCampaign({
      eventId,
      campaignId: item.campaign.campaignId,
      sendDate: item.sendDate,
      sendTime: item.sendTime,
      timezone: config.timezone,
      cookie: auth.cookie,
      orgId: auth.orgId
    });
    item.campaign.scheduledAt = new Date().toISOString();
    item.campaign.sendDate = item.sendDate;
    item.campaign.sendTime = item.sendTime;
    item.campaign.timezone = config.timezone;
    console.log(`Scheduled campaign: ${item.campaign.label} (${item.campaign.campaignId}) for ${item.sendDate} ${item.sendTime}`);
  }

  manifest.status = "campaigns_scheduled";
  manifest.glueUp = {
    ...(manifest.glueUp || {}),
    publishedAt: manifest.glueUp?.publishedAt || new Date().toISOString(),
    campaigns: campaigns.length === allCampaigns.length ? campaigns : allCampaigns
  };
  await writeJson(join(runDir, "manifest.json"), manifest);
  console.log(`\nScheduled ${scheduled.length} campaign(s) for ${runDir}.`);
}

async function applyCapturedCampaignSetup(args) {
  const runDir = resolveRunDir(args);
  const probePath = args.probe || ".glueup-debug/campaign-probe.json";
  const [manifest, event, probeReport] = await Promise.all([
    readJson(join(runDir, "manifest.json")),
    readJson(join(runDir, "event.json")),
    readJson(probePath)
  ]);

  const eventId = manifest?.glueUp?.eventId;
  const campaigns = manifest?.glueUp?.campaigns || [];
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId.`);
  const targetCampaigns = campaigns.filter((campaign) => campaign.campaignId);
  if (!targetCampaigns.length) {
    throw new Error(`${join(runDir, "manifest.json")} has no campaign IDs to set up.`);
  }

  if (!probeReport?.captureValues) {
    throw new Error(`${probePath} was not captured with --capture-values.`);
  }

  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  const authNotes = {
    env: "Using GLUEUP_COOKIE/CSRF from the environment.",
    session: "Using saved Glue Up session.",
    login: "Logged in to Glue Up."
  };
  if (authNotes[auth.source]) console.log(authNotes[auth.source]);

  for (const campaign of targetCampaigns) {
    const payloads = extractCampaignSetupPayloads(probeReport, { eventId, event, campaign });
    await applyCampaignSetup({
      eventId,
      campaignId: campaign.campaignId,
      payloads,
      cookie: auth.cookie,
      orgId: auth.orgId
    });
    campaign.setupAppliedAt = new Date().toISOString();
    console.log(`Applied setup: ${campaign.label} (${campaign.campaignId})`);
  }

  manifest.status = "campaigns_setup";
  manifest.glueUp = {
    ...(manifest.glueUp || {}),
    campaigns: targetCampaigns.length === campaigns.length ? targetCampaigns : campaigns
  };
  await writeJson(join(runDir, "manifest.json"), manifest);
  console.log(`Updated ${join(runDir, "manifest.json")}`);
}

async function markIgnore(args) {
  const runDir = resolveRunDir(args);
  const manifest = await readJson(join(runDir, "manifest.json"));
  const eventId = manifest?.glueUp?.eventId;
  const campaigns = (manifest?.glueUp?.campaigns || []).filter((campaign) => campaign.campaignId);
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId.`);

  const title = String(args.title || "PLEASE IGNORE");
  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  const authNotes = {
    env: "Using GLUEUP_COOKIE/CSRF from the environment.",
    session: "Using saved Glue Up session.",
    login: "Logged in to Glue Up."
  };
  if (authNotes[auth.source]) console.log(authNotes[auth.source]);

  await markEventIgnoreViaSettingsPage({ eventId, title, headless: !args.headed });
  console.log(`Marked event ${eventId}: ${title}`);

  for (const campaign of campaigns) {
    const payloads = buildDefaultCampaignSetupPayloads({
      eventId,
      event: { eventName: title },
      campaign: { ...campaign, title }
    }).filter((payload) => payload.action === "SetupCampaignFormSubmit");
    await applyCampaignSetup({
      eventId,
      campaignId: campaign.campaignId,
      payloads,
      cookie: auth.cookie,
      orgId: auth.orgId
    });
    campaign.title = title;
    campaign.ignoredAt = new Date().toISOString();
    console.log(`Marked campaign ${campaign.campaignId}: ${title}`);
  }

  manifest.status = "ignored";
  manifest.glueUp = {
    ...(manifest.glueUp || {}),
    ignoredAt: new Date().toISOString(),
    ignoreTitle: title,
    campaigns: campaigns.length === (manifest.glueUp?.campaigns || []).length ? campaigns : manifest.glueUp.campaigns
  };
  await writeJson(join(runDir, "manifest.json"), manifest);
  console.log(`Updated ${join(runDir, "manifest.json")}`);
}

async function markEventIgnoreViaSettingsPage({ eventId, title, headless }) {
  const { chromium } = await import("playwright");
  const sessionDir = resolve(process.env.GLUEUP_SESSION_DIR || ".glueup-session");
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless,
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(`https://ycp.glueup.com/events/${eventId}/setup/settings/general/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
    await page.locator('input[name="title"]').first().waitFor({ state: "visible", timeout: 60_000 });
    await page.locator('input[name="title"]').first().fill(title);
    const responsePromise = page
      .waitForResponse((response) =>
        response.url().includes(`/events/${eventId}/setup/settings/general/ajax`) &&
        response.request().method() === "POST"
      )
      .catch(() => null);
    await page.locator('button.save-button, [data-event="StandardForm::submit"]').first().click();
    const response = await responsePromise;
    if (response && !response.ok()) {
      throw new Error(`Glue Up settings save failed ${response.status()}.`);
    }
    await page.waitForTimeout(1_000);
    const currentTitle = await page.locator('input[name="title"]').first().inputValue();
    if (currentTitle !== title) {
      throw new Error(`Glue Up settings save did not persist the ignore title; current title is "${currentTitle}".`);
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function populateEventSettingsViaSettingsPage({ eventId, event, timezone, headless }) {
  const { chromium } = await import("playwright");
  const sessionDir = resolve(process.env.GLUEUP_SESSION_DIR || ".glueup-session");
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless,
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || (await context.newPage());
  const title = event?.eventName || event?.sourceDocumentTitle || "Untitled event";
  const times = parseEventTimes(event);
  try {
    await page.goto(`https://ycp.glueup.com/events/${eventId}/setup/settings/general/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
    await page.locator('input[name="title"]').first().waitFor({ state: "visible", timeout: 60_000 });
    await fillFirstVisible(page, ['input[name="title"]'], title);
    await fillFirstVisible(page, ['input[name="startDate"]', 'input[name="start_date"]'], times.startDate);
    await fillFirstVisible(page, ['input[name="endDate"]', 'input[name="end_date"]'], times.endDate);
    await fillFirstVisible(page, ['input[name="startTime"]', 'input[name="start_time"]'], times.startTime);
    await fillFirstVisible(page, ['input[name="endTime"]', 'input[name="end_time"]'], times.endTime);
    await fillFirstVisible(page, ['input[name="venue.timezone"]', 'input[name="timezone"]'], timezone);

    const responsePromise = page
      .waitForResponse((response) =>
        response.url().includes(`/events/${eventId}/setup/settings/general/ajax`) &&
        response.request().method() === "POST"
      )
      .catch(() => null);
    await page.locator('button.save-button, [data-event="StandardForm::submit"]').first().click();
    const response = await responsePromise;
    if (response && !response.ok()) {
      throw new Error(`Glue Up settings save failed ${response.status()}.`);
    }
    await page.waitForTimeout(1_000);
    const currentTitle = await page.locator('input[name="title"]').first().inputValue();
    if (currentTitle !== title) {
      throw new Error(`Glue Up settings save did not persist the event title; current title is "${currentTitle}".`);
    }
  } finally {
    await context.close().catch(() => {});
  }
}

function rawEventField(event, keys) {
  const rawFields = event?.rawFields || {};
  for (const key of keys) {
    const normalized = key.toLowerCase().replace(/[:*]/g, "").replace(/\s+/g, " ").trim();
    if (rawFields[normalized]) return rawFields[normalized];
  }
  return "";
}

function cleanSingleLine(value) {
  return String(value || "")
    .replace(/\u000b/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

async function populateEventVenueViaAjax({ eventId, event, cookie, csrfToken, orgId }) {
  const venue = normalizeEventVenue(event);
  if (!venue.full) {
    console.log("Skipping venue populate: event.venue is blank.");
    return null;
  }
  const currentPath = `/events/${eventId}/publishing/content/venue/`;
  const pageCsrfToken = await fetchGlueUpPageCsrfToken({
    path: currentPath,
    cookie,
    fallback: csrfToken
  });

  const geo = await searchVenueGeo({
    eventId,
    search: venue.search,
    cookie,
    csrfToken: pageCsrfToken,
    orgId
  });
  const payload = {
    id: "0",
    file: {
      id: "",
      uri: "",
      name: "",
      type: "",
      size: 0,
      createdOn: Date.now()
    },
    info: "",
    "address.provinceDropdown.us": {},
    country: {
      code: "US"
    },
    cityName: venue.city,
    address: venue.address,
    name: venue.name,
    geo,
    submit: "save"
  };

  await postGlueUpAjax({
    path: `/events/${eventId}/publishing/content/venue/ajax`,
    currentPath: `/events/${eventId}/publishing/content/venue/`,
    refererPath: `/events/${eventId}/publishing/content/venue/`,
    action: "EventVenueSubmit",
    data: payload,
    cookie,
    csrfToken: pageCsrfToken,
    orgId
  });
  console.log(`Populated venue: ${venue.name || venue.address}`);
  return {
    name: venue.name,
    address: venue.address,
    cityName: venue.city,
    countryCode: "US",
    geo
  };
}

// Adds each speaker to the draft via the speakers page's `create-manual-speaker`
// AJAX action (the same action the "add manually" UI fires). Existing speakers are
// skipped by name so re-runs stay idempotent. The default profile image (declared
// near the top) mirrors what the Glue Up UI sends for a speaker with no photo.
async function populateEventSpeakersViaAjax({ eventId, speakers, cookie, csrfToken, orgId }) {
  if (!speakers.length) return [];
  const currentPath = `/events/${eventId}/publishing/content/speakers/`;
  const pageHtml = await fetchGlueUpPageHtml({ path: currentPath, cookie });
  const pageCsrfToken = extractGlueUpCsrfToken(pageHtml) || csrfToken;

  const populated = [];
  for (const speaker of speakers) {
    if (pageHtml.includes(speaker.fullName)) {
      console.log(`Skipping existing speaker: ${speaker.fullName}`);
      populated.push({ ...speaker, skipped: true });
      continue;
    }
    let image = {
      uri: GLUEUP_DEFAULT_SPEAKER_IMAGE_URI,
      originalUri: GLUEUP_DEFAULT_SPEAKER_IMAGE_URI,
      styleString: `background-image: url( ${GLUEUP_DEFAULT_SPEAKER_IMAGE_URI} );`,
      html: { src: GLUEUP_DEFAULT_SPEAKER_IMAGE_URI }
    };
    if (speaker.photoPath) {
      const uploaded = await uploadGlueUpSpeakerImage({
        photoPath: speaker.photoPath,
        cookie,
        csrfToken: pageCsrfToken,
        orgId,
        currentPath
      }).catch((error) => {
        console.log(`Speaker photo upload failed for ${speaker.fullName} (using default): ${error.message}`);
        return null;
      });
      if (uploaded) image = uploaded;
    }
    const data = {
      id: "",
      email: "",
      order: { code: "-1" },
      description: speaker.description || "",
      website: "",
      company: speaker.company || "",
      position: speaker.position || "",
      lastName: speaker.lastName || "",
      firstName: speaker.firstName || "",
      image
    };
    await postGlueUpAjax({
      path: `/events/${eventId}/publishing/content/speakers/ajax`,
      currentPath,
      refererPath: currentPath,
      action: "create-manual-speaker",
      data,
      cookie,
      csrfToken: pageCsrfToken,
      orgId
    });
    console.log(`Populated speaker: ${speaker.fullName}`);
    populated.push(speaker);
  }
  return populated;
}

// Uploads a speaker headshot and returns the cropped square image object for the
// create-manual-speaker payload, replaying the UploadImageButton flow: POST
// /upload/images (files[] + token/orgID/currentPath/returnUrl/type) then
// POST /upload/images?isCrop=true with a centered-square crop box.
async function uploadGlueUpSpeakerImage({ photoPath, cookie, csrfToken, orgId, currentPath }) {
  const bytes = await readFile(photoPath);
  const ext = sniffImageExt(bytes);
  const mime = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[ext] || "image/jpeg";
  const fileName = `headshot.${ext}`;

  const form = new FormData();
  form.append("files[]", new Blob([bytes], { type: mime }), fileName);
  form.append("token", csrfToken);
  form.append("orgID", String(orgId));
  form.append("currentPath", currentPath);
  form.append("returnUrl", "");
  form.append("type", "square");
  const uploadJson = await postGlueUpUpload({ path: "/upload/images", body: form, cookie, currentPath });
  const uuid = Object.values(uploadJson.data.value)[0]?.id;
  if (!uuid) throw new Error("upload returned no image id");

  const dims = imageDimensions(bytes) || { width: 600, height: 600 };
  const side = Math.min(dims.width, dims.height);
  const cropData = {
    id: null,
    "ImageCropper.uri": `/resources/public/images/orig/${uuid}.${ext}`,
    "ImageCropper.dimensions": {
      x: Math.floor((dims.width - side) / 2),
      y: Math.floor((dims.height - side) / 2),
      width: side,
      height: side
    },
    extension: ext,
    fileName,
    fileType: mime,
    type: "square"
  };
  const cropJson = await postGlueUpUpload({
    path: "/upload/images?isCrop=true",
    body: new URLSearchParams({
      action: "cropImage",
      data: JSON.stringify(cropData),
      token: csrfToken,
      orgID: String(orgId),
      currentPath
    }).toString(),
    cookie,
    currentPath,
    urlencoded: true
  });
  return cropJson.data.value;
}

// Sets the event banner ("headerImage") on the Website > Design customizer.
// Reverse-engineered from the UI: upload the image via the shared /upload/images
// flow, then POST the design page's `updateCustomizeSidebarGroupItemImage` action
// with id:"headerImage" and the fixed-width image value object. Save is verifiable
// from the JSON response (code 200, empty data.errors via assertNoAppError).
async function populateEventBannerViaDesignPage({ eventId, bannerPath, cookie, csrfToken, orgId }) {
  if (!bannerPath) return null;
  const currentPath = `/events/${eventId}/publishing/website/design/`;
  const pageCsrf = await fetchGlueUpPageCsrfToken({ path: currentPath, cookie, fallback: csrfToken });
  const value = await uploadGlueUpBannerImage({ photoPath: bannerPath, cookie, csrfToken: pageCsrf, orgId, currentPath });
  await postGlueUpAjax({
    path: `/events/${eventId}/publishing/website/design/ajax`,
    currentPath,
    refererPath: currentPath,
    action: "updateCustomizeSidebarGroupItemImage",
    data: { id: "headerImage", value },
    cookie,
    csrfToken: pageCsrf,
    orgId
  });
  console.log(`Populated event banner from ${bannerPath}`);
  return value;
}

// Uploads a banner image and builds the `headerImage` value object the design
// customizer expects. Unlike the speaker headshot flow this uses type "fixed-width"
// (full-bleed header, no square crop); the fixed-width/orig URIs are assembled from
// the uploaded image id by the same convention the UI uses.
async function uploadGlueUpBannerImage({ photoPath, cookie, csrfToken, orgId, currentPath }) {
  const bytes = await readFile(photoPath);
  const ext = sniffImageExt(bytes);
  const mime = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[ext] || "image/jpeg";

  const form = new FormData();
  form.append("files[]", new Blob([bytes], { type: mime }), `banner.${ext}`);
  form.append("token", csrfToken);
  form.append("orgID", String(orgId));
  form.append("currentPath", currentPath);
  form.append("returnUrl", "");
  form.append("type", "fixed-width");
  const uploadJson = await postGlueUpUpload({ path: "/upload/images", body: form, cookie, currentPath });
  const uploaded = Object.values(uploadJson.data.value)[0] || {};
  const uuid = uploaded.id;
  if (!uuid) throw new Error("banner upload returned no image id");
  const fileExt = uploaded.extension || ext;

  const fixedWidth = (width) => `/resources/public/images/fixed-width/${width}/${uuid}.${fileExt}`;
  const uri = fixedWidth(1000);
  const originalUri = `/resources/public/images/orig/${uuid}.${fileExt}`;
  return {
    styleString: `background-image: url( ${uri} ) !important;background-position: center center;`,
    croppedUrl: `/cropped-image/x/alignment/Center?image=${encodeURIComponent(uri)}`,
    type: "fixed-width",
    uri,
    originalUri,
    html: `<img async src="${uri}" title="" alt="" srcset="${fixedWidth(1920)} 2x"/>`,
    alignment: "Center",
    size: 1000,
    id: uuid,
    name: `${uuid}.${fileExt}`
  };
}

async function postGlueUpUpload({ path, body, cookie, currentPath, urlencoded = false }) {
  const headers = {
    cookie,
    accept: "application/json, text/javascript, */*; q=0.01",
    "x-requested-with": "XMLHttpRequest",
    referer: `${GLUEUP_BASE_URL}${currentPath}`
  };
  if (urlencoded) headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  const response = await fetch(`${GLUEUP_BASE_URL}${path}`, { method: "POST", headers, body });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Glue Up upload ${path} returned non-JSON: ${text.slice(0, 120)}`);
  }
  if (json.code !== 201) {
    throw new Error(`Glue Up upload ${path} failed (code ${json.code}): ${JSON.stringify(json.data?.errors || [])}`);
  }
  return json;
}

// Reads pixel dimensions from JPEG or PNG bytes (for the centered-square crop box).
function imageDimensions(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Parses the raw speaker field into structured entries, dropping TBD placeholders.
function normalizeEventSpeakers(event) {
  const rawSpeakers = Array.isArray(event?.speakers) && event.speakers.length
    ? event.speakers
    : splitSpeakerEntries(rawEventField(event, ["speaker (if applicable)", "speakers", "speaker", "presenter", "presenters"]));
  return rawSpeakers
    .map((speaker) => parseSpeakerEntry(speaker))
    .filter((speaker) => speaker && !/^tbd\b/i.test(speaker.fullName));
}

function splitSpeakerEntries(value) {
  return String(value || "")
    .replace(/\u000b/g, "\n")
    .split(/\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSpeakerEntry(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const [namePart, ...detailParts] = raw.includes(",") ? raw.split(",") : raw.split(/\s+-\s+/);
  const fullName = cleanSingleLine(namePart);
  if (!fullName) return null;
  const detail = detailParts.join(raw.includes(",") ? "," : " - ").trim();
  const { position, company } = parseSpeakerDetail(detail);
  const { firstName, lastName } = splitSpeakerName(fullName);
  return { fullName, firstName, lastName, position, company, description: "" };
}

function parseSpeakerDetail(value) {
  const detail = cleanSingleLine(value);
  if (!detail) return { position: "", company: "" };
  const parts = detail.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { position: parts[0], company: parts.slice(1).join(" - ") };
  }
  return { position: detail, company: "" };
}

function splitSpeakerName(fullName) {
  const parts = cleanSingleLine(fullName).split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

async function fetchGlueUpPageCsrfToken({ path, cookie, fallback }) {
  const html = await fetchGlueUpPageHtml({ path, cookie });
  return extractGlueUpCsrfToken(html) || fallback;
}

async function fetchGlueUpPageHtml({ path, cookie }) {
  const response = await fetch(`${GLUEUP_BASE_URL}${path}`, {
    headers: {
      cookie,
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to load Glue Up page ${path} (${response.status}).`);
  }
  return html;
}

function extractGlueUpCsrfToken(html) {
  const match =
    html.match(/<meta[^>]+id=["']csrf-token["'][^>]*\scontent=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+name=["']csrf-token["'][^>]*\scontent=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*\s(?:id|name)=["']csrf-token["']/i);
  return match?.[1] || "";
}

function normalizeEventVenue(event) {
  const full = String(event?.venue || "").replace(/\r\n/g, "\n").trim();
  const lines = full
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const name = lines[0] || "";
  const addressLines = lines.slice(1);
  const city = String(event?.city || inferCityFromAddressLines(addressLines) || "").trim();
  const address = addressLines[0] || "";
  const search = [name, ...addressLines, city].filter(Boolean).join(" ");
  return { full, name, address, city, search };
}

function inferCityFromAddressLines(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^([^,\n]+),?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.exec(lines[i]);
    if (match) return match[1].trim();
  }
  return "";
}

async function searchVenueGeo({ eventId, search, cookie, csrfToken, orgId }) {
  const response = await postGlueUpAjax({
    path: "/map/ajax",
    currentPath: `/events/${eventId}/publishing/content/venue/`,
    refererPath: `/events/${eventId}/publishing/content/venue/`,
    action: "search",
    data: { search },
    cookie,
    csrfToken,
    orgId
  });
  const value = response?.data?.value;
  if (!value || typeof value.latitude !== "number" || typeof value.longitude !== "number") {
    throw new Error(`Glue Up map search did not return coordinates for venue search "${search}".`);
  }
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    zoom: typeof value.zoom === "number" ? value.zoom : 14
  };
}

async function postGlueUpAjax({ path, currentPath, refererPath, action, data, cookie, csrfToken, orgId }) {
  if (!cookie) throw new Error("Missing GLUEUP_COOKIE.");
  if (!csrfToken) throw new Error("Missing Glue Up CSRF token.");
  const body = new URLSearchParams({
    action,
    data: JSON.stringify(data || {}),
    token: csrfToken,
    orgID: String(orgId),
    currentPath
  });
  const response = await fetch(`${GLUEUP_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: GLUEUP_BASE_URL,
      referer: `${GLUEUP_BASE_URL}${refererPath || currentPath}`,
      "x-requested-with": "XMLHttpRequest",
      cookie
    },
    body: body.toString()
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Glue Up ${action} failed ${response.status}: ${text}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Glue Up ${action} returned non-JSON response: ${text}`);
  }
  assertNoAppError(payload, action);
  return payload;
}

async function fillFirstVisible(page, selectors, value) {
  if (!value) return false;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await locator.fill(String(value));
      return true;
    }
  }
  return false;
}

// Populates the event description into the Glue Up draft's content/summary page.
// The summary `about` field is a Quill rich-text editor (div.ql-editor) saved via
// the StandardForm action POST /events/<eventId>/publishing/content/summary/ajax.
// Returns true when a description was written, false when event.description is empty.
async function populateEventSummaryViaSummaryPage({ eventId, event, headless }) {
  const html = descriptionToHtml(event?.description);
  if (!html) return false;

  const { chromium } = await import("playwright");
  const sessionDir = resolve(process.env.GLUEUP_SESSION_DIR || ".glueup-session");
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless,
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(`https://ycp.glueup.com/events/${eventId}/publishing/content/summary/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
    await page.locator("div.ql-editor").first().waitFor({ state: "visible", timeout: 60_000 });

    // Set the Quill content via its API when available (keeps the editor model in
    // sync), falling back to writing the editor DOM and firing an input event.
    await page.evaluate((value) => {
      const editor = document.querySelector("div.ql-editor");
      if (!editor) return;
      const container = editor.closest(".ql-container");
      const quill = window.Quill && container && typeof window.Quill.find === "function"
        ? window.Quill.find(container)
        : null;
      if (quill && quill.clipboard && typeof quill.clipboard.dangerouslyPasteHTML === "function") {
        quill.setText("");
        quill.clipboard.dangerouslyPasteHTML(0, value);
      } else {
        editor.innerHTML = value;
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, html);

    const responsePromise = page
      .waitForResponse((response) =>
        response.url().includes(`/events/${eventId}/publishing/content/summary/ajax`) &&
        response.request().method() === "POST"
      )
      .catch(() => null);
    await page.locator('button.save-button, [data-event="StandardForm::submit"]').first().click();
    const response = await responsePromise;
    if (response && !response.ok()) {
      throw new Error(`Glue Up summary save failed ${response.status()}.`);
    }
    await page.waitForTimeout(1_000);

    // The save response is an empty text/html body, so confirm persistence by
    // reloading: the injected text lingers in the DOM whether or not the save
    // took, but a fresh page only shows what Glue Up stored server-side.
    await page.goto(`https://ycp.glueup.com/events/${eventId}/publishing/content/summary/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
    await page.locator("div.ql-editor").first().waitFor({ state: "visible", timeout: 60_000 });
    const saved = await page.locator("div.ql-editor").first().innerText().catch(() => "");
    const expected = stripHtml(html);
    const probe = expected.slice(0, 40);
    if (!saved.replace(/\s+/g, " ").includes(probe.replace(/\s+/g, " "))) {
      throw new Error("Glue Up summary save did not persist the event description.");
    }
    return true;
  } finally {
    await context.close().catch(() => {});
  }
}

// Converts plain-text description (blank-line separated) into the paragraph HTML
// the Glue Up Quill editor stores in the summary `about` field.
function descriptionToHtml(description) {
  const text = typeof description === "string" ? description.trim() : "";
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Plain text of the description HTML, for comparing against the reloaded editor.
function stripHtml(html) {
  return String(html)
    .replace(/<\/(p|div|br)>/gi, " ")
    .replace(/<br\s*\/?>(?=)/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeCampaigns(existing, created) {
  const byKey = new Map(existing.map((campaign) => [campaign.key, campaign]));
  for (const campaign of created) {
    byKey.set(campaign.key, { ...(byKey.get(campaign.key) || {}), ...campaign });
  }
  return CAMPAIGN_PLAN.map(({ key }) => byKey.get(key)).filter(Boolean);
}

function campaignTitleForPlan(event, { label }) {
  const baseTitle = event?.eventName || event?.sourceDocumentTitle || "Event";
  return `${baseTitle} — Invitation (${label})`;
}

function camelCampaignKey(key) {
  if (key === "week-before") return "weekBefore";
  if (key === "day-before") return "dayBefore";
  return key;
}

function printAuthNote(auth) {
  const authNotes = {
    env: "Using GLUEUP_COOKIE/CSRF from the environment.",
    session: "Using saved Glue Up session.",
    login: "Logged in to Glue Up."
  };
  if (authNotes[auth.source]) console.log(authNotes[auth.source]);
}

async function findReusableDraftForTemplate({ runDir, selectedGlueUp, auth = null }) {
  const entries = await readdir("runs", { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateRunDir = join("runs", entry.name);
    if (resolve(candidateRunDir) === resolve(runDir)) continue;

    const candidate = await readReusableCandidate(candidateRunDir).catch(() => null);
    if (!candidate?.manifest?.glueUp?.eventId) continue;
    if (!glueUpTemplateMatches(candidate.glueUp, selectedGlueUp)) continue;
    if (candidate.manifest?.glueUp?.publishedAt || candidate.manifest?.status === "campaigns_scheduled") continue;
    const draftStatus = auth ? await safeGlueUpConfirmsDraft(candidate.manifest.glueUp.eventId, auth) : true;
    if (!draftStatus) {
      console.log(
        `Skipping ${candidate.runDir}: Glue Up does not confirm event ${candidate.manifest.glueUp.eventId} is still a draft.`
      );
      continue;
    }
    candidates.push(candidate);
  }

  candidates.sort((a, b) => reusableDraftScore(b) - reusableDraftScore(a));
  return candidates[0] || null;
}

async function readReusableCandidate(runDir) {
  const manifest = await readJson(join(runDir, "manifest.json"));
  const templateSelection = await readJson(join(runDir, "template-selection.json")).catch(() => null);
  const selectedGlueUp = templateSelection?.selected?.glueUp || {};
  return {
    runDir,
    manifest,
    glueUp: {
      eventType: manifest?.glueUp?.eventType || selectedGlueUp.eventType || null,
      blueprintCode: manifest?.glueUp?.blueprintCode || selectedGlueUp.blueprintCode || null
    }
  };
}

function reusableDraftScore(candidate) {
  const glueUp = candidate.manifest?.glueUp || {};
  const status = candidate.manifest?.status;
  const ignoredBoost = status === "ignored" || glueUp.ignoredAt ? 10_000_000_000_000 : 0;
  const createdAt = Date.parse(glueUp.draftCreatedAt || candidate.manifest?.preparedAt || "") || 0;
  return ignoredBoost + createdAt;
}

function reusableGlueUpSnapshot(glueUp = {}) {
  return {
    eventId: glueUp.eventId,
    eventUrl: glueUp.eventUrl,
    draftCreatedAt: glueUp.draftCreatedAt,
    blueprintCode: glueUp.blueprintCode,
    eventType: glueUp.eventType,
    campaigns: Array.isArray(glueUp.campaigns) ? glueUp.campaigns.map((campaign) => ({ ...campaign })) : []
  };
}

async function assertRunEventIsDraft({ runDir, args }) {
  const manifest = await readJson(join(runDir, "manifest.json"));
  const eventId = manifest?.glueUp?.eventId;
  if (!eventId) throw new Error(`${join(runDir, "manifest.json")} is missing glueUp.eventId. Run ensure first.`);
  if (args.dryRun) return;
  const auth = await ensureGlueUpAuth({ headless: !args.headed });
  printAuthNote(auth);
  await assertGlueUpEventIsDraft({
    eventId,
    cookie: auth.cookie,
    source: join(runDir, "manifest.json")
  });
}

async function assertGlueUpEventIsDraft({ eventId, cookie, source }) {
  const confirmed = await glueUpConfirmsDraft(eventId, { cookie });
  if (!confirmed) {
    throw new Error(
      `${source} points at Glue Up event ${eventId}, but Glue Up does not confirm that event is still a draft. Refusing to repurpose a possibly published event.`
    );
  }
}

// Scheduling is hard-gated by Glue Up: on an unpublished event the admin UI
// pops "Please publish your event" and blocks the send. Fail fast with a clear
// message rather than letting each schedule-campaign call error mid-loop.
async function assertGlueUpEventIsPublished({ eventId, cookie, source }) {
  const stillDraft = await glueUpConfirmsDraft(eventId, { cookie });
  if (stillDraft) {
    throw new Error(
      `${source} points at Glue Up event ${eventId}, which is still a draft. Publish the event in Glue Up after reviewing it, then re-run finalize. Scheduling is blocked until the event is published.`
    );
  }
}

async function glueUpConfirmsDraft(eventId, auth) {
  if (!eventId || !auth?.cookie) return false;
  const html = await fetchGlueUpDraftListHtml({ cookie: auth.cookie });
  return draftListContainsEventId(html, eventId);
}

async function safeGlueUpConfirmsDraft(eventId, auth) {
  try {
    return await glueUpConfirmsDraft(eventId, auth);
  } catch (error) {
    console.log(`Could not verify draft status for Glue Up event ${eventId}: ${error.message}`);
    return false;
  }
}

async function fetchGlueUpDraftListHtml({ cookie }) {
  const response = await fetch(`${GLUEUP_BASE_URL}/events/draft/`, {
    headers: {
      cookie,
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to load Glue Up draft list for draft verification (${response.status}).`);
  }
  return text;
}

function draftListContainsEventId(html, eventId) {
  const id = String(eventId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`/events/${id}(?:/|\\b)`),
    new RegExp(`["']eventId["']\\s*:\\s*["']?${id}["']?`),
    new RegExp(`["']eventID["']\\s*:\\s*["']?${id}["']?`),
    new RegExp(`["']id["']\\s*:\\s*["']?${id}["']?`)
  ].some((pattern) => pattern.test(html));
}

function assertGlueUpTemplateCompatible({ actual, expected, source }) {
  if (!actual?.blueprintCode) {
    console.log(`Warning: ${source} has a Glue Up event ID but no blueprintCode; template compatibility cannot be verified.`);
    return;
  }
  if (!glueUpTemplateMatches(actual, expected)) {
    throw new Error(
      `${source} already points at Glue Up event ${actual.eventId}, but its template is ${actual.blueprintCode}/${actual.eventType || "unknown"} and this run selected ${expected.blueprintCode}/${expected.eventType}. Use a template-compatible draft or create a fresh run manifest.`
    );
  }
}

function glueUpTemplateMatches(actual, expected) {
  if (!actual?.blueprintCode || !expected?.blueprintCode) return false;
  if (String(actual.blueprintCode) !== String(expected.blueprintCode)) return false;
  if (actual.eventType && expected.eventType && String(actual.eventType) !== String(expected.eventType)) return false;
  return true;
}

async function syncRecentPreparedArtifacts({ limit, optional = false }) {
  try {
    const runs = JSON.parse(
      ghCapture([
        "run",
        "list",
        "--workflow",
        PREPARE_WORKFLOW,
        "--status",
        "success",
        "--limit",
        String(limit),
        "--json",
        "databaseId"
      ])
    );

    for (const run of runs) {
      const artifacts = JSON.parse(
        ghCapture([
          "api",
          `repos/{owner}/{repo}/actions/runs/${run.databaseId}/artifacts`,
          "--jq",
          ".artifacts"
        ])
      );
      for (const artifact of artifacts.filter((item) => item.name.startsWith(ARTIFACT_PREFIX))) {
        const slug = artifact.name.slice(ARTIFACT_PREFIX.length);
        if (existsSync(join("runs", slug, "manifest.json"))) continue;
        console.log(`Downloading reusable draft artifact ${artifact.name} from run #${run.databaseId} ...`);
        gh(["run", "download", String(run.databaseId), "-n", artifact.name, "-D", "runs"]);
      }
    }
  } catch (error) {
    if (!optional) throw error;
    console.log(`Could not refresh recent artifacts automatically: ${error.message}`);
  }
}

async function glueupLogin(args) {
  const auth = await loginGlueUp({ headless: args.headless ?? false });
  console.log(`Session saved. Org ID: ${auth.orgId}`);
  console.log(`Draft workspace: https://ycp.glueup.com/events/draft`);
}

async function syncRun(args) {
  const eventInfo = parseEvent(args);
  await syncEvent(eventInfo, { fresh: args.fresh });
  console.log("Next: npm run ensure");
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
// for ensure: the index is named once, on GitHub, not again locally.
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
      `No successful ${PREPARE_WORKFLOW} run found. Dispatch one with: npm run ensure -- <index>`
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

// Resolve the run for ensure. The normal shorthand is positional:
// `npm run ensure -- 6`, which dispatches a fresh prepare and ensures Glue Up
// shells. With no flags it pulls the latest successful prepare run from CI.
// --event N targets a specific older event; --run path uses a local run as-is.
async function prepareRunForDraft(args) {
  if (args.run) return args.run;

  const positionalEvent = args.event === undefined ? args._?.[1] : undefined;

  if (args.fresh || positionalEvent !== undefined) {
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

function resolveRunDir(args) {
  if (args.run) return args.run;
  if (args.event !== undefined || args._?.[1] !== undefined) {
    const eventInfo = parseEvent(args);
    return join("runs", eventInfo.slug);
  }
  const current = readCurrentRun();
  if (current) return current;
  throw new Error("Missing run target. Run `npm run ensure -- <event-index>` first.");
}

function readCurrentRun() {
  if (!existsSync(CURRENT_RUN_FILE)) return null;
  const value = readFileSync(CURRENT_RUN_FILE, "utf8").trim();
  return value || null;
}

async function writeCurrentRun(runDir) {
  await writeFile(CURRENT_RUN_FILE, `${runDir}\n`, "utf8");
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
        `Missing run file "${path}". Use the local ensure step first:\n  npm run ensure -- 6\nFor debugging only, you can pre-stage an artifact with:\n  npm run sync-run -- --event 6 --fresh`
      );
    }
    throw error;
  }
}

function usage() {
  console.log(`Glue Up Agent

Usage:
  npm run ensure -- 6      # pull event data, ensure Glue Up session, draft, and campaigns
  npm run populate         # populate the active draft and campaigns
  npm run populate-venue   # populate only the active draft venue
  npm run populate-summary # populate only the active draft description/summary
  npm run populate-speakers # populate only the active draft speakers
  npm run populate-banner  # populate only the active draft banner (needs banner.jpg in the run)
  npm run finalize         # schedule campaigns after manual review and publish

Support/debug commands:
  npm run sync-run -- --event 6 [--fresh] # pre-stage an artifact only
  npm run glueup-login                    # refresh the saved browser session only
  npm run monthly-prepare -- --event 6    # CI prepare backend; usually dispatched by ensure --fresh
  npm run validate -- --run runs/evt-2026-006
  npm run apply-campaign-setup -- --event 6
  npm run mark-ignore -- --event 6 --headed
  npm run populate-venue -- --event 6
  npm run populate-summary -- --event 6
  npm run populate-speakers -- --event 6
  npm run populate-banner -- --event 6

Options:
  --year YYYY        Defaults to the current year for ensure
  --dry-run          Write a plan without mutating Glue Up
  --headed           Open a visible browser for Glue Up page mutations
`);
}
