import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Env, LineupMove } from "../types";

// Yahoo Fantasy Baseball URLs
// /b1 = 2026 MLB Fantasy Baseball (number changes each season)
const YAHOO_FANTASY_BASE = "https://baseball.fantasysports.yahoo.com/b1";

// Cookie persistence path
function cookiePath(env: Env): string {
  return join(env.DATA_DIR, "yahoo-cookies.json");
}

async function saveCookies(page: Page, env: Env): Promise<void> {
  const cookies = await page.cookies();
  writeFileSync(cookiePath(env), JSON.stringify(cookies));
}

async function loadCookies(page: Page, env: Env): Promise<boolean> {
  const path = cookiePath(env);
  if (!existsSync(path)) return false;
  try {
    const cookies = JSON.parse(readFileSync(path, "utf-8"));
    await page.setCookie(...cookies);
    return true;
  } catch {
    return false;
  }
}

// Find Chrome/Chromium on the system
function findChrome(): string {
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("Chrome/Chromium not found. Install with: apt install chromium-browser");
}

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
}

async function ensureLoggedIn(page: Page, env: Env): Promise<void> {
  // Try loading saved cookies first
  await loadCookies(page, env);

  // Navigate to fantasy page — if redirected to login, cookies expired
  const teamUrl = `${YAHOO_FANTASY_BASE}/${env.YAHOO_LEAGUE_ID}/${env.YAHOO_TEAM_ID}`;
  await page.goto(teamUrl, { waitUntil: "networkidle2", timeout: 30000 });

  // Check if we're logged in
  if (!page.url().includes("login.yahoo.com")) {
    return; // cookies worked
  }

  // Need to log in — use Yahoo OAuth tokens to get a session
  // Actually, Yahoo login requires username/password for browser sessions
  // We'll use a different approach: set the roster via the Yahoo API-like
  // mobile endpoints that the website uses internally
  throw new Error("Yahoo browser session expired. Run /auth/browser to log in interactively.");
}

// ---------------------------------------------------------------------------
// Set lineup via Yahoo website
// ---------------------------------------------------------------------------

export async function setLineupViaBrowser(
  env: Env,
  date: string,
  moves: LineupMove[],
): Promise<{ success: boolean; message: string; debug?: string }> {
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    await ensureLoggedIn(page, env);

    // Navigate to the roster page for the target date
    const rosterUrl = `${YAHOO_FANTASY_BASE}/${env.YAHOO_LEAGUE_ID}/${env.YAHOO_TEAM_ID}/team?date=${date}`;
    await page.goto(rosterUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Debug: screenshot + dump page structure
    const screenshotPath = join(env.DATA_DIR, "roster-page.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Dump page structure for debugging
    const pageInfo = (await page.evaluate(`
      (() => {
        const selects = Array.from(document.querySelectorAll("select")).map(
          s => ({ name: s.name, id: s.id, options: Array.from(s.options).map(o => o.value).slice(0, 5) })
        );
        const forms = Array.from(document.querySelectorAll("form")).map(
          f => ({ action: f.action, id: f.id, method: f.method })
        );
        const links = Array.from(document.querySelectorAll("a[href*='swap'], a[href*='move'], a[href*='position']")).map(
          a => ({ href: a.href, text: (a.textContent || "").trim() })
        );
        const playerRows = Array.from(document.querySelectorAll("[data-player], .player, tr.player")).map(
          el => ({ id: el.id, classes: el.className })
        );
        return { selects, forms, links, playerRows, url: window.location.href, title: document.title };
      })()
    `)) as Record<string, unknown>;

    // Try position selects by common Yahoo patterns
    let movesApplied = 0;
    const selectPatterns = [
      (id: string) => `select[name*="${id}"]`,
      (id: string) => `select[data-player="${id}"]`,
      (id: string) => `#pos_${id}`,
      (id: string) => `select.pos-select[data-id="${id}"]`,
    ];

    for (const move of moves) {
      for (const pattern of selectPatterns) {
        try {
          const selector = pattern(move.playerId);
          const selectEl = await page.$(selector);
          if (selectEl) {
            await page.select(selector, move.position);
            movesApplied++;
            break;
          }
        } catch {
          // try next pattern
        }
      }
    }

    if (movesApplied > 0) {
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], .roster-submit');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
      }
    }

    await saveCookies(page, env);

    return {
      success: movesApplied > 0,
      message: `Applied ${movesApplied}/${moves.length} lineup moves for ${date}`,
      debug: JSON.stringify(pageInfo, null, 2),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: msg };
  } finally {
    await browser?.close();
  }
}

// ---------------------------------------------------------------------------
// Interactive login — user calls /auth/browser, gets a URL to open
// Uses a headed browser briefly to capture the session
// ---------------------------------------------------------------------------

export async function startBrowserLogin(env: Env): Promise<{ success: boolean; message: string }> {
  let browser: Browser | null = null;

  try {
    // Launch headed browser for login
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: false, // user needs to see and interact
      args: ["--no-sandbox"],
    });

    const page = await browser.newPage();
    const teamUrl = `${YAHOO_FANTASY_BASE}/${env.YAHOO_LEAGUE_ID}/${env.YAHOO_TEAM_ID}`;
    await page.goto(teamUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // Wait for user to log in (page will eventually not be on login.yahoo.com)
    console.log("Waiting for Yahoo login... Complete it in the browser window.");

    let attempts = 0;
    while (
      (page.url().includes("login.yahoo.com") || page.url().includes("accounts.google.com")) &&
      attempts < 300
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
    }

    if (page.url().includes("login.yahoo.com") || page.url().includes("accounts.google.com")) {
      return { success: false, message: "Login timed out after 5 minutes" };
    }

    await saveCookies(page, env);
    return { success: true, message: "Yahoo browser session saved!" };
  } catch (e) {
    return {
      success: false,
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await browser?.close();
  }
}
