// Local UI preview with an in-memory adapter. No Google/GitHub writes.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const data = JSON.parse(await readFile(new URL("../api/leaders.json", import.meta.url), "utf8"));
const initial = data.leaders.map((leader, i) => ({ id:`demo-${i}`, name:leader.name, title:leader.title, group:leader.group, photo:leader.image || "" }));
const adapter = `<script>
  (() => {
    let data = { leaders:${JSON.stringify(initial).replace(/</g, "\\u003c")}, revision:"demo-1", hasUnpublishedChanges:false, uploadsEnabled:true };
    let approved = JSON.stringify(data.leaders), version = 1;
    window.leadersEditorPreviewApi = async (method, payload) => {
      if (method === "getLeaderEditorData") return structuredClone(data);
      if (method === "getLeaderPhotoPreview") return "";
      if (method === "uploadLeaderPhoto") return { photo:"https://example.invalid/demo-photo-" + (++version) + ".jpg" };
      if (method === "getLeaderPublishStatus") return { status:"completed", conclusion:"success", startedAt:new Date().toISOString(), url:"" };
      if (!["saveLeaderDraft","publishLeaderDraft"].includes(method)) throw new Error("Unknown preview method.");
      if (payload.revision !== data.revision) throw new Error("Reload the preview before saving.");
      data.leaders = structuredClone(payload.leaders);
      if (method === "publishLeaderDraft") approved = JSON.stringify(data.leaders);
      data.revision = "demo-" + (++version);
      data.hasUnpublishedChanges = JSON.stringify(data.leaders) !== approved;
      data.message = "Preview only: publishing works here without changing the website.";
      return structuredClone(data);
    };
  })();
</script>`;
const port = Number(process.argv[2] || 4174);
createServer(async (request, response) => {
  const html = await readFile(new URL("../sheet/Editor.html", import.meta.url), "utf8");
  response.writeHead(200, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store" });
  response.end(html.replace("<!-- LOCAL_PREVIEW_ADAPTER -->", () => adapter));
}).listen(port, "127.0.0.1", () => console.log(`Leader editor preview: http://localhost:${port}/`));
