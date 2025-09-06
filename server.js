import express from "express";
import cors from "cors";
import fs from "fs";
import { chromium } from "playwright";
import mongoose from "mongoose";
import dotenv from "dotenv";

// --- Configuration ---
dotenv.config();
const PORT = process.env.PORT || 8000;
const COOKIES_FILE_PATH = "./cookies.json";
const MONGO_URI = process.env.MONGO_URI;



// --- Logic to Create cookies.json on Render ---
// This block checks for a TWITTER_COOKIES environment variable. If it exists,
// it writes the content to a cookies.json file on the server's temporary storage.
// This is essential for a hosting environment like Render.
if (process.env.TWITTER_COOKIES) {
  if (!fs.existsSync(COOKIES_FILE_PATH)) {
    console.log("[DEBUG] cookies.json not found. Creating from environment variable...");
    fs.writeFileSync(COOKIES_FILE_PATH, process.env.TWITTER_COOKIES);
    console.log("[DEBUG] cookies.json created successfully for the server session.");
  }
}

// --- MongoDB Connection ---
if (!MONGO_URI) {
  console.error("❌ ERROR: MONGO_URI is not defined in your .env file.");
  process.exit(1);
}
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected successfully."))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// --- Mongoose Schema ---
const ArticleSchema = new mongoose.Schema({
  title: { type: String, required: true },
  summary: { type: String },
  body: { type: String },
  url: { type: String, required: true, unique: true },
  source: { type: String, required: true, index: true },
  isCreatedBy: {
    type: String,
    required: true,
    enum: ['twitter', 'rss', 'manual']
  },
  publishedAt: { type: Date, required: true },
  media: [{
    mediaType: { type: String, enum: ['image', 'video_post'], required: true },
    url: { type: String, required: true }
  }]
}, { timestamps: true });

const Article = mongoose.model('Article', ArticleSchema);

// --- 🆕 Main Scraper Function (More Aggressive Scrolling) ---
async function scrapeTweets(username, requiredTweetCount = 25) {
  if (!fs.existsSync(COOKIES_FILE_PATH)) {
    throw new Error("Cookies file not found. Please run 'node login.js' first.");
  }
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE_PATH, 'utf8'));
    context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    const targetUrl = `https://x.com/${username}`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    
    // Increased timeout for slower connections
    await page.waitForSelector("div[data-testid='cellInnerDiv']", { timeout: 25000 });

    // ✅ More aggressive scrolling loop
    let tweetCount = 0;
    const maxScrolls = 10; // Increased scroll attempts
    console.log(`[DEBUG] Starting scrolling process to load at least ${requiredTweetCount} tweets...`);
    for (let i = 0; i < maxScrolls; i++) {
        const previousTweetCount = tweetCount;
        await page.evaluate(() => window.scrollBy(0, 2500)); // Scroll further
        await page.waitForTimeout(2000); // Wait longer for content
        tweetCount = await page.locator("article[data-testid='tweet']").count();
        console.log(`[DEBUG] Scroll attempt ${i + 1}: Page now contains ${tweetCount} tweets.`);
        if (tweetCount >= requiredTweetCount || tweetCount === previousTweetCount) {
            break;
        }
    }

    // Process all loaded tweets to find new ones
    const scrapedTweets = await page.$$eval(
      "article[data-testid='tweet']",
      (articles) =>
        articles.map((article) => {
          const mainTimeEl = article.querySelector("a[href*='/status/'] time");
          if (!mainTimeEl) return null;
          const mainLinkEl = mainTimeEl.closest("a");
          const textEl = article.querySelector("div[data-testid='tweetText']");
          if (!mainLinkEl || !textEl) return null;

          const media = [];
          const hasVideoPlayer = article.querySelector("div[data-testid='videoPlayer']");
          
          if (hasVideoPlayer) {
            let videoPostUrl = mainLinkEl.href;
            const quotedTweetContainer = article.querySelector("div[role='link'][tabindex='0']");
            if (quotedTweetContainer) {
              const quotedTimeEl = quotedTweetContainer.querySelector("time");
              const quotedLinkEl = quotedTimeEl ? quotedTimeEl.closest("a") : null;
              if (quotedLinkEl && quotedLinkEl.href) {
                videoPostUrl = quotedLinkEl.href;
              }
            }
            media.push({ mediaType: 'video_post', url: videoPostUrl });
          } else {
            article.querySelectorAll("div[data-testid='tweetPhoto'] img").forEach(img => {
              if (img.src) {
                media.push({ mediaType: 'image', url: img.src });
              }
            });
          }

          return {
            text: textEl.innerText,
            url: mainLinkEl.href,
            date: mainTimeEl.getAttribute("datetime"),
            media: media,
          };
        })
    );

    const validTweets = scrapedTweets.filter(t => t !== null);
    console.log(`✅ Scraped ${validTweets.length} unique tweets from @${username}'s page.`);
    return validTweets.sort((a, b) => new Date(b.date) - new Date(a.date));

  } finally {
    if (browser) await browser.close();
  }
}

// --- Express Server Setup ---
const app = express();
app.use(cors());
app.use(express.json());

// --- API Endpoints ---
app.get("/", (req, res) => res.send("Stealth Media Scraper server is running."));

app.get("/scrape/:username", async (req, res) => {
  const { username } = req.params;
  const count = parseInt(req.query.count, 10) || 5;

  console.log(`Request received to find and save up to ${count} new tweets for @${username}...`);

  try {
    // ✅ Scrape a larger, fixed number of tweets to ensure we find new content
    const TWEETS_TO_SCRAPE = 40; 
    const recentTweetsFromPage = await scrapeTweets(username, TWEETS_TO_SCRAPE);

    if (recentTweetsFromPage.length === 0) {
      return res.status(404).json({ message: "No tweets found on the user's profile." });
    }

    const standardizedTweets = recentTweetsFromPage.map(tweet => ({
        ...tweet,
        url: tweet.url.replace('x.com', 'twitter.com'),
        media: tweet.media.map(m => ({ ...m, url: m.url.replace('x.com', 'twitter.com') }))
    }));

    const scrapedUrls = standardizedTweets.map(t => t.url);
    const existingArticles = await Article.find({ url: { $in: scrapedUrls } }).select('url -_id');
    const existingUrls = new Set(existingArticles.map(a => a.url));

    const newTweets = standardizedTweets.filter(tweet => !existingUrls.has(tweet.url));

    if (newTweets.length === 0) {
      return res.status(200).json({ message: "Scraping complete. No new tweets found.", username });
    }

    // Save up to the user's requested count, with a max of 25
    const maxToSave = Math.min(count, 25);
    const tweetsToSave = newTweets.slice(0, maxToSave);

    // --- Database Save Logic ---
    const savePromises = tweetsToSave.map(tweet => {
      const articleData = {
        title: tweet.text.slice(0, 150) + (tweet.text.length > 150 ? '...' : ''),
        summary: tweet.text,
        // body: tweet.text,
        url: tweet.url,
        source: `Twitter @${username}`,
        isCreatedBy: "manual", // ✅ FIX: Corrected from "manual"
        publishedAt: new Date(tweet.date),
        media: tweet.media,
      };

      return Article.updateOne({ url: articleData.url }, { $setOnInsert: articleData }, { upsert: true });
    });
    
    const results = await Promise.all(savePromises);
    const newArticlesSavedCount = results.filter(r => r.upsertedCount > 0).length;

    console.log(`Database complete: ${newArticlesSavedCount} new articles were saved.`);

    res.status(200).json({
      message: "Scrape and save operation completed successfully.",
      username,
      newArticlesSaved: newArticlesSavedCount,
      articles: tweetsToSave,
    });

  } catch (error) {
    console.error(`❌ Top-level error for @${username}:`, error);
    res.status(500).json({ error: "Failed to scrape or save tweets.", details: error.message });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`🚀 Server is live on http://localhost:${PORT}`);
});

