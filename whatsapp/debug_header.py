"""Inspect #main header and try opening contact/group info."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

from scraper import SESSION_DIR, find_search_box, load_targets, wait_for_any, wait_for_whatsapp_ready, xpath_literal

OUT = Path(__file__).parent / "debug_output"


def main():
    target = load_targets()[0]
    name = target["name"]
    escaped = xpath_literal(name)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(str(SESSION_DIR), headless=False, viewport={"width": 1440, "height": 1000})
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            wait_for_whatsapp_ready(page)
            sb = find_search_box(page)
            sb.click()
            sb.fill("")
            sb.fill(name)
            page.wait_for_timeout(2000)
            wait_for_any(page, [f"span[title={escaped}]", f"xpath=//span[@title={escaped}]"], 30_000).click()
            page.wait_for_timeout(3000)

            header_info = page.evaluate(
                """
                () => {
                  const header = document.querySelector('#main header');
                  if (!header) return { error: 'no header' };
                  const walk = (el, depth=0) => {
                    if (depth > 6) return null;
                    const r = el.getBoundingClientRect();
                    const attrs = {};
                    for (const a of ['title','aria-label','role','data-icon','data-testid','tabindex']) {
                      const v = el.getAttribute(a);
                      if (v) attrs[a] = v;
                    }
                    const text = (el.innerText || '').trim().slice(0, 60);
                    const node = {
                      tag: el.tagName,
                      text,
                      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                      attrs,
                      children: [],
                    };
                    for (const child of el.children) {
                      const c = walk(child, depth + 1);
                      if (c) node.children.push(c);
                    }
                    return node;
                  };
                  return walk(header);
                }
                """
            )
            (OUT / "header_tree.json").write_text(json.dumps(header_info, indent=2))
            print("Wrote header_tree.json")

            # Try clicking channel title div in header (not span[title])
            attempts = [
                ("header_name_div", f"#main header div:has-text({escaped})"),
                ("header_clickable", "#main header [role='button']"),
                ("header_img", "#main header img"),
                ("header_first_div", "#main header div >> nth=0"),
            ]
            for label, sel in attempts:
                loc = page.locator(sel).first
                try:
                    if loc.count() and loc.is_visible(timeout=2000):
                        print(f"Trying {label}: {sel}")
                        loc.click(timeout=5000)
                        page.wait_for_timeout(2500)
                        texts = page.evaluate(
                            """
                            () => Array.from(document.querySelectorAll('span,div,button'))
                              .map(el => (el.innerText||'').trim())
                              .filter(t => t && t.length < 80)
                              .filter(t => /media|link|doc|info|member|privacy/i.test(t))
                              .slice(0, 40)
                            """
                        )
                        print(f"  matching texts: {texts}")
                        page.screenshot(path=str(OUT / f"header_try_{label}.png"))
                except Exception as exc:
                    print(f"  {label} failed: {exc}")

        finally:
            ctx.close()


if __name__ == "__main__":
    main()
