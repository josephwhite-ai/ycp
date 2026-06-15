export async function generateArtifacts({ event, photos, config }) {
  if (config.openaiApiKey) {
    try {
      return await generateWithOpenAI({ event, photos, config });
    } catch (error) {
      return {
        ...generateDeterministicArtifacts({ event, photos }),
        generationWarning: `OpenAI generation failed; used deterministic templates instead. ${error.message}`
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

  const webpage = `# ${event.eventName || "Untitled Event"}

Template mode: use the approved Glue Up event template for ${event.eventType || "the selected event type"} and populate the fields below.

${event.description || "Event description coming soon."}

## Details

${details || "- Details coming soon."}

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
async function generateWithOpenAI({ event, photos, config }) {
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
            "You generate concise Glue Up event-template field briefs and campaign-template fill briefs from structured event data. Do not invent campaign templates or standalone email layouts. Return strict JSON only."
        },
        {
          role: "user",
          content: JSON.stringify({
            task:
              "Create a webpage field brief for filling the approved Glue Up event template, a one-week-before campaign-template fill brief, a day-before campaign-template fill brief, and rank photo recommendations. Do not write standalone email campaigns from scratch.",
            event,
            photos: photos.map((photo) => ({
              id: photo.id,
              name: photo.name,
              webViewLink: photo.webViewLink || ""
            }))
          })
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "glueup_event_artifacts",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              webpage: { type: "string" },
              emails: {
                type: "object",
                additionalProperties: false,
                properties: {
                  weekBefore: { type: "string" },
                  dayBefore: { type: "string" }
                },
                required: ["weekBefore", "dayBefore"]
              },
              photoRecommendations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    rank: { type: "number" },
                    id: { type: "string" },
                    name: { type: "string" },
                    webViewLink: { type: "string" },
                    reason: { type: "string" }
                  },
                  required: ["rank", "id", "name", "webViewLink", "reason"]
                }
              }
            },
            required: ["webpage", "emails", "photoRecommendations"]
          }
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = data.output_text || data.output?.flatMap((item) => item.content || []).find((part) => part.text)?.text;
  if (!text) throw new Error("OpenAI response did not include output text.");
  return JSON.parse(text);
}
