import { assertNoAppError } from "./draftCreate.js";

const DEFAULT_BASE_URL = "https://ycp.glueup.com";
const DEFAULT_ORG_ID = "5828";
const DEFAULT_CAMPAIGN_TYPE = "EventInvitationCampaign";

// The campaign CSRF token is rendered into the campaigns page's raw HTML as
// <meta id="csrf-token">, mirroring the draft-create page (the SPA strips it from
// the live DOM after hydration), so it must be read fresh using the session
// cookie. Verify the page path on the first live run.
export async function fetchCampaignCsrfToken({ cookie, baseUrl = DEFAULT_BASE_URL }) {
  if (!cookie) throw new Error("Missing GLUEUP_COOKIE.");

  const url = `${baseUrl}/campaigns/list/`;
  const response = await fetch(url, {
    headers: {
      cookie,
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to load Glue Up campaigns page for CSRF token (${response.status}).`);
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

export function buildAddCampaignRequest({
  eventId,
  title,
  csrfToken,
  orgId = DEFAULT_ORG_ID,
  campaignType = DEFAULT_CAMPAIGN_TYPE
}) {
  if (!eventId) throw new Error("Missing Glue Up event ID.");
  if (!title) throw new Error("Missing campaign title.");
  if (!csrfToken) throw new Error("Missing Glue Up CSRF token.");

  // The admin UI posts AddCampaign with eventId and campaignType as plain
  // strings (not { code: ... }), and the new campaign's ID comes back in the
  // response redirect path, not the body.
  const currentPath = "/campaigns/list/";
  const body = new URLSearchParams({
    action: "AddCampaign",
    data: JSON.stringify({
      id: null,
      eventId: String(eventId),
      campaignType,
      title
    }),
    token: csrfToken,
    orgID: String(orgId),
    currentPath
  });

  return {
    method: "POST",
    url: `${DEFAULT_BASE_URL}/crm/people/ajax`,
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

// AddCampaign redirects to /events/<eventId>/promote/campaigns/<campaignId>/,
// which is the only place the new campaign ID appears.
export function parseAddCampaignResult(response) {
  assertNoAppError(response, "AddCampaign");

  const data = response.data && typeof response.data === "object" ? response.data : response;
  const redirect = response.redirect || data.redirect || data.url || null;
  const match = redirect && /\/events\/(\d+)\/promote\/campaigns\/(\d+)\//.exec(redirect);
  if (!match) {
    throw new Error(
      `Glue Up AddCampaign succeeded but no campaign ID was found in the redirect: ${JSON.stringify(response)}`
    );
  }

  const [, eventId, campaignId] = match;
  return {
    eventId,
    campaignId,
    campaignUrl: `${DEFAULT_BASE_URL}/events/${eventId}/promote/campaigns/${campaignId}/`,
    raw: response
  };
}

export async function addCampaign({
  eventId,
  title,
  csrfToken = process.env.GLUEUP_CSRF_TOKEN,
  cookie = process.env.GLUEUP_COOKIE,
  orgId = process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID,
  campaignType = DEFAULT_CAMPAIGN_TYPE
}) {
  if (!cookie) throw new Error("Missing GLUEUP_COOKIE.");

  const token = csrfToken || (await fetchCampaignCsrfToken({ cookie }));
  const request = buildAddCampaignRequest({
    eventId,
    title,
    csrfToken: token,
    orgId,
    campaignType
  });

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
    throw new Error(`Glue Up campaign create failed ${response.status}: ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Glue Up AddCampaign returned non-JSON response: ${text}`);
  }

  return parseAddCampaignResult(payload);
}
