/**
 * Adds the chapter leader editor and publishing tools to the Sheet's Website menu.
 *
 * Install this file, Editor.gs and Editor.html in Extensions > Apps Script. In Project
 * Settings > Script properties add GITHUB_TOKEN: a fine-grained GitHub token for
 * josephwhite-ai/ycp with "Actions: Read and write" permission only.
 */
const REPO = "josephwhite-ai/ycp";
const WORKFLOW = "webflow-pages.yml";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Website")
    .addItem("Edit leaders", "showLeaderEditor")
    .addSeparator()
    .addItem("Republish approved leaders", "publishLeaders")
    .addItem("Check the last publish", "showPublishStatus")
    .addToUi();
}

function githubRequest_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!token) throw new Error("The GITHUB_TOKEN script property is not set. See the setup note at the top of the script.");
  const options = {
    method: method,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
    muteHttpExceptions: true
  };
  if (body) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(body);
  }
  return UrlFetchApp.fetch("https://api.github.com/repos/" + REPO + path, options);
}

function publishLeaders() {
  const ui = SpreadsheetApp.getUi();
  try {
    dispatchLeadersPublish_();
    ui.alert("Publishing started", "The approved roster will update in a few minutes. Saved drafts stay private until you use Publish changes in the editor.", ui.ButtonSet.OK);
  } catch (error) {
    ui.alert("Could not start publishing", error.message, ui.ButtonSet.OK);
  }
}

function dispatchLeadersPublish_() {
  const response = githubRequest_("post", "/actions/workflows/" + WORKFLOW + "/dispatches", { ref: "main" });
  if (response.getResponseCode() !== 204) throw new Error("GitHub returned " + response.getResponseCode() + ". Ask the technology lead to check the publishing connection.");
}

function getLeaderPublishStatus() {
  const response = githubRequest_("get", "/actions/workflows/" + WORKFLOW + "/runs?per_page=1");
  if (response.getResponseCode() !== 200) throw new Error("Could not read publish status (GitHub returned " + response.getResponseCode() + ").");
  const run = JSON.parse(response.getContentText()).workflow_runs?.[0];
  return run ? { status: run.status, conclusion: run.conclusion || "", url: run.html_url, startedAt: run.created_at } : null;
}

function showPublishStatus() {
  const ui = SpreadsheetApp.getUi();
  let run;
  try { run = getLeaderPublishStatus(); } catch (error) { ui.alert(error.message); return; }
  if (!run) { ui.alert("No publishes yet."); return; }
  const outcome =
    run.status !== "completed"
      ? "still running"
      : run.conclusion === "success"
        ? "succeeded"
        : "FAILED. Open the link below and look at the 'Sync leaders from the Google Sheet' step for the rows to fix";
  ui.alert("Last workflow run " + outcome, "Started " + new Date(run.startedAt).toLocaleString() + "\n" + run.url, ui.ButtonSet.OK);
}
