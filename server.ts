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
          '--disable-gpu'
        ]
      };
      
      if (process.env.ANTIGRAVITY_API_KEY) {
        let proxyRegion = 'us';
        if (domain.endsWith('.co.uk')) proxyRegion = 'uk';
        else if (domain.endsWith('.de')) proxyRegion = 'de';
        else if (domain.endsWith('.nl')) proxyRegion = 'nl';
        
        launchOptions.proxy = {
          server: `http://proxy.antigravityai.com:8080`,
          username: process.env.ANTIGRAVITY_API_KEY,
          password: `residential-${proxyRegion}`
        };
      }
      
      browser = await chromium.launch(launchOptions);
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
      });
      const page = await context.newPage();
      
      console.log(`Auditing Amazon: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      // Extraction logic - Using page.evaluate for better accuracy after hydration
      const liveData = await page.evaluate(`() => {
        const getT = (s) => document.querySelector(s)?.textContent?.trim() || "";
        
        // 1. Images
        const images = [];
        const mainImg = document.querySelector('#landingImage') || document.querySelector('#imgTagWrapperId img') || document.querySelector('#main-image');
        if (mainImg) {
          const src = mainImg.getAttribute('data-old-hires') || mainImg.getAttribute('src');
          if (src && src.startsWith('http')) images.push(src);
        }
        
        document.querySelectorAll('#altImages li img').forEach(img => {
          const src = img.getAttribute('data-old-hires') || img.getAttribute('src');
          if (src && src.startsWith('http') && !images.includes(src)) images.push(src);
        });

        // 2. Bullets
        const bullets = [];
        document.querySelectorAll('#feature-bullets li span.a-list-item').forEach(el => {
          const t = el.textContent?.trim() || "";
          if (t.length > 5) bullets.push(t);
        });

        // 3. Price
        const pEl = document.querySelector('#corePrice_feature_div .a-offscreen') || 
                    document.querySelector('#priceblock_ourprice') || 
                    document.querySelector('.a-price span.a-offscreen');
        const price = pEl?.textContent?.trim() || "N/A";

        // 4. Shipping
        const sEl = document.querySelector('#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID') || 
                    document.querySelector('#deliveryBlockMessage') ||
                    document.querySelector('.mir-delivery-message-text');
        const shipping = sEl?.textContent?.trim() || "N/A";

        return {
          title: getT('#productTitle'),
          description: getT('#productDescription') || (document.querySelector('.aplus-v2') ? "A+ Content Present" : "No description"),
          bullets,
          price,
          shipping,
          images,
          hasAPlus: !!document.querySelector('.aplus-v2, #aplus, #premium-aplus'),
          variations: !!document.querySelector('#twister, #inline-twister-row-size_name, #inline-twister-row-color_name')
        };
      }`);

      // Post-process images
      liveData.images = getUniqueImages(liveData.images);

      const auditResult = performAudit(masterData, liveData, 'amazon', domain);
      res.json({ liveData, auditResult });

    } catch (error: any) {
      console.error("Amazon Audit Fatal Error:", error);
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
        args: ['--no-sandbox', '--disable-setuid-sandbox']
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
        extraHTTPHeaders: { 'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7' }
      });
      const page = await context.newPage();
      
      console.log(`Auditing Bol: ${searchUrl}`);
      // Simple logic: Consent -> Search -> Link -> Extraction
      await page.goto('https://www.bol.com/nl/nl/', { waitUntil: 'load', timeout: 30000 }).catch(() => null);
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(el => el.innerText.includes('Accepteer'));
        if (b) (b as any).click();
      }).catch(() => null);
      
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      let isProductPage = await page.evaluate(() => !!document.querySelector('[data-test="title"]'));
      
      if (!isProductPage) {
        const link = await page.waitForSelector('a[href*="/p/"]', { timeout: 10000 }).catch(() => null);
        if (link) {
          const href = await link.getAttribute('href');
          if (href) await page.goto(href.startsWith('http') ? href : `https://www.bol.com${href}`, { waitUntil: 'domcontentloaded' });
        }
      }
      
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.scrollBy(0, 500));
      
      const liveData = await page.evaluate(`() => {
        const getT = (s) => document.querySelector(s)?.textContent?.trim() || "";
        
        // Handle Bol price whole/fraction
        let price = "N/A";
        const priceEl = document.querySelector('[data-test="price"], .promo-price');
        if (priceEl) {
          const whole = priceEl.querySelector('.promo-price__whole')?.textContent?.trim() || "";
          const fraction = priceEl.querySelector('.promo-price__fraction')?.textContent?.trim() || "";
          price = whole ? whole + "." + (fraction || '00') : priceEl.textContent?.trim().replace(',', '.') || "N/A";
        }

        const images = [];
        document.querySelectorAll('img[src*="media.s-bol.com"]').forEach(img => {
          const src = img.getAttribute('src');
          if (src && !images.includes(src)) images.push(src);
        });

        const bullets = [];
        document.querySelectorAll('[data-test="product-features"] li').forEach(li => {
          bullets.push(li.textContent?.trim() || "");
        });

        return {
          title: getT('[data-test="title"]') || getT('h1.page-title') || document.title,
          description: getT('[data-test="description"]') || getT('.js_product_description'),
          price,
          shipping: getT('[data-test="delivery-highlight"]') || getT('.js_delivery_info') || "N/A",
          bullets,
          images,
          hasAPlus: !!document.querySelector('.manufacturer-info, .js_product_description img'),
          variations: !!document.querySelector('[data-test="variant-selector"], .variant-selector')
        };
      }`);

      liveData.images = getUniqueImages(liveData.images);
      const auditResult = performAudit(masterData, liveData, 'bol');
      res.json({ liveData, auditResult });

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
    
    // Safety
    if (!auditResult) auditResult = { title: {}, description: {}, price: {}, shipping: {}, bullets: [], images: { live: [] }, hasAPlus: {}, variations: {} };
    if (!masterData) masterData = { images: [] };

    const masterFirst = masterData.images?.[0] || "";
    const liveFirst = auditResult.images?.live?.[0] || "";
    const allLiveImages = (auditResult.images?.live || []).join(", ");
    
    const sharedData: any = {
      "Identifier": identifier,
      "Title Match": getMatchText(auditResult.title?.match),
      "Description Match": getMatchText(auditResult.description?.match),
      "Main Image Link": masterFirst,
      "Live Image Links": allLiveImages,
      "Main Image": masterFirst ? `=IMAGE("${masterFirst}")` : "",
      "Live Image": liveFirst ? `=IMAGE("${liveFirst}")` : "",
      "A+ Content": getAPlusText(auditResult.hasAPlus?.live),
      "Shipping Time": auditResult.shipping?.live || "N/A",
      "Price": auditResult.price?.live || "N/A",
      "Variations": getVariationText(auditResult.variations?.live),
      "Bullet Points Match": auditResult.bullets ? getMatchText(auditResult.bullets.length > 0 && auditResult.bullets.every((b: any) => b.match)) : "N/A"
    };

    const prefix = mode === 'amazon' ? 'Amazon' : 'Bol';
    const masterImgs = masterData.images || [];
    const liveImgs = auditResult.images?.live || [];

    for (let i = 1; i <= 10; i++) {
      sharedData[`${prefix} Master Image ${i}`] = masterImgs[i-1] ? `=IMAGE("${masterImgs[i-1]}")` : "";
      sharedData[`${prefix} Live Image ${i}`] = liveImgs[i-1] ? `=IMAGE("${liveImgs[i-1]}")` : "";
    }

    return mode === 'amazon' ? { "ASIN": identifier, ...sharedData } : { "EAN": identifier, ...sharedData };
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

      const auth = new JWT({ email: serviceAccountEmail, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      const sheets = google.sheets({ version: 'v4', auth });
      
      await sheets.spreadsheets.values.clear({
        spreadsheetId: targetSheetId,
        range: `'${targetTab}'!A2:AZ1000`,
      });
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 5. Save Audit Result to QC Automation Sheet
  app.post("/api/sheets/save-audit", async (req, res) => {
    try {
      const { mode, auditResult, masterData, marketplace, identifier } = req.body;
      const targetSheetId = "1V4lNf30SlBwczSvGX9rfn5eWFH2AvMO4TqMHAHalS7s";
      const targetTab = mode === 'amazon' ? 'Amazon QC Results' : 'Bol QC Results';
      
      const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      const auth = new JWT({ email: serviceAccountEmail, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      const sheets = google.sheets({ version: 'v4', auth });
      const doc = new GoogleSpreadsheet(targetSheetId, auth);
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle[targetTab];
      
      await sheet.loadHeaderRow();
      const headers = sheet.headerValues;
      const rowData = prepareRowData(mode, auditResult, masterData, marketplace, identifier);
      
      const rowArray = headers.map(h => {
        const key = Object.keys(rowData).find(k => k.toLowerCase() === h.toLowerCase());
        return key ? (rowData as any)[key] : "";
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId,
        range: `'${targetTab}'!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [rowArray] }
      });
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/sheets/batch-save-audit", async (req, res) => {
    try {
      const { mode, audits } = req.body;
      const targetSheetId = "1V4lNf30SlBwczSvGX9rfn5eWFH2AvMO4TqMHAHalS7s";
      const targetTab = mode === 'amazon' ? 'Amazon QC Results' : 'Bol QC Results';
      
      const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      const auth = new JWT({ email: serviceAccountEmail, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      const sheets = google.sheets({ version: 'v4', auth });
      const doc = new GoogleSpreadsheet(targetSheetId, auth);
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle[targetTab];
      
      await sheet.loadHeaderRow();
      const headers = sheet.headerValues;
      const allRows = audits.map((a: any) => {
        const rowData = prepareRowData(mode, a.auditResult, a.masterData, a.marketplace, a.identifier);
        return headers.map(h => {
          const key = Object.keys(rowData).find(k => k.toLowerCase() === h.toLowerCase());
          return key ? (rowData as any)[key] : "";
        });
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId,
        range: `'${targetTab}'!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: allRows }
      });
      
      res.json({ success: true, count: allRows.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/proxy-image", async (req, res) => {
    try {
      const url = req.query.url as string;
      const resp = await axios.get(url, { responseType: 'arraybuffer' });
      res.set('Content-Type', resp.headers['content-type']);
      res.send(Buffer.from(resp.data));
    } catch (error: any) {
      res.status(500).send(error.message);
    }
  });

  function cleanText(text: string): string {
    if (!text) return "";
    return String(text).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }

  function getUniqueImages(urlList: string[]) {
    const finalImages: string[] = [];
    const ids = new Set();
    for (const url of urlList) {
      if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;
      const match = url.match(/\/I\/([A-Za-z0-9_-]+)/) || url.match(/media\.s-bol\.com\/([A-Za-z0-9_-]+)/);
      const id = match ? match[1] : url;
      if (!ids.has(id)) {
        ids.add(id);
        finalImages.push(url);
      }
    }
    return finalImages;
  }

  function performAudit(master: any, live: any, mode: 'amazon' | 'bol', domain?: string) {
    const results: any = {};
    const cM = (t: string) => cleanText(t);
    
    results.title = { master: master.title, live: live.title, match: cM(master.title) === cM(live.title) };
    results.description = { 
      master: master.description, 
      live: live.description, 
      match: live.description.includes('IMAGE:') || live.description.includes('APLUS') ? false : cM(master.description) === cM(live.description),
      status: (live.description.includes('APLUS')) ? "Manual Check Required: A+ Content Live" : null
    };
    results.bullets = (master.bullets || []).map((mb: string, i: number) => ({
      master: mb, live: live.bullets?.[i] || "", match: cM(mb) === cM(live.bullets?.[i] || "")
    }));
    results.hasAPlus = { master: !!master.hasAPlus, live: !!live.hasAPlus, match: !!master.hasAPlus === !!live.hasAPlus };
    results.variations = { master: !!master.variations, live: !!live.variations, match: !!master.variations === !!live.variations };
    results.price = { master: master.price, live: live.price, match: cM(String(master.price)) === cM(String(live.price)) };
    results.shipping = { master: master.shipping, live: live.shipping, match: cM(master.shipping) === cM(live.shipping) };
    
    const mF = master.images?.[0] || "";
    const lF = live.images?.[0] || "";
    const getFN = (u: string) => u.split('/').pop()?.split('?')[0] || "";
    results.images = { master: master.images || [], live: live.images || [], match: mF && lF && (mF === lF || getFN(mF) === getFN(lF)) };

    return results;
  }

  async function getImageHash(buffer: Buffer) {
    const { data } = await sharp(buffer).resize(8, 8, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
    return data;
  }

  function compareHashes(h1: Buffer, h2: Buffer) {
    let diff = 0;
    for (let i = 0; i < h1.length; i++) { if (Math.abs(h1[i] - h2[i]) > 20) diff++; }
    return 1 - (diff / h1.length);
  }

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true, allowedHosts: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
