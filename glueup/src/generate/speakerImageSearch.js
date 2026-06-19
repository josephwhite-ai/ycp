const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const GENERIC_COMPANY_WORDS = new Set([
  "and", "company", "corporation", "financial", "group", "inc", "llc", "partners", "services", "solutions", "the"
]);
const PROFESSIONAL_PROFILE_RE = /(^|\.)(linkedin\.com|crunchbase\.com|bloomberg\.com)$/i;

// Best-effort speaker-photo fallback. Tavily ties images to corroborating source
// pages; metadata establishes identity, then Gemini checks only whether the image
// is plausibly a single-person professional headshot.
export async function findSpeakerHeadshot({ speaker }) {
  const tavilyApiKey = process.env.TAVILY_API_KEY || "";
  const geminiApiKey = process.env.GEMINI_API_KEY || "";
  if (!tavilyApiKey || !geminiApiKey || !speaker?.fullName) return null;

  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tavilyApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: buildSpeakerImageQuery(speaker),
        search_depth: "basic",
        max_results: 5,
        include_images: true,
        include_image_descriptions: true,
        exact_match: true
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      console.log(`Tavily image search skipped for "${speaker.fullName}": API returned ${response.status}.`);
      return null;
    }

    const payload = await response.json();
    const candidates = buildCandidates(payload.results || [], speaker);
    if (!candidates.length) {
      console.log(`Tavily found no high-confidence source page for "${speaker.fullName}".`);
      return null;
    }

    for (const candidate of candidates) {
      const image = await downloadCandidate(candidate.url).catch((error) => {
        console.log(`Could not download image candidate for "${speaker.fullName}": ${error.message}`);
        return null;
      });
      if (!image || !isSuitableDimensions(image.dimensions)) continue;

      const plausibility = await checkHeadshotPlausibility({
        bytes: image.bytes,
        mime: image.mime,
        speaker,
        candidate,
        apiKey: geminiApiKey
      });
      if (!plausibility.accepted) continue;

      return {
        bytes: image.bytes,
        ext: image.ext,
        sourceUrl: candidate.url,
        contextUrl: candidate.contextUrl,
        confidence: {
          ...candidate.confidence,
          reasons: [...candidate.confidence.reasons, `Gemini: ${plausibility.reason}`]
        }
      };
    }
  } catch (error) {
    console.log(`Tavily image search skipped for "${speaker.fullName}": ${error.message}`);
  }
  return null;
}

export function buildSpeakerImageQuery(speaker) {
  const parts = [`"${String(speaker.fullName).trim()}"`];
  if (speaker.position) parts.push(String(speaker.position).trim());
  if (speaker.company) parts.push(String(speaker.company).trim());
  return parts.filter(Boolean).join(" ");
}

export function assessCandidateConfidence(result, speaker) {
  const name = normalizeText(speaker.fullName);
  const nameTokens = tokens(speaker.fullName);
  const lastName = normalizeText(speaker.lastName || nameTokens.at(-1));
  const companyTokens = meaningfulCompanyTokens(speaker.company);
  const positionTokens = tokens(speaker.position).filter((token) => token.length >= 4);
  const evidence = normalizeText([result.title, result.content, result.url].filter(Boolean).join(" "));
  const host = safeHostname(result.url);

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

function buildCandidates(results, speaker) {
  const candidates = [];
  for (const result of results) {
    const confidence = assessCandidateConfidence(result, speaker);
    if (!confidence.high) continue;
    for (const image of result.images || []) {
      const url = typeof image === "string" ? image : image?.url;
      if (!/^https?:\/\//i.test(String(url || ""))) continue;
      const description = typeof image === "string" ? "" : image.description || "";
      candidates.push({
        url,
        description,
        contextUrl: result.url,
        sourceTitle: result.title || "",
        confidence,
        relevance: imageRelevance({ url, description, sourceTitle: result.title }, speaker)
      });
    }
  }
  return candidates
    .sort((a, b) => b.confidence.score - a.confidence.score || b.relevance - a.relevance)
    .slice(0, 10);
}

function imageRelevance(candidate, speaker) {
  const evidence = normalizeText([candidate.url, candidate.description, candidate.sourceTitle].join(" "));
  const nameMatches = tokens(speaker.fullName).filter((token) => evidence.includes(token)).length;
  const portraitHint = /headshot|portrait|profile|team|staff|bio/.test(evidence) ? 2 : 0;
  const logoPenalty = /logo|icon|banner|favicon/.test(evidence) ? 4 : 0;
  return nameMatches * 2 + portraitHint - logoPenalty;
}

async function checkHeadshotPlausibility({ bytes, mime, speaker, candidate, apiKey }) {
  try {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const response = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            {
              text:
                `Assess this candidate image for ${speaker.fullName}. ` +
                `The source page is "${candidate.sourceTitle}" (${candidate.contextUrl}). ` +
                "Accept only a clear, professional image dominated by one identifiable adult person's face and upper body. " +
                "Reject groups, logos, graphics, screenshots, full-page images, low-quality images, and photos where the person is too small. " +
                "Do not claim to verify identity; metadata handles identity."
            },
            { inline_data: { mime_type: mime, data: bytes.toString("base64") } }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              accepted: { type: "BOOLEAN" },
              reason: { type: "STRING" }
            },
            required: ["accepted", "reason"]
          }
        }
      }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) return { accepted: false, reason: `Gemini returned ${response.status}` };
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text || "{}");
    return { accepted: parsed.accepted === true, reason: String(parsed.reason || "no reason") };
  } catch (error) {
    return { accepted: false, reason: error.message };
  }
}

async function downloadCandidate(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; YCPGlueUpPrepare/1.0)" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("image exceeds 8 MB limit");
  const bytes = await readLimitedBody(response, MAX_IMAGE_BYTES);
  const ext = sniffDownloadedImage(bytes);
  if (!ext) throw new Error("downloaded bytes are not a supported image");
  const mime = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext];
  return { bytes, ext, mime, dimensions: imageDimensions(bytes, ext) };
}

function isSuitableDimensions(dimensions) {
  if (!dimensions) return false;
  const aspect = dimensions.width / dimensions.height;
  return dimensions.width >= 200 && dimensions.height >= 200 && aspect >= 0.55 && aspect <= 1.35;
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
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
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

function imageDimensions(bytes, ext) {
  if (ext === "png" && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (ext === "jpg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (ext === "webp" && bytes.toString("ascii", 12, 16) === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3)
    };
  }
  return null;
}
