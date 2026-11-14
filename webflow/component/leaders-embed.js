/*
 * YCP chapter leaders embed.
 *
 * Fills every element marked with data-ycp-leaders from a JSON endpoint:
 *
 *   <div data-ycp-leaders data-src="https://example.org/leaders.json" data-group="leadership"></div>
 *   <script src="https://example.org/leaders-embed.js" defer></script>
 *
 * data-src    URL of the JSON: { "leaders": [{ "name", "title", "group", "image" }] }
 * data-group  optional; show only leaders whose "group" matches
 *
 * Cards use the chapter page's existing Webflow classes, so they pick up the
 * site's styling. Anything already inside the element stays in place until the
 * data has loaded, and stays for good if loading fails.
 */
(function () {
  "use strict";

  var requests = {}; // one fetch per data-src, shared by every embed on the page

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // Image URLs may be relative to the JSON file. Only http(s) results are used.
  function resolveImageUrl(image, baseUrl) {
    if (!text(image)) return "";
    try {
      var url = new URL(text(image), baseUrl);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  // Returns clean leader records, dropping entries with no name.
  function normalizeLeaders(data, baseUrl) {
    var list = data && Array.isArray(data.leaders) ? data.leaders : null;
    if (!list) throw new Error('Leaders data must look like { "leaders": [...] }.');
    return list
      .filter(function (entry) { return entry && text(entry.name); })
      .map(function (entry) {
        return {
          name: text(entry.name),
          title: text(entry.title),
          group: text(entry.group).toLowerCase(),
          image: resolveImageUrl(entry.image, baseUrl)
        };
      });
  }

  function element(doc, tag, className, content) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content; // never innerHTML: the data is untrusted
    return node;
  }

  function renderCard(doc, leader) {
    var item = element(doc, "div", "w-dyn-item");
    item.setAttribute("role", "listitem");
    var card = item.appendChild(element(doc, "div", "team2_item"));

    var imageWrapper = card
      .appendChild(element(doc, "div", "margin-bottom margin-small"))
      .appendChild(element(doc, "div", "team2_image-wrapper chapterpage_headshot-wrapper"));
    if (leader.image) {
      var image = element(doc, "img", "team2_image chapterpage_headshots");
      image.alt = leader.name;
      image.loading = "lazy";
      image.src = leader.image;
      imageWrapper.appendChild(image);
    }

    var details = card.appendChild(element(doc, "div", "margin-bottom"));
    details.appendChild(element(doc, "div", "text-size-large text-weight-semibold margin-bottom margin-xxsmall", leader.name));
    details.appendChild(element(doc, "div", "text-size-medium", leader.title));
    return item;
  }

  function renderList(doc, leaders) {
    var list = element(doc, "div", "item_grid chapters_page w-dyn-items");
    list.setAttribute("role", "list");
    leaders.forEach(function (leader) { list.appendChild(renderCard(doc, leader)); });
    return list;
  }

  function loadLeaders(src) {
    if (!requests[src]) {
      requests[src] = fetch(src, { credentials: "omit" })
        .then(function (response) {
          if (!response.ok) throw new Error("GET " + src + " returned " + response.status + ".");
          return response.json();
        })
        .then(function (data) { return normalizeLeaders(data, src); });
    }
    return requests[src];
  }

  function mount(target) {
    if (target.getAttribute("data-ycp-leaders-state")) return; // already handled
    target.setAttribute("data-ycp-leaders-state", "loading");
    var src = target.getAttribute("data-src");
    var group = text(target.getAttribute("data-group")).toLowerCase();

    Promise.resolve()
      .then(function () {
        if (!src) throw new Error("data-src is missing.");
        return loadLeaders(new URL(src, document.baseURI).href);
      })
      .then(function (leaders) {
        var shown = group ? leaders.filter(function (leader) { return leader.group === group; }) : leaders;
        if (!shown.length) throw new Error("No leaders" + (group ? ' in group "' + group + '"' : "") + ".");
        target.replaceChildren(renderList(document, shown));
        target.setAttribute("data-ycp-leaders-state", "ready");
      })
      .catch(function (error) {
        target.setAttribute("data-ycp-leaders-state", "error");
        console.error("[ycp-leaders] " + error.message, target);
      });
  }

  function mountAll() {
    document.querySelectorAll("[data-ycp-leaders]").forEach(mount);
  }

  var api = { normalizeLeaders: normalizeLeaders, mountAll: mountAll };
  if (typeof window !== "undefined") window.YCPLeaders = api;
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
})();
