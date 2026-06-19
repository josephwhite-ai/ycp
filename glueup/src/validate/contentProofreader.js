const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Reviews public-facing structured fields and generated copy for clear typos.
// It reports issues but never rewrites source text automatically.
export async function proofreadEventContent({ event, speakers = [], artifacts = {}, config = {} }) {
  if (!config.geminiApiKey) {
    return { status: "skipped", reason: "GEMINI_API_KEY is not configured", issues: [] };
  }

  const reviewInput = {
    eventName: event.eventName || "",
    description: event.description || "",
    venue: event.venue || "",
    city: event.city || "",
    speakers: speakers.map(({ fullName, position, company }) => ({ fullName, position, company })),
    webpage: String(artifacts.webpage || "").slice(0, 12_000),
    emailWeekBefore: String(artifacts.emails?.weekBefore || "").slice(0, 8_000),
    emailDayBefore: String(artifacts.emails?.dayBefore || "").slice(0, 8_000)
  };

  try {
    const response = await fetch(`${GEMINI_BASE}/models/${config.geminiModel}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.geminiApiKey },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text:
              "Proofread this public event content for clear typographical, spelling, agreement, and grammar errors. " +
              "Be conservative: do not flag style preferences, curly punctuation, unusual but plausible proper names, " +
              "theological phrasing, or job titles merely because they are uncommon. Do flag an awkward singular/plural " +
              "or word-form error in a professional title when confidence is high. Never rewrite the content wholesale. " +
              "For each issue, quote the shortest exact original text, provide a minimal correction, identify its field, " +
              "and explain briefly. Return no issue when uncertain.\n\n" + JSON.stringify(reviewInput)
          }]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              issues: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    field: { type: "STRING" },
                    original: { type: "STRING" },
                    suggestion: { type: "STRING" },
                    reason: { type: "STRING" },
                    confidence: { type: "STRING", enum: ["HIGH", "MEDIUM"] }
                  },
                  required: ["field", "original", "suggestion", "reason", "confidence"]
                }
              }
            },
            required: ["issues"]
          }
        }
      }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok) {
      return { status: "skipped", reason: `Gemini returned ${response.status}`, issues: [] };
    }
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text || "{}");
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(validIssue) : [];
    return { status: "completed", reviewedAt: new Date().toISOString(), issues };
  } catch (error) {
    return { status: "skipped", reason: error.message, issues: [] };
  }
}

function validIssue(issue) {
  return (
    issue &&
    ["HIGH", "MEDIUM"].includes(issue.confidence) &&
    [issue.field, issue.original, issue.suggestion, issue.reason].every((value) => typeof value === "string" && value.trim())
  );
}
