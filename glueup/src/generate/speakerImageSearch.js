const SEARCH_URL = "https://www.googleapis.com/customsearch/v1";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const GENERIC_COMPANY_WORDS = new Set([
  "and", "company", "corporation", "financial", "group", "inc", "llc", "partners", "services", "the"
]);
const PROFESSIONAL_PROFILE_RE = /(^|\.)(linkedin\.com|crunchbase\.com|bloomberg\.com)$/i;

// Best-effort Google Custom Search image fallback. Search failures, quota limits,
// unsuitable results, and download failures all return null so prepare can keep
// the default Glue Up avatar.
export async function findSpeakerHeadshot({ speaker }) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY || "";
  const cx = process.env.GOOGLE_CSE_CX || "";
  if (!apiKey || !cx || !speaker?.fullName) return null;

  const query = buildSpeakerImageQuery(speaker);
  const url = new URL(SEARCH_URL);
  url.search = new URLSearchParams({
    key: apiKey,
    cx,
    searchType: "image",
    num: "5",
    q: query
  });

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      console.log(`Google image search skipped for "${speaker.fullName}": API returned ${response.status}.`);
      return null;
    }

    const payload = await response.json();
    const candidates = (payload.items || [])
      .filter(isSuitableCandidate)
      .map((item) => ({ item, confidence: assessCandidateConfidence(item, speaker) }))
      .filter(({ confidence }) => confidence.high)
      .sort(
        (a, b) =>
          b.confidence.score - a.confidence.score ||
          candidateVisualScore(b.item) - candidateVisualScore(a.item)
      );
    if (!candidates.length) {
      console.log(`Google image search found no high-confidence result for "${speaker.fullName}".`);
      return null;
    }

    for (const { item, confidence } of candidates) {
      const image = await downloadCandidate(item).catch((error) => {
        console.log(`Could not download image candidate for "${speaker.fullName}": ${error.message}`);
        return null;
      });
      if (image) {
        return {
          ...image,
          sourceUrl: item.link,
          contextUrl: item.image?.contextLink || "",
          confidence
        };
      }
    }
  } catch (error) {
    console.log(`Google image search skipped for "${speaker.fullName}": ${error.message}`);
  }
  return null;
}

export function buildSpeakerImageQuery(speaker) {
  const parts = [`"${String(speaker.fullName).trim()}"`];
  if (speaker.position) parts.push(String(speaker.position).trim());
  if (speaker.company) parts.push("at", String(speaker.company).trim());
  return parts.filter(Boolean).join(" ");
}

// Identity confidence comes from search-result metadata, not facial recognition.
// Strong company corroboration is preferred; an exact distinctive name on a
// professional profile is also accepted when company metadata is unavailable.
export function assessCandidateConfidence(item, speaker) {
  const name = normalizeText(speaker.fullName);
  const nameTokens = tokens(speaker.fullName);
  const lastName = normalizeText(speaker.lastName || nameTokens.at(-1));
  const companyTokens = meaningfulCompanyTokens(speaker.company);
  const positionTokens = tokens(speaker.position).filter((token) => token.length >= 4);
  const evidence = normalizeText([
    item.title,
    item.snippet,
    item.displayLink,
    item.image?.contextLink,
    item.link
  ].filter(Boolean).join(" "));
  const host = safeHostname(item.image?.contextLink || item.displayLink || item.link);

  const exactName = Boolean(name && evidence.includes(name));
  const allNameTokens = nameTokens.length >= 2 && nameTokens.every((token) => evidence.includes(token));
  const companyMatches = companyTokens.filter((token) => evidence.includes(token));
  const companyMatch = companyTokens.length > 0 && companyMatches.length === companyTokens.length;
  const positionMatches = positionTokens.filter((token) => evidence.includes(token));
  const professionalProfile = PROFESSIONAL_PROFILE_RE.test(host);
  const distinctiveLastName = lastName.length >= 8;

  let score = exactName ? 5 : allNameTokens ? 4 : 0;
  if (companyMatch) score += 4;
  else if (companyMatches.length) score += 2;
  if (positionMatches.length >= Math.min(2, positionTokens.length) && positionMatches.length) score += 1;
  if (professionalProfile) score += 1;

  const high =
    (exactName && companyMatch) ||
    (allNameTokens && companyMatch && score >= 8) ||
    (exactName && distinctiveLastName && professionalProfile && score >= 6);
  const reasons = [];
  if (exactName) reasons.push("exact name match");
  else if (allNameTokens) reasons.push("all name tokens match");
  if (companyMatch) reasons.push(`company match (${companyMatches.join(", ")})`);
  if (positionMatches.length) reasons.push(`position match (${positionMatches.join(", ")})`);
  if (professionalProfile) reasons.push(`professional profile (${host})`);

  return { level: high ? "high" : "low", high, score, reasons };
}

function isSuitableCandidate(item) {
  const mime = String(item?.mime || "").toLowerCase();
  const width = Number(item?.image?.width || 0);
  const height = Number(item?.image?.height || 0);
  const aspect = width / height;
  return Boolean(item?.link) && ALLOWED_MIME.has(mime) && width >= 200 && height >= 200 && aspect >= 0.55 && aspect <= 1.35;
}

function candidateVisualScore(item) {
  const width = Number(item.image.width);
  const height = Number(item.image.height);
  const aspect = width / height;
  const portraitBonus = aspect <= 1 ? 300_000 : 0;
  const jpegBonus = item.mime === "image/jpeg" ? 100_000 : 0;
  return Math.min(width * height, 4_000_000) + portraitBonus + jpegBonus - Math.abs(aspect - 0.8) * 100_000;
}

function meaningfulCompanyTokens(value) {
  const all = tokens(value);
  const meaningful = all.filter((token) => token.length >= 3 && !GENERIC_COMPANY_WORDS.has(token));
  return meaningful.length ? meaningful : all.filter((token) => token.length >= 4);
}

function tokens(value) {
  return normalizeText(value).split(" ").filter(Boolean);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeHostname(value) {
  try {
    const url = /^https?:\/\//i.test(String(value || "")) ? value : `https://${value}`;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function downloadCandidate(candidate) {
  const response = await fetch(candidate.link, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; YCPGlueUpPrepare/1.0)" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  if (!ALLOWED_MIME.has(contentType)) throw new Error(`unexpected content type ${contentType || "unknown"}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("image exceeds 8 MB limit");

  const bytes = await readLimitedBody(response, MAX_IMAGE_BYTES);
  const ext = sniffDownloadedImage(bytes);
  if (!ext) throw new Error("downloaded bytes are not a supported image");
  return { bytes, ext };
}

async function readLimitedBody(response, limit) {
  if (!response.body) throw new Error("empty response body");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error("image exceeds 8 MB limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
}

function sniffDownloadedImage(bytes) {
  if (bytes?.[0] === 0xff && bytes?.[1] === 0xd8 && bytes?.[2] === 0xff) return "jpg";
  if (bytes?.[0] === 0x89 && bytes?.[1] === 0x50 && bytes?.[2] === 0x4e && bytes?.[3] === 0x47) return "png";
  if (bytes?.toString("ascii", 0, 4) === "RIFF" && bytes?.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
