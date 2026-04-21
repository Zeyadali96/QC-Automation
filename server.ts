import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { google } from "googleapis";
import stringSimilarity from "string-similarity";
import sharp from "sharp";
import { differenceInDays } from 'date-fns';
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

// Use stealth plugin
chromium.use(stealth());

function getUniqueImages(images: string[]): string[] {
  if (!images || images.length === 0) return [];
  
  const cleanedUrls = images.map(url => {
    // Amazon High-Res Normalizer: Strips all sizing fragments like ._AC_..._
    // Also handles Bol.com normalization
    if (url.includes('amazon.com') || url.includes('ssl-images-amazon.com')) {
      return url.replace(/\._[A-Z0-9,_-]+_\./g, '.');
    }
    if (url.includes('media.s-bol.com')) {
      return url.replace(/\/\d+x\d+\//, "/large/").replace("/small/", "/large/").replace("/thumb/", "/large/");
    }
    return url;
  });

  // Extract Amazon image ID (like B0BZ4V1N4Y) or just deduplicate the normalized URL
  return Array.from(new Set(cleanedUrls)).filter(url => url && url.startsWith('http'));
}

function cleanText(text: string): string {
  if (!text) return "";
  return text.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function performAudit(master: any, live: any, type: string, domain?: string) {
  const results: any = {};

  results.title = {
    master: master.title,
    live: live.title,
    similarity: stringSimilarity.compareTwoStrings(cleanText(master.title), cleanText(live.title)),
    match: stringSimilarity.compareTwoStrings(cleanText(master.title), cleanText(live.title)) > 0.8
  };

  results.description = {
    master: master.description,
    live: live.description,
    similarity: stringSimilarity.compareTwoStrings(cleanText(master.description), cleanText(live.description)),
    match: stringSimilarity.compareTwoStrings(cleanText(master.description), cleanText(live.description)) > 0.7
  };

  results.bullets = (live.bullets || []).map((bullet: string, idx: number) => {
    const masterBullet = master[`bullet${idx+1}`] || "";
    return {
      master: masterBullet,
      live: bullet,
      similarity: stringSimilarity.compareTwoStrings(cleanText(masterBullet), cleanText(bullet)),
      match: stringSimilarity.compareTwoStrings(cleanText(masterBullet), cleanText(bullet)) > 0.8
    };
  });

  results.hasAPlus = {
    master: !!master.hasAPlus,
    live: !!live.hasAPlus,
    match: !!master.hasAPlus === !!live.hasAPlus
  };

  results.variations = {
    master: !!master.variations,
    live: !!live.variations,
    match: !!master.variations === !!live.variations
  };

  results.price = {
    master: master.price,
    live: live.price,
    match: master.price == live.price
  };

  results.shipping = {
    master: master.shipping,
    live: live.shipping,
    similarity: stringSimilarity.compareTwoStrings(cleanText(master.shipping), cleanText(live.shipping)),
    match: cleanText(master.shipping) === cleanText(live.shipping)
  };

  const masterImages = master.images || [];
  const liveImages = live.images || [];
  const masterFirst = masterImages[0] || "";
  const liveFirst = liveImages[0] || "";
  
  const getFilename = (url: string) => url.split('/').pop()?.split('?')[0] || "";
  const isImageMatch = masterFirst && liveFirst && (masterFirst === liveFirst || getFilename(masterFirst) === getFilename(liveFirst));

  results.images = {
    master: masterImages,
    live: liveImages,
    match: isImageMatch
  };

  return results;
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // 1. Fetch Google Sheet Data
  app.post("/api/sheets/fetch", async (req, res) => {
    try {
      const { sheetId, sheetName } = req.body;
      const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!serviceAccountEmail || !privateKey) {
        return res.status(400).json({ error: "Google Sheets credentials not configured." });
      }

      const auth = new JWT({ email: serviceAccountEmail, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      const doc = new GoogleSpreadsheet(sheetId, auth);
      await doc.loadInfo();
      const sheet = sheetName ? doc.sheetsByTitle[sheetName] : doc.sheetsByIndex[0];
      const rows = await sheet.getRows();
      res.json({ data: rows.map(row => row.toObject()), title: doc.title });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 2. Audit Amazon
  app.post("/api/audit/amazon", async (req, res) => {
    let browser;
    try {
      const { asin, marketplace, masterData } = req.body;
      const domain = marketplace || 'amazon.com';
      const url = `https://www.${domain}/dp/${asin}`;
      
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
      });

      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      const isCaptcha = await page.evaluate(() => document.title.includes('Robot Check') || document.body.innerText.includes('Type the characters'));
      if (isCaptcha) throw new Error("Amazon blocked with CAPTCHA.");

      await page.waitForTimeout(3000);
      
      const rawData = await page.evaluate(() => {
        const title = (document.querySelector('#productTitle') as any)?.innerText.trim() || "";
        const price = (document.querySelector('.a-price .a-offscreen') as any)?.innerText.trim() || "N/A";
        const ship = (document.querySelector('#mir-layout-DELIVERY_BLOCK') as any)?.innerText.trim() || "N/A";
        
        let images: string[] = [];
        const imgEl = document.querySelector('#landingImage');
        const dynamicJson = imgEl?.getAttribute('data-a-dynamic-image');
        if (dynamicJson) {
           images = Object.keys(JSON.parse(dynamicJson));
        }

        const aPlus = !!document.querySelector('.aplus-v2, #aplus');
        const desc = (document.querySelector('#productDescription') as any)?.innerText.trim() || "";
        const bullets = Array.from(document.querySelectorAll('#feature-bullets li span')).map(s => (s as any).innerText.trim()).filter(t => t.length > 5);
        const variations = !!document.querySelector('#twister');

        return { title, price, shipping: ship, images, hasAPlus: aPlus, description: desc, bullets, variations };
      });

      const liveData = {
        ...rawData,
        images: getUniqueImages(rawData.images),
        shipping: rawData.shipping // Simplified for now
      };

      const auditResult = performAudit(masterData, liveData, 'amazon', domain);
      res.json({ liveData, auditResult });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    } finally {
      if (browser) await browser.close();
    }
  });

  // 3. Audit Bol.com
  app.post("/api/audit/bol", async (req, res) => {
    let browser;
    try {
      const { ean, masterData } = req.body;
      const searchUrl = `https://www.bol.com/nl/nl/s/?searchtext=${ean}`;
      
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
      const page = await context.newPage();
      
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      
      if (await page.evaluate(() => document.title.includes('geblokkeerd') || document.body.innerText.includes('Access Denied'))) {
        throw new Error("Bol.com blocked the server IP.");
      }

      const firstProductLink = await page.getAttribute('a[href*="/p/"]:not([href*="javascript"])', 'href');
      if (firstProductLink) {
        await page.goto(firstProductLink.startsWith('http') ? firstProductLink : `https://www.bol.com${firstProductLink}`, { waitUntil: 'domcontentloaded' });
      }

      await page.waitForTimeout(3000);

      const rawData = await page.evaluate(() => {
        const title = (document.querySelector('[data-test="title"]') as any)?.innerText.trim() || "";
        const price = (document.querySelector('[data-test="price"]') as any)?.innerText.replace(/\s+/g, '').replace('€', '').trim() || "N/A";
        const ship = (document.querySelector('[data-test="delivery-highlight"]') as any)?.innerText.trim() || "N/A";
        
        let images: string[] = [];
        document.querySelectorAll('.js_product_media_items img, .pdp-images img').forEach(img => {
          const src = (img as any).src;
          if (src && src.includes('media.s-bol.com')) images.push(src);
        });

        const desc = (document.querySelector('[data-test="description-content"]') as any)?.innerText.trim() || "";
        const bullets = Array.from(document.querySelectorAll('[data-test="product-features"] li')).map(li => (li as any).innerText.trim());
        const variations = !!document.querySelector('[data-test="variant-selector"]');
        const aPlus = !!document.querySelector('.js_product_info img');

        return { title, price, shipping: ship, images, description: desc, bullets, variations, hasAPlus: aPlus };
      });

      const liveData = {
        ...rawData,
        images: getUniqueImages(rawData.images)
      };

      const auditResult = performAudit(masterData, liveData, 'bol');
      res.json({ liveData, auditResult });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    } finally {
      if (browser) await browser.close();
    }
  });

  // Standard Vite setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*', (req, res) => res.sendFile(path.join(process.cwd(), 'dist', 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
}

startServer().catch(err => {
  console.error("Critical Error starting server:", err);
  process.exit(1);
});
