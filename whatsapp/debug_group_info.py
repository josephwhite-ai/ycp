"""Probe whether the Group Info drawer is actually visible after opening it."""
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
        ctx = p.chromium.launch_persistent_context(
            str(SESSION_DIR),
            headless=False,
            viewport={"width": 1440, "height": 1000},
            args=["--window-size=1440,1000"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            wait_for_whatsapp_ready(page)
            search = find_search_box(page)
            search.click()
            search.fill("")
            search.fill(name)
            page.wait_for_timeout(2_000)
            wait_for_any(page, [f"#pane-side span[title={escaped}]", f"span[title={escaped}]"], 30_000).click()
            page.wait_for_timeout(2_000)
            page.mouse.click(448, 86)
            page.wait_for_timeout(1_000)

            menu = page.locator("#main header button[aria-label='Menu']").first
            menu.click(timeout=5_000)
            page.wait_for_timeout(500)
            page.locator("button[role='menuitem']:has-text('Group info')").first.click(timeout=5_000)
            page.wait_for_timeout(3_000)
            page.screenshot(path=str(OUT / "group_info_probe.png"), full_page=True)

            state = page.evaluate(
                """
                () => {
                    const interesting = [
                        '[role="dialog"]',
                        '[data-testid="drawer-right"]',
                        '[data-testid="chat-info-drawer"]',
                        '[data-testid="group-info-drawer-body"]',
                        '[data-testid="block-media-links-docs"]',
                    ];
                    return interesting.flatMap(selector => [...document.querySelectorAll(selector)].map(el => {
                        const rect = el.getBoundingClientRect();
                        const style = getComputedStyle(el);
                        return {
                            selector,
                            text: (el.innerText || '').slice(0, 160),
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            w: Math.round(rect.width),
                            h: Math.round(rect.height),
                            display: style.display,
                            visibility: style.visibility,
                            opacity: style.opacity,
                            pointerEvents: style.pointerEvents,
                            transform: style.transform,
                            className: el.className,
                        };
                    }));
                }
                """
            )
            print(json.dumps(state, indent=2))
        finally:
            ctx.close()


if __name__ == "__main__":
    main()
