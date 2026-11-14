// Resizes leader photos to a web-friendly JPEG. Cards show photos at about 190px
// wide, so 600px covers high-density screens.
import sharp from "sharp";
import heicConvert from "heic-convert";

const SIZE = 600;

export async function processImage(bytes, mimeType = "") {
  let input = bytes;
  // iPhone photos are often HEIC, which sharp's prebuilt binaries cannot read.
  if (/hei[cf]/i.test(mimeType) || isHeic(bytes)) {
    input = Buffer.from(await heicConvert({ buffer: bytes, format: "JPEG", quality: 0.92 }));
  }
  return sharp(input, { failOn: "error" })
    .rotate() // apply the camera's orientation
    .resize({ width: SIZE, height: SIZE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }) // transparent PNGs get a white background
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

function isHeic(bytes) {
  const brand = bytes.subarray(4, 12).toString("latin1");
  return /^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand);
}
