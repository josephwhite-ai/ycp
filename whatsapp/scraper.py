import base64
import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


DEFAULT_CHANNEL = "Saint Joseph Patron Saint of Workers and Entrepreneurs Catholic Business Club"
CONFIG_PATH = Path(os.getenv("CHANNEL_CONFIG", Path(__file__).parent / "channels.json"))
SESSION_DIR = Path(__file__).parent / "whatsapp_session"
DOWNLOAD_DIR = Path(__file__).parent / "downloaded_images"
WHATSAPP_URL = "https://web.whatsapp.com/"

# Headed mode is deliberate: WhatsApp Web is unreliable in headless mode, and
# Playwright's chrome-headless-shell crashes with this persisted profile.
HEADLESS = os.getenv("WHATSAPP_HEADLESS", "").lower() in {"1", "true", "yes"}
MAX_IMAGES = int(os.getenv("MAX_IMAGES", "500"))
MAX_SCROLLS = int(os.getenv("MAX_SCROLLS", os.getenv("SCROLL_PASSES", "250")))
SCROLL_WAIT_SECONDS = float(os.getenv("SCROLL_WAIT_SECONDS", "2.5"))
WHATSAPP_READY_TIMEOUT_MS = int(os.getenv("WHATSAPP_READY_TIMEOUT_MS", "600000"))
DEBUG_BROWSER_CONSOLE = os.getenv("DEBUG_BROWSER_CONSOLE", "").lower() in {"1", "true", "yes"}
DEBUG_DIR = Path(__file__).parent / "debug_output"


def safe_folder_name(value):
    folder = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip().lower())
    return folder.strip("-") or "channel"


def load_targets():
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open() as config_file:
            config = json.load(config_file)

        community = config.get("community")
        targets = []
        for channel in config.get("channels", []):
            name = channel["name"]
            targets.append(
                {
                    "community": community,
                    "name": name,
                    "folder": channel.get("local_folder") or safe_folder_name(name),
                }
            )
        if targets:
            return targets

    channel_name = os.getenv("WHATSAPP_CHANNEL", DEFAULT_CHANNEL)
    return [
        {
            "community": None,
            "name": channel_name,
            "folder": safe_folder_name(channel_name),
        }
    ]


def xpath_literal(value):
    if "'" not in value:
        return f"'{value}'"
    if '"' not in value:
        return f'"{value}"'
    parts = value.split("'")
    return "concat(" + ', "\'", '.join(f"'{part}'" for part in parts) + ")"


def wait_for_any(page, selectors, timeout=120_000):
    deadline = time.monotonic() + timeout / 1000
    last_error = None

    while time.monotonic() < deadline:
        for selector in selectors:
            try:
                matches = page.locator(selector)
                for index in range(min(matches.count(), 20)):
                    locator = matches.nth(index)
                    if locator.is_visible(timeout=250) and is_in_viewport(locator):
                        return locator
            except PlaywrightTimeoutError as exc:
                last_error = exc
        page.wait_for_timeout(500)

    raise RuntimeError(f"Timed out waiting for any selector: {selectors}") from last_error


def is_in_viewport(locator, min_width=2, min_height=2):
    box = locator.bounding_box()
    if not box or box["width"] < min_width or box["height"] < min_height:
        return False

    return locator.page.evaluate(
        """box => (
            box.x < window.innerWidth &&
            box.y < window.innerHeight &&
            box.x + box.width > 0 &&
            box.y + box.height > 0
        )""",
        box,
    )


def wait_for_whatsapp_ready(page):
    print("Loading WhatsApp Web...")
    page.goto(WHATSAPP_URL, wait_until="domcontentloaded", timeout=60_000)
    return wait_for_any(
        page,
        [
            "#pane-side",
            "div[aria-label='Chat list']",
            "div[aria-label='Chats']",
            "div[role='grid'][aria-label*='Chat']",
        ],
        timeout=WHATSAPP_READY_TIMEOUT_MS,
    )


def find_search_box(page):
    return wait_for_any(
        page,
        [
            "input[aria-label='Search or start a new chat']",
            "input[aria-label*='Search']",
            "div[contenteditable='true'][aria-label*='Search']",
            "div[role='textbox'][aria-label*='Search']",
            "xpath=//input[contains(@aria-label, 'Search')]",
            "xpath=//div[@contenteditable='true' and contains(@aria-label, 'Search')]",
            "xpath=//div[@role='textbox' and contains(@aria-label, 'Search')]",
        ],
        timeout=30_000,
    )


def dismiss_overlays(page, presses=3):
    for _ in range(presses):
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)


def click_center(locator, timeout=5_000):
    box = locator.bounding_box(timeout=timeout)
    if not box:
        locator.click(timeout=timeout)
        return
    locator.page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def load_state(target_dir):
    state_path = target_dir / "state.json"
    if not state_path.exists():
        return {"hashes": [], "message_signatures": []}
    try:
        with state_path.open() as state_file:
            state = json.load(state_file)
        if isinstance(state.get("hashes"), list) and isinstance(state.get("message_signatures", []), list):
            state.setdefault("message_signatures", [])
            return state
    except json.JSONDecodeError:
        pass
    return {"hashes": [], "message_signatures": []}


def save_state(target_dir, hashes, message_signatures):
    state_path = target_dir / "state.json"
    state = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "hashes": sorted(hashes),
        "message_signatures": sorted(message_signatures)[-2_000:],
    }
    state_path.write_text(json.dumps(state, indent=2) + "\n")


def timeline_image_locators(page):
    main = page.locator("#main").first
    if not main.count():
        return []
    candidates = main.locator("img[src^='blob:'], img[src*='whatsapp.net']").all()
    return _large_visible_images(candidates)


def _large_visible_images(images, min_size=80):
    thumbnails = []
    for image in images:
        try:
            box = image.bounding_box()
            if not box or box["width"] < min_size or box["height"] < min_size:
                continue
            if box["y"] < 65:
                continue
            if not is_in_viewport(image, min_width=min_size, min_height=min_size):
                continue
            thumbnails.append(image)
        except Exception:
            continue
    return thumbnails


def extension_for_image(src, content_type):
    if "jpeg" in content_type or "jpg" in content_type:
        return "jpg"
    if "webp" in content_type:
        return "webp"
    if src.startswith("blob:"):
        return "png"
    if ".png" in src:
        return "png"
    return "jpg"


_BLOB_FETCH_JS = """
async (url) => {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
"""


def save_image(page, image, target_dir, existing_hashes):
    src = image.get_attribute("src") or ""
    if not src:
        return False

    if src.startswith("http"):
        response = page.request.get(src, timeout=30_000)
        if not response.ok:
            return False
        data = response.body()
        content_type = (response.headers.get("content-type") or "").lower()
    elif src.startswith("blob:"):
        # Fetch the real compressed image from the browser's blob store.
        # Using image.screenshot() here would capture a pixelated UI render
        # instead of the actual JPEG/WEBP payload.
        try:
            data_url = page.evaluate(_BLOB_FETCH_JS, src)
            # data_url is "data:<mime>;base64,<payload>"
            header, b64 = data_url.split(",", 1)
            content_type = header.split(":")[1].split(";")[0].lower()
            data = base64.b64decode(b64)
        except Exception as exc:
            print(f"  blob fetch failed, falling back to screenshot: {exc}")
            data = image.screenshot(type="png", timeout=5_000)
            content_type = "image/png"
    else:
        data = image.screenshot(type="png", timeout=5_000)
        content_type = "image/png"

    digest = hashlib.sha256(data).hexdigest()[:16]
    if digest in existing_hashes:
        return False

    ext = extension_for_image(src, content_type)
    save_path = target_dir / f"img_{digest}.{ext}"
    save_path.write_bytes(data)
    existing_hashes.add(digest)
    print(f"Saved {save_path.name}")
    page.wait_for_timeout(300)
    return True


def visible_message_signatures(page):
    raw_signatures = page.evaluate(
        """
        () => {
            const main = document.querySelector('#main');
            if (!main) return [];
            const selectors = [
                '[data-id]',
                '.message-in',
                '.message-out',
                '[role="row"]'
            ];
            const nodes = Array.from(main.querySelectorAll(selectors.join(',')));
            const seen = new Set();
            const signatures = [];
            for (const node of nodes) {
                const rect = node.getBoundingClientRect();
                if (rect.width < 40 || rect.height < 12) continue;
                if (rect.y < 65 || rect.y > window.innerHeight - 80) continue;
                if (rect.x >= window.innerWidth || rect.x + rect.width <= 0) continue;

                const dataId = node.getAttribute('data-id') || '';
                const text = (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
                if (!dataId && !text) continue;

                const value = `${dataId}|${text}`;
                if (seen.has(value)) continue;
                seen.add(value);
                signatures.push(value);
            }
            return signatures;
        }
        """
    )
    return {
        hashlib.sha1(signature.encode("utf-8")).hexdigest()[:20]
        for signature in raw_signatures
    }


def reached_phone_history_boundary(page):
    return page.evaluate(
        """
        () => {
            const main = document.querySelector('#main');
            if (!main) return false;
            for (const el of main.querySelectorAll('button, div, span')) {
                const text = (el.innerText || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                if (!text.includes('click here to get older messages from your phone')) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width < 20 || rect.height < 10) continue;
                if (rect.y < 0 || rect.y > window.innerHeight) continue;
                if (rect.x >= window.innerWidth || rect.x + rect.width <= 0) continue;
                return true;
            }
            return false;
        }
        """
    )


def open_channel(page, channel_name):
    print(f"Searching for channel: {channel_name}")
    dismiss_overlays(page, presses=2)
    search_box = find_search_box(page)
    search_box.click()
    search_box.fill("")
    search_box.fill(channel_name)
    page.wait_for_timeout(2_000)

    escaped_name = xpath_literal(channel_name)
    channel_selectors = [
        f"#pane-side span[title={escaped_name}]",
        f"xpath=//div[@id='pane-side']//span[@title={escaped_name}]",
        f"span[title={escaped_name}]",
        f"xpath=//span[@title={escaped_name}]",
    ]
    channel_row = wait_for_any(page, channel_selectors, timeout=30_000)
    click_center(channel_row)
    print("Channel opened.")

    wait_for_any(
        page,
        [
            "#main",
            "div[role='application']",
            "div[aria-label='Message list']",
        ],
        timeout=60_000,
    )
    wait_for_any(
        page,
        [
            "#main [data-testid='conversation-info-header']",
            "[data-testid='conversation-info-header']",
            "#main header [title='Profile details']",
            "#main [data-testid='conversation-header'] [role='button']",
        ],
        timeout=30_000,
    )
    page.wait_for_timeout(2_000)


def save_currently_visible_images(page, target_dir, existing_hashes, remaining):
    images = timeline_image_locators(page)
    print(f"Found {len(images)} visible timeline image(s).")

    saved = 0
    for image in images:
        if saved >= remaining:
            break
        try:
            if not image.is_visible(timeout=500):
                continue
            if save_image(page, image, target_dir, existing_hashes):
                saved += 1
        except Exception as exc:
            print(f"Skipped one image: {exc}")

    return saved


def scroll_timeline_up(page):
    message_list = page.locator("#main div[aria-label='Message list']").first
    if message_list.count():
        try:
            message_list.hover(timeout=5_000)
        except Exception:
            page.mouse.move(1200, 500)
    else:
        page.mouse.move(1200, 500)
    page.mouse.wheel(0, -1200)
    page.wait_for_timeout(int(SCROLL_WAIT_SECONDS * 1000))


def write_zero_image_diagnostic(page, target):
    DEBUG_DIR.mkdir(exist_ok=True)
    label = safe_folder_name(target["name"])
    screenshot_path = DEBUG_DIR / f"zero_images_{label}.png"
    page.screenshot(path=str(screenshot_path), full_page=True)
    print(f"No images were saved; wrote diagnostic screenshot to {screenshot_path}.")


def save_visible_images(page, target):
    target_dir = DOWNLOAD_DIR / target["folder"]
    target_dir.mkdir(parents=True, exist_ok=True)
    state = load_state(target_dir)
    previous_message_signatures = set(state.get("message_signatures", []))
    seen_message_signatures = set()
    existing_hashes = {
        path.stem.removeprefix("img_")
        for path in target_dir.glob("img_*.*")
    }
    existing_hashes.update(state.get("hashes", []))

    saved_total = 0
    unchanged_scrolls = 0
    last_view_signature = None

    for scroll_pass in range(MAX_SCROLLS + 1):
        remaining = MAX_IMAGES - saved_total
        if remaining <= 0:
            break

        visible_signatures = visible_message_signatures(page)
        seen_message_signatures.update(visible_signatures)

        saved_total += save_currently_visible_images(page, target_dir, existing_hashes, remaining)
        if previous_message_signatures and visible_signatures & previous_message_signatures:
            print("Reached messages recorded in the previous state; stopping timeline scan.")
            break
        if reached_phone_history_boundary(page):
            print("Reached WhatsApp's older-messages-from-phone boundary; stopping timeline scan.")
            break
        if scroll_pass >= MAX_SCROLLS:
            print(f"Reached MAX_SCROLLS={MAX_SCROLLS}; stopping timeline scan.")
            break
        if saved_total >= MAX_IMAGES:
            break

        view_signature = tuple(sorted(visible_signatures))
        if view_signature and view_signature == last_view_signature:
            unchanged_scrolls += 1
        else:
            unchanged_scrolls = 0
        last_view_signature = view_signature
        if unchanged_scrolls >= 3:
            print("Timeline view stopped changing after repeated scrolls; stopping scan.")
            break

        print(f"Scrolling up in chat timeline (scroll {scroll_pass + 1}, cap {MAX_SCROLLS})...")
        scroll_timeline_up(page)

    save_state(target_dir, existing_hashes, previous_message_signatures | seen_message_signatures)
    print(f"Saved {saved_total} new images to {target_dir}.")
    if saved_total == 0 and MAX_IMAGES > 0:
        write_zero_image_diagnostic(page, target)


def scrape_whatsapp():
    if HEADLESS:
        print("Warning: headless mode is enabled, but WhatsApp Web may not load reliably.")

    targets = load_targets()
    print(f"Loaded {len(targets)} channel target(s) from {CONFIG_PATH}.")

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(SESSION_DIR),
            headless=HEADLESS,
            accept_downloads=True,
            viewport={"width": 2200, "height": 1200},
        )
        page = context.pages[0] if context.pages else context.new_page()
        if DEBUG_BROWSER_CONSOLE:
            page.on("console", lambda msg: print(f"Browser console {msg.type}: {msg.text[:300]}"))

        try:
            for index, target in enumerate(targets, start=1):
                community = f" in {target['community']}" if target.get("community") else ""
                print(f"[{index}/{len(targets)}] Processing {target['name']}{community}")
                wait_for_whatsapp_ready(page)
                open_channel(page, target["name"])
                save_visible_images(page, target)
                dismiss_overlays(page, presses=2)
                page.wait_for_timeout(3_000)
        finally:
            context.close()


if __name__ == "__main__":
    scrape_whatsapp()
