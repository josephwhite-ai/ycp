import { parseEventAgenda, selectPublicAgenda } from "../extract/agenda.js";

const DEFAULT_BASE_URL = "https://ycp.glueup.com";
const DEFAULT_ORG_ID = "5828";

function toAbsoluteUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${DEFAULT_BASE_URL}${value}`;
  return `${DEFAULT_BASE_URL}/${value}`;
}

export function assertNoAppError(response, action) {
  if (!response || typeof response !== "object") {
    throw new Error(`Glue Up ${action} returned an unexpected response.`);
  }
  const appErrors = response.data && Array.isArray(response.data.errors) ? response.data.errors : [];
  const appErrorCode = typeof response.code === "number" ? response.code : null;
  if (
    response.success === false ||
    response.status === "error" ||
    appErrors.length > 0 ||
    (appErrorCode !== null && appErrorCode >= 400)
  ) {
    const message =
      appErrors[0] ||
      response.message ||
      response.error ||
      `Glue Up rejected the ${action} request${appErrorCode ? ` (code ${appErrorCode})` : ""}.`;
    throw new Error(message);
  }
}

export function parseDraftCreateResult(response) {
  assertNoAppError(response, "draft create");

  const data = response.data && typeof response.data === "object" ? response.data : response;
  const redirect = response.redirect || data.redirect || data.url || null;
  const redirectEventId = redirect && /\/events\/(\d{3,})\//.exec(redirect)?.[1];
  const eventId =
    data.eventId != null
      ? String(data.eventId)
      : data.id != null
        ? String(data.id)
        : redirectEventId || null;
  const eventUrl = toAbsoluteUrl(redirect) || (eventId ? `${DEFAULT_BASE_URL}/events/${eventId}/dashboard/` : null);

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

// The draft-create CSRF token is rendered into the create page's raw HTML as
// <meta id="csrf-token" content="..."> and is per-form (the SPA strips it from
// the live DOM after hydration), so it must be read fresh from the create page
// for the specific event type using the session cookie.
export async function fetchCsrfToken({ cookie, eventType, baseUrl = DEFAULT_BASE_URL }) {
  if (!cookie) throw new Error("Missing GLUEUP_COOKIE.");
  if (!eventType) throw new Error("Missing eventType for CSRF token fetch.");

  const url = `${baseUrl}/events/draft/create/${eventType}`;
  const response = await fetch(url, {
    headers: {
      cookie,
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to load Glue Up create page for CSRF token (${response.status}).`);
  }

  const match =
    html.match(/<meta[^>]+id=["']csrf-token["'][^>]*\scontent=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*\sid=["']csrf-token["']/i);
  if (!match) {
    throw new Error(
      `Could not find <meta id="csrf-token"> on ${url}. The session cookie may be expired — re-run \`npm run glueup-login\`.`
    );
  }
  return match[1];
}

// "7-9PM", "7:00-9:00 PM", "6:30PM-8:30PM" -> { startTime: "19:00", endTime: "21:00" }.
// A trailing am/pm applies to both sides when only one is given.
export function parseEventTimes(event) {
  const startDate = event?.eventDate || "";
  const blank = { startDate, startTime: "", endDate: startDate, endTime: "" };
  if (!startDate) return blank;

  // The event window spans the public agenda only: internal leadership rows
  // (setup/cleanup) must not pull the start earlier or push the end later.
  const publicRows = selectPublicAgenda(parseEventAgenda(event?.rawFields?.time || ""));
  if (!publicRows.length) return blank;

  return {
    startDate,
    startTime: publicRows[0].startTime,
    endDate: startDate,
    endTime: publicRows[publicRows.length - 1].endTime
  };
}

export function buildEventSessionData({ event, blueprintCode, timezone }) {
  const title = event?.eventName || event?.sourceDocumentTitle || "Untitled event";
  const { startDate, startTime, endDate, endTime } = parseEventTimes(event);
  return {
    sessionRegistration: false,
    blueprint: String(blueprintCode),
    defaultLanguage: "en",
    "venue.timezone": { code: timezone },
    endTime,
    endDate,
    startTime,
    startDate,
    title,
    isCheckoutEnabled: false,
    memberLists: [],
    directoryVisibility: { code: "AfterPublished" },
    enableDirectory: true
  };
}

async function postDraftAction({ cookie, token, orgId, url, action, currentPath, referer, data }) {
  const body = new URLSearchParams({
    action,
    data: JSON.stringify(data),
    token,
    orgID: String(orgId),
    currentPath
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: DEFAULT_BASE_URL,
      referer,
      "x-requested-with": "XMLHttpRequest",
      cookie
    },
    body: body.toString()
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Glue Up ${action} failed ${response.status}: ${text}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Glue Up ${action} returned non-JSON response: ${text}`);
  }
  assertNoAppError(payload, action);
  return payload;
}

// Replicates the admin UI's 3-step create flow:
// AddEvent (draft shell) -> blueprintSubmit (apply template) -> EventSessionSubmit
// (sets content and actually creates the event, redirecting to /events/<id>/dashboard/).
export async function createDraftFromBlueprint({
  templateSelection,
  event,
  timezone = process.env.GLUEUP_TIMEZONE || "America/New_York",
  csrfToken = process.env.GLUEUP_CSRF_TOKEN,
  cookie = process.env.GLUEUP_COOKIE,
  orgId = process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID
}) {
  if (!cookie) throw new Error("Missing GLUEUP_COOKIE.");
  const glueUp = templateSelection?.selected?.glueUp;
  if (!glueUp?.eventType || !glueUp?.blueprintCode) {
    throw new Error("Selected template is missing Glue Up eventType or blueprintCode.");
  }
  const { eventType, blueprintCode } = glueUp;
  const token = csrfToken || (await fetchCsrfToken({ cookie, eventType }));
  const createPath = `/events/draft/create/${eventType}`;

  await postDraftAction({
    cookie,
    token,
    orgId,
    url: `${DEFAULT_BASE_URL}/events/draft/ajax`,
    action: "AddEvent",
    currentPath: "/events/draft/#Modal::AddEvent",
    referer: `${DEFAULT_BASE_URL}/events/draft/`,
    data: { id: null, eventType: { code: eventType } }
  });

  await postDraftAction({
    cookie,
    token,
    orgId,
    url: `${DEFAULT_BASE_URL}/events/draft/create/ajax`,
    action: "blueprintSubmit",
    currentPath: createPath,
    referer: `${DEFAULT_BASE_URL}${createPath}`,
    data: { eventType, blueprint: { code: blueprintCode } }
  });

  const payload = await postDraftAction({
    cookie,
    token,
    orgId,
    url: `${DEFAULT_BASE_URL}/events/draft/create/ajax`,
    action: "EventSessionSubmit",
    currentPath: `${createPath}/?blueprint=${blueprintCode}`,
    referer: `${DEFAULT_BASE_URL}${createPath}`,
    data: buildEventSessionData({ event, blueprintCode, timezone })
  });

  return parseDraftCreateResult(payload);
}
