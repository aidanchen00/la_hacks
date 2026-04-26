"""
Shared Playwright launcher used by shopping + appointment agents to replace
the paid BrowserUse SaaS calls.

Two entry points:
- scrape_with_playwright(url, selector, timeout) — generic: returns innerText
  of the first matching selector (or None on any failure).
- extract_with_playwright(url, extractor, timeout) — flexible: caller passes
  an async callable that receives the Page and returns a dict. Lets per-site
  scrapers run multiple selectors / clicks before returning structured data.

Both ALWAYS close the browser context in a finally block — no leaked Chromium
processes. HEADLESS env var (default true) toggles visible browser windows
for demo purposes.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Awaitable, Callable, Dict, Optional

logger = logging.getLogger("playwright-browser")

# Default true — can flip to "0" or "false" via HEADLESS env var to watch the
# scraping happen on screen (useful when judges want to see it work).
def _headless() -> bool:
    return os.getenv("HEADLESS", "true").lower() not in ("0", "false", "no")


async def scrape_with_playwright(
    url: str, selector: str, timeout: int = 15
) -> Optional[str]:
    """Generic: navigate, wait for selector, return its innerText. Returns
    None on any exception or timeout — caller decides whether to fall back."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("playwright not installed — run `pip3 install playwright && playwright install chromium`")
        return None

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=_headless())
        context = await browser.new_context(
            user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36"),
        )
        page = await context.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            try:
                await page.wait_for_selector(selector, timeout=timeout * 1000, state="visible")
            except Exception:
                # Selector timed out — but page may still have useful body text
                pass
            el = await page.query_selector(selector)
            if not el:
                return None
            return (await el.inner_text()).strip() or None
        except Exception as e:
            logger.warning(f"scrape_with_playwright failed for {url}: {e}")
            return None
        finally:
            try:
                await context.close()
            except Exception:
                pass
            try:
                await browser.close()
            except Exception:
                pass


async def extract_with_playwright(
    url: str,
    extractor: Callable[[Any], Awaitable[Dict[str, Any]]],
    timeout: int = 25,
) -> Optional[Dict[str, Any]]:
    """Flexible: navigate to `url`, hand the Page to `extractor`, return its
    dict. Used by per-site scrapers that need to wait for multiple selectors
    or extract several fields at once.

    Returns None on any failure (network, timeout, extractor exception)."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("playwright not installed — run `pip3 install playwright && playwright install chromium`")
        return None

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=_headless())
        context = await browser.new_context(
            user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36"),
            viewport={"width": 1280, "height": 900},
        )
        page = await context.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            return await extractor(page)
        except Exception as e:
            logger.warning(f"extract_with_playwright failed for {url}: {e}")
            return None
        finally:
            try:
                await context.close()
            except Exception:
                pass
            try:
                await browser.close()
            except Exception:
                pass
