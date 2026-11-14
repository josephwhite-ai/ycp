import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import sharp from "sharp";
import { processImage } from "../src/images.js";
import { buildPhotos, leadersDocument, planPhotos, serialize } from "../src/sync.js";

const leader = (row, name, photo, group = "leadership") => ({ row, name, title: "T", group, photo });
const DRIVE_FILES = {
  good: { id: "good", name: "ann.jpg", mimeType: "image/jpeg", size: "1000", md5Checksum: "aaa" },
  doc: { id: "doc", name: "Bio.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: "10" }
};
const getDriveFile = async id => {
  if (!DRIVE_FILES[id]) throw new Error("Google Drive returned 404");
  return DRIVE_FILES[id];
};

test("planPhotos names photos by content, so a new photo changes leaders.json", async () => {
  const { planned, errors } = await planPhotos(
    [leader(2, "Ann Lee", { kind: "drive", id: "good" }), leader(3, "Bob", null), leader(4, "Cy", { kind: "url", url: "https://e.org/c.jpg" })],
    { getDriveFile }
  );
  assert.deepEqual(errors, []);
  const document = leadersDocument(planned);
  assert.match(document.leaders[0].image, /^photos\/ann-lee-[0-9a-f]{10}\.jpg$/);
  assert.equal("image" in document.leaders[1], false);
  assert.match(document.leaders[2].image, /^photos\/cy-[0-9a-f]{10}\.jpg$/);

  DRIVE_FILES.good = { ...DRIVE_FILES.good, md5Checksum: "bbb" };
  const again = leadersDocument((await planPhotos([leader(2, "Ann Lee", { kind: "drive", id: "good" })], { getDriveFile })).planned);
  assert.notEqual(again.leaders[0].image, document.leaders[0].image);
});

test("planPhotos explains unreadable and non-image Drive files", async () => {
  const { errors } = await planPhotos(
    [leader(2, "Ann", { kind: "drive", id: "missing" }), leader(3, "Bob", { kind: "drive", id: "doc" })],
    { getDriveFile }
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^Row 2 \(Ann\): could not open the Photo link .* shared leaders photos folder/);
  assert.match(errors[1], /^Row 3 \(Bob\): .*"Bio.docx", which is not an image/);
});

test("buildPhotos downloads each photo once and collects failures", async () => {
  const { planned } = await planPhotos(
    [leader(2, "Ann", { kind: "drive", id: "good" }), leader(3, "Cy", { kind: "url", url: "https://e.org/broken.jpg" }), leader(4, "Dee", null)],
    { getDriveFile }
  );
  const { files, errors } = await buildPhotos(planned, {
    downloadDrive: async () => Buffer.from("drive"),
    downloadUrl: async () => {
      throw new Error("https://e.org/broken.jpg returned 404");
    },
    processImage: async bytes => Buffer.concat([bytes, Buffer.from("!")])
  });
  assert.deepEqual(files.map(file => file.bytes.toString()), ["drive!"]);
  assert.deepEqual(errors, ["Row 3 (Cy): could not use the photo (https://e.org/broken.jpg returned 404)."]);
});

test("the published document is accepted by the embed component", async () => {
  const { planned } = await planPhotos([leader(2, "Ann", { kind: "drive", id: "good" }, "board")], { getDriveFile });
  const json = serialize(leadersDocument(planned));
  const window = {};
  vm.runInNewContext(readFileSync(new URL("../component/leaders-embed.js", import.meta.url), "utf8"), { window, URL, console });
  const [parsed] = window.YCPLeaders.normalizeLeaders(JSON.parse(json), "https://josephwhite-ai.github.io/ycp/webflow/leaders.json");
  assert.match(parsed.image, /^https:\/\/josephwhite-ai\.github\.io\/ycp\/webflow\/photos\/ann-[0-9a-f]{10}\.jpg$/);
  assert.equal(parsed.group, "board");
});

test("processImage shrinks large photos to a 600px JPEG and flattens transparency", async () => {
  const big = await sharp({ create: { width: 2400, height: 1600, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0 } } }).png().toBuffer();
  const output = await processImage(big, "image/png");
  const meta = await sharp(output).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ["jpeg", 600, 400, false]);

  const small = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#888" } }).jpeg().toBuffer();
  const kept = await sharp(await processImage(small, "image/jpeg")).metadata();
  assert.deepEqual([kept.width, kept.height], [200, 300], "small photos are not enlarged");

  await assert.rejects(processImage(Buffer.from("not an image"), "image/jpeg"));
});
