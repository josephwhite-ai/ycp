import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { replaceLeaderLists } from "../src/embed.js";

const card = name => `<div role="listitem" class="w-dyn-item"><div class="team2_item"><div>${name}</div></div></div>`;
const list = cards => `<div class="w-dyn-list"><div role="list" class="w-dyn-items">${cards}</div></div>`;
const PAGE =
  `<section><div class="w-dyn-list"><div class="w-dyn-empty"><div>No items found.</div></div></div></section>` +
  `<div class="pane">${list(card("A") + card("B"))}</div><div class="pane">${list(card("C"))}</div><footer></footer>`;
const URLS = { dataUrl: "/api/leaders.json", scriptUrl: "/component/leaders-embed.js" };

test("replaces both leader lists, in page order, and leaves other lists alone", () => {
  const { html, replaced } = replaceLeaderLists(PAGE, URLS);
  assert.equal(replaced, 2);
  assert.ok(!html.includes("team2_item"));
  assert.ok(html.includes("No items found."), "the unrelated empty list is kept");
  assert.ok(html.indexOf('data-group="leadership"') < html.indexOf('data-group="board"'));
  assert.ok(html.includes(`<div class="pane"><div data-ycp-leaders data-src="/api/leaders.json" data-group="leadership"></div>`));
  assert.ok(html.endsWith(`<script src="/component/leaders-embed.js" defer></script></div><footer></footer>`));
});

test("running it again changes nothing", () => {
  const once = replaceLeaderLists(PAGE, URLS).html;
  assert.deepEqual(replaceLeaderLists(once, URLS), { html: once, replaced: 0 });
});

// The component is a plain browser script; load it without a document to reach its data clean-up.
function loadComponent() {
  const window = {};
  const source = readFileSync(new URL("../component/leaders-embed.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { window, URL, console });
  return window.YCPLeaders;
}

test("normalizeLeaders cleans records and resolves image URLs against the data URL", () => {
  const { normalizeLeaders } = loadComponent();
  const leaders = normalizeLeaders(
    {
      leaders: [
        { name: " Ann ", title: "President", group: "Leadership", image: "photos/ann.jpg" },
        { name: "Bob", image: "javascript:alert(1)" },
        { name: "", title: "No name" },
        null
      ]
    },
    "https://api.example.org/ycp/leaders.json"
  );
  assert.equal(JSON.stringify(leaders), JSON.stringify([
    { name: "Ann", title: "President", group: "leadership", image: "https://api.example.org/ycp/photos/ann.jpg" },
    { name: "Bob", title: "", group: "", image: "" }
  ]));
  assert.throws(() => normalizeLeaders({ people: [] }, "https://api.example.org/"), /leaders/);
});

test("the sample data file is valid for the component", () => {
  const { normalizeLeaders } = loadComponent();
  const data = JSON.parse(readFileSync(new URL("../api/leaders.json", import.meta.url), "utf8"));
  const leaders = normalizeLeaders(data, "http://localhost:4173/api/leaders.json");
  assert.equal(leaders.length, data.leaders.length);
  assert.ok(leaders.every(leader => leader.image && ["leadership", "board"].includes(leader.group)));
});
