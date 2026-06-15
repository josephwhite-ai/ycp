export const EVENT_TYPES = [
  {
    key: "st-joseph-saturdays",
    label: "St Joseph Saturdays",
    hints: ["sjs", "st joseph saturday", "st. joseph saturday", "saint joseph saturday"],
    variants: [
      {
        key: "standard",
        label: "Standard",
        hints: [],
        glueUp: {
          eventType: "Offline",
          blueprintCode: "90664"
        }
      }
    ],
    requiredFields: ["eventName", "eventDate", "registrationUrl", "venue"]
  },
  {
    key: "executive-speaker-series",
    label: "Executive Speaker Series",
    hints: ["ess", "executive speaker series", "speaker series", "executive speaker"],
    variants: [
      {
        key: "standard",
        label: "Standard",
        hints: [],
        glueUp: {
          eventType: "Offline",
          blueprintCode: "90655"
        }
      }
    ],
    requiredFields: ["eventName", "eventDate", "registrationUrl", "venue", "speakers"]
  },
  {
    key: "executive-panel-discussion",
    label: "Executive Panel Discussion",
    hints: ["epd", "executive panel discussion", "panel discussion", "executive panel", "panel"],
    variants: [
      {
        key: "members-only",
        label: "Members Only",
        hints: ["members only", "member only", "member-exclusive", "member exclusive"],
        glueUp: {
          eventType: "Offline",
          blueprintCode: "90666"
        }
      },
      {
        key: "public",
        label: "Open to the Public",
        hints: ["open to the public", "public", "non-member", "nonmember"],
        glueUp: {
          eventType: "Offline",
          blueprintCode: "90667"
        }
      }
    ],
    requiredFields: ["eventName", "eventDate", "registrationUrl", "speakers"]
  },
  {
    key: "networking-happy-hour",
    label: "Networking Happy Hour",
    hints: ["nhh", "networking happy hour", "happy hour", "networking"],
    variants: [
      {
        key: "members-only",
        label: "Members Only",
        hints: ["members only", "member only", "member-exclusive", "member exclusive"],
        glueUp: {
          eventType: "Offline",
          blueprintCode: "90662"
        }
      },
      {
        key: "public",
        label: "Open to the Public",
        hints: ["open to the public", "public", "non-member", "nonmember"],
        glueUp: {
          eventType: "Offline",
          blueprintCode: "90663"
        }
      }
    ],
    requiredFields: ["eventName", "eventDate", "registrationUrl", "venue"]
  }
];

export function selectEventTemplate(event) {
  const explicitType =
    event.eventType ||
    event.rawFields?.["event type"] ||
    event.rawFields?.["program type"] ||
    event.rawFields?.["template"] ||
    "";
  const haystack = normalizeSearchText([
    explicitType,
    event.eventName,
    event.description,
    ...(event.sessions || []).flatMap((session) => [
      session.title,
      session.description,
      ...(session.speakers || [])
    ])
  ]);

  const scoredTypes = EVENT_TYPES.map((type) => {
    const matches = type.hints.filter((hint) => haystack.includes(hint));
    const normalizedExplicitType = normalizeSearchText([explicitType]);
    const explicitMatch =
      normalizedExplicitType &&
      (normalizedExplicitType.includes(normalize(type.label)) ||
        type.hints.includes(normalizedExplicitType))
        ? 2
        : 0;
    return {
      ...type,
      score: matches.length + explicitMatch,
      matchedHints: matches
    };
  }).sort((a, b) => b.score - a.score);

  const best = scoredTypes[0];
  const selectedType = best?.score > 0 ? best : null;
  const selectedVariant = selectedType ? selectVariant(selectedType, haystack) : null;
  const selectedGlueUp = selectedVariant?.glueUp || null;

  return {
    selected:
      selectedType && selectedVariant
        ? {
            key: selectedType.key,
            label: selectedType.label,
            variantKey: selectedVariant.key,
            variantLabel: selectedVariant.label,
            glueUp: selectedGlueUp,
            requiredFields: selectedType.requiredFields
          }
        : null,
    confidence:
      selectedType?.score >= 2 && selectedVariant?.confidence !== "needs_review"
        ? "high"
        : selectedType?.score === 1
          ? "medium"
          : "needs_review",
    candidates: scoredTypes.map(({ key, label, score, matchedHints, variants }) => ({
      key,
      label,
      score,
      matchedHints,
      variants: variants.map(({ key: variantKey, label: variantLabel, glueUp }) => ({
        key: variantKey,
        label: variantLabel,
        glueUp
      }))
    })),
    notes: selectedGlueUp?.blueprintCode
      ? []
      : ["Glue Up blueprint codes have not been configured yet for this template variant."]
  };
}

function selectVariant(type, haystack) {
  if (type.variants.length === 1) {
    return { ...type.variants[0], confidence: "high" };
  }

  const scored = type.variants
    .map((variant) => ({
      ...variant,
      score: variant.hints.filter((hint) => haystack.includes(hint)).length
    }))
    .sort((a, b) => b.score - a.score);

  if (scored[0]?.score > 0) return { ...scored[0], confidence: "high" };
  return { ...scored.find((variant) => variant.key === "public"), confidence: "default_public" };
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeSearchText(values) {
  const joined = values.filter(Boolean).join(" ");
  const words = joined
    .replace(/\bE\.?S\.?S\.?\b/gi, " ESS ")
    .replace(/\bE\.?P\.?D\.?\b/gi, " EPD ")
    .replace(/\bN\.?H\.?H\.?\b/gi, " NHH ")
    .replace(/\bS\.?J\.?S\.?\b/gi, " SJS ");
  return normalize(words);
}
