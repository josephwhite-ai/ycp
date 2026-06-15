import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


SESSION_DIR = Path(__file__).parent / "whatsapp_session"
WHATSAPP_URL = "https://web.whatsapp.com/"


def wait_for_any(page, selectors, timeout=10 * 60 * 1000):
    deadline = time.monotonic() + timeout / 1000
    last_error = None

    while time.monotonic() < deadline:
        for selector in selectors:
            try:
                locator = page.locator(selector).first
                if locator.count() and locator.is_visible(timeout=500):
                    return locator
            except PlaywrightTimeoutError as exc:
                last_error = exc
        page.wait_for_timeout(500)

    raise RuntimeError(f"Timed out waiting for any selector: {selectors}") from last_error


def wait_for_whatsapp_ready(page, timeout=10 * 60 * 1000):
    """Wait until WhatsApp is logged in and the chat list is visible."""
    return wait_for_any(
        page,
        [
            "#pane-side",
            "div[aria-label='Chat list']",
            "div[aria-label='Chats']",
            "div[role='grid'][aria-label*='Chat']",
        ],
        timeout=timeout,
    )


def run():
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(SESSION_DIR),
            headless=False,
            viewport={"width": 1440, "height": 1000},
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(WHATSAPP_URL, wait_until="domcontentloaded", timeout=60_000)

        print("If WhatsApp asks for a QR code, scan it now.")
        print("Waiting until the chat list is visible...")
        wait_for_whatsapp_ready(page)
        print("Login/session is ready. You can close the browser window.")

        context.close()


if __name__ == "__main__":
    run()
