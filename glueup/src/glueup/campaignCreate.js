const DEFAULT_BASE_URL = "https://ycp.glueup.com";
const DEFAULT_ORG_ID = "5828";
const DEFAULT_CAMPAIGN_TYPE = "EventInvitationCampaign";

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

  const currentPath = "/campaigns/list/";
  const body = new URLSearchParams({
    action: "AddCampaign",
    data: JSON.stringify({
      id: null,
      eventId: { code: String(eventId) },
      campaignType: { code: campaignType },
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

export async function addCampaign({
  eventId,
  title,
  csrfToken = process.env.GLUEUP_CSRF_TOKEN,
  cookie = process.env.GLUEUP_COOKIE,
  orgId = process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID,
  campaignType = DEFAULT_CAMPAIGN_TYPE
}) {
  if (!cookie) throw new Error("Missing GLUEUP_COOKIE.");

  const request = buildAddCampaignRequest({
    eventId,
    title,
    csrfToken,
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

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
