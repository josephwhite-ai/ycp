const DEFAULT_BASE_URL = "https://ycp.glueup.com";
const DEFAULT_ORG_ID = "5828";

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
      response.message || response.error || "Glue Up rejected the draft create request.";
    throw new Error(message);
  }

  const data = response.data && typeof response.data === "object" ? response.data : response;
  const eventId = data.eventId != null ? String(data.eventId) : data.id != null ? String(data.id) : null;
  const redirect = data.redirect || data.url || null;
  const eventUrl = toAbsoluteUrl(redirect) || (eventId ? `${DEFAULT_BASE_URL}/events/edit/${eventId}` : null);

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
