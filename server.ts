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
import { differenceInDays, parse } from 'date-fns';
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

// Use stealth plugin
chromium.use(stealth());

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Make core helpers available globally for access inside nested routes after esbuild minification
  (globalThis as any).getUniqueImages = getUniqueImages;
  (globalThis as any).performAudit = performAudit;
  (globalThis as any).cleanText = cleanText;
  (globalThis as any).getImageHash = getImageHash;
  (globalThis as any).compareHashes = compareHashes;

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // API Routes
  
  // 1. Fetch Google Sheet Data
  app.post("/api/sheets/fetch", async (req, res) => {
    try {
      const { sheetId, sheetName } = req.body;
      
      const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!serviceAccountEmail || !privateKey) {
        return res.status(400).json({ error: "Google Sheets credentials not configured in environment variables." });
      }

      const auth = new JWT({
        email: serviceAccountEmail,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const doc = new GoogleSpreadsheet(sheetId, auth);
      await doc.loadInfo();
      
      const sheet = sheetName ? doc.sheetsByTitle[sheetName] : doc.sheetsByIndex[0];
      
      if (!sheet) {
        return res.status(404).json({ 
          error: `Sheet "${sheetName || 'at index 0'}" not found in spreadsheet. Available sheets: ${Object.keys(doc.sheetsByTitle).join(', ')}` 
        });
      }

      const rows = await sheet.getRows();
      
      const data = rows.map(row => row.toObject());
      res.json({ data, title: doc.title });
    } catch (error: any) {
      console.error("Sheets Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // 2. Audit Amazon
  app.post("/api/audit/amazon", async (req, res) => {
    let browser: any;
    try {
      const { asin, marketplace, masterData } = req.body;
      const domain = marketplace || 'amazon.com';
      const url = `https://www.${domain}/dp/${asin}`;
      
      const launchOptions: any = { 
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      };
      if (process.env.ANTIGRAVITY_API_KEY) {
        let region = 'us';
        if (domain.endsWith('.co.uk')) region = 'uk';
        else if (domain.endsWith('.de')) region = 'de';
        else if (domain.endsWith('.pl')) region = 'pl';
        launchOptions.proxy = {
          server: `http://${process.env.ANTIGRAVITY_API_KEY}:residential-${region}@proxy.antigravityai.com:8080`
        };
      }
      
      browser = await chromium.launch(launchOptions);
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
      });
      const page = await context.newPage();
      
      console.log(`Auditing Amazon: ${url}`);
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(3000);

      const livedata = await page.evaluate(`() => {
        const getT = (s) => document.querySelector(s)?.innerText?.trim() || "";
        
        // Price Extraction
        const priceSelectors = [
          '#price_inside_buybox',
          '#corePrice_feature_div .a-offscreen',
          '#priceblock_ourprice',
          '.a-price span.a-offscreen',
          '#managed-price-asin',
          '#kindle-price',
          '#priceblock_dealprice'
        ];
        let priceText = "";
        for (const s of priceSelectors) {
          const t = getT(s);
          if (t) { priceText = t; break; }
        }
        
        // Clean price: handle 10,99 (EU) and 10.99 (US/UK)
        let price = "N/A";
        if (priceText) {
          const match = priceText.match(/(\\d+[,.]\\d{2})/) || priceText.match(/(\\d+)/);
          if (match) {
            price = match[0].replace(',', '.');
          }
        }

        // Shipping Extraction
        const shipSelectors = [
          '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID',
          '#deliveryBlockMessage',
          '#corePrice_feature_div + div span[data-csa-c-type="element"]',
          '#shippingMessage',
          '#upsell-messaging',
          '.a-spacing-base .a-text-bold',
          '.mir-delivery-message-text'
        ];
        let shipping = "N/A";
        for (const s of shipSelectors) {
          const t = getT(s);
          if (t && t.length > 5) { shipping = t; break; }
        }

        // Images
        const images = [];
        const imgElements = document.querySelectorAll('#landingImage, #imgTagWrapperId img, .a-dynamic-image, #main-image, .imgTagWrapper img');
        imgElements.forEach(el => {
          const src = el.getAttribute('data-old-hires') || el.getAttribute('src') || el.getAttribute('data-a-dynamic-image');
          if (src) {
            if (src.startsWith('{')) {
              try { images.push(Object.keys(JSON.parse(src))[0]); } catch(e){}
            } else {
              images.push(src);
            }
          }
        });

        // Bullets
        const bullets = [];
        document.querySelectorAll('#feature-bullets ul li span').forEach(el => {
          const t = el.innerText?.trim() || "";
          if (t && t.length > 5 && !t.includes('fits')) bullets.push(t);
        });

        const hasAPlus = !!document.querySelector('.aplus-v2, #aplus, #premium-aplus');

        return {
          title: getT('#productTitle'),
          images,
          bullets,
          description: getT('#productDescription') || (hasAPlus ? "A+ Content Present" : "No description"),
          hasAPlus,
          variations: !!document.querySelector('#twister'),
          shipping,
          price
        };
      }`);

      // Cleanup images in server-side helper
      if (livedata) {
        livedata.images = (globalThis as any).getUniqueImages(livedata.images || []);
      }

      const auditResult = (globalThis as any).performAudit(masterData, livedata, 'amazon', domain);
      res.json({ liveData: livedata, auditResult });
    } catch (error: any) {
      console.error("Amazon Audit Error:", error);
      res.status(500).json({ error: error.message });
    } finally {
      if (browser) await browser.close();
    }
  });

  // 3. Audit Bol.com
  app.post("/api/audit/bol", async (req, res) => {
    let browser: any;
    try {
      const { ean, masterData } = req.body;
      const searchUrl = `https://www.bol.com/nl/nl/s/?searchtext=${ean}`;
      
      const launchOptions: any = { 
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      };
      
      if (process.env.ANTIGRAVITY_API_KEY) {
        launchOptions.proxy = {
          server: `http://proxy.antigravityai.com:8080`,
          username: process.env.ANTIGRAVITY_API_KEY,
          password: 'residential-nl'
        };
      }
      
      browser = await chromium.launch(launchOptions);
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        extraHTTPHeaders: {
          'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
        }
      });
      const page = await context.newPage();
      
      console.log(`Auditing Bol: ${searchUrl}`);
      // Navigate to home page first to get cookies
      await page.goto('https://www.bol.com/nl/nl/', { waitUntil: 'load', timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(1000);
      
      // Click consent if present
      await page.evaluate(`() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.toLowerCase().includes('accepteer') || b.id.includes('accept'));
        if (btn) btn.click();
      }`).catch(() => null);
      
      // Search
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);

      // Check if on search page or product page
      let isProductPage = await page.evaluate(`() => !!document.querySelector('[data-test="title"], h1.page-title')`);
      
      if (!isProductPage) {
        const isSearchPage = await page.evaluate(`() => !!document.querySelector('.product-list, [data-test="product-list"]')`);
        if (isSearchPage) {
          const link = await page.waitForSelector('a[href*="/p/"]', { timeout: 10000 }).catch(() => null);
          if (link) {
            const href = await link.getAttribute('href');
            if (href) {
              await page.goto(href.startsWith('http') ? href : `https://www.bol.com${href}`, { waitUntil: 'networkidle' });
            }
          }
        }
      }

      // Wait for product details to hydrate
      await page.waitForSelector('[data-test="title"], h1.page-title', { timeout: 10000 }).catch(() => null);
      await page.evaluate(`() => window.scrollBy(0, 800)`);
      await page.waitForTimeout(2000);

      const liveDataRaw = await page.evaluate(`() => {
        const getT = (s) => document.querySelector(s)?.innerText?.trim() || "";
        
        // Advanced Title
        const title = getT('[data-test="title"]') || getT('h1.page-title') || getT('.product-title') || document.title;
        
        // Advanced Price (Bol often splits price into whole and fraction)
        let priceStr = "";
        const priceEl = document.querySelector('[data-test="price"], .promo-price');
        if (priceEl) {
          const whole = priceEl.querySelector('.promo-price__whole')?.innerText?.trim() || "";
          const fraction = priceEl.querySelector('.promo-price__fraction')?.innerText?.trim() || "";
          if (whole) {
            priceStr = whole + "." + (fraction || "00");
          } else {
            priceStr = priceEl.innerText.trim();
          }
        }
        
        if (!priceStr || priceStr === "N/A") {
          priceStr = getT('.buying-block__price') || getT('.js_delivery_info .price');
        }

        const priceMatch = priceStr.match(/(\\d+)[,.](\\d{2})/) || priceStr.match(/(\\d+)/);
        const price = priceMatch ? (priceMatch[2] ? priceMatch[1] + "." + priceMatch[2] : priceMatch[1] + ".00") : "N/A";

        // Images
        const images = [];
        document.querySelectorAll('img[src*="media.s-bol.com"], [data-test="media-items"] img').forEach(img => {
          const src = img.src || img.getAttribute('data-src');
          if (src && !images.includes(src)) images.push(src);
        });

        // Bullets
        const bullets = [];
        const bulletSelectors = [
          '[data-test="product-features"] li',
          '.product-features li',
          '.specs-list li',
          '.product-specifications li'
        ];
        for (const s of bulletSelectors) {
          const els = document.querySelectorAll(s);
          if (els.length > 0) {
            els.forEach(li => bullets.push(li.innerText.trim()));
            break;
          }
        }

        // Description
        const description = getT('[data-test="description"]') || getT('.js_product_description') || getT('.product-description');

        return {
          title,
          price,
          images: images || [],
          bullets: bullets || [],
          description,
          variations: document.querySelectorAll('.js_attribute_selector, [data-test="variant-selector"], .variant-selector').length > 0 ? 1 : 0,
          hasAPlus: document.querySelectorAll('.js_product_description img, .manufacturer-info img, [data-test="description"] img').length > 0 ? 1 : 0,
          shipping: getT('[data-test="delivery-highlight"]') || getT('.js_delivery_info') || getT('.shipping-delivery-promise') || "N/A"
        };
      }`);

      const livedata = {
        ...liveDataRaw,
        images: (globalThis as any).getUniqueImages(liveDataRaw?.images || [])
      };

      const auditResult = (globalThis as any).performAudit(masterData, livedata, 'bol');
      res.json({ liveData: livedata, auditResult });

    } catch (error: any) {
      console.error("Bol Audit Fatal Error:", error);
      res.status(500).json({ error: error.message });
    } finally {
      if (browser) await browser.close();
    }
  });

  function prepareRowData(mode: string, auditResult: any, masterData: any, marketplace: string, identifier: string) {
    const getMatchText = (isMatch: boolean) => isMatch ? 'Yes' : 'No';
    const getAPlusText = (hasAPlus: boolean) => hasAPlus ? 'Available' : 'Not Available';
    const getVariationText = (exists: boolean) => exists ? 'Yes' : 'No';
    
    // Extreme safety checks for missing audit data
    if (!auditResult) auditResult = { title: {}, description: {}, price: {}, shipping: {}, bullets: [], images: { live: [] }, hasAPlus: {}, variations: {} };
    if (!masterData) masterData = { images: [] };

    const masterFirst = (masterData.images && masterData.images[0]) || "";
    const liveFirst = (auditResult.images?.live && auditResult.images.live[0]) || "";
    const allLiveImages = (auditResult.images?.live || []).join(", ");
    
    const sharedData: any = {
      "Identifier": identifier || "N/A",
      "SKU": identifier || "N/A",
      "Title match": getMatchText(auditResult.title?.match),
      "Title Match": getMatchText(auditResult.title?.match),
      "Description match": getMatchText(auditResult.description?.match),
      "Description Match": getMatchText(auditResult.description?.match),
      "Main Image Link": masterFirst,
      "Live Image Links": allLiveImages,
      "Main Image": masterFirst ? `=IMAGE("${masterFirst}")` : "",
      "Live Image": liveFirst ? `=IMAGE("${liveFirst}")` : "",
      "Main Live Image": liveFirst ? `=IMAGE("${liveFirst}")` : "",
      "Image 1": masterFirst, 
      "Live Image 1": liveFirst,
      "A+ Content": getAPlusText(auditResult.hasAPlus?.live),
      "A+": getAPlusText(auditResult.hasAPlus?.live),
      "Has A+": getAPlusText(auditResult.hasAPlus?.live),
      "Shipping Time": auditResult.shipping?.live || "N/A",
      "Shipping": auditResult.shipping?.live || "N/A",
      "Delivery Days": auditResult.shipping?.live || "N/A",
      "Price": auditResult.price?.live || "N/A",
      "Variation": getVariationText(auditResult.variations?.live),
      "Variations": getVariationText(auditResult.variations?.live),
      "Variation Match": getVariationText(auditResult.variations?.live),
      "Bullet Points match": auditResult.bullets ? getMatchText(auditResult.bullets.length > 0 && auditResult.bullets.every((b: any) => b.match)) : "N/A",
      "Bullet Points Match": auditResult.bullets ? getMatchText(auditResult.bullets.length > 0 && auditResult.bullets.every((b: any) => b.match)) : "N/A",
      "Bullets Match": auditResult.bullets ? getMatchText(auditResult.bullets.length > 0 && auditResult.bullets.every((b: any) => b.match)) : "N/A"
    };

    const prefix = mode === 'amazon' ? 'Amazon' : 'Bol';
    const masterImgs = masterData.images || [];
    const liveImgs = auditResult.images?.live || [];

    sharedData[`${prefix} Main Image`] = masterImgs[0] ? `=IMAGE("${masterImgs[0]}")` : "";
    sharedData[`${prefix} Main Live Image`] = liveImgs[0] ? `=IMAGE("${liveImgs[0]}")` : "";

    for (let i = 1; i <= 10; i++) {
      const url = masterImgs[i-1] || "";
      sharedData[`${prefix} Master Image ${i}`] = url ? `=IMAGE("${url}")` : "";
      const lUrl = liveImgs[i-1] || "";
      sharedData[`${prefix} Live Image ${i}`] = lUrl ? `=IMAGE("${lUrl}")` : "";
    }

    if (mode === 'amazon') {
      const allBulletsMatch = auditResult.bullets && auditResult.bullets.length > 0 && auditResult.bullets.every((b: any) => b.match);
      return {
        "ASIN": identifier,
        "Marketplace": marketplace,
        "Bullet Points match": getMatchText(allBulletsMatch),
        ...sharedData
      };
    } else {
      return {
        "EAN": identifier,
        "Marketplace": "Bol.com",
        ...sharedData
      };
    }
  }

  // 4. Clear Target Tab Data
  app.post("/api/sheets/clear-sheet", async (req, res) => {
    try {
      const { mode } = req.body;
      const targetSheetId = "1V4lNf30SlBwczSvGX9rfn5eWFH2AvMO4TqMHAHalS7s";
      const targetTab = mode === 'amazon' ? 'Amazon QC Results' : 'Bol QC Results';
      
      const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!serviceAccountEmail || !privateKey) {
        return res.status(400).json({ error: "Google Sheets credentials not configured." });
      }

      const auth = new JWT({
        email: serviceAccountEmail,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const sheets = google.sheets({ version: 'v4', auth });
      
      // Wipe protocol: Strict Clear A2:AZ1000
      await sheets.spreadsheets.values.clear({
        spreadsheetId: targetSheetId,
        range: `'${targetTab}'!A2:AZ1000`,
      });
      
      res.json({ success: true, message: `Tab "${targetTab}" cleared A2:AZ1000.` });
    } catch (error: any) {
      console.error("Clear Sheet Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // 5. Save Audit Result to QC Automation Sheet (Singular)
  app.post("/api/sheets/save-audit", async (req, res) => {
    try {
      const { mode, auditResult, masterData, marketplace, identifier } = req.body;
      const targetSheetId = "1V4lNf30SlBwczSvGX9rfn5eWFH2AvMO4TqMHAHalS7s";
      const targetTab = mode === 'amazon' ? 'Amazon QC Results' : 'Bol QC Results';
      
      const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!serviceAccountEmail || !privateKey) {
        return res.status(400).json({ error: "Google Sheets credentials not configured." });
      }

      const auth = new JWT({
        email: serviceAccountEmail,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const sheets = google.sheets({ version: 'v4', auth });
      const doc = new GoogleSpreadsheet(targetSheetId, auth);
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle[targetTab];
      
      if (!sheet) {
        return res.status(404).json({ error: `Tab "${targetTab}" not found.` });
      }

      await sheet.loadHeaderRow();
      const headers = sheet.headerValues;
      const rowData = prepareRowData(mode, auditResult, masterData, marketplace, identifier);
      
      // Map to header order for batch update
      const rowArray = headers.map(h => {
        const key = Object.keys(rowData).find(k => k.toLowerCase() === h.toLowerCase());
        return key ? rowData[key] : "";
      });

      // 1. Wipe protocol: Clear A2:AZ1000
      await sheets.spreadsheets.values.clear({
        spreadsheetId: targetSheetId,
        range: `'${targetTab}'!A2:AZ1000`,
      });

      // 2. Overwrite logic: Start writing at A2
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId,
        range: `'${targetTab}'!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [rowArray]
        }
      });
      
      res.json({ success: true, tab: targetTab, overrode: true });
    } catch (error: any) {
      console.error("Save Audit Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // 6. Batch Save Audit Results
  app.post("/api/sheets/batch-save-audit", async (req, res) => {
    try {
      const { mode, audits } = req.body; // audits is array of { auditResult, masterData, marketplace, identifier }
      const targetSheetId = "1V4lNf30SlBwczSvGX9rfn5eWFH2AvMO4TqMHAHalS7s";
      const targetTab = mode === 'amazon' ? 'Amazon QC Results' : 'Bol QC Results';
      
      const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!serviceAccountEmail || !privateKey) {
        return res.status(400).json({ error: "Google Sheets credentials not configured." });
      }

      const auth = new JWT({
        email: serviceAccountEmail,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const sheets = google.sheets({ version: 'v4', auth });
      const doc = new GoogleSpreadsheet(targetSheetId, auth);
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle[targetTab];
      
      if (!sheet) {
        return res.status(404).json({ error: `Tab "${targetTab}" not found.` });
      }

      await sheet.loadHeaderRow();
      const headers = sheet.headerValues;
      const allRows = audits.map((a: any) => {
        const rowData = prepareRowData(mode, a.auditResult, a.masterData, a.marketplace, a.identifier);
        return headers.map(h => {
          const key = Object.keys(rowData).find(k => k.toLowerCase() === h.toLowerCase());
          return key ? rowData[key] : "";
        });
      });

      // 1. Wipe protocol: Clear A2:AZ1000
      await sheets.spreadsheets.values.clear({
        spreadsheetId: targetSheetId,
        range: `'${targetTab}'!A2:AZ1000`,
      });

      // 2. Overwrite logic: Start writing at A2
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId,
        range: `'${targetTab}'!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: allRows
        }
      });
      
      res.json({ success: true, count: allRows.length });
    } catch (error: any) {
      console.error("Batch Save Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // 7. Image Proxy for Google Drive/UserContent
  app.get("/api/proxy-image", async (req, res) => {
    let imageUrl = req.query.url as string;
    try {
      if (!imageUrl) return res.status(400).send("URL is required");

      // Transform Google Drive "view" links to "download" links
      if (imageUrl.includes('drive.google.com')) {
        const fileIdMatch = imageUrl.match(/\/d\/([^\/]+)/);
        if (fileIdMatch) {
          imageUrl = `https://drive.google.com/uc?export=download&id=${fileIdMatch[1]}`;
        }
      }

      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        },
        timeout: 15000
      });

      const contentType = response.headers['content-type'];
      res.setHeader('Content-Type', contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(response.data);
    } catch (error: any) {
      console.error(`Proxy Error for URL [${imageUrl}]:`, error.message);
      res.status(500).send(`Failed to fetch image: ${error.message}`);
    }
  });

  // 5. Image Comparison Helper
  app.post("/api/images/compare", async (req, res) => {
    try {
      const { url1, url2 } = req.body;
      
      const img1Resp = await axios.get(url1, { responseType: 'arraybuffer' });
      const img2Resp = await axios.get(url2, { responseType: 'arraybuffer' });
      
      const hash1 = await getImageHash(Buffer.from(img1Resp.data));
      const hash2 = await getImageHash(Buffer.from(img2Resp.data));
      
      const similarity = compareHashes(hash1, hash2);
      res.json({ similarity });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  function cleanText(text: string): string {
    if (!text) return "";
    let cleaned = String(text);
    // Strip everything that isn't a letter or number for exact comparison (Google Sheets Fix)
    return cleaned.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }

  function getUniqueImages(urlList: string[]) {
    if (!urlList || !Array.isArray(urlList)) return [];
    const idToUrlMap = new Map<string, string>();
    const finalImages: string[] = [];
    
    for (const url of urlList) {
      if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;
      
      let imgId = "";
      let isAmazon = false;
      let processedUrl = url;
      
      if (url.includes('amazon.com') || url.includes('media-amazon.com')) {
        isAmazon = true;
        try {
          if (url.includes('/I/')) {
            imgId = url.split('/I/')[1].split('.')[0];
          } else {
            const match = url.match(/\/images\/I\/([A-Za-z0-9_-]+)/);
            if (match) imgId = match[1];
          }
        } catch (e) {
          const match = url.match(/\/images\/I\/([A-Za-z0-9_-]+)/);
          if (match) imgId = match[1];
        }
      } else if (url.includes('media.s-bol.com')) {
        const match = url.match(/media\.s-bol\.com\/([A-Za-z0-9_-]+)/);
        if (match) imgId = match[1];
        
        // Normalize Bol URLs to large version
        processedUrl = url.replace(/\/\d+x\d+\//, "/large/")
                          .replace("/small/", "/large/")
                          .replace("/slot/", "/large/")
                          .replace("/thumb/", "/large/")
                          .replace("/100x100/", "/large/")
                          .replace("/124x124/", "/large/")
                          .replace("/140x140/", "/large/")
                          .replace("/210x210/", "/large/")
                          .replace("/40x40/", "/large/");
      } else {
        const match = url.match(/\/([A-Za-z0-9_-]{10,20})/);
        if (match) imgId = match[1];
      }

      if (imgId) {
        if (isAmazon) {
          const existingUrl = idToUrlMap.get(imgId);
          if (!existingUrl) {
            idToUrlMap.set(imgId, url);
          } else {
            const getRes = (u: string) => {
              if (u.includes('SL1500') || u.includes('original')) return 9999;
              const match = u.match(/SL(\d+)/);
              return match ? parseInt(match[1]) : 0;
            };
            if (getRes(url) > getRes(existingUrl)) {
              idToUrlMap.set(imgId, url);
            }
          }
        } else {
          if (!idToUrlMap.has(imgId)) {
            idToUrlMap.set(imgId, processedUrl);
          }
        }
      } else {
        if (!finalImages.includes(url)) {
          finalImages.push(url);
        }
      }
    }

    return [...Array.from(idToUrlMap.values()), ...finalImages];
  }

  function performAudit(master: any, live: any, mode: 'amazon' | 'bol', domain?: string) {
    const results: any = {};
    
    // Title Comparison
    const cleanMasterTitle = cleanText(master?.title || "");
    const cleanLiveTitle = cleanText(live?.title || "");
    const titleSimilarity = stringSimilarity.compareTwoStrings(cleanMasterTitle, cleanLiveTitle);
    results.title = {
      master: master?.title || "N/A",
      live: live?.title || "N/A",
      similarity: titleSimilarity,
      match: cleanMasterTitle === cleanLiveTitle
    };

    // Description Comparison
    const liveDesc = live?.description || "";
    const masterDesc = master?.description || "";
    const isImageDesc = liveDesc.startsWith('IMAGE:');
    const isAPlusImages = liveDesc.startsWith('APLUS_IMAGES:');
    const isAPlusData = liveDesc.startsWith('APLUS_DATA:');
    const cleanMasterDesc = cleanText(masterDesc);
    const cleanLiveDesc = (isImageDesc || isAPlusImages || isAPlusData) ? "" : cleanText(liveDesc);
    const descSimilarity = (isImageDesc || isAPlusImages || isAPlusData) ? 0.5 : stringSimilarity.compareTwoStrings(cleanMasterDesc, cleanLiveDesc);
    
    results.description = {
      master: masterDesc,
      live: liveDesc,
      similarity: descSimilarity,
      match: (isImageDesc || isAPlusImages || isAPlusData) ? false : (cleanMasterDesc === cleanLiveDesc),
      isImage: isImageDesc || isAPlusImages || isAPlusData,
      isAPlus: isAPlusImages || isAPlusData,
      status: ((isAPlusImages || isAPlusData) && cleanMasterDesc) ? "Manual Check Required: A+ Content Live" : null
    };

    // Currency Validation
    results.currency = {
      expected: "N/A",
      actual: live?.currency || "N/A",
      match: true
    };

    // Bullet Points Comparison
    const mBullets = master?.bullets || [];
    const lBullets = live?.bullets || [];
    results.bullets = mBullets.map((mb: string, i: number) => {
      const lb = lBullets[i] || "";
      const cmb = cleanText(mb);
      const clb = cleanText(lb);
      const similarity = stringSimilarity.compareTwoStrings(cmb, clb);
      return {
        master: mb,
        live: lb,
        similarity: similarity,
        match: cmb === clb
      };
    });

    results.hasAPlus = {
      master: !!(master?.hasAPlus),
      live: !!(live?.hasAPlus),
      match: !!(master?.hasAPlus) === !!(live?.hasAPlus)
    };

    results.variations = {
      master: !!(master?.variations),
      live: !!(live?.variations),
      match: !!(master?.variations) === !!(live?.variations)
    };

    results.price = {
      master: master?.price || "N/A",
      live: live?.price || "N/A",
      match: (master?.price || "N/A") == (live?.price || "N/A")
    };

    const mShip = master?.shipping || "";
    const lShip = live?.shipping || "";
    results.shipping = {
      master: mShip,
      live: lShip,
      similarity: stringSimilarity.compareTwoStrings(cleanText(mShip), cleanText(lShip)),
      match: cleanText(mShip) === cleanText(lShip)
    };

    // Image comparison results
    const masterImages = master?.images || [];
    const liveImages = live?.images || [];
    const masterFirst = masterImages[0] || "";
    const liveFirst = liveImages[0] || "";
    
    // Simple match logic
    const getFilename = (url: string) => (url || "").split('/').pop()?.split('?')[0] || "";
    const isImageMatch = masterFirst && liveFirst && (masterFirst === liveFirst || getFilename(masterFirst) === getFilename(liveFirst));

    results.images = {
      master: masterImages,
      live: liveImages,
      match: isImageMatch
    };

    return results;
  }

  async function getImageHash(buffer: Buffer) {
    // Basic hash: resize to 8x8 and convert to grayscale
    const { data } = await sharp(buffer)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  }

  function compareHashes(h1: Buffer, h2: Buffer) {
    let diff = 0;
    for (let i = 0; i < h1.length; i++) {
      if (Math.abs(h1[i] - h2[i]) > 20) diff++;
    }
    return 1 - (diff / h1.length);
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
