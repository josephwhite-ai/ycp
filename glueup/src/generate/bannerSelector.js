// Picks the best event banner from the shared photo-library candidates using
// Gemini vision — *without* converting anything. It ranks Drive's server-generated
// JPEG thumbnails (which exist even for HEIC originals), so only the single chosen
// image needs a full download + HEIC->JPEG conversion downstream.
//
// Ranking reuses the project's Google service account (same credential as Drive)
// to call the Gemini / Generative Language API, so no separate AI vendor key is
// required.

import { googleAccessToken, GENAI_SCOPES } from "../drive/googleDriveClient.js";

const GENAI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const THUMBNAIL_SIZE = 800;

// Upsizes a Drive thumbnailLink (which defaults to a tiny =s220 crop) to a more
// useful thumbnail for vision. Gemini Flash Lite downsamples internally, so a few
// hundred px is plenty and keeps the request small.
function upsizeThumbnail(link) {
  if (!link) return link;
  return /=s\d+(-c)?$/.test(link) ? link.replace(/=s\d+(-c)?$/, `=s${THUMBNAIL_SIZE}`) : `${link}=s${THUMBNAIL_SIZE}`;
}

// Downloads each candidate's thumbnail as base64 for the vision call. Candidates
// without a usable thumbnail are dropped (they can't be ranked by sight) but
// reported back so the caller can fall back to a newest-first pick.
async function loadThumbnails(drive, candidates) {
  const withThumb = [];
  const skipped = [];
  for (const candidate of candidates) {
    if (!candidate.thumbnailLink) {
      skipped.push(candidate);
      continue;
    }
    try {
      const bytes = await drive.downloadContentUri(upsizeThumbnail(candidate.thumbnailLink));
      withThumb.push({ candidate, base64: bytes.toString("base64") });
    } catch (error) {
      skipped.push({ ...candidate, thumbnailError: error.message });
    }
  }
  return { withThumb, skipped };
}

function eventContext(event) {
  return {
    title: event?.title || event?.name || "",
    eventType: event?.eventType || "",
    date: event?.eventDate || "",
    venue: event?.venue || "",
    description: (event?.description || "").slice(0, 600)
  };
}

// Returns { chosen, reason, ranking, skipped } where `chosen` is one of the input
// candidate objects, or null when ranking was not possible (no creds, no
// thumbnails, or the model returned nothing usable).
export async function selectBannerCandidate({ drive, candidates, event, config }) {
  if (!candidates?.length) {
    return { chosen: null, reason: "no banner candidates", ranking: [], skipped: [] };
  }

  let token;
  try {
    token = await googleAccessToken(GENAI_SCOPES);
  } catch (error) {
    return { chosen: null, reason: `no Google credentials for Gemini ranking: ${error.message}`, ranking: [], skipped: candidates };
  }

  const { withThumb, skipped } = await loadThumbnails(drive, candidates);
  if (!withThumb.length) {
    return { chosen: null, reason: "no candidate thumbnails available for vision ranking", ranking: [], skipped };
  }

  const parts = [
    {
      text: JSON.stringify({
        task:
          "Choose the single best photo to use as the hero banner for this event's public web page. Prefer a recent, high-quality, horizontally-composed photo that visually represents the event or community; avoid blurry shots, screenshots, flyers/graphics with heavy text, and images dominated by a single face. Return the chosen image id and a short reason, plus a ranking of all images. The images follow in order, each preceded by its id.",
        event: eventContext(event),
        images: withThumb.map((item, index) => ({
          index,
          id: item.candidate.id,
          name: item.candidate.name,
          folder: item.candidate.folder,
          modifiedTime: item.candidate.modifiedTime
        }))
      })
    }
  ];
  for (const item of withThumb) {
    parts.push({ text: `Image id=${item.candidate.id} (${item.candidate.name}):` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: item.base64 } });
  }

  const model = config?.geminiModel || "gemini-2.5-flash-lite";
  const response = await fetch(`${GENAI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            chosenId: { type: "STRING" },
            ranking: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  rank: { type: "NUMBER" },
                  id: { type: "STRING" },
                  reason: { type: "STRING" }
                },
                required: ["rank", "id", "reason"]
              }
            }
          },
          required: ["chosenId", "ranking"]
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini banner ranking failed ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const parsed = parseGeminiJson(payload);
  if (!parsed?.chosenId) {
    return { chosen: null, reason: "model returned no chosenId", ranking: [], skipped };
  }

  const byId = new Map(withThumb.map((item) => [item.candidate.id, item.candidate]));
  const chosen = byId.get(parsed.chosenId) || null;
  const reason = parsed.ranking?.find((entry) => entry.id === parsed.chosenId)?.reason || "selected by Gemini vision ranking";
  return { chosen, reason, ranking: parsed.ranking || [], skipped };
}

// Pulls the JSON object out of a Gemini generateContent response (the first
// candidate's concatenated text parts, which hold the responseSchema JSON).
function parseGeminiJson(payload) {
  const text = (payload.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
