// Builds the published leaders data from the Google Sheet. Network and image
// work are passed in, so the rules can be tested without Google.
import { createHash } from "node:crypto";
import { slugify } from "./sheet.js";

const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

function shortHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 10);
}

// Works out where each leader's photo comes from and what it will be published as,
// without downloading anything. The file name changes whenever the photo does, so
// leaders.json changes too and browsers never show a stale photo.
export async function planPhotos(leaders, { getDriveFile }) {
  const errors = [];
  const planned = [];
  for (const leader of leaders) {
    const { photo } = leader;
    if (!photo) {
      planned.push({ leader, source: null, path: null });
      continue;
    }
    if (photo.kind === "url") {
      planned.push({ leader, source: photo, path: `photos/${slugify(leader.name)}-${shortHash(photo.url)}.jpg` });
      continue;
    }
    let file;
    try {
      file = await getDriveFile(photo.id);
    } catch (error) {
      errors.push(
        `Row ${leader.row} (${leader.name}): could not open the Photo link in Google Drive. ` +
          `Make sure the photo is in the shared leaders photos folder. (${error.message})`
      );
      continue;
    }
    if (!file.mimeType?.startsWith("image/")) {
      errors.push(`Row ${leader.row} (${leader.name}): the Photo link points to "${file.name}", which is not an image.`);
      continue;
    }
    if (Number(file.size) > MAX_PHOTO_BYTES) {
      errors.push(`Row ${leader.row} (${leader.name}): the photo "${file.name}" is larger than 25 MB.`);
      continue;
    }
    const version = file.md5Checksum || `${file.id}:${file.modifiedTime}`;
    planned.push({ leader, source: { ...photo, mimeType: file.mimeType }, path: `photos/${slugify(leader.name)}-${shortHash(version)}.jpg` });
  }
  return { planned, errors };
}

export function leadersDocument(planned) {
  return {
    leaders: planned.map(({ leader, path }) => ({
      name: leader.name,
      title: leader.title,
      group: leader.group,
      ...(path ? { image: path } : {})
    }))
  };
}

export function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// Downloads and resizes every photo. Returns { files: [{ path, bytes }], errors }.
export async function buildPhotos(planned, { downloadDrive, downloadUrl, processImage, concurrency = 4 }) {
  const files = [];
  const errors = [];
  const jobs = planned.filter(item => item.source);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { leader, source, path } = jobs[next++];
      try {
        const original = source.kind === "drive" ? await downloadDrive(source.id) : await downloadUrl(source.url);
        if (original.length > MAX_PHOTO_BYTES) throw new Error("the photo is larger than 25 MB");
        files.push({ path, bytes: await processImage(original, source.mimeType) });
      } catch (error) {
        errors.push(`Row ${leader.row} (${leader.name}): could not use the photo (${error.message}).`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { files, errors };
}
