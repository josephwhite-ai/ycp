import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSessionCookies, launchGlueUpContext } from "../src/glueup/browserSession.js";

test("restores session cookies across browser steps and drops expired cookies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glueup-session-test-"));
  const cookies = [
    { name: "session", value: "test", domain: "ycp.glueup.com", path: "/", expires: -1 },
    { name: "expired", value: "old", domain: "ycp.glueup.com", path: "/", expires: 1 }
  ];
  try {
    await saveSessionCookies({ cookies: async () => cookies }, dir);
    assert.equal((await stat(join(dir, "session-cookies.json"))).mode & 0o777, 0o600);
    let restored;
    const context = { addCookies: async value => { restored = value; }, close: async () => {} };
    const chromium = { launchPersistentContext: async () => context };
    assert.equal(await launchGlueUpContext(chromium, dir, {}), context);
    assert.deepEqual(restored, [cookies[0]]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "session-cookies.json"))), cookies);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing snapshot supports first login; malformed snapshot closes the context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glueup-session-test-"));
  let closed = false;
  const context = { addCookies: async () => assert.fail("no valid snapshot"), close: async () => { closed = true; } };
  const chromium = { launchPersistentContext: async () => context };
  try {
    await launchGlueUpContext(chromium, dir, {});
    assert.equal(closed, false);
    await writeFile(join(dir, "session-cookies.json"), "broken");
    await assert.rejects(launchGlueUpContext(chromium, dir, {}), SyntaxError);
    assert.equal(closed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
