// Minimal Google Drive access for the leaders sync, using a service account key.
// Mirrors the approach in glueup/src/drive/googleDriveClient.js.
import { createPrivateKey, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

const DRIVE = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

async function serviceAccountToken(credentialsPath) {
  const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: credentials.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(credentials.private_key), "base64url");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` })
  });
  if (!response.ok) throw new Error(`Google token request failed ${response.status}: ${await response.text()}`);
  return (await response.json()).access_token;
}

export function createDriveClient(env = process.env) {
  let tokenPromise;
  const token = () => {
    if (env.GOOGLE_ACCESS_TOKEN) return Promise.resolve(env.GOOGLE_ACCESS_TOKEN);
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to a service account key file, or GOOGLE_ACCESS_TOKEN.");
    }
    tokenPromise ||= serviceAccountToken(env.GOOGLE_APPLICATION_CREDENTIALS);
    return tokenPromise;
  };
  async function get(url) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${await token()}` } });
    if (!response.ok) throw new Error(`Google Drive returned ${response.status}`);
    return response;
  }
  const params = extra => new URLSearchParams({ supportsAllDrives: "true", ...extra });

  return {
    // Google exports the first tab of a Sheet as CSV.
    async exportSheetCsv(fileId) {
      return (await get(`${DRIVE}/files/${fileId}/export?${params({ mimeType: "text/csv" })}`)).text();
    },
    async getDriveFile(fileId) {
      return (await get(`${DRIVE}/files/${fileId}?${params({ fields: "id,name,mimeType,size,md5Checksum,modifiedTime" })}`)).json();
    },
    async downloadDrive(fileId) {
      return Buffer.from(await (await get(`${DRIVE}/files/${fileId}?${params({ alt: "media" })}`)).arrayBuffer());
    }
  };
}
