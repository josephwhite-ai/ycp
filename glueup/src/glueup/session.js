import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEBUG_DIR = ".glueup-debug";

export const GLUEUP_BASE_URL = "https://ycp.glueup.com";
export const GLUEUP_DRAFT_URL = `${GLUEUP_BASE_URL}/events/draft`;
export const DEFAULT_ORG_ID = "5828";
export const DEFAULT_SESSION_DIR = ".glueup-session";

const LOGIN_PATH_HINTS = ["/login", "/signin", "/sign-in", "/account/login", "/user/login"];
const AUTH_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

export async function resolveGlueUpAuth(options = {}) {
  const cookie = process.env.GLUEUP_COOKIE;
  const csrfToken = process.env.GLUEUP_CSRF_TOKEN;
  const orgId = process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID;

  if (cookie && csrfToken) {
    return { cookie, csrfToken, orgId, source: "env" };
  }

  if (process.env.CI && !process.env.GLUEUP_EMAIL && !process.env.GLUEUP_PASSWORD) {
    throw new Error(
      "CI requires GLUEUP_EMAIL and GLUEUP_PASSWORD repository secrets (or GLUEUP_COOKIE and GLUEUP_CSRF_TOKEN)."
    );
  }

  const session = await getGlueUpSession(options);
  return { ...session, source: "playwright" };
}

export async function loginGlueUp(options = {}) {
  const session = await withGlueUpBrowser({
    ...options,
    headless: options.headless ?? false
  });

  try {
    await openDraftWorkspace(session.page);
    await maybeSubmitCredentials(session.page, options);
    await waitForAuthenticatedDraftPage(session.page, options);
    const auth = await extractSession(session.context, session.page);
    console.log("Glue Up session is ready.");
    if (auth.csrfToken) {
      console.log("CSRF token captured.");
    } else {
      console.log("Warning: CSRF token was not found on /events/draft.");
    }
    return auth;
  } finally {
    await session.close();
  }
}

export async function getGlueUpSession(options = {}) {
  const session = await withGlueUpBrowser({
    ...options,
    headless: options.headless ?? true
  });

  try {
    await openDraftWorkspace(session.page);
    await maybeSubmitCredentials(session.page, options);
    await waitForAuthenticatedDraftPage(session.page, options);
    return await extractSession(session.context, session.page);
  } catch (error) {
    await captureFailureArtifacts(session.page, error);
    throw error;
  } finally {
    await session.close();
  }
}

async function withGlueUpBrowser(options = {}) {
  const { chromium } = await import("playwright");
  const headless = options.headless ?? true;
  const useEphemeral = options.ephemeral ?? Boolean(process.env.CI);

  if (useEphemeral) {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 }
    });
    const page = await context.newPage();
    return {
      context,
      page,
      async close() {
        await context.close();
        await browser.close();
      }
    };
  }

  const sessionDir = resolve(options.sessionDir || process.env.GLUEUP_SESSION_DIR || DEFAULT_SESSION_DIR);
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless,
    viewport: { width: 1440, height: 1000 }
  });

  const page = context.pages()[0] || (await context.newPage());
  return {
    context,
    page,
    async close() {
      await context.close();
    }
  };
}

async function openDraftWorkspace(page) {
  await page.goto(GLUEUP_DRAFT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (await isLoginPage(page)) {
    await page.goto(`${GLUEUP_BASE_URL}/account/login`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
  }
}

async function maybeSubmitCredentials(page, options = {}) {
  const email = options.email || process.env.GLUEUP_EMAIL;
  const password = options.password || process.env.GLUEUP_PASSWORD;
  if (!email || !password) {
    if (process.env.CI) {
      throw new Error("GLUEUP_EMAIL and GLUEUP_PASSWORD are required for headless CI login.");
    }
    return;
  }

  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  if (!(await emailInput.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return;
  }

  await emailInput.fill(email);
  await passwordInput.fill(password);

  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submit.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await submit.click();
  } else {
    await passwordInput.press("Enter");
  }

  await page.waitForLoadState("domcontentloaded");
}

async function waitForAuthenticatedDraftPage(page, options = {}) {
  const headless = options.headless ?? true;
  const deadline = Date.now() + AUTH_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const url = page.url();
    if (isDraftWorkspaceUrl(url) && !(await isLoginPage(page))) {
      return;
    }

    if (await isLoginPage(page)) {
      if (headless) {
        console.log("Waiting for headless Glue Up login to complete...");
      } else {
        console.log("Complete Glue Up login in the browser window, then wait for /events/draft to load.");
      }
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(`Timed out waiting for authenticated Glue Up session at ${GLUEUP_DRAFT_URL}.`);
}

export async function testHeadlessLogin(options = {}) {
  if (!options.email && !process.env.GLUEUP_EMAIL) {
    throw new Error("GLUEUP_EMAIL is required for headless login test.");
  }
  if (!options.password && !process.env.GLUEUP_PASSWORD) {
    throw new Error("GLUEUP_PASSWORD is required for headless login test.");
  }

  const auth = await getGlueUpSession({
    ...options,
    headless: true,
    ephemeral: true
  });

  return {
    ok: true,
    url: GLUEUP_DRAFT_URL,
    orgId: auth.orgId,
    cookieCount: auth.cookie.split(";").filter(Boolean).length,
    csrfTokenLength: auth.csrfToken.length
  };
}

function isDraftWorkspaceUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("glueup.com") && parsed.pathname.startsWith("/events/draft");
  } catch {
    return false;
  }
}

async function isLoginPage(page) {
  const url = page.url();
  if (LOGIN_PATH_HINTS.some((hint) => url.includes(hint))) {
    return true;
  }

  const passwordVisible = await page
    .locator('input[type="password"]')
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  return passwordVisible;
}

async function extractSession(context, page) {
  await page.waitForSelector("meta#csrf-token, meta[name='csrf-token']", { timeout: 30_000 });

  const cookies = await context.cookies(GLUEUP_BASE_URL);
  const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
  if (!cookie) {
    throw new Error("Glue Up session has no cookies. Run `npm run glueup-login` first.");
  }

  const csrfToken = await extractCsrfToken(page);
  const orgId = (await extractOrgId(page)) || process.env.GLUEUP_ORG_ID || DEFAULT_ORG_ID;

  return { cookie, csrfToken, orgId };
}

async function extractCsrfToken(page) {
  const token = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"], meta#csrf-token');
    if (meta?.content) return meta.content;

    const input = document.querySelector('input[name="token"], input[name="csrf-token"]');
    if (input?.value) return input.value;

    return null;
  });

  if (!token) {
    throw new Error(
      `Could not find a CSRF token on ${GLUEUP_DRAFT_URL}. Set GLUEUP_CSRF_TOKEN or re-run \`npm run glueup-login\`.`
    );
  }

  return token;
}

async function extractOrgId(page) {
  return page.evaluate(() => {
    const activeOrg = document.querySelector(
      ".DropDownListItem.multi-org-block .orgItem[data-id], li.org-active[data-id]"
    );
    return activeOrg?.dataset?.id || null;
  });
}

export function sessionDirExists(sessionDir = process.env.GLUEUP_SESSION_DIR || DEFAULT_SESSION_DIR) {
  return existsSync(resolve(sessionDir));
}

// Value-free: this runs on a PUBLIC repo where logs/artifacts are world-readable,
// so it must only emit names, counts, and lengths — never token/cookie values.
async function captureFailureArtifacts(page, error) {
  try {
    const dir = resolve(DEBUG_DIR);
    mkdirSync(dir, { recursive: true });
    const url = page.url();

    const probe = await page
      .evaluate(() => {
        const metaTokenNames = [...document.querySelectorAll("meta")]
          .map((m) => m.getAttribute("name") || m.getAttribute("id"))
          .filter((n) => n && /csrf|token/i.test(n));
        const tokenInputs = [...document.querySelectorAll("input")]
          .filter((i) => /csrf|token/i.test(i.name || ""))
          .map((i) => ({ name: i.name, valueLength: (i.value || "").length }));
        const globalKeys = Object.keys(window).filter((k) => /csrf|token|org/i.test(k));
        return {
          metaCount: document.querySelectorAll("meta").length,
          metaTokenNames,
          tokenInputs,
          globalKeys
        };
      })
      .catch((e) => ({ probeError: e?.message || String(e) }));

    const cookies = await page.context().cookies(GLUEUP_BASE_URL).catch(() => []);
    const cookieSummary = cookies.map((c) => ({ name: c.name, valueLength: (c.value || "").length }));

    const report = {
      url,
      error: error?.message || String(error),
      cookies: cookieSummary,
      ...probe
    };
    writeFileSync(resolve(dir, "probe.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.error(`Login failed at ${url}. Wrote value-free probe to ${dir}/probe.json.`);
  } catch (captureError) {
    console.error(`Could not capture failure diagnostics: ${captureError?.message || captureError}`);
  }
}
