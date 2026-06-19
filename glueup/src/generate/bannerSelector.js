// Picks the best event banner from the shared photo-library candidates using AI
// vision — *without* converting anything. It ranks Drive's server-generated JPEG
// thumbnails (which exist even for HEIC originals), so only the single chosen
// image needs a full download + HEIC->JPEG conversion downstream.

const THUMBNAIL_SIZE = 800;

// Upsizes a Drive thumbnailLink (which defaults to a tiny =s220 crop) to a more
// useful square-ish thumbnail for vision. detail:"low" downsamples anyway, so a
// few hundred px is plenty and keeps the request cheap.
function upsizeThumbnail(link) {
  if (!link) return link;
  return /=s\d+(-c)?$/.test(link) ? link.replace(/=s\d+(-c)?$/, `=s${THUMBNAIL_SIZE}`) : `${link}=s${THUMBNAIL_SIZE}`;
}

// Downloads each candidate's thumbnail as a base64 data URL for the vision call.
// Candidates without a usable thumbnail are dropped (they can't be ranked by sight)
// but reported back so the caller can fall back to a newest-first pick.
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
      withThumb.push({ candidate, dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` });
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
// candidate objects, or null when ranking was not possible (no API key, no
// thumbnails, or the model returned nothing usable).
export async function selectBannerCandidate({ drive, candidates, event, config }) {
  if (!config?.openaiApiKey) {
    return { chosen: null, reason: "no OPENAI_API_KEY; skipping AI banner ranking", ranking: [], skipped: candidates };
  }
  if (!candidates?.length) {
    return { chosen: null, reason: "no banner candidates", ranking: [], skipped: [] };
  }

  const { withThumb, skipped } = await loadThumbnails(drive, candidates);
  if (!withThumb.length) {
    return { chosen: null, reason: "no candidate thumbnails available for vision ranking", ranking: [], skipped };
  }

  const content = [
    {
      type: "input_text",
      text: JSON.stringify({
        task:
          "Choose the single best photo to use as the hero banner for this event's public web page. Prefer a recent, high-quality, horizontally-composed photo that visually represents the event or community; avoid blurry shots, screenshots, flyers/graphics with heavy text, and images dominated by a single face. Return the chosen image id and a short reason, plus a ranking of all images.",
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
    content.push({ type: "input_text", text: `Image id=${item.candidate.id} (${item.candidate.name}):` });
    content.push({ type: "input_image", image_url: item.dataUrl, detail: "low" });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.openaiModel,
      input: [
        {
          role: "system",
          content:
            "You are an art director selecting a hero banner image. You only choose from the provided images. Return strict JSON only."
        },
        { role: "user", content }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "banner_selection",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              chosenId: { type: "string" },
              ranking: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    rank: { type: "number" },
                    id: { type: "string" },
                    reason: { type: "string" }
                  },
                  required: ["rank", "id", "reason"]
                }
              }
            },
            required: ["chosenId", "ranking"]
          }
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI banner ranking failed ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const parsed = parseResponseJson(payload);
  if (!parsed?.chosenId) {
    return { chosen: null, reason: "model returned no chosenId", ranking: [], skipped };
  }

  const byId = new Map(withThumb.map((item) => [item.candidate.id, item.candidate]));
  const chosen = byId.get(parsed.chosenId) || null;
  const reason = parsed.ranking?.find((entry) => entry.id === parsed.chosenId)?.reason || "selected by AI vision ranking";
  return { chosen, reason, ranking: parsed.ranking || [], skipped };
}

// Pulls the JSON object out of a /v1/responses payload (output_text aggregation).
function parseResponseJson(payload) {
  const text =
    payload.output_text ||
    payload.output
      ?.flatMap((item) => item.content || [])
      ?.map((part) => part.text)
      ?.filter(Boolean)
      ?.join("") ||
    "";
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
