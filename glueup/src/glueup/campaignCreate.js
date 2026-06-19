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

function campaignPath({ eventId, campaignId }) {
  if (!eventId) throw new Error("Missing Glue Up event ID.");
  if (!campaignId) throw new Error("Missing Glue Up campaign ID.");
  return `/events/${eventId}/promote/campaigns/${campaignId}/`;
}

async function postCampaignAction({
  eventId,
  campaignId,
  action,
  data,
  csrfToken = process.env.GLUEUP_CSRF_TOKEN,
  cookie = process.env.GLUEUP_COOKIE,
  orgId = process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID
}) {
  if (!cookie) throw new Error("Missing GLUEUP_COOKIE.");
  if (!action) throw new Error("Missing Glue Up campaign action.");
  const token = csrfToken || (await fetchCampaignCsrfToken({ cookie }));
  const currentPath = campaignPath({ eventId, campaignId });
  const body = new URLSearchParams({
    action,
    data: JSON.stringify(data || {}),
    token,
    orgID: String(orgId),
    currentPath
  });

  const response = await fetch(`${DEFAULT_BASE_URL}${currentPath}ajax`, {
    method: "POST",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: DEFAULT_BASE_URL,
      referer: `${DEFAULT_BASE_URL}${currentPath}`,
      "x-requested-with": "XMLHttpRequest",
      cookie
    },
    body: body.toString()
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Glue Up campaign ${action} failed ${response.status}: ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Glue Up campaign ${action} returned non-JSON response: ${text}`);
  }
  assertNoAppError(payload, action);
  return payload;
}

function rewriteEventIdKeys(value, eventId) {
  if (Array.isArray(value)) return value.map((item) => rewriteEventIdKeys(item, eventId));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key.replace(/eventID=\d+/g, `eventID=${eventId}`),
      rewriteEventIdKeys(val, eventId)
    ])
  );
}

function setupPayloadForCampaign(action, payload, { eventId, event, campaign }) {
  const data = rewriteEventIdKeys(structuredClone(payload), eventId);
  if (action === "negativeFiltersStandardFormSubmit") {
    for (const key of Object.keys(data)) {
      if (key.startsWith(`Invitees?eventID=${eventId}`)) data[key] = false;
      if (key === `Attendees?eventID=${eventId}&status=all`) data[key] = true;
    }
  }
  if (data?.setup) {
    data.setup.subject = event?.eventName || data.setup.subject;
    data.setup.campaignName = campaign?.title || data.setup.campaignName;
  }
  return data;
}

function eventPreheader(event) {
  const title = event?.eventName || event?.sourceDocumentTitle || "our next event";
  return `Join us for ${title}.`;
}

export function buildDefaultCampaignSetupPayloads({ eventId, event, campaign, speakersHtml } = {}) {
  if (!eventId) throw new Error("Missing Glue Up event ID.");
  const title = event?.eventName || event?.sourceDocumentTitle || "Event";
  // Email body blocks. The optional speakers block (built by the caller from the
  // event's parsed speakers) is inserted after the event summary so invitees see
  // who is presenting.
  const contentBlocks = [
    { type: "organizationLogo", "value.size": "S", "value.alignment": "Left" },
    { type: "detailsHeader" },
    { type: "html", value: "<p>Dear [givenName,fallback=Subscriber],</p>" },
    { type: "summary" },
    ...(speakersHtml ? [{ type: "html", value: speakersHtml }] : []),
    { type: "rsvp" },
    {
      type: "sponsors",
      "value.groups.6a3096bae4b07b64411cbe1b": true,
      "value.showTitle": false
    }
  ];
  const payloads = [
    {
      action: "recipientFiltersStandardFormSubmit",
      data: {
        "OrganizationMembers?status=Accepted": false,
        "Members?isSmartList=true&listID=16108": false,
        "Members?isPurchaser=true&status=Active": false,
        "Members?isPrimary=true&status=Active": false,
        "Members?status=Active": false,
        "Subscribers?listID=32924": false,
        [`Attendees?eventID=${eventId}&isCanceled=true`]: false,
        [`Attendees?eventID=${eventId}&isCheckedIn=false`]: false,
        [`Attendees?eventID=${eventId}&isCheckedIn=true`]: false,
        [`Attendees?eventID=${eventId}&status=Waitlist`]: false,
        [`Attendees?eventID=${eventId}&status=AwaitingApproval`]: false,
        [`Attendees?eventID=${eventId}&status=all`]: false,
        [`Invitees?eventID=${eventId}&status=NoResponse`]: false,
        [`Invitees?eventID=${eventId}&status=NotSent`]: false,
        [`Invitees?eventID=${eventId}`]: false,
        "::ignore::": [true, true],
        Contacts: true
      }
    },
    {
      action: "negativeFiltersStandardFormSubmit",
      data: {
        "OrganizationMembers?status=Accepted": false,
        "Members?isSmartList=true&listID=16108": false,
        "Members?isPurchaser=true&status=Active": false,
        "Members?isPrimary=true&status=Active": false,
        "Members?status=Active": false,
        "Subscribers?listID=32924": false,
        [`Attendees?eventID=${eventId}&isCanceled=true`]: false,
        [`Attendees?eventID=${eventId}&isCheckedIn=false`]: false,
        [`Attendees?eventID=${eventId}&isCheckedIn=true`]: false,
        [`Attendees?eventID=${eventId}&status=Waitlist`]: false,
        [`Attendees?eventID=${eventId}&status=AwaitingApproval`]: false,
        [`Attendees?eventID=${eventId}&status=all`]: true,
        [`Invitees?eventID=${eventId}&status=NoResponse`]: false,
        [`Invitees?eventID=${eventId}&status=NotSent`]: false,
        [`Invitees?eventID=${eventId}`]: false,
        "Individual?isSubscriber=true": false,
        "Individual?isWorkingGroup=true": false,
        Contacts: false
      }
    },
    {
      action: "SetupCampaignFormSubmit",
      data: {
        setup: {
          type: DEFAULT_CAMPAIGN_TYPE,
          ccToAssistant: false,
          additionalRecipients: "",
          replyTo: "",
          senderEmail: { code: "64c87d4ce4b050224d5a75b0" },
          preheader: eventPreheader(event),
          subject: title,
          language: { code: "en" },
          campaignName: campaign?.title || title
        },
        submit: "save_and_continue"
      }
    },
    {
      action: "ContentFormSubmit",
      data: {
        blocks: contentBlocks,
        submit: "save_and_continue"
      }
    }
  ];

  return payloads.map(({ action, data }) => ({
    action,
    data: setupPayloadForCampaign(action, data, { eventId, event, campaign })
  }));
}

export function extractCampaignSetupPayloads(probeReport, { eventId, event, campaign } = {}) {
  const captured = Array.isArray(probeReport?.captured) ? probeReport.captured : [];
  const byAction = new Map(captured.map((record) => [record.action, record.dataValue]));
  const actions = [
    "recipientFiltersStandardFormSubmit",
    "negativeFiltersStandardFormSubmit",
    "SetupCampaignFormSubmit",
    "ContentFormSubmit"
  ];

  return actions.map((action) => {
    const data = byAction.get(action);
    if (!data) {
      throw new Error(`Probe report is missing captured data for ${action}. Re-run probe-campaign with --capture-values.`);
    }
    return {
      action,
      data: setupPayloadForCampaign(action, data, { eventId, event, campaign })
    };
  });
}

export async function applyCampaignSetup({
  eventId,
  campaignId,
  payloads,
  csrfToken = process.env.GLUEUP_CSRF_TOKEN,
  cookie = process.env.GLUEUP_COOKIE,
  orgId = process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID
}) {
  if (!Array.isArray(payloads) || !payloads.length) {
    throw new Error("Missing campaign setup payloads.");
  }
  const token = csrfToken || (await fetchCampaignCsrfToken({ cookie }));
  const responses = [];
  for (const payload of payloads) {
    responses.push(
      await postCampaignAction({
        eventId,
        campaignId,
        action: payload.action,
        data: payload.data,
        csrfToken: token,
        cookie,
        orgId
      })
    );
  }
  return responses;
}

export async function scheduleCampaign({
  eventId,
  campaignId,
  sendDate,
  sendTime = "04:00",
  timezone = "America/New_York",
  isNotificationEnabled = false,
  csrfToken = process.env.GLUEUP_CSRF_TOKEN,
  cookie = process.env.GLUEUP_COOKIE,
  orgId = process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID
}) {
  if (!sendDate) throw new Error("Missing campaign send date.");
  return postCampaignAction({
    eventId,
    campaignId,
    action: "schedule-campaign",
    data: {
      id: null,
      isNotificationEnabled,
      timezone: { code: timezone },
      sendTime,
      sendDate
    },
    csrfToken,
    cookie,
    orgId
  });
}
