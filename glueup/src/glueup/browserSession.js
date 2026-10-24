import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";

export function sessionDirectory(directory) {
  return resolve(directory || process.env.GLUEUP_SESSION_DIR || ".glueup-session");
}

// Chromium profiles do not reliably retain session cookies after context.close().
// Keep a private, gitignored cookie snapshot and restore it for every browser step.
export async function saveSessionCookies(context, directory) {
  const dir = sessionDirectory(directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "session-cookies.json");
  await writeFile(path, JSON.stringify(await context.cookies()), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function launchGlueUpContext(chromium, directory, options) {
  const dir = sessionDirectory(directory);
  const context = await chromium.launchPersistentContext(dir, options);
  try {
    let cookies;
    try {
      cookies = JSON.parse(await readFile(join(dir, "session-cookies.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (cookies) await context.addCookies(cookies.filter(cookie =>
      cookie.expires === -1 || cookie.expires > Date.now() / 1000
    ));
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}
