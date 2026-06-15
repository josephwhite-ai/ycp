"""One-off DOM probe for WhatsApp Web selectors. Run with headed browser."""
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from scraper import (
    SESSION_DIR,
    WHATSAPP_URL,
    find_search_box,
    load_targets,
    wait_for_any,
    wait_for_whatsapp_ready,
    xpath_literal,
)

OUT = Path(__file__).parent / "debug_output"
OUT.mkdir(exist_ok=True)


def dump_page_state(page, label):
    path = OUT / f"{label}.png"
    page.screenshot(path=str(path), full_page=True)
    print(f"Screenshot: {path}")

    # Visible text snippets in right panels / headers
    js = """
    () => {
      const texts = [];
      for (const el of document.querySelectorAll('span, div, button')) {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 80) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (!el.offsetParent && el.tagName !== 'BODY') continue;
        texts.push({ t, x: Math.round(r.x), y: Math.round(r.y), tag: el.tagName });
      }
      const seen = new Set();
      const out = [];
      for (const item of texts.sort((a,b) => a.y - b.y || a.x - b.x)) {
        const key = item.t + '|' + item.x;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= 120) break;
      }
      return out;
    }
    """
    snippets = page.evaluate(js)
    (OUT / f"{label}.json").write_text(json.dumps(snippets, indent=2))
    print(f"Wrote {len(snippets)} text snippets to {OUT / f'{label}.json'}")


def main():
    targets = load_targets()
    target = targets[0]
    channel_name = target["name"]
    escaped = xpath_literal(channel_name)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(SESSION_DIR),
            headless=False,
            viewport={"width": 1440, "height": 1000},
        )
        page = context.pages[0] if context.pages else context.new_page()
        try:
            wait_for_whatsapp_ready(page)
            dump_page_state(page, "01_ready")

            search_box = find_search_box(page)
            search_box.click()
            search_box.fill("")
            search_box.fill(channel_name)
            page.wait_for_timeout(2000)
            channel_row = wait_for_any(
                page,
                [
                    f"span[title={escaped}]",
                    f"xpath=//span[@title={escaped}]",
                ],
                timeout=30_000,
            )
            channel_row.click()
            page.wait_for_timeout(3000)
            dump_page_state(page, "02_channel_open")

            # Try multiple ways to open info
            attempts = [
                ("header_title", lambda: page.locator(f"#main header span[title={escaped}]").first.click(timeout=3000)),
                ("header_div1", lambda: page.locator("#main header > div").nth(1).click(timeout=3000)),
                ("header", lambda: page.locator("#main header").click(timeout=3000)),
                ("info_icon", lambda: page.locator("[data-icon='info'], [data-icon='info-refreshed']").first.click(timeout=3000)),
                ("menu_button", lambda: page.locator("#main header button").last.click(timeout=3000)),
            ]
            for name, fn in attempts:
                try:
                    fn()
                    page.wait_for_timeout(2000)
                    dump_page_state(page, f"03_after_{name}")
                except Exception as exc:
                    print(f"{name} failed: {exc}")

            # blob images anywhere
            count = page.locator("img[src^='blob:']").count()
            print(f"Total blob images on page: {count}")
            regions = page.locator("div[role='region']").count()
            print(f"role=region count: {regions}")

        finally:
            context.close()


if __name__ == "__main__":
    main()
