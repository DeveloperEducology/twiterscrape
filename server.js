import { chromium } from "playwright";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cron from "node-cron";
import fetch from "node-fetch";
import fs from "fs";

// --- Configuration ---
dotenv.config();
const MONGO_URI = process.env.MONGO_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const COOKIES_FILE_PATH = "./cookies.json";

// --- ⬇️ ADD THE TWITTER USERNAMES YOU WANT TO SCRAPE HERE ---
const TARGET_USERNAMES = ["BCCI","CricCrazyJohns","IndianTechGuide", "mufaddal_vohra", "bigtvtelugu","balaji25_t","GulteOfficial", "narendramodi", "AshwiniVaishnaw", "vamsikaka"];

// ✅ FIX: Add a lock flag to prevent concurrent job execution
let isJobRunning = false;

// --- Server Initialization Checks ---
if (!MONGO_URI || !GEMINI_API_KEY) {
  console.error(
    "❌ ERROR: MONGO_URI and GEMINI_API_KEY must be defined in your .env file."
  );
  process.exit(1);
}

if (process.env.TWITTER_COOKIES && !fs.existsSync(COOKIES_FILE_PATH)) {
    console.log("[SETUP] Creating cookies.json from TWITTER_COOKIES environment variable...");
    fs.writeFileSync(COOKIES_FILE_PATH, process.env.TWITTER_COOKIES);
}

// --- MongoDB Connection ---
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected successfully."))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// --- Mongoose Schema ---
const ArticleSchema = new mongoose.Schema({
    title: { type: String, required: true },
    summary: { type: String, required: true },
    body: { type: String },
    url: { type: String, required: true, unique: true },
    source: { type: String, required: true, index: true },
    isCreatedBy: { type: String, required: true, default: "twitter_gemini" },
    publishedAt: { type: Date, required: true },
    media: [{
        mediaType: { type: String, enum: ["image", "video_post", "youtube_video"], required: true },
        url: { type: String, required: true },
    }],
}, { timestamps: true });

const Article = mongoose.model("Article", ArticleSchema);

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeUserProfile(username) {
    if (!fs.existsSync(COOKIES_FILE_PATH)) {
        console.error(`❌ Cookies file not found for @${username}. Cannot scrape profile.`);
        return [];
    }

    console.log(`[SCRAPE] Starting profile scrape for @${username}...`);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    try {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE_PATH, 'utf8'));
        await context.addCookies(cookies);
        const page = await context.newPage();
        await page.goto(`https://x.com/${username}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("article[data-testid='tweet']", { timeout: 20000 });

        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(1500);

        const scrapedTweets = await page.$$eval("article[data-testid='tweet']", (articles) =>
            articles.slice(0, 10).map((article) => {
                const timeEl = article.querySelector("a[href*='/status/'] time");
                const linkEl = timeEl ? timeEl.closest("a") : null;
                const textEl = article.querySelector("div[data-testid='tweetText']");

                if (!linkEl || !textEl) return null;

                const media = [];
                if (article.querySelector("div[data-testid='videoPlayer']")) {
                    media.push({ mediaType: "video_post", url: linkEl.href });
                } else {
                    article.querySelectorAll("div[data-testid='tweetPhoto'] img").forEach((img) => {
                        if (img.src) {
                            const highResUrl = new URL(img.src);
                            highResUrl.searchParams.delete('name');
                            highResUrl.searchParams.set('format', 'jpg');
                            media.push({ mediaType: "image", url: highResUrl.href });
                        }
                    });
                }
                const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
                const youtubeMatch = (textEl.innerText || "").match(youtubeRegex);
                if (youtubeMatch && youtubeMatch[1]) {
                    media.unshift({ mediaType: "youtube_video", url: youtubeMatch[1] });
                }

                return {
                    text: textEl.innerText,
                    url: linkEl.href,
                    date: timeEl.getAttribute("datetime"),
                    media,
                };
            })
        );

        const validTweets = scrapedTweets.filter(Boolean);
        console.log(`[SCRAPE] Found ${validTweets.length} recent tweets for @${username}.`);
        return validTweets;

    } catch (error) {
        console.error(`❌ Failed to scrape profile @${username}:`, error.message);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}

async function summarizeWithGemini(text) {
    if (!text) return null;

    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `You are a professional Telugu news editor. Analyze the following text and generate a news report.
    Provide your response ONLY in JSON format with two keys: "title" and "summary".
    The "title" must be a short, engaging headline in Telugu.
    The "summary" must be a single paragraph of about 85 words in Telugu.
    Do not include any text or markdown formatting outside of the JSON object.

    Text to analyze: "${text}"`;

    let currentDelay = 1000;
    const maxRetries = 3;

    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log("[GEMINI] Sending content to Gemini for summarization...");
            const response = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            });

            if (response.status === 429) {
                console.warn(`[GEMINI] Rate limit hit. Retrying in ${currentDelay / 1000}s... (Attempt ${i + 1}/${maxRetries})`);
                await delay(currentDelay);
                currentDelay *= 2;
                continue;
            }

            if (!response.ok) {
                throw new Error(`API call failed: ${response.status}`);
            }

            const data = await response.json();
            const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (!content) {
                throw new Error("Invalid response structure from Gemini API.");
            }

            const jsonString = content.replace(/```json|```/g, "").trim();
            const parsedJson = JSON.parse(jsonString);
            console.log("[GEMINI] Successfully received summary from Gemini.");
            return parsedJson;

        } catch (error) {
            console.error(`❌ Error with Gemini API on attempt ${i + 1}:`, error.message);
            if (i === maxRetries - 1) {
                return null;
            }
            await delay(currentDelay);
            currentDelay *= 2;
        }
    }
    return null;
}

/**
 * The main processing function that orchestrates scraping and saving.
 */
async function processTweets() {
    // ✅ FIX: Check if the job is already running and exit if it is.
    if (isJobRunning) {
        console.log("[INFO] A previous job is still running. Skipping this scheduled run.");
        return;
    }

    // ✅ FIX: Set the lock flag and wrap the entire process in a try...finally block.
    isJobRunning = true;
    try {
        console.log("\n🚀 Starting scheduled job...");

        for (const username of TARGET_USERNAMES) {
            const recentTweets = await scrapeUserProfile(username);
            if (recentTweets.length === 0) {
                console.log(`[INFO] No new tweets found for @${username}. Skipping.`);
                continue;
            }

            const scrapedUrls = recentTweets.map(t => t.url);
            const existingArticles = await Article.find({ url: { $in: scrapedUrls } }).select('url -_id');
            const existingUrls = new Set(existingArticles.map(a => a.url));
            const newTweets = recentTweets.filter(tweet => !existingUrls.has(tweet.url));

            if (newTweets.length === 0) {
                console.log(`[INFO] All scraped tweets for @${username} are already in the database.`);
                continue;
            }

            console.log(`[PROCESS] Found ${newTweets.length} new tweets for @${username} to process.`);

            for (const tweet of newTweets) {
                const summarizedArticle = await summarizeWithGemini(tweet.text);

                if (summarizedArticle && summarizedArticle.title && summarizedArticle.summary) {
                    const articleData = {
                        title: summarizedArticle.title,
                        summary: summarizedArticle.summary,
                        body: tweet.text,
                        url: tweet.url.replace("x.com", "twitter.com"),
                        isCreatedBy: "twitter_gemini", 
                        source: `Twitter @${username}`,
                        publishedAt: new Date(tweet.date),
                        media: tweet.media,
                    };
                    await Article.updateOne({ url: articleData.url }, { $setOnInsert: articleData }, { upsert: true });
                    console.log(`✅ Successfully saved article: ${tweet.url}`);
                } else {
                    console.error(`Skipping save for ${tweet.url} due to failed summarization.`);
                }
                
                await delay(1000);
            }
        }
        console.log("✅ Scheduled job finished.");
    } catch (error) {
        console.error("❌ An unexpected error occurred during the job:", error);
    } finally {
        // ✅ FIX: Always release the lock, even if an error occurs.
        isJobRunning = false;
        console.log("[INFO] Job lock released.");
    }
}

// Cron Job Scheduling: Runs every 10 minutes.
// cron.schedule("*/10 * * * *", processTweets);

console.log(
  `🚀 News Scraper & Summarizer is running. Will process tweets from ${TARGET_USERNAMES.length} users every 10 minutes.`
);

// Run the job immediately on start for the first time
// processTweets();