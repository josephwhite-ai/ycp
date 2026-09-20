import { formatAgendaRange, parseEventAgenda, selectPublicAgenda } from "../extract/agenda.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function interpretEventFields({ event, config = {} }) {
  const speakerTimes = String(event?.rawSpeakerTimes || "").trim();
  const campaignSubject = String(event?.rawCampaignSubject || "").replace(/\s+/g, " ").trim();
  const sources = {
    ...(speakerTimes ? { speakerTimes } : {}),
    ...(campaignSubject ? { campaignSubject } : {})
  };
  if (!speakerTimes && !campaignSubject) return null;

  const fallback = deterministicSpeakerSchedule(speakerTimes, event?.speakers);
  if (!speakerTimes || !config.geminiApiKey) {
    return {
      campaignSubject,
      speakerSchedule: fallback,
      sources,
      methods: {
        campaignSubject: campaignSubject ? "direct" : "not_present",
        speakerSchedule: speakerTimes ? "deterministic" : "not_present"
      }
    };
  }

  try {
    const speakerSchedule = await interpretSpeakerTimesWithGemini({ event, speakerTimes, config });
    return {
      campaignSubject,
      speakerSchedule,
      sources,
      methods: {
        campaignSubject: campaignSubject ? "direct" : "not_present",
        speakerSchedule: "gemini"
      }
    };
  } catch (error) {
    return {
      campaignSubject,
      speakerSchedule: fallback,
      sources,
      methods: {
        campaignSubject: campaignSubject ? "direct" : "not_present",
        speakerSchedule: "deterministic"
      },
      warning: `Gemini speaker-time interpretation failed; used deterministic parsing. ${error.message}`
    };
  }
}

export function applyInterpretedEventFields(event, interpretedFields) {
  if (!interpretedFields) return event;
  return {
    ...event,
    ...(interpretedFields.campaignSubject ? { campaignSubject: interpretedFields.campaignSubject } : {}),
    ...(interpretedFields.speakerSchedule?.length ? { speakerSchedule: interpretedFields.speakerSchedule } : {})
  };
}

function deterministicSpeakerSchedule(value, speakers = []) {
  const knownNames = speakerNames(speakers);
  return selectPublicAgenda(parseEventAgenda(value)).map((row) => ({
    speakerName: matchKnownSpeaker(row.label, knownNames) || row.label,
    startTime: row.startTime,
    endTime: row.endTime,
    topic: ""
  })).filter((row) => row.speakerName && row.startTime);
}

function speakerNames(speakers) {
  return (Array.isArray(speakers) ? speakers : [])
    .map((speaker) => String(speaker || "").split(/,|\s+-\s+/, 1)[0].trim())
    .filter(Boolean);
}

function matchKnownSpeaker(value, names) {
  const haystack = String(value || "").toLowerCase();
  return names.find((name) => haystack.includes(name.toLowerCase())) || "";
}

async function interpretSpeakerTimesWithGemini({ event, speakerTimes, config }) {
  const knownNames = speakerNames(event?.speakers);
  const publicEventSchedule = selectPublicAgenda(event?.agenda || []).map((row) => ({
    time: formatAgendaRange(row),
    label: row.label
  }));
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
            "Interpret the supplied speaker speaking-time field into structured schedule rows. " +
            "Use 24-hour HH:mm times. Include only speakers and times explicitly supported by the field. " +
            "Match speakerName to the supplied speaker names exactly when possible. Do not invent times, speakers, or topics. " +
            "Use the public event schedule only to resolve AM/PM ambiguity. Return JSON only.\n\n" +
            JSON.stringify({
              speakerTimes,
              speakers: knownNames,
              publicEventSchedule
            })
        }]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            speakerSchedule: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  speakerName: { type: "STRING" },
                  startTime: { type: "STRING" },
                  endTime: { type: "STRING" },
                  topic: { type: "STRING" }
                },
                required: ["speakerName", "startTime", "endTime", "topic"]
              }
            }
          },
          required: ["speakerSchedule"]
        }
      }
    }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error(`Gemini returned ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response did not include output text.");
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed.speakerSchedule) ? parsed.speakerSchedule : [])
    .filter(validScheduleRow)
    .map((row) => normalizeSpeakerName(row, knownNames))
    .filter(Boolean);
}

function validScheduleRow(row) {
  return (
    row &&
    typeof row.speakerName === "string" && row.speakerName.trim() &&
    validClock(row.startTime) &&
    (row.endTime === "" || validClock(row.endTime)) &&
    typeof row.topic === "string"
  );
}

function validClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
}

function normalizeSpeakerName(row, knownNames) {
  if (!knownNames.length) return { ...row, speakerName: row.speakerName.trim() };
  const candidate = row.speakerName.trim().toLowerCase();
  const exact = knownNames.find((name) => name.toLowerCase() === candidate);
  const contained = knownNames.find((name) => candidate.includes(name.toLowerCase()));
  const speakerName = exact || contained;
  return speakerName ? { ...row, speakerName } : null;
}
