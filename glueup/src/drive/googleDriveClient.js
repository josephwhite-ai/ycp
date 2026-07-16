import { execFileSync } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DOCS_BASE = "https://docs.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly"
];
// Scope for calling the Gemini (Generative Language) API with the same service
// account. cloud-platform is the broadly-accepted OAuth scope for generateContent.
export const GENAI_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export class GoogleDriveClient {
  constructor({ accessTokenProvider = defaultAccessTokenProvider } = {}) {
    this.accessTokenProvider = accessTokenProvider;
  }

  async listChildren(folderId, { pageSize = 100, fields, driveId } = {}) {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: String(pageSize),
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      fields:
        fields ||
        "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, parents)"
    });
    // Listing inside a shared drive (e.g. its root) requires the drive scope.
    if (driveId) {
      params.set("corpora", "drive");
      params.set("driveId", driveId);
    }

    const files = [];
    let pageToken = "";
    do {
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.#request(`${DRIVE_BASE}/files?${params}`);
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || "";
    } while (pageToken);

    return files;
  }

  async getFile(fileId, fields = "id, name, mimeType, driveId, parents, modifiedTime") {
    const params = new URLSearchParams({ supportsAllDrives: "true", fields });
    return this.#request(`${DRIVE_BASE}/files/${fileId}?${params}`);
  }

  async query({ q, driveId, pageSize = 50, fields } = {}) {
    const params = new URLSearchParams({
      q,
      pageSize: String(pageSize),
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      fields: fields || "files(id, name, mimeType, modifiedTime, parents)"
    });
    if (driveId) {
      params.set("corpora", "drive");
      params.set("driveId", driveId);
    }
    const data = await this.#request(`${DRIVE_BASE}/files?${params}`);
    return data.files || [];
  }

  async findChildFolder(parentId, candidates) {
    const children = await this.listChildren(parentId);
    const folders = children.filter(
      (file) => file.mimeType === "application/vnd.google-apps.folder"
    );
    return folders.find((file) => candidates.includes(normalizeName(file.name))) || null;
  }

  async findChildFile(parentId, targetName) {
    const children = await this.listChildren(parentId);
    const normalizedTarget = normalizeName(targetName);
    return (
      children.find((file) => normalizeName(file.name) === normalizedTarget) ||
      children.find((file) => normalizeName(file.name).includes(normalizedTarget)) ||
      null
    );
  }

  // Folder owners don't always name the doc exactly "<Month> <Year> - Event
  // Summary Sheet" — the month may be abbreviated ("Aug 2026") or the spacing
  // may vary. Match any child named like a summary sheet, preferring one that
  // mentions the expected month and year.
  async findSummaryDoc(parentId, { monthName, year }) {
    const children = await this.listChildren(parentId);
    const sheets = children.filter((file) =>
      normalizeName(file.name).includes("event summary sheet")
    );
    if (!sheets.length) return null;

    const matchesMonth = (file) =>
      nameTokens(file.name).some((token) => isMonthToken(token, monthName));
    const matchesYear = (file) => file.name.includes(String(year));

    return (
      sheets.find((file) => matchesMonth(file) && matchesYear(file)) ||
      sheets.find((file) => matchesMonth(file)) ||
      (sheets.length === 1 ? sheets[0] : null)
    );
  }

  async findEventFolder(eventsFolderId, { year, index }) {
    const yearFolder = await this.findChildFolder(eventsFolderId, [
      normalizeName(String(year)),
      normalizeName(`${year} Events`)
    ]);
    if (!yearFolder) {
      throw new Error(`Could not find Drive year folder for ${year}.`);
    }

    const folders = (await this.listChildren(yearFolder.id))
      .filter((file) => file.mimeType === "application/vnd.google-apps.folder")
      .sort((a, b) => a.name.localeCompare(b.name));
    const eventFolder = folders.find((folder) => leadingIndex(folder.name) === index);
    if (!eventFolder) {
      const available = folders.map((folder) => folder.name).join(", ") || "none";
      throw new Error(
        `Could not find Drive event folder with index ${index} in ${year}. Available ${year} folders: ${available}`
      );
    }

    return { yearFolder, eventFolder };
  }

  async getGoogleDoc(documentId) {
    return this.#request(`${DOCS_BASE}/documents/${documentId}`);
  }

  // Downloads the raw bytes of a binary Drive file (e.g. a JPEG/PNG headshot).
  async downloadFile(fileId) {
    const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    return this.#requestBytes(`${DRIVE_BASE}/files/${fileId}?${params}`);
  }

  // Downloads an authenticated content URI, e.g. a Google Doc inline image's
  // `contentUri`. These are short-lived googleusercontent URLs needing the token.
  async downloadContentUri(uri) {
    return this.#requestBytes(uri);
  }

  async listImagesRecursive(folderId, { maxDepth = 2 } = {}) {
    const images = [];
    await this.#walk(folderId, 0, maxDepth, images);
    return images;
  }

  async #walk(folderId, depth, maxDepth, images) {
    const children = await this.listChildren(folderId);
    for (const child of children) {
      if (child.mimeType?.startsWith("image/")) {
        images.push(child);
      } else if (
        depth < maxDepth &&
        child.mimeType === "application/vnd.google-apps.folder"
      ) {
        await this.#walk(child.id, depth + 1, maxDepth, images);
      }
    }
  }

  async #request(url, options = {}) {
    const token = await this.accessTokenProvider();
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google API request failed ${response.status}: ${body}`);
    }

    return response.json();
  }

  async #requestBytes(url) {
    const token = await this.accessTokenProvider();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`Google binary download failed ${response.status}: ${await response.text()}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

export async function defaultAccessTokenProvider() {
  return googleAccessToken(SCOPES);
}

// Mints a Google OAuth access token for the requested scopes. Service-account and
// service-account ADC credentials can mint any scope (so the same key works for
// both Drive and Gemini); a pre-supplied GOOGLE_ACCESS_TOKEN or user/gcloud login
// carries whatever scopes it was granted, so `scopes` is best-effort there.
export async function googleAccessToken(scopes = SCOPES) {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return serviceAccountAccessToken(process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes);
  }

  const adcPath =
    process.env.GOOGLE_APPLICATION_DEFAULT_CREDENTIALS ||
    join(process.env.HOME || "", ".config/gcloud/application_default_credentials.json");
  if (adcPath && existsSync(adcPath)) {
    return applicationDefaultAccessToken(adcPath, scopes);
  }

  try {
    return execFileSync("gcloud", ["auth", "print-access-token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    throw new Error(
      "No Google auth available. Set GOOGLE_ACCESS_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, or log into gcloud with the account that can access the Drive folder."
    );
  }
}

async function applicationDefaultAccessToken(credentialsPath, scopes = SCOPES) {
  const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  if (credentials.type === "service_account") {
    return serviceAccountAccessToken(credentialsPath, scopes);
  }
  if (!credentials.refresh_token || !credentials.client_id || !credentials.client_secret) {
    throw new Error(`Application Default Credentials at ${credentialsPath} are not refreshable user credentials.`);
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token"
    })
  });

  if (!response.ok) {
    throw new Error(`Application Default Credentials token request failed ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function serviceAccountAccessToken(credentialsPath, scopes = SCOPES) {
  const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: scopes.join(" "),
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600
    })
  );
  const unsigned = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign.sign(createPrivateKey(credentials.private_key), "base64url");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`
    })
  });

  if (!response.ok) {
    throw new Error(`Service account token request failed ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.access_token;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function normalizeName(name) {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function nameTokens(name) {
  return normalizeName(name).split(/[^a-z]+/).filter(Boolean);
}

// "Aug", "Sept", and the full month name all identify the month: any word of
// three or more letters that prefixes the month name counts.
function isMonthToken(token, monthName) {
  return token.length >= 3 && monthName.toLowerCase().startsWith(token);
}

// The leading number in an event folder name ("06 - June 2026 - NHH") is the
// event index. Returns null when the name doesn't start with one.
function leadingIndex(name) {
  const match = /^\s*(\d+)\s*-/.exec(name);
  return match ? Number(match[1]) : null;
}
