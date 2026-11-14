import test from "node:test";
import assert from "node:assert/strict";
import { findSiteStylesheetUrl, removeTrackingScripts, transformPage } from "../src/snapshot.js";

const CSS_URL = "https://cdn.prod.website-files.com/634e/css/ycp.webflow.shared.abc.css";
const PAGE = `<html><head>
<link href="https://fonts.googleapis.com" rel="preconnect"/>
<link href="${CSS_URL}" rel="stylesheet" type="text/css" integrity="sha384-x" crossorigin="anonymous"/>
<script src="https://ajax.googleapis.com/ajax/libs/webfont/1.6.26/webfont.js"></script>
<script>WebFont.load({ google: { families: ["Montserrat:400"] } });</script>
<script>!function(f){if(f.fbq)return;}(window);</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
<script>window.dataLayer = window.dataLayer || [];</script>
<script defer src="https://api.youngcatholicprofessionals.org/oidc/main.bundle.js"></script>
<script async="" src="/9i1h/-l7nx"></script>
</head><body>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-1"></iframe></noscript>
<noscript>Please enable JavaScript.</noscript>
<a href="/about">About</a><a href="//cdn.example.com/x">CDN</a><a href="#">Top</a>
<form action="/search"></form>
<script src='https://app.glueup.com/compiled/js/eb-widgets.min.js'></script>
<script src="https://cdn.prod.website-files.com/634e/js/webflow.js"></script>
</body></html>`;

test("removes analytics and sign-in scripts but keeps the ones the page needs", () => {
  const { html, removed } = removeTrackingScripts(PAGE);
  for (const gone of ["fbq", "googletagmanager", "dataLayer", "oidc", "/9i1h/"]) {
    assert.ok(!html.includes(gone), `${gone} should be removed`);
  }
  for (const kept of ["webfont.js", "WebFont.load", "eb-widgets.min.js", "js/webflow.js", "Please enable JavaScript."]) {
    assert.ok(html.includes(kept), `${kept} should be kept`);
  }
  assert.equal(removed.length, 6);
});

test("finds the Webflow stylesheet and ignores other link tags", () => {
  assert.equal(findSiteStylesheetUrl(PAGE), CSS_URL);
  assert.equal(findSiteStylesheetUrl(`<link href="https://fonts.googleapis.com" rel="preconnect"/>`), null);
});

test("transformPage localizes the stylesheet, fixes links and adds the overrides sheet", () => {
  const { html, stylesheetUrl } = transformPage(PAGE, { pageUrl: "https://www.example.org/chapter/x" });
  assert.equal(stylesheetUrl, CSS_URL);
  assert.ok(html.includes(`<link href="css/webflow.css" rel="stylesheet" type="text/css"/>`));
  assert.ok(!html.includes(CSS_URL) && !html.includes("sha384-x"));
  assert.ok(html.includes(`href="https://www.example.org/about"`));
  assert.ok(html.includes(`action="https://www.example.org/search"`));
  assert.ok(html.includes(`href="//cdn.example.com/x"`) && html.includes(`href="#"`));
  assert.ok(html.indexOf("css/webflow.css") < html.indexOf("/overrides.css"));
  assert.ok(html.includes(`<link href="/overrides.css" rel="stylesheet" type="text/css"/></head>`));
});

test("transformPage fails loudly when the page has no site stylesheet", () => {
  assert.throws(() => transformPage("<html><head></head></html>", { pageUrl: "https://www.example.org/" }), /stylesheet/);
});
