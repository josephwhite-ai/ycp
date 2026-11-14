/**
 * Adds a "Website" menu to the leaders Google Sheet with a "Publish leaders now"
 * item, so editors don't have to wait for the hourly sync.
 *
 * Setup (once): Extensions > Apps Script, paste this file, then in Project
 * Settings > Script properties add GITHUB_TOKEN: a fine-grained GitHub token for
 * josephwhite-ai/ycp with "Actions: Read and write" permission only.
 */
const REPO = "josephwhite-ai/ycp";
const WORKFLOW = "webflow-pages.yml";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Website")
    .addItem("Publish leaders now", "publishLeaders")
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
  const response = githubRequest_("post", "/actions/workflows/" + WORKFLOW + "/dispatches", { ref: "main" });
  const ui = SpreadsheetApp.getUi();
  if (response.getResponseCode() === 204) {
    ui.alert(
      "Publishing started",
      "The website updates in a few minutes. Visitors' browsers may keep the old list for up to 10 more minutes.\n\n" +
        'Use Website > "Check the last publish" to see whether it worked.',
      ui.ButtonSet.OK
    );
  } else {
    ui.alert("Could not start publishing", "GitHub said: " + response.getResponseCode() + " " + response.getContentText(), ui.ButtonSet.OK);
  }
}

function showPublishStatus() {
  const response = githubRequest_("get", "/actions/workflows/" + WORKFLOW + "/runs?per_page=1");
  const ui = SpreadsheetApp.getUi();
  const run = JSON.parse(response.getContentText()).workflow_runs?.[0];
  if (!run) {
    ui.alert("No publishes yet.");
    return;
  }
  const outcome =
    run.status !== "completed"
      ? "still running"
      : run.conclusion === "success"
        ? "succeeded"
        : "FAILED. Open the link below and look at the 'Sync leaders from the Google Sheet' step for the rows to fix";
  ui.alert("Last publish " + outcome, "Started " + new Date(run.created_at).toLocaleString() + "\n" + run.html_url, ui.ButtonSet.OK);
}
