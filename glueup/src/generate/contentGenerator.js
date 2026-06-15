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
  const sessionLines = event.sessions?.length
    ? event.sessions
        .map((session) => {
          const speakers = session.speakers?.length ? ` (${session.speakers.join(", ")})` : "";
          return `- ${session.time ? `${session.time}: ` : ""}${session.title}${speakers}`;
        })
        .join("\n")
    : "- Agenda details coming soon.";

  const webpage = `# ${event.eventName || "Untitled Event"}

Template mode: use the approved Glue Up template for ${event.eventType || "the selected event type"} and populate the fields below.

${event.description || "Event description coming soon."}

## Details

- Date: ${event.eventDate || "TBD"}
- Venue: ${event.venue || "TBD"}
- City: ${event.city || "TBD"}
- Registration: ${event.registrationUrl || "TBD"}

## Program

${sessionLines}

## Recommended Hero Image

${hero ? `${hero.name} (${hero.webViewLink || hero.id})` : "No image found."}
`;

  const weekEmail = `Subject: Join us for ${event.eventName || "our upcoming event"}

Hi,

You're invited to ${event.eventName || "our upcoming event"}${event.eventDate ? ` on ${event.eventDate}` : ""}.

${event.description || ""}

Register here: ${event.registrationUrl || "[registration link needed]"}
`;

  const dayBeforeEmail = `Subject: Tomorrow: ${event.eventName || "event reminder"}

Hi,

This is a quick reminder that ${event.eventName || "the event"} is tomorrow.

${event.venue ? `Location: ${event.venue}` : ""}
${event.registrationUrl ? `Details and registration: ${event.registrationUrl}` : ""}
`;

  return {
    webpage,
    emails: {
      weekBefore: weekEmail,
      dayBefore: dayBeforeEmail
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
            "You generate concise Glue Up webpage and email campaign drafts from structured event data. Return strict JSON only."
        },
        {
          role: "user",
          content: JSON.stringify({
            task:
              "Create a webpage markdown draft, a one-week-before email, a day-before email, and rank photo recommendations.",
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
