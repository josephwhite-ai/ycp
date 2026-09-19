import { parseEventAgenda, selectPublicAgenda, formatAgendaRange } from "../extract/agenda.js";
import { shortenEventSummary } from "./eventContent.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function generateArtifacts({ event, photos, config }) {
  if (config.geminiApiKey) {
    try {
      return await generateWithGemini({ event, photos, config });
    } catch (error) {
      return {
        ...generateDeterministicArtifacts({ event, photos }),
        generationWarning: `Gemini generation failed; used deterministic templates instead. ${error.message}`
      };
    }
  }

  return generateDeterministicArtifacts({ event, photos });
}

function generateDeterministicArtifacts({ event, photos }) {
  const hero = photos[0] || null;
  const details = [
    event.eventDate ? `- Date: ${event.eventDate}` : "",
    event.venue ? `- Venue: ${event.venue}` : "",
    event.city ? `- City: ${event.city}` : "",
    event.registrationUrl
      ? `- Registration: ${event.registrationUrl}`
      : "- Registration: to be created in Glue Up"
  ].filter(Boolean).join("\n");

  // Public agenda only: internal leadership rows (setup/cleanup) are excluded.
  // Only render a Schedule section for a real multi-item agenda, not a single
  // overall time range (which is already conveyed by the date/time fields).
  const publicRows = selectPublicAgenda(parseEventAgenda(event.rawFields?.time || ""));
  const isAgenda = publicRows.length > 1 || publicRows.some((row) => row.label);
  const scheduleSection = isAgenda
    ? `\n## Schedule\n\n${publicRows
        .map((row) => `- ${formatAgendaRange(row)}${row.label ? ` — ${row.label}` : ""}`)
        .join("\n")}\n`
    : "";

  const webpage = `# ${event.eventName || "Untitled Event"}

Template mode: use the approved Glue Up event template for ${event.eventType || "the selected event type"} and populate the fields below.

${event.description || "Event description coming soon."}

## Details

${details || "- Details coming soon."}
${scheduleSection}
## Recommended Hero Image

${hero ? `${hero.name} (${hero.webViewLink || hero.id})` : "No image found."}
`;

  const campaignTemplateBrief = `# Campaign Template Fill Brief

Do not create a campaign from scratch. Use the approved Glue Up campaign template for this event type as the starting point.

## Event Fields

- Event name: ${event.eventName || "TBD"}
- Event date: ${event.eventDate || "TBD"}
${event.venue ? `- Venue: ${event.venue}` : ""}
${event.city ? `- City: ${event.city}` : ""}
- Event page URL: to be created after the Glue Up event draft exists

## Source Summary

${event.description || ""}
`;

  return {
    webpage,
    campaignSummary: shortenEventSummary(event.description),
    emails: {
      weekBefore: campaignTemplateBrief,
      dayBefore: campaignTemplateBrief
    },
    photoRecommendations: photos.slice(0, 8).map((photo, index) => ({
      rank: index + 1,
      id: photo.id,
      name: photo.name,
      webViewLink: photo.webViewLink || ""
    }))
  };
}

async function generateWithGemini({ event, photos, config }) {
  // Sanitize the agenda before sending it to the model: expose only the public
  // schedule and strip internal leadership rows from the raw time block so they
  // can never surface in generated public copy.
  const publicRows = selectPublicAgenda(parseEventAgenda(event.rawFields?.time || ""));
  const publicSchedule = publicRows.map((row) => ({
    time: formatAgendaRange(row),
    label: row.label
  }));
  const sanitizedEvent = publicRows.length
    ? {
        ...event,
        rawFields: {
          ...event.rawFields,
          time: publicRows.map((row) => `${formatAgendaRange(row)} ${row.label}`.trim()).join("\n")
        },
        publicSchedule
      }
    : { ...event, publicSchedule };

  const response = await fetch(`${GEMINI_BASE}/models/${config.geminiModel}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiApiKey
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{
          text:
            "Generate concise Glue Up event-template field briefs from the supplied structured event data. " +
            "Do not invent facts, campaign templates, or standalone email layouts. The campaignSummary must be " +
            "a self-contained, inviting plain-text condensation of the source event description, normally 40-80 words " +
            "and never longer than the source; do not pad a short source or add facts. It must be " +
            "suitable as the main body of an invitation email. Return only the requested JSON.\n\n" +
            JSON.stringify({
              task:
                "Create a webpage field brief, a shortened campaign summary, one-week-before and day-before campaign-template fill briefs, and ranked photo recommendations. For any schedule or agenda, use only event.publicSchedule; never include internal setup, cleanup, or leadership-team items.",
              event: sanitizedEvent,
              photos: photos.map((photo) => ({
                id: photo.id,
                name: photo.name,
                webViewLink: photo.webViewLink || ""
              }))
            })
        }]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            webpage: { type: "STRING" },
            campaignSummary: { type: "STRING" },
            emails: {
              type: "OBJECT",
              properties: {
                weekBefore: { type: "STRING" },
                dayBefore: { type: "STRING" }
              },
              required: ["weekBefore", "dayBefore"]
            },
            photoRecommendations: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  rank: { type: "NUMBER" },
                  id: { type: "STRING" },
                  name: { type: "STRING" },
                  webViewLink: { type: "STRING" },
                  reason: { type: "STRING" }
                },
                required: ["rank", "id", "name", "webViewLink", "reason"]
              }
            }
          },
          required: ["webpage", "campaignSummary", "emails", "photoRecommendations"]
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response did not include output text.");
  const generated = JSON.parse(text);
  return {
    ...generated,
    campaignSummary: shortenEventSummary(generated.campaignSummary || event.description)
  };
}
