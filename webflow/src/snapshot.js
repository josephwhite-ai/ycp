// Turns the live chapter page's HTML into a copy that is safe to open locally:
// no analytics or sign-in scripts, a local stylesheet, and links that still
// resolve against the live site.

// A script is dropped when its attributes or body mention any of these.
const BLOCKED_SCRIPT_PATTERNS = [
  /googletagmanager\.com/i,
  /\bgtag\s*\(/,
  /\bdataLayer\b/,
  /google_tags_first_party/,
  /\bfbq\b/,
  /connect\.facebook\.net/i,
  /clarity\.ms/i,
  /visitorGlobalObjectAlias/, // ActiveCampaign site tracking
  /api\.youngcatholicprofessionals\.org\/oidc/i, // member sign-in bundle
  /\bsrc=["']\/(?!\/)/ // same-origin scripts (Google's first-party tag proxy)
];

export const LOCAL_STYLESHEET_PATH = "css/webflow.css";
export const OVERRIDES_STYLESHEET_PATH = "/overrides.css";

function isBlockedScript(attrs, body) {
  return BLOCKED_SCRIPT_PATTERNS.some(pattern => pattern.test(attrs) || pattern.test(body));
}

export function removeTrackingScripts(html) {
  const removed = [];
  const withoutScripts = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, body) => {
    if (!isBlockedScript(attrs, body)) return match;
    removed.push(attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1] || "inline script");
    return "";
  });
  const cleaned = withoutScripts.replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi, (match, body) => {
    if (!/googletagmanager\.com|facebook\.com\/tr/i.test(body)) return match;
    removed.push("noscript tracking fallback");
    return "";
  });
  return { html: cleaned, removed };
}

// Returns the URL of the Webflow site stylesheet, or null if the page has none.
export function findSiteStylesheetUrl(html) {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel=["']stylesheet["']/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href && /website-files\.com\/.+\.css/i.test(href)) return href;
  }
  return null;
}

// Points the site stylesheet at the downloaded copy. The integrity attribute
// goes too, so the local file can be edited.
export function useLocalStylesheet(html, stylesheetUrl) {
  return html.replace(/<link\b[^>]*>/gi, tag =>
    tag.includes(stylesheetUrl) ? `<link href="${LOCAL_STYLESHEET_PATH}" rel="stylesheet" type="text/css"/>` : tag
  );
}

// Root-relative links ("/about") would hit the local server; send them to the live site.
export function absolutizeRootRelativeUrls(html, origin) {
  return html.replace(/\b(href|src|action)=(["'])\/(?!\/)/gi, (_, attr, quote) => `${attr}=${quote}${origin}/`);
}

export function injectOverridesStylesheet(html) {
  const tag = `<link href="${OVERRIDES_STYLESHEET_PATH}" rel="stylesheet" type="text/css"/>`;
  if (!/<\/head>/i.test(html)) throw new Error("Page has no </head>; cannot add the overrides stylesheet.");
  return html.replace(/<\/head>/i, `${tag}</head>`);
}

export function transformPage(html, { pageUrl }) {
  const stylesheetUrl = findSiteStylesheetUrl(html);
  if (!stylesheetUrl) throw new Error("Could not find the Webflow site stylesheet in the page.");
  const { html: cleaned, removed } = removeTrackingScripts(html);
  let output = useLocalStylesheet(cleaned, stylesheetUrl);
  output = absolutizeRootRelativeUrls(output, new URL(pageUrl).origin);
  output = injectOverridesStylesheet(output);
  return { html: output, stylesheetUrl, removed };
}
