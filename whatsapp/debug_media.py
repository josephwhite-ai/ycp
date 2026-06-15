"""Test full media drawer flow with corrected selectors."""
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

            info = page.locator("[data-testid='conversation-info-header']").first
            info.click(timeout=10_000)
            page.wait_for_timeout(2000)
            page.screenshot(path=str(OUT / "media_01_info.png"))

            media = wait_for_any(
                page,
                [
                    "span:has-text('Media, links and docs')",
                    "div:has-text('Media, links and docs')",
                ],
                15_000,
            )
            media.click()
            page.wait_for_timeout(3000)
            page.screenshot(path=str(OUT / "media_02_drawer.png"))

            stats = page.evaluate(
                """
                () => {
                  const imgs = Array.from(document.querySelectorAll('img'));
                  const srcs = {};
                  for (const img of imgs) {
                    const s = img.src || '';
                    const key = s.split('?')[0].slice(0, 40);
                    srcs[key] = (srcs[key] || 0) + 1;
                  }
                  const blob = imgs.filter(i => i.src.startsWith('blob:')).length;
                  const cdn = imgs.filter(i => i.src.includes('whatsapp.net')).length;
                  const regions = document.querySelectorAll("div[role='region']").length;
                  return { total: imgs.length, blob, cdn, srcPrefixes: srcs, regions };
                }
                """
            )
            print(stats)

            # scroll and recount
            page.mouse.wheel(0, 1500)
            page.wait_for_timeout(2000)
            stats2 = page.evaluate(
                "() => ({ blob: [...document.querySelectorAll('img')].filter(i => i.src.startsWith('blob:')).length, cdn: [...document.querySelectorAll('img')].filter(i => i.src.includes('whatsapp.net')).length })"
            )
            print("after scroll", stats2)

        finally:
            ctx.close()


if __name__ == "__main__":
    main()
