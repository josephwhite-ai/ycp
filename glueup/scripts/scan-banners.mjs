#!/usr/bin/env node
// Lists the shared photo-library drive and downloads JPEG thumbnails so an
// operator can pick a banner without converting HEIC originals.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GoogleDriveClient } from "../src/drive/googleDriveClient.js";

const DRIVE_ID = process.env.GLUEUP_PHOTO_LIBRARY_FOLDER_ID || "0APt58RkpagPZUk9PVA";
const SKIP = /pdf split|organizer|eventdata|receipt|^ads$/i;
const OUT = process.argv[2] || "banner-scan";
const PER_FOLDER = 6;
const MAX_TOTAL = 40;
const EXTRA_IDS = (process.env.BANNER_EXTRA_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

function upsizeThumbnail(link) {
  if (!link) return link;
  return /=s\d+(-c)?$/.test(link) ? link.replace(/=s\d+(-c)?$/, "=s800") : `${link}=s800`;
}

function slug(value) {
  return String(value || "x").replace(/[^\w.-]+/g, "_").slice(0, 40);
}

const drive = new GoogleDriveClient();
await mkdir(OUT, { recursive: true });

const root = await drive.listChildren(DRIVE_ID, { driveId: DRIVE_ID });
const years = root
  .filter((file) => file.mimeType?.includes("folder") && /^\d{4}$/.test(file.name))
  .sort((a, b) => b.name.localeCompare(a.name));

const catalog = [];
const seen = new Set();

async function saveThumb(img, yearName, folderName) {
  if (seen.has(img.id) || catalog.length >= MAX_TOTAL) return;
  seen.add(img.id);
  const entry = {
    id: img.id,
    name: img.name,
    mimeType: img.mimeType,
    modifiedTime: img.modifiedTime,
    year: yearName,
    folder: folderName,
    width: img.imageMediaMetadata?.width || null,
    height: img.imageMediaMetadata?.height || null
  };
  if (img.thumbnailLink) {
    try {
      const bytes = await drive.downloadContentUri(upsizeThumbnail(img.thumbnailLink));
      const file = `${slug(yearName)}-${slug(folderName)}-${img.id}.jpg`;
      await writeFile(join(OUT, file), bytes);
      entry.thumb = file;
    } catch (error) {
      entry.thumbError = error.message;
    }
  }
  catalog.push(entry);
  console.log(`${entry.thumb ? "saved" : "listed"} ${yearName}/${folderName}/${img.name}`);
}

for (const year of years) {
  if (catalog.length >= MAX_TOTAL) break;
  const subs = (await drive.listChildren(year.id, { driveId: DRIVE_ID }))
    .filter((file) => file.mimeType?.includes("folder") && !SKIP.test(file.name))
    .sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")));
  console.log(`\n=== ${year.name} (${subs.length} folders) ===`);
  for (const sub of subs) {
    if (catalog.length >= MAX_TOTAL) break;
    const images = (
      await drive.listChildren(sub.id, {
        driveId: DRIVE_ID,
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime, thumbnailLink, imageMediaMetadata)"
      })
    )
      .filter((file) => file.mimeType?.startsWith("image/"))
      .sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")));
    console.log(`${year.name}/${sub.name}: ${images.length} images`);
    for (const img of images.slice(0, PER_FOLDER)) {
      await saveThumb(img, year.name, sub.name);
    }
  }
}

for (const id of EXTRA_IDS) {
  if (catalog.length >= MAX_TOTAL) break;
  try {
    const img = await drive.getFile(
      id,
      "id, name, mimeType, modifiedTime, thumbnailLink, imageMediaMetadata, parents"
    );
    await saveThumb(img, "extra", img.name);
  } catch (error) {
    console.log(`extra id ${id} failed: ${error.message}`);
  }
}

await writeFile(join(OUT, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`\nWrote ${catalog.length} candidates to ${OUT}/`);
