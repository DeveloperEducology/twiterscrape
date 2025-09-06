import { chromium } from "playwright";
import fs from "fs";

// --- Configuration ---
const LOGIN_URL = "https://x.com/login";
const COOKIES_FILE_PATH = "./cookies.json";
// We will wait up to 2 minutes for the user to log in.
const LOGIN_TIMEOUT = 120000; 

/**
 * Launches a browser, waits for the user to log in, and then automatically
 * detects a successful login, saves cookies, and closes.
 */
async function automaticLoginAndSaveCookies() {
  let browser;
  console.log("🚀 Launching browser for login...");
  
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("   Navigating to the login page...");
    await page.goto(LOGIN_URL);

    console.log("\n   >>> Please log in to your X account in the browser window. <<<");
    console.log("   After you log in, just wait. The script will automatically close the browser for you.");

    // Wait for the main timeline to appear after a successful login.
    // We do this by waiting for a unique element on the home page, like the "Home" navigation link.
    const homeTimelineSelector = 'a[data-testid="AppTabBar_Home_Link"]';
    
    console.log("\n   Waiting for successful login (up to 2 minutes)...");
    await page.waitForSelector(homeTimelineSelector, { state: 'visible', timeout: LOGIN_TIMEOUT });
    
    console.log("\n✅ Login successful! Main timeline detected.");
    console.log("   Waiting 2 seconds to ensure all cookies are set...");
    await page.waitForTimeout(2000); // Small delay to capture all session data.

    console.log("   Saving session cookies...");
    const cookies = await context.cookies();
    
    if (cookies.length === 0) {
        throw new Error("No cookies were captured despite successful login detection.");
    }

    fs.writeFileSync(COOKIES_FILE_PATH, JSON.stringify(cookies, null, 2));
    console.log(`✅ Cookies saved successfully to ${COOKIES_FILE_PATH}`);
    console.log("   You can now start the main server with 'npm start'.");

  } catch (error) {
    console.error("\n❌ ERROR: Login process failed or took too long (more than 2 minutes).");
    console.error("   Please try running 'node login.js' again.", error.message);
  } finally {
    // Ensure the browser always closes, even if there's an error.
    if (browser) {
      console.log("   Closing browser.");
      await browser.close();
    }
  }
}

automaticLoginAndSaveCookies();

