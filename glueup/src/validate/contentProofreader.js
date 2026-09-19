import { SPECIAL_VALIDATION_RULES, specialRulePromptData } from "./specialValidationRules.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Reviews public-facing structured fields and generated copy for clear typos.
// It reports issues but never rewrites source text automatically.
export async function proofreadEventContent({ event, speakers = [], artifacts = {}, rendered = {}, config = {} }) {
  if (!config.geminiApiKey) {
    return { status: "skipped", reason: "GEMINI_API_KEY is not configured", issues: [], specialRuleResults: [] };
  }

  const reviewInput = {
    eventName: event.eventName || "",
    description: event.description || "",
    venue: event.venue || "",
    city: event.city || "",
    speakers: speakers.map(({ fullName, position, company }) => ({ fullName, position, company })),
    webpage: String(artifacts.webpage || "").slice(0, 12_000),
    emailWeekBefore: String(artifacts.emails?.weekBefore || "").slice(0, 8_000),
    emailDayBefore: String(artifacts.emails?.dayBefore || "").slice(0, 8_000),
    // The actual published strings (tags stripped) so the review covers what
    // populate transfers, not just the source fields and briefs.
    publishedSummary: htmlToText(rendered.summaryHtml),
    publishedSchedule: htmlToText(rendered.pageScheduleHtml),
    publishedCampaignSummary: htmlToText(rendered.campaignSummaryHtml),
    publishedCampaignSpeakers: htmlToText(rendered.campaignSpeakersHtml)
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
              "and explain briefly. Return no issue when uncertain. Separately evaluate EVERY special validation rule below. " +
              "For each rule, return exactly one ruleResults entry with applies=true when the content semantically refers " +
              "to the rule's subject even through abbreviations or alternate wording. Set passes=false if any applicable " +
              "public-facing reference violates the instruction. Do not use spelling-pattern heuristics alone; evaluate " +
              "the meaning and identity of the referenced place or entity.\n\n" +
              JSON.stringify({ content: reviewInput, specialValidationRules: specialRulePromptData() })
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
              },
              ruleResults: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    ruleId: { type: "STRING" },
                    applies: { type: "BOOLEAN" },
                    passes: { type: "BOOLEAN" },
                    field: { type: "STRING" },
                    original: { type: "STRING" },
                    suggestion: { type: "STRING" },
                    reason: { type: "STRING" }
                  },
                  required: ["ruleId", "applies", "passes", "field", "original", "suggestion", "reason"]
                }
              }
            },
            required: ["issues", "ruleResults"]
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
    const sourceText = JSON.stringify(reviewInput);
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((issue) => validIssue(issue, sourceText))
      : [];
    const knownRuleIds = new Set(SPECIAL_VALIDATION_RULES.map((rule) => rule.id));
    const specialRuleResults = Array.isArray(parsed.ruleResults)
      ? parsed.ruleResults.filter((result) => validRuleResult(result, knownRuleIds))
      : [];
    return { status: "completed", reviewedAt: new Date().toISOString(), issues, specialRuleResults };
  } catch (error) {
    return { status: "skipped", reason: error.message, issues: [], specialRuleResults: [] };
  }
}

function validRuleResult(result, knownRuleIds) {
  return (
    result &&
    knownRuleIds.has(result.ruleId) &&
    typeof result.applies === "boolean" &&
    typeof result.passes === "boolean" &&
    [result.field, result.original, result.suggestion, result.reason].every((value) => typeof value === "string")
  );
}

// Strips HTML tags/entities so the proofreader reviews prose, not markup.
function htmlToText(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function validIssue(issue, sourceText) {
  return (
    issue &&
    ["HIGH", "MEDIUM"].includes(issue.confidence) &&
    [issue.field, issue.original, issue.suggestion, issue.reason].every((value) => typeof value === "string" && value.trim()) &&
    sourceText.includes(issue.original) &&
    canonicalCorrection(issue.original) !== canonicalCorrection(issue.suggestion) &&
    meaningfulWords(issue.original) !== meaningfulWords(issue.suggestion)
  );
}

function meaningfulWords(value) {
  const connectors = new Set(["a", "an", "and", "or", "the", "to"]);
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !connectors.has(word))
    .sort()
    .join("|");
}

// Spacing, punctuation, and capitalization-only changes are style edits rather
// than typo corrections and must never block publication.
function canonicalCorrection(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
