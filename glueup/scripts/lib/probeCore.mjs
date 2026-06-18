import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const BASE_URL = "https://ycp.glueup.com";
export const DEFAULT_SESSION_DIR = ".glueup-session";
export const DEFAULT_BLOCK = "send|schedule|dispatch|deliver|publish|remind";
export const DEBUG_DIR = ".glueup-debug";
export const AJAX_HINT = /\/ajax(\?|$)/i;
export const SECRET_KEYS = /token|cookie|csrf|password|secret|auth/i;
export const SAFE_VALUE_KEYS = /^(id|code|eventid|campaignid|campaigntype|status|type|name|title)$/i;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function describeData(value, prefix = "") {
  const out = [];
  const visit = (val, path) => {
    if (val === null || typeof val !== "object") {
      const leaf = path.split(".").pop() || "";
      const entry = { path, type: val === null ? "null" : typeof val };
      if (typeof val === "string") entry.length = val.length;
      if (SECRET_KEYS.test(leaf)) {
        entry.redacted = true;
      } else if (SAFE_VALUE_KEYS.test(leaf)) {
        entry.value = val;
      }
      out.push(entry);
      return;
    }
    if (Array.isArray(val)) {
      out.push({ path, type: "array", length: val.length });
      val.slice(0, 2).forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    for (const [key, nested] of Object.entries(val)) {
      visit(nested, path ? `${path}.${key}` : key);
    }
  };
  visit(value, prefix);
  return out;
}

export function redactSensitiveValues(value) {
  const visit = (val, key = "") => {
    if (SECRET_KEYS.test(key)) return "<redacted>";
    if (val === null || typeof val !== "object") return val;
    if (Array.isArray(val)) return val.map((item) => visit(item, key));
    return Object.fromEntries(Object.entries(val).map(([nestedKey, nested]) => [nestedKey, visit(nested, nestedKey)]));
  };
  return visit(value);
}

export function parseBody(request) {
  const raw = request.postData() || "";
  try {
    const params = new URLSearchParams(raw);
    const action = params.get("action");
    let data = null;
    let dataValue = null;
    const dataRaw = params.get("data");
    if (dataRaw) {
      try {
        const parsedData = JSON.parse(dataRaw);
        data = describeData(parsedData);
        dataValue = redactSensitiveValues(parsedData);
      } catch {
        data = [{ path: "data", type: "unparsed", length: dataRaw.length }];
      }
    }
    const fields = [...params.keys()].filter((key) => key !== "data");
    return { action, fields, data, dataValue };
  } catch {
    return { action: null, fields: [], data: null, dataValue: null, rawLength: raw.length };
  }
}

export function describeResponseBody(text) {
  try {
    return describeData(JSON.parse(text));
  } catch {
    return [{ path: "<non-json>", type: "text", length: text.length }];
  }
}

export function debugPath(fileName) {
  const dir = resolve(DEBUG_DIR);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, fileName);
}

export function createReportWriter(reportPath, buildReport) {
  return () => {
    writeFileSync(reportPath, `${JSON.stringify(buildReport(), null, 2)}\n`, "utf8");
  };
}

export async function installAjaxProbe({
  context,
  reportPath,
  metadata,
  captureValues,
  blockPattern,
  blockUrls = false,
  getHint,
  ajaxHint = AJAX_HINT,
  extraState = {}
}) {
  const captured = [];
  const blocked = [];
  const gets = [];
  const writeReport = createReportWriter(reportPath, () => ({
    ...metadata,
    blockPattern: blockPattern.source,
    captureValues,
    capturedCount: captured.length,
    blockedCount: blocked.length,
    getCount: gets.length,
    captured,
    blocked,
    gets,
    ...extraState
  }));

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    const isAjax = ajaxHint.test(url) && method === "POST";

    if (method === "GET" && getHint?.test(url)) {
      try {
        const response = await route.fetch();
        const text = await response.text();
        const contentType = response.headers()["content-type"] || "";
        const record = {
          at: new Date().toISOString(),
          method,
          url: url.replace(BASE_URL, ""),
          status: response.status(),
          contentType
        };
        if (contentType.includes("json")) {
          record.body = describeResponseBody(text);
        } else {
          record.bodyLength = text.length;
        }
        gets.push(record);
        writeReport();
        await route.fulfill({ response });
      } catch {
        await route.continue();
      }
      return;
    }

    if (!isAjax) {
      await route.continue();
      return;
    }

    const parsed = parseBody(request);
    const action = parsed.action || "<none>";
    const shouldBlock = blockPattern.test(action) || (blockUrls && blockPattern.test(url));
    const record = {
      at: new Date().toISOString(),
      method,
      url: url.replace(BASE_URL, ""),
      action,
      fields: parsed.fields,
      data: parsed.data,
      blocked: shouldBlock
    };
    if (captureValues && parsed.dataValue !== null) record.dataValue = parsed.dataValue;

    if (shouldBlock) {
      blocked.push(record);
      console.log(`\n  BLOCKED (not sent): action="${action}"  ${record.url}`);
      writeReport();
      await route.abort();
      return;
    }

    try {
      const response = await route.fetch();
      const text = await response.text();
      record.response = {
        status: response.status(),
        body: describeResponseBody(text)
      };
      captured.push(record);
      console.log(`  captured: action="${action}" -> ${response.status()}`);
      writeReport();
      await route.fulfill({ response });
    } catch (error) {
      record.error = error?.message || String(error);
      captured.push(record);
      writeReport();
      await route.continue();
    }
  });

  writeReport();
  return { captured, blocked, gets, writeReport };
}

export async function snapshotForms(page) {
  return page.evaluate(() => {
    const controlSelector = "input, textarea, select, button";
    const labelFor = (control) => {
      const id = control.getAttribute("id");
      const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const implicit = control.closest("label");
      return (explicit?.innerText || implicit?.innerText || "").trim().replace(/\s+/g, " ");
    };
    return [...document.querySelectorAll("form")].map((form, formIndex) => ({
      formIndex,
      action: form.getAttribute("action") || "",
      method: form.getAttribute("method") || "",
      id: form.getAttribute("id") || "",
      className: form.getAttribute("class") || "",
      controls: [...form.querySelectorAll(controlSelector)].map((control) => ({
        tag: control.tagName.toLowerCase(),
        type: control.getAttribute("type") || "",
        name: control.getAttribute("name") || "",
        id: control.getAttribute("id") || "",
        className: control.getAttribute("class") || "",
        placeholder: control.getAttribute("placeholder") || "",
        ariaLabel: control.getAttribute("aria-label") || "",
        label: labelFor(control),
        required: control.hasAttribute("required")
      }))
    }));
  });
}

export function resolvePathTemplate(path, values) {
  return String(path).replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => values[key] || "");
}

export async function waitForBrowserClose(context) {
  await new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    context.on("close", finish);
    for (const page of context.pages()) page.on("close", finish);
    context.on("page", (page) => page.on("close", finish));
  });
}
