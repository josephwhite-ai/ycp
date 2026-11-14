// Swaps the Webflow CMS leader lists in a page copy for the embed component,
// the way the site admin would with a Code Embed element.

// Order of the leader lists on the chapter page: the "Our Leadership" tab, then "Our Board & Chaplaincy".
const GROUPS_IN_PAGE_ORDER = ["leadership", "board"];
const LIST_OPEN_TAG = '<div class="w-dyn-list">';

export function embedSnippet({ dataUrl, scriptUrl, group }) {
  return (
    `<div data-ycp-leaders data-src="${dataUrl}" data-group="${group}"></div>` +
    `<script src="${scriptUrl}" defer></script>`
  );
}

// Returns the index just past the </div> that closes the <div> opening at `start`.
function endOfDiv(html, start) {
  const tags = /<div\b|<\/div>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let match; (match = tags.exec(html)); ) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return tags.lastIndex;
  }
  throw new Error("Unbalanced <div> in the page copy.");
}

export function replaceLeaderLists(html, { dataUrl, scriptUrl }) {
  let output = "";
  let cursor = 0;
  let replaced = 0;
  for (let start; (start = html.indexOf(LIST_OPEN_TAG, cursor)) >= 0; ) {
    const end = endOfDiv(html, start);
    const isLeaderList = html.slice(start, end).includes('class="team2_item"');
    output += html.slice(cursor, start);
    if (isLeaderList) {
      const group = GROUPS_IN_PAGE_ORDER[replaced];
      if (!group) throw new Error(`Expected ${GROUPS_IN_PAGE_ORDER.length} leader lists but found more.`);
      output += embedSnippet({ dataUrl, scriptUrl, group });
      replaced += 1;
    } else {
      output += html.slice(start, end);
    }
    cursor = end;
  }
  return { html: output + html.slice(cursor), replaced };
}
