// Serves the local page copy. Usage: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OVERRIDES_STYLESHEET_PATH } from "../src/snapshot.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(projectDir, "site");
const port = Number(process.argv[2] || process.env.PORT || 4173);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

// URL prefixes served from tracked project folders instead of site/.
const PROJECT_FOLDERS = ["api", "component"];

function resolveFile(urlPath) {
  if (urlPath === OVERRIDES_STYLESHEET_PATH) return path.join(projectDir, "overrides.css");
  const folder = PROJECT_FOLDERS.find(name => urlPath.startsWith(`/${name}/`));
  const root = folder ? path.join(projectDir, folder) : siteDir;
  const relative = folder ? urlPath.slice(folder.length + 1) : urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath;
  const file = path.join(root, relative);
  // Refuse paths that climb out of the folder being served.
  return file.startsWith(root + path.sep) ? file : null;
}

const server = createServer(async (request, response) => {
  let file = null;
  try {
    file = resolveFile(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
  } catch {
    // Malformed URL: fall through to 404.
  }
  try {
    if (!file) throw new Error("outside site/");
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      // Lets a page on another origin (such as a Webflow staging site) load the data and component.
      "access-control-allow-origin": "*"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end(file?.endsWith("index.html") ? "No snapshot yet. Run: npm run snapshot\n" : "Not found\n");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local page copy: http://localhost:${port}/`);
});
