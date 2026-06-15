const DEFAULT_BASE_URL = "https://ycp.glueup.com";
const DEFAULT_ORG_ID = "5828";

function asString(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && value.code != null) return String(value.code);
  return null;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return null;
}

function toAbsoluteUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${DEFAULT_BASE_URL}${value}`;
  return `${DEFAULT_BASE_URL}/${value}`;
}

export function parseDraftCreateResult(response) {
  if (!response || typeof response !== "object") {
    throw new Error("Glue Up draft create returned an unexpected response.");
  }

  if (response.success === false || response.status === "error") {
    const message =
      response.message ||
      response.error ||
      response.errors?.join?.(", ") ||
      "Glue Up rejected the draft create request.";
    throw new Error(message);
  }

  const data = response.data && typeof response.data === "object" ? response.data : response;
  const eventId = firstString(
    data.eventId,
    data.id,
    data.event?.id,
    data.event?.code,
    data.code,
    response.eventId,
    response.id
  );

  const redirectOrUrl = firstString(
    data.redirect,
    data.url,
    data.eventUrl,
    data.editUrl,
    response.redirect,
    response.url
  );

  const eventUrl = toAbsoluteUrl(redirectOrUrl) || (eventId ? `${DEFAULT_BASE_URL}/events/edit/${eventId}` : null);

  if (!eventId && !eventUrl) {
    throw new Error(
      `Glue Up draft create succeeded but no event ID or URL was found in the response: ${JSON.stringify(response)}`
    );
  }

  return {
    eventId,
    eventUrl,
    raw: response
  };
}

export function buildDraftCreateRequest({ templateSelection, csrfToken, orgId = DEFAULT_ORG_ID }) {
  const selected = templateSelection?.selected;
  const glueUp = selected?.glueUp;
  if (!glueUp?.eventType || !glueUp?.blueprintCode) {
    throw new Error("Selected template is missing Glue Up eventType or blueprintCode.");
  }
  if (!csrfToken) {
    throw new Error("Missing Glue Up CSRF token.");
  }

  const currentPath = `/events/draft/create/${glueUp.eventType}`;
  const body = new URLSearchParams({
    action: "blueprintSubmit",
    data: JSON.stringify({
      eventType: glueUp.eventType,
      blueprint: {
        code: glueUp.blueprintCode
      }
    }),
    token: csrfToken,
    orgID: String(orgId),
    currentPath
  });

  return {
    method: "POST",
    url: `${DEFAULT_BASE_URL}/events/draft/create/ajax`,
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: DEFAULT_BASE_URL,
      referer: `${DEFAULT_BASE_URL}${currentPath}`,
      "x-requested-with": "XMLHttpRequest"
    },
    body: body.toString()
  };
}

export async function createDraftFromBlueprint({
  templateSelection,
  csrfToken = process.env.GLUEUP_CSRF_TOKEN,
  cookie = process.env.GLUEUP_COOKIE,
  orgId = process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID
}) {
  if (!cookie) throw new Error("Missing GLUEUP_COOKIE.");
  const request = buildDraftCreateRequest({ templateSelection, csrfToken, orgId });
  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      ...request.headers,
      cookie
    },
    body: request.body
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Glue Up draft create failed ${response.status}: ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Glue Up draft create returned non-JSON response: ${text}`);
  }

  return parseDraftCreateResult(payload);
}
