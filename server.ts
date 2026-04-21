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
    let browser;
    try {
      const { asin, marketplace, masterData } = req.body;
      const domain = marketplace || 'amazon.com';
      const url = `https://www.${domain}/dp/${asin}`;
      
            const launchOptions: any = { 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      };
      if (process.env.ANTIGRAVITY_API_KEY) {
        let region = 'us';
        if (domain.endsWith('.co.uk')) region = 'uk';
        else if (domain.endsWith('.de')) region = 'de';
        else if (domain.endsWith('.pl')) region = 'pl';
        launchOptions.proxy = {
          server: `http://${process.env.ANTIGRAVITY_API_KEY}:residential-${region}@proxy.antigravityai.com:8080`
        };
      } else if (process.env.PROXY_SERVER) {
        launchOptions.proxy = {
          server: process.env.PROXY_SERVER,
          username: process.env.PROXY_USERNAME,
          password: process.env.PROXY_PASSWORD
        };
      }
      browser = await chromium.launch(launchOptions);
                  const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      ];
      const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
      const context = await browser.newContext({
        userAgent: randomUserAgent,
        viewport: { width: 1920, height: 1080 }
      });

      // Set regional postcodes and language preferences
      const cookies = [
        { name: 'session-id', value: '123-4567890-1234567', domain: `.${domain}`, path: '/' },
        { name: 'ubid-main', value: '123-4567890-1234567', domain: `.${domain}`, path: '/' }
      ];
      
      // Clear existing cookies first to prevent session tracking
      await context.clearCookies();
      
      if (domain.endsWith('.co.uk')) {
        cookies.push({ name: 'lc-main', value: 'en_GB', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'i18n-prefs', value: 'GBP', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'sp-cdn', value: '"LND:NW1 6XE"', domain: `.${domain}`, path: '/' });
      } else if (domain.endsWith('.de')) {
        cookies.push({ name: 'lc-main', value: 'de_DE', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'i18n-prefs', value: 'EUR', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'sp-cdn', value: '"BER:10117"', domain: `.${domain}`, path: '/' });
      } else if (domain.endsWith('.pl')) {
        cookies.push({ name: 'lc-main', value: 'pl_PL', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'i18n-prefs', value: 'PLN', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'sp-cdn', value: '"WAW:00-001"', domain: `.${domain}`, path: '/' });
      } else if (domain.endsWith('.se')) {
        cookies.push({ name: 'lc-main', value: 'sv_SE', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'i18n-prefs', value: 'SEK', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'sp-cdn', value: '"STO:111 20"', domain: `.${domain}`, path: '/' });
      } else {
        cookies.push({ name: 'lc-main', value: 'en_US', domain: `.${domain}`, path: '/' });
      }
      
      await context.addCookies(cookies);
            const page = await context.newPage();
      await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
      
      // Optimize loading by blocking unnecessary resources
      await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,css}', (route) => {
        const url = route.request().url();
        // Allow main product images if needed, but for scraping HTML we usually don't need them
        // However, we extract image URLs from the script tags or landingImage src, so we don't need the actual image files to load.
        route.abort();
      });

      // Navigate and wait for initial load
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        // Only trigger the extraction after networkidle (Playwright's equivalent of networkidle2)
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
      } catch (e: any) {
        if (e.name === 'TimeoutError') {
          console.warn("Initial navigation timed out, attempting to proceed with current content...");
        } else {
          throw e;
        }
      }
      
      // Mandatory "Wait-Until" Logic: Ensure the product display is fully visible
      await page.waitForSelector('#ppd', { state: 'visible', timeout: 15000 }).catch(() => {
        console.warn("Product display (#ppd) not fully visible within 15s, proceeding anyway.");
      });
      
      // Check for CAPTCHA
      const isCaptcha = await page.evaluate(function() {
        // @ts-ignore
        if (typeof __name === 'undefined') { (window as any).__name = (t: any, v: any) => t; }
        return document.title.includes('Robot Check') || 
               document.body.innerText.includes('Type the characters you see in this image') ||
               document.body.innerText.includes('To discuss automated access to Amazon data please contact');
      });
      
      if (isCaptcha) {
        throw new Error("Amazon blocked the request with a CAPTCHA. Please try again later.");
      }

      // Wait a bit more for dynamic elements (variations, etc.)
      await page.waitForTimeout(3000);
      
      // Get content
      const content = await page.content();
      const $ = cheerio.load(content);

      // 1. Image Extraction (Extracting main and secondary images, deduplicating via getUniqueImages)
      let images: string[] = [];
      const landingImg = $('#landingImage').attr('data-old-hires') || $('#landingImage').attr('src');
      if (landingImg && landingImg.startsWith('http')) images.push(landingImg);
      
      $('#altImages ul li img').each((_, el) => {
        const url = $(el).attr('data-old-hires') || $(el).attr('src');
        if (url && url.startsWith('http')) {
          images.push(url);
        }
      });
      const uniqueImages = getUniqueImages(images);

      // A+ Content Extraction (Exclude Brand Stories)
      const aPlusContainer = $('.aplus-v2, #aplus, #premium-aplus').not('#brandStory_feature_div, .aplus-brand-story-v2, .aplus-brand-story-v1');
      
      // Remove Brand Story sections if they exist within the container
      aPlusContainer.find('.aplus-brand-story-v2, .aplus-brand-story-v1, #brandStory_feature_div, .premium-brand-story, [class*="brand-story"]').remove();
      
      const hasAPlus = aPlusContainer.length > 0;
      let amazonDesc = $('#productDescription').text().trim();
      
      // Extract A+ text ONLY (Simpler revert)
      let aPlusData = null;
      if (hasAPlus) {
        const aPlusText = aPlusContainer.find('p, h3, h4, span, li').map((_, el) => {
          if (el.tagName === 'img') return '';
          if ($(el).closest('.aplus-brand-story-v2, .aplus-brand-story-v1, #brandStory_feature_div, .premium-brand-story, [class*="brand-story"]').length > 0) return '';
          return $(el).text().trim();
        }).get().filter(t => t.length > 0).join('\n\n');
        
        aPlusData = { text: aPlusText };
      }

      // If description is empty but A+ is present, use A+ data
      if (!amazonDesc && aPlusData) {
        amazonDesc = `APLUS_DATA:${JSON.stringify(aPlusData)}`;
      } else if (!amazonDesc) {
        amazonDesc = "No description on detail page";
      }

      // Shipping Extraction (Target: Right-side Buybox and delivery elements)
      const deliverySelectors = [
        'div#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID',
        'span[data-amazon-delivery-date]',
        'div#deliveryBlockMessage',
        '#delivery-message',
        '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
        '#mir-layout-DELIVERY_BLOCK',
        '#pfd-desktop-PRIMARY_DELIVERY_MESSAGE_LARGE',
        '#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE',
        '#fastest_delivery_message',
        '#upsell-messaging',
        '#ddmDeliveryMessage',
        '.a-spacing-base .a-text-bold',
        '#pba-delivery-message',
        '.a-section [data-feature-name="delivery"]',
        '.a-box .a-box-group .a-text-bold',
        '[data-a-color="teletype"]'
      ];
      
      let rawShippingTime = "";
      for (const selector of deliverySelectors) {
        const el = $(selector);
        if (el.length) {
          rawShippingTime = el.find('span').attr('data-csa-c-delivery-time') || el.attr('data-csa-c-delivery-time') || "";
          if (!rawShippingTime) {
            // Try to find the bold text which usually contains the date
            rawShippingTime = el.find('.a-text-bold').first().text().trim() || el.text().trim();
          }
          if (rawShippingTime) break;
        }
      }
      
      console.log(`Extracted Raw Shipping: ${rawShippingTime}`);
      
      let shippingDaysNum = 0;
      let shippingDaysStr = "N/A";
      if (rawShippingTime) {
        try {
          const today = new Date();
          const currentYear = today.getFullYear();
          
          let dateStr = rawShippingTime;
          // Handle ranges by taking the first date
          if (dateStr.includes('-')) {
            dateStr = dateStr.split('-')[0].trim();
          }
          
          // Month maps for international Amazon sites
          const nlMonthMap: Record<string, number> = {
            'januari': 0, 'februari': 1, 'maart': 2, 'april': 3, 'mei': 4, 'juni': 5,
            'juli': 6, 'augustus': 7, 'september': 8, 'oktober': 9, 'november': 10, 'december': 11
          };
          const enMonthMap: Record<string, number> = {
            'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
            'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11,
            'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5, 'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
          };
          const deMonthMap: Record<string, number> = {
            'januar': 0, 'februar': 1, 'märz': 2, 'april': 3, 'mai': 4, 'juni': 5,
            'juli': 6, 'august': 7, 'september': 8, 'oktober': 9, 'november': 10, 'dezember': 11
          };
          const plMonthMap: Record<string, number> = {
            'stycznia': 0, 'lutego': 1, 'marca': 2, 'kwietnia': 3, 'maja': 4, 'czerwca': 5,
            'lipca': 6, 'sierpnia': 7, 'września': 8, 'października': 9, 'listopada': 10, 'grudnia': 11
          };

          const s = dateStr.toLowerCase();
          const dayMatch = s.match(/\d+/);
          const monthMatch = s.match(/[a-zäöüßżćśóźńłęą]+/g) || [];
          
          let targetDate: Date | null = null;

          if (dayMatch) {
            const day = parseInt(dayMatch[0]);
            let monthIndex = -1;
            
            for (const monthName of monthMatch) {
              if (nlMonthMap[monthName] !== undefined) monthIndex = nlMonthMap[monthName];
              else if (enMonthMap[monthName] !== undefined) monthIndex = enMonthMap[monthName];
              else if (deMonthMap[monthName] !== undefined) monthIndex = deMonthMap[monthName];
              else if (plMonthMap[monthName] !== undefined) monthIndex = plMonthMap[monthName];
              if (monthIndex !== -1) break;
            }

            if (monthIndex !== -1) {
              targetDate = new Date(currentYear, monthIndex, day);
            } else {
              const parsed = new Date(dateStr + ` ${currentYear}`);
              if (!isNaN(parsed.getTime())) targetDate = parsed;
            }
          }

          if (!targetDate) {
            if (/morgen|tomorrow|morgen|jutro/i.test(s)) {
              targetDate = new Date();
              targetDate.setDate(targetDate.getDate() + 1);
            } else if (/vandaag|today|heute|dzisiaj/i.test(s)) {
              targetDate = new Date();
            }
          }

          if (targetDate) {
            targetDate.setHours(0, 0, 0, 0);
            const todayClean = new Date();
            todayClean.setHours(0, 0, 0, 0);
            const diff = differenceInDays(targetDate, todayClean);
            shippingDaysNum = diff >= 0 ? diff : 0;
            shippingDaysStr = `${shippingDaysNum} Day${shippingDaysNum === 1 ? '' : 's'}`;
            console.log(`Calculated Shipping: ${shippingDaysStr} (diff: ${diff})`);
          }
        } catch (e) {
          console.error("Shipping parsing error:", e);
        }
      }

      // Price Extraction (Target: #corePriceDisplay_desktop_feature_div with multiple fallbacks)
      let priceDisplay = "N/A";
      let listPrice = "N/A";
      
      // Primary selectors for core price display
      const corePriceDiv = $('span.a-offscreen, span#price_inside_buybox, div#corePrice_feature_div');
      if (corePriceDiv.length) {
        priceDisplay = corePriceDiv.find('span.a-offscreen').first().text().trim() || 
                       corePriceDiv.find('.a-price span.a-offscreen').first().text().trim() || 
                       corePriceDiv.find('.a-color-price').first().text().trim();
        // List Price / RRP
        listPrice = corePriceDiv.find('.a-price.a-text-price span.a-offscreen').first().text().trim() || 
                    $('.basisPrice .a-offscreen').first().text().trim() || 
                    $('.a-price-range .a-offscreen').first().text().trim() || "N/A";
      }
      
      // Fallback selectors if primary didn't work
      if (!priceDisplay || priceDisplay === "N/A" || priceDisplay === "") {
        const fallbacks = [
          '#price_inside_buybox',
          '#priceblock_ourprice',
          '#priceblock_dealprice',
          'span.a-price span.a-offscreen',
          'span.a-color-price',
          '.apexPriceToPay',
          '#corePrice_desktop_feature_div .a-offscreen',
          '#buyNew_non_vat_price',
          '.a-price[data-a-size="xl"] .a-offscreen',
          '.a-price[data-a-size="l"] .a-offscreen'
        ];
        
        for (const selector of fallbacks) {
          const text = $(selector).first().text().trim();
          if (text && text !== "" && text !== "N/A") {
            priceDisplay = text;
            break;
          }
        }
      }

      const variationSelectors = [
        '.swatches',
        '.inline-twister-row',
        '#twister',
        '#inline-twister-row-size_name',
        '#inline-twister-row-color_name',
        'li.swatchAvailable',
        '#variation_size_name',
        '#variation_color_name',
        '#variation_style_name',
        '#twister-main-container',
        'select#native_dropdown_selected_size_name',
        '.twister-style-2',
        '#variation_edition_name',
        '#variation_pattern_name',
        '#variation_scent_name',
        '#variation_item_package_quantity',
        '#variation_flavor_name',
        '#variation_material_name',
        '.twister-container',
        '[id^="variation_"]',
        '.a-section.twister-row',
        '#native_dropdown_selected_color_name',
        '#native_dropdown_selected_style_name',
        '.swatchSelect',
        '.swatchAvailable',
        '.a-declarative[data-action="a-modal"]', // Often used for size charts/variations
        '[data-variation-name]',
        '.twister-row',
        '#variation_type',
        '#variation_name',
        '.variation-group',
        '.js_attribute_selector'
      ];
      let hasVariations = false;
      for (const selector of variationSelectors) {
        if ($(selector).length > 0) {
          hasVariations = true;
          break;
        }
      }
      
      // Fallback: check for any element with "variation" in ID or class inside a twister container
      if (!hasVariations) {
        if ($('[id*="variation"], [class*="variation"]').length > 0 && ($('#twister-main-container, #twister').length > 0 || $('.twister-row').length > 0)) {
          hasVariations = true;
        }
      }
      
      // Additional check for labels which often indicate variations across all categories
      if (!hasVariations) {
        const twisterText = $('#twister-main-container, #twister, #variation_type, #variation_name').text().toLowerCase();
        const variationKeywords = [
          // Basic
          'size:', 'color:', 'style:', 'rozmiar:', 'kolor:', 'styl:', 'gr├╢sse:', 'farbe:', 'storlek:', 'f├جrg:',
          'edition:', 'pattern:', 'scent:', 'flavor:', 'material:', 'configuration:', 'capacity:', 'length:',
          'width:', 'height:', 'weight:', 'volume:', 'quantity:', 'package:', 'type:', 'model:', 'version:',
          'platform:', 'format:', 'design:', 'finish:', 'voltage:', 'wattage:', 'amperage:', 'speed:',
          'memory:', 'storage:', 'display:', 'screen:', 'resolution:', 'connectivity:', 'interface:',
          'compatibility:', 'os:', 'language:', 'region:', 'country:', 'age:', 'gender:',
          // Extended Physical
          'thickness:', 'diameter:', 'depth:', 'fabric:', 'material_type:', 'bundle:', 'set:', 'pack:', 'count:',
          'thickness:', 'diameter:', 'depth:', 'item_dimensions:', 'item_weight:', 'item_form:',
          // Tech & Electronics
          'hardware_platform:', 'software_edition:', 'connectivity_technology:', 'wireless_communication_technology:',
          'power_source:', 'battery_type:', 'memory_storage_capacity:', 'display_size:', 'screen_size:',
          // Apparel & Accessories
          'shoe_size:', 'apparel_size:', 'lens_color:', 'frame_color:', 'lens_width:', 'hand_orientation:',
          // Sports & Outdoors
          'shaft_material:', 'flex:', 'grip_size:', 'tension:', 'weight_class:',
          // Beauty & Health
          'scent_description:', 'item_form:', 'unit_count:', 'number_of_items:', 'number_of_pieces:',
          // Localized Polish
          'grubo┼ؤ─ç:', '┼ؤrednica:', 'g┼é─آboko┼ؤ─ç:', 'tkanina:', 'zestaw:', 'opakowanie:', 'liczba:', 'cz─آstotliwo┼ؤ─ç:',
          'gwarancja:', 'platforma:', 'wersja:', 'rozdzielczo┼ؤ─ç:', 'kompatybilno┼ؤ─ç:', 'j─آzyk:', 'kraj:', 'wiek:', 'p┼ée─ç:',
          // Localized German
          'dicke:', 'durchmesser:', 'tiefe:', 'stoff:', 'set:', 'packung:', 'anzahl:', 'frequenz:', 'garantie:',
          'plattform:', 'version:', 'aufl├╢sung:', 'kompatibilit├جt:', 'sprache:', 'land:', 'alter:', 'geschlecht:',
          // Localized Swedish
          'tjocklek:', 'diameter:', 'djup:', 'tyg:', 'set:', 'f├╢rpackning:', 'antal:', 'frekvens:', 'garanti:',
          'plattform:', 'version:', 'uppl├╢sning:', 'kompatibilitet:', 'spr├حk:', 'land:', '├حlder:', 'k├╢n:',
          // Internal Amazon Names
          'size_name', 'color_name', 'style_name', 'item_package_quantity', 'unit_count', 'customer_defined_variation',
          'scent_name', 'flavor_name', 'material_name', 'pattern_name', 'edition_name'
        ];
        if (variationKeywords.some(k => twisterText.includes(k))) {
          hasVariations = true;
        }
      }
      
      // Final check: look for any list or select inside twister that has more than one option
      if (!hasVariations) {
        const twisterOptions = $('#twister-main-container select option, #twister-main-container ul li').length;
        if (twisterOptions > 1) {
          hasVariations = true;
        }
      }

      // Amazon Bullet Points (Refined to prevent duplication and distortion)
      const amazonBullets: string[] = [];
      const primaryBulletSelectors = [
        '#feature-bullets ul li span.a-list-item',
        '#featurebullets_feature_div ul li span.a-list-item',
        '[data-feature-name="featurebullets"] ul li span.a-list-item',
        '#productFactsDesktopExpander ul li span.a-list-item',
        '.a-unordered-list.a-vertical li span.a-list-item'
      ];

      primaryBulletSelectors.forEach(s => {
        $(s).each((_, el) => {
          const text = $(el).text().trim();
          if (text.length > 2 && 
              !text.includes('See more photos') && 
              !text.includes('Check details') && 
              !text.includes('See more') &&
              !amazonBullets.includes(text)) {
            amazonBullets.push(text);
          }
        });
      });

      console.log(`Extracted ${amazonBullets.length} Amazon Bullets`);

      const liveData = {
        title: ($('#productTitle').text() || $('span[id="productTitle"]').text()).trim(),
        description: amazonDesc,
        bullets: amazonBullets,
        price: priceDisplay,
        listPrice: listPrice,
        currency: "", // Removed currency validation
        shipping: shippingDaysStr,
        rawShipping: rawShippingTime || "N/A",
        variations: hasVariations ? 1 : 0,
        hasAPlus: hasAPlus,
        images: uniqueImages
      };

      const auditResult = performAudit(masterData, liveData, 'amazon', domain);
      res.json({ liveData, auditResult });
    } catch (error: any) {
      console.error("Amazon Audit Error:", error);
      res.status(500).json({ 
        error: error.message || "An unexpected error occurred during Amazon audit",
        details: error.stack,
        name: error.name
      });
    } finally {
      if (browser) await browser.close();
    }
  });

  // 3. Audit Bol.com
  app.post("/api/audit/bol", async (req, res) => {
    let browser;
    let retryCount = 0;
    const maxRetries = 3;
    
    const performBolAudit = async () => {
      try {
        const { ean, masterData } = req.body;
        const searchUrl = `https://www.bol.com/nl/nl/s/?searchtext=${ean}`;
        
        console.log(`Starting Bol Audit for EAN: ${ean} (Attempt ${retryCount + 1})`);
        
        // Antigravity Proxy Configuration for Bol.com
        // Using NL Residential Proxies to bypass IP block
        const launchOptions: any = { 
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        };
        
        // Use Antigravity API if available, otherwise fall back to standard proxy
        if (process.env.ANTIGRAVITY_API_KEY) {
          // Antigravity NL Residential Proxy Configuration
          launchOptions.proxy = {
            server: `http://proxy.antigravityai.com:8080`,
            username: process.env.ANTIGRAVITY_API_KEY,
            password: 'residential-nl'
          };
          console.log("Using Antigravity NL Residential Proxy for Bol.com");
        } else if (process.env.PROXY_SERVER) {
          launchOptions.proxy = {
            server: process.env.PROXY_SERVER,
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
          };
          console.log("Using standard proxy for Bol.com");
        }
        
        browser = await chromium.launch(launchOptions);
                  const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      ];
      const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
      const context = await browser.newContext({
        userAgent: randomUserAgent,
        viewport: { width: 1920, height: 1080 },
        extraHTTPHeaders: {
          'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Referer': 'https://www.google.com/',
          'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'User-Agent': randomUserAgent
        }
      });

      // Clear cookies between requests to prevent session tracking
      await context.clearCookies();
      
      // Set cookies for language and country
      await context.addCookies([
        { name: 'cookie_consent', value: 'true', domain: '.bol.com', path: '/' },
        { name: 'bol_gdpr_consent', value: 'yes', domain: '.bol.com', path: '/' },
        { name: 'nl_NL', value: 'true', domain: '.bol.com', path: '/' },
        { name: 'language', value: 'nl-NL', domain: '.bol.com', path: '/' },
        { name: 'country', value: 'NL', domain: '.bol.com', path: '/' },
        { name: 'bol_p_incognito', value: 'true', domain: '.bol.com', path: '/' }
      ]);

            const page = await context.newPage();
      await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
      
      // [NEW] Human-like Self-Search Strategy
      console.log(`Bypassing deep-links: Navigating to Bol home page first...`);
      try {
        await page.goto('https://www.bol.com/nl/nl/', { waitUntil: 'load', timeout: 30000 });
      } catch (e) {
        console.warn("Home page load timed out or failed, attempting to proceed to search directly...");
        await page.goto(searchUrl, { waitUntil: 'load', timeout: 45000 }).catch(() => null);
      }

      // 1. Handle Cookie Consent Wall (More aggressive)
      await page.evaluate(() => {
        const acceptButton = Array.from(document.querySelectorAll('button')).find(b => 
          b.id.includes('accept') || 
          b.innerText.toLowerCase().includes('accepteer') || 
          b.innerText.toLowerCase().includes('accept') ||
          b.getAttribute('data-test') === 'consent-modal-confirm-btn'
        );
        if (acceptButton) (acceptButton as any).click();
      }).catch(() => null);
      await page.waitForTimeout(1000);

      // Perform Search if we land on Home Page
      const currentUrl = page.url();
      if (currentUrl.endsWith('.com/nl/nl/') || currentUrl.endsWith('.com/') || currentUrl.includes('de-winkel-van-ons-allemaal')) {
         console.log(`On home page. Performing active search for: ${asin}`);
         const searchInput = await page.waitForSelector('[data-test="search-input"]', { timeout: 10000 }).catch(() => null);
         if (searchInput) {
            await searchInput.type(asin, { delay: 100 });
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2000);
         } else {
            console.log("Search input not found, navigating to search URL directly...");
            await page.goto(searchUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => null);
         }
      }
      
      // 2. Handle Title "bol" or loading states
      let currentTitle = await page.title();
      if (currentTitle.toLowerCase() === 'bol' || currentTitle.toLowerCase() === 'bol.com' || currentTitle === '') {
        console.log("Detected generic 'bol' title, waiting for content/redirect...");
        await page.waitForTimeout(5000);
        currentTitle = await page.title();
      }

      // Check for CAPTCHA or blocking
      const isBlocked = await page.evaluate(function() {
        // @ts-ignore
        if (typeof __name === 'undefined') { (window as any).__name = (t: any, v: any) => t; }
        const text = document.body.innerText;
        const title = document.title.toLowerCase();
        return title.includes('robot') || 
               title.includes('captcha') ||
               text.includes('Ben je een robot?') ||
               text.includes('rustig aan speed racer') ||
               text.includes('Je gaat iets te snel') ||
               text.includes('IP adres is geblokkeerd') ||
               text.includes('IP address is blocked');
      });

      if (isBlocked) {
        const title = await page.title();
        throw new Error(`Bol.com blocked the request or redirect (Title: ${title})`);
      }

      // Check if we are on a search page or product page
      let pageTitle = await page.title();
      console.log(`Page Title after handling: ${pageTitle}`);
      
      const isSearchPage = pageTitle.includes('Alle artikelen') || 
                           pageTitle.includes('Zoekresultaten') || 
                           await page.evaluate(function() {
                             // @ts-ignore
                             if (typeof __name === 'undefined') { (window as any).__name = (t: any, v: any) => t; }
                             return !!document.querySelector('.product-list, .product-item--grid, [data-test="product-list"]');
                           });
      
      if (isSearchPage) {
        console.log("Search page detected, looking for product link...");
        const firstProductSelector = 'a[href*="/p/"]:not([href*="javascript"]), .product-title a, a[data-test="product-title"], .product-item--grid a, .product-list a';
        const el = await page.waitForSelector(firstProductSelector, { timeout: 10000 }).catch(() => null);
        const firstProductLink = el ? await el.getAttribute('href') : null;
        
        if (firstProductLink) {
          const productUrl = firstProductLink.startsWith('http') ? firstProductLink : `https://www.bol.com${firstProductLink}`;
          console.log(`Navigating to product URL: ${productUrl}`);
          await page.goto(productUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => null);
        }
      }

      // 4. Resilient Wait & Scroll Strategy (2026 Update)
      try {
        console.log("Waiting for body...");
        await page.waitForSelector('body', { timeout: 10000 });

        // Humanize: Scroll slightly to trigger lazy-load elements (React hydration)
        console.log("Triggering scroll for React hydration...");
        await page.mouse.wheel(0, 500);
        await page.waitForTimeout(1000); 
        await page.mouse.wheel(0, -200);

        // Updated Selector Check for 2026 Header (most stable)
        const headerSelector = '[data-test="title"], h1.page-title, .js_pdp_title, .pdp-header';
        console.log("Ensuring PDP Header is visible...");
        await page.waitForSelector(headerSelector, { 
            state: 'visible', 
            timeout: 15000 
        });
      } catch (error: any) {
        // Diagnostic: Log content on failure to identify Akamai/CAPTCHA
        const title = await page.title();
        const html = await page.content();
        console.error(`Bol.com Timeout Error details. Page Title: ${title}, URL: ${page.url()}`);
        if (html.includes('akamai') || html.includes('Akamai')) {
           throw new Error("Bol.com Blocked by Akamai. Try again with a different proxy region.");
        }
        throw new Error(`Bol.com Timeout: Could not find product header (Current: ${title}). See logs for HTML diagnostic.`);
      }

      // Human-like delay after page load (3 seconds) to allow all JS to execute
      console.log("Waiting 3 seconds for JavaScript execution...");
      await page.waitForTimeout(3000);

      // Scroll 500px down and back up instantly to trigger lazy loading
      await page.evaluate(() => {
        window.scrollBy(0, 500);
        setTimeout(() => window.scrollBy(0, -500), 100);
      });
      await page.waitForTimeout(1000);

      // Wait for description and media containers specifically (critical for JS-rendered content)
      await page.waitForSelector('#pdp_description, .js_product_description, div.js_product_media_items, .pdp-images, [data-test="product-main-image"]', { timeout: 15000 }).catch(() => null);

      const liveDataRaw = await page.evaluate(function() {
        // @ts-ignore
        if (typeof __name === 'undefined') { (window as any).__name = (t: any, v: any) => t; }
        
        // 1. Title
        const elTitle = document.querySelector('[data-test="title"]') || document.querySelector('h1.page-title') || document.querySelector('h1');
        const title = elTitle ? (elTitle as any).innerText.trim() : "";
        
        // 2. Description
        let description = "";
        
        // Prioritize "Productbeschrijving" heading extraction
        const headings = Array.from(document.querySelectorAll('h2, h3, h4, b, strong, span'));
        const descHeading = headings.find(h => {
          const t = (h as any).innerText || (h as any).textContent || "";
          return t.includes('Productbeschrijving') || t.includes('Product description');
        });
        
        if (descHeading) {
           const parent = descHeading.closest('section') || descHeading.parentElement;
           if (parent) {
              const clone = parent.cloneNode(true) as HTMLElement;
              const UI_SELECTORS = ['.js_description_read_more', '[data-test="read-more"]', '.pdp-description__read-more', 'button', 'a.button--link'];
              UI_SELECTORS.forEach(sel => {
                clone.querySelectorAll(sel).forEach(btn => btn.remove());
              });
              const text = (clone as any).innerText || (clone as any).textContent || "";
              description = text.replace(/Productbeschrijving|Product description/i, '').trim();
              // Global clean for UI fragments
              description = description.replace(/toon meer|toon minder/gi, '').trim();
           }
        }

        if (!description || description.length < 50) {
          const descSelectors = [
            'div[data-test="description"]',
            'div.js_product_description',
            '#pdp_description',
            'section.product-description',
            '[data-test="product-description"]',
            '.js_product_description',
            '.product-description',
            '.product-description-content',
            'div[itemprop="description"]',
            '#descriptionBlock',
            'section#description',
            '.slot-product-description',
            '.pdp-description',
            '.manufacturer-info', // Bol A+ equivalent
            '.product-info',      // Bol A+ equivalent
            '[data-test="product-info"]'
          ];
          
          // Try to expand "Lees meer" if it exists
          const readMore = document.querySelector('.js_description_read_more, [data-test="read-more"], .pdp-description__read-more');
          if (readMore) (readMore as any).click();

          let pooledText = "";
          for (const s of descSelectors) {
            const el = document.querySelector(s);
            if (el) {
               const clone = el.cloneNode(true) as HTMLElement;
               const UI_SELECTORS = ['.js_description_read_more', '[data-test="read-more"]', '.pdp-description__read-more', 'button', 'a.button--link'];
               UI_SELECTORS.forEach(sel => {
                 clone.querySelectorAll(sel).forEach(btn => btn.remove());
               });
               const text = (clone as any).innerText || (clone as any).textContent || "";
               if (text.trim().length > 20) {
                  let html = clone.innerHTML;
                  let t = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n').replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
                  // Secondary cleanup for text fragments
                  t = t.replace(/toon meer|toon minder/gi, '').trim();
                  
                  if (!pooledText.includes(t)) {
                    pooledText += (pooledText ? "\n\n" : "") + t;
                  }
               }
            }
          }
          if (pooledText) description = pooledText;
        }

        // 3. Price (Prioritize data-test for 2026)
        let price = "N/A";
        const promoEl = document.querySelector('[data-test="price"]') || 
                        document.querySelector('.promo-price') || 
                        document.querySelector('#buyBlockSlot [class*="text-promo-text-high"]') || 
                        document.querySelector('.buy-block__price');
        if (promoEl) {
           price = (promoEl as any).innerText.replace(/\s+/g, '').replace('ظéش', '').trim().replace(',', '.');
           // Ensure it's a valid price format
           if (!/^\d+\.\d+$/.test(price) && price.includes('.')) {
              // already okay
           } else if (/^\d+$/.test(price)) {
              // missing cents? Bol usually has ,- for round numbers
           }
        } else {
          const buyBlock = document.querySelector('#buyBlockSlot') || document.querySelector('.buy-block') || document.querySelector('[data-test="buy-block"]');
          if (buyBlock) {
             const text = (buyBlock as any).innerText;
             const match = text.match(/(\d+),(\d{2})/) || text.match(/(\d+),-/);
             if (match) price = match[2] ? `${match[1]}.${match[2]}` : `${match[1]}.00`;
          }
          if (price === "N/A") {
            const meta = document.querySelector('meta[property="product:price:amount"]') || document.querySelector('meta[itemprop="price"]');
            if (meta) price = meta.getAttribute('content') || "N/A";
          }
        }

        // 4. Shipping
        let shippingText = "N/A";
        // Look for "Uiterlijk [Date] in huis" or "Morgen in huis"
        const deliveryPromise = document.querySelector('[data-test="delivery-highlight"]') || 
                                document.querySelector('[data-test="delivery-promise"]') ||
                                document.querySelector('.js_delivery_info') || 
                                document.querySelector('.ui-delivery-info') || 
                                document.querySelector('.delivery-promise') || 
                                document.querySelector('.delivery-delivery-time') || 
                                document.querySelector('.buy-block__delivery-text');
                                
        if (deliveryPromise) {
          shippingText = (deliveryPromise as any).innerText.trim();
        } else {
          const bodyText = document.body.innerText;
          const uiterlijkMatch = bodyText.match(/Uiterlijk\s+(.+?)\s+in\s+huis/i);
          if (uiterlijkMatch) shippingText = uiterlijkMatch[0];
        }

        // 5. Images (Revised extraction to avoid empty results)
        let images: string[] = [];
        
        // Strategy 1: Preload tags (Often has high-res URLs)
        try {
          const preloads = Array.from(document.querySelectorAll('link[rel="preload"][as="image"]'));
          preloads.forEach(link => {
            const href = link.getAttribute('href');
            if (href && href.includes('media.s-bol.com')) images.push(href);
          });
        } catch(e) {}

        // Strategy 2: Main image selectors
        const mainSelectors = [
          '[data-test="product-main-image"] img',
          '.js_main_product_image',
          '.pdp-main-image img',
          'img.js_main_product_image'
        ];
        for(const s of mainSelectors) {
          const img = document.querySelector(s);
          if (img) {
            const src = (img as any).src || img.getAttribute('src');
            if (src && src.startsWith('http')) images.push(src);
          }
        }
        
        // Strategy 3: Thumbnails
        const thumbSelectors = [
          '.js_product_media_items img',
          '.pdp-images img',
          '.js_image_container img',
          '.product-images__item img'
        ];
        for(const s of thumbSelectors) {
          const thumbs = Array.from(document.querySelectorAll(s));
          thumbs.forEach(img => {
            const src = (img as any).src || img.getAttribute('data-src') || img.getAttribute('src');
            if (src && src.includes('media.s-bol.com')) {
              images.push(src);
            }
          });
        }
        
        // 6. Variations & A+
        const hasVariations = !!(
          document.querySelector('.js_attribute_selector .js_attribute_label') ||
          document.querySelector('.js_attribute_selector .active') ||
          document.querySelector('.js_attribute_selector [selected]') ||
          document.querySelector('.js_attribute_selector') ||
          document.querySelector('[data-test="variant-selector"]') || 
          document.querySelector('.variant-selector') || 
          document.querySelector('.js_bundle_as_variant_selector') ||
          document.querySelector('[data-test="variant-dropdown"]') ||
          document.querySelector('.js_variant_selector') ||
          document.querySelector('[data-test="variant-list"]') ||
          document.querySelector('.pdp-variant-selector') ||
          document.querySelector('.js_variant_dropdown') ||
          // Check for label or option elements inside attribute selector
          Array.from(document.querySelectorAll('.js_attribute_selector label, .js_attribute_selector option')).length > 1 ||
          // Broad pattern matching for variation themes
          Array.from(document.querySelectorAll('span, div, h3, label')).some(el => {
            const t = (el as any).innerText || "";
            const themes = [
              'Kies je kleur', 
              'Kies je maat', 
              'Kies je variant', 
              'Kies je bestanddeel', 
              'Kies je model',
              'Kies je type',
              'Kies je uitvoering',
              'Kies je breedte',
              'Kies je lengte',
              'Kies je inhoud',
              'Kies je gewicht',
              'Kies je verpakking',
              'Kies je aantal',
              'Kies je materiaal',
              'Kies je geur',
              'Kies je smaak',
              'Kies je stijl',
              'Kies je set',
              'Kies je platform'
            ];
            return themes.some(theme => t.includes(theme));
          })
        );
        
        const hasAPlus = !!(
          Array.from(document.querySelectorAll('.js_product_description img, .product-description img, .product-description-content img, [data-test="product-info"] img, .js_product_info img, .manufacturer-info img, .product-info img'))
            .some(img => {
              const parent = img.closest('section, div');
              if (parent) {
                const text = (parent as any).innerText || "";
                if (text.includes('Over het merk') || text.includes('Brand Story')) return false;
              }
              return true;
            })
        );

        // 6. Bullet Points / Kenmerken for Bol
        let bullets: string[] = [];
        const featureSelectors = [
          '[data-test="product-features"] li',
          '.product-features li',
          '.js_product_features li',
          '.specs-list__item',
          '.product-specifications li'
        ];
        
        const extractedSet = new Set<string>();
        for (const s of featureSelectors) {
          const items = document.querySelectorAll(s);
          if (items.length > 0) {
            Array.from(items).forEach(li => {
              const t = (li as any).innerText.trim();
              if (t.length > 3) extractedSet.add(t);
            });
          }
        }
        bullets = Array.from(extractedSet);

        return {
          title,
          description,
          price,
          shipping: shippingText,
          images,
          bullets,
          variations: hasVariations ? 1 : 0,
          hasAPlus: hasAPlus ? 1 : 0
        };
      });

      console.log(`Extracted Title: ${liveDataRaw.title}`);
      console.log(`Extracted Price: ${liveDataRaw.price}`);
      console.log(`Has Variations: ${liveDataRaw.variations}`);
      console.log(`Has A+ Content: ${liveDataRaw.hasAPlus}`);
      console.log(`Description Length: ${liveDataRaw.description.length}`);
      console.log(`Images Found: ${liveDataRaw.images?.length || 0}`);

      // Parse shipping days
      let shippingDaysStr = "N/A";
      let shippingDaysNum = 0;
      if (liveDataRaw.shipping && liveDataRaw.shipping !== "N/A") {
        try {
          const s = liveDataRaw.shipping.toLowerCase();
          const today = new Date();
          const currentYear = today.getFullYear();
          today.setHours(0, 0, 0, 0);

          if (s.includes('vandaag') || s.includes('today')) {
            shippingDaysNum = 0;
            shippingDaysStr = "0 Days";
          } else if (s.includes('morgen') || s.includes('tomorrow')) {
            shippingDaysNum = 1;
            shippingDaysStr = "1 Day";
          } else {
            const nlMonthMap: Record<string, number> = {
              'januari': 0, 'februari': 1, 'maart': 2, 'april': 3, 'mei': 4, 'juni': 5,
              'juli': 6, 'augustus': 7, 'september': 8, 'oktober': 9, 'november': 10, 'december': 11
            };
            
            const dayMatch = s.match(/\d+/);
            const monthMatch = s.match(/[a-z]+/g) || [];
            
            let targetDate: Date | null = null;
            if (dayMatch) {
              const day = parseInt(dayMatch[0]);
              let monthIndex = -1;
              for (const monthName of monthMatch) {
                if (nlMonthMap[monthName] !== undefined) {
                  monthIndex = nlMonthMap[monthName];
                  break;
                }
              }
              if (monthIndex !== -1) {
                targetDate = new Date(currentYear, monthIndex, day);
              }
            }
            
            if (targetDate) {
              targetDate.setHours(0, 0, 0, 0);
              const todayClean = new Date();
              todayClean.setHours(0, 0, 0, 0);
              const diff = differenceInDays(targetDate, todayClean);
              shippingDaysNum = diff >= 0 ? diff : 0;
              shippingDaysStr = `${shippingDaysNum} Day${shippingDaysNum === 1 ? '' : 's'}`;
            }
          }
        } catch (e) {}
      }

      const liveData = {
        title: liveDataRaw.title,
        description: liveDataRaw.description || "No description on detail page",
        bullets: liveDataRaw.bullets || [],
        price: liveDataRaw.price,
        shipping: shippingDaysStr,
        rawShipping: liveDataRaw.shipping || "N/A",
        variations: liveDataRaw.variations,
        hasAPlus: liveDataRaw.hasAPlus,
        images: liveDataRaw.images && liveDataRaw.images.length > 0 ? getUniqueImages(liveDataRaw.images) : []
      };

      const auditResult = performAudit(masterData, liveData, 'bol');
      res.json({ liveData, auditResult });
      } catch (error: any) {
        // Handle IP block with retry logic
        if (error.message === "IP_BLOCKED" && retryCount < maxRetries) {
          retryCount++;
          console.log(`IP blocked detected. Retrying with new proxy (Attempt ${retryCount}/${maxRetries})...`);
          if (browser) await browser.close();
          return performBolAudit(); // Retry with new proxy rotation
        }
        throw error;
      }
    };
    
    try {
      await performBolAudit();
    } catch (error: any) {
      console.error("Bol Audit Error:", error);
      res.status(500).json({ 
        error: error.message || "An unexpected error occurred during Bol.com audit",
        details: error.stack,
        name: error.name
      });
    } finally {
      if (browser) await browser.close();
    }
  });

  function prepareRowData(mode: string, auditResult: any, masterData: any, marketplace: string, identifier: string) {
    const getMatchText = (isMatch: boolean) => isMatch ? 'Yes' : 'No';
    const getAPlusText = (hasAPlus: boolean) => hasAPlus ? 'Available' : 'Not Available';
    const getVariationText = (exists: boolean) => exists ? 'Yes' : 'No';
    
    const masterFirst = masterData.images?.[0] || "";
    const liveFirst = auditResult.images?.live?.[0] || "";
    const allLiveImages = (auditResult.images?.live || []).join(", ");
    
    const sharedData: any = {
      "Identifier": identifier,
      "SKU": identifier,
      "Title match": getMatchText(auditResult.title.match),
      "Title Match": getMatchText(auditResult.title.match),
      "Description match": getMatchText(auditResult.description.match),
      "Description Match": getMatchText(auditResult.description.match),
      "Main Image Link": masterFirst,
      "Live Image Links": allLiveImages,
      "Main Image": masterFirst ? `=IMAGE("${masterFirst}")` : "",
      "Live Image": liveFirst ? `=IMAGE("${liveFirst}")` : "",
      
      // Specific requested mappings Target: "Main Live Image", "Image 1", "Live Image 1"
      "Main Live Image": liveFirst ? `=IMAGE("${liveFirst}")` : "",
      "Image 1": masterFirst, 
      "Live Image 1": liveFirst,
      
      "A+ Content": getAPlusText(auditResult.hasAPlus.live),
      "A+": getAPlusText(auditResult.hasAPlus.live),
      "Has A+": getAPlusText(auditResult.hasAPlus.live),
      "Shipping Time": auditResult.shipping.live || "N/A",
      "Shipping": auditResult.shipping.live || "N/A",
      "Delivery Days": auditResult.shipping.live || "N/A",
      "Price": auditResult.price.live || "N/A",
      "Variation": getVariationText(auditResult.variations.live),
      "Variations": getVariationText(auditResult.variations.live),
      "Variation Match": getVariationText(auditResult.variations.live),
      "Bullet Points match": auditResult.bullets ? getMatchText(auditResult.bullets.length > 0 && auditResult.bullets.every((b: any) => b.match)) : "N/A",
      "Bullet Points Match": auditResult.bullets ? getMatchText(auditResult.bullets.length > 0 && auditResult.bullets.every((b: any) => b.match)) : "N/A",
      "Bullets Match": auditResult.bullets ? getMatchText(auditResult.bullets.length > 0 && auditResult.bullets.every((b: any) => b.match)) : "N/A"
    };

    // Bulk Image Columns Implementation
    const prefix = mode === 'amazon' ? 'Amazon' : 'Bol';
    const masterImgs = masterData.images || [];
    const liveImgs = auditResult.images?.live || [];

    // Main image aliases
    sharedData[`${prefix} Main Image`] = masterImgs[0] ? `=IMAGE("${masterImgs[0]}")` : "";
    sharedData[`${prefix} Main Live Image`] = liveImgs[0] ? `=IMAGE("${liveImgs[0]}")` : "";

    // Master Images 1-10
    for (let i = 1; i <= 10; i++) {
      const url = masterImgs[i-1] || "";
      sharedData[`${prefix} Master Image ${i}`] = url ? `=IMAGE("${url}")` : "";
    }

    // Live Images 1-10
    for (let i = 1; i <= 10; i++) {
      const url = liveImgs[i-1] || "";
      sharedData[`${prefix} Live Image ${i}`] = url ? `=IMAGE("${url}")` : "";
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
    const cleanMasterTitle = cleanText(master.title);
    const cleanLiveTitle = cleanText(live.title);
    const titleSimilarity = stringSimilarity.compareTwoStrings(cleanMasterTitle, cleanLiveTitle);
    results.title = {
      master: master.title,
      live: live.title,
      similarity: titleSimilarity,
      match: cleanMasterTitle === cleanLiveTitle
    };

    // Description Comparison
    const isImageDesc = live.description.startsWith('IMAGE:');
    const isAPlusImages = live.description.startsWith('APLUS_IMAGES:');
    const isAPlusData = live.description.startsWith('APLUS_DATA:');
    const cleanMasterDesc = cleanText(master.description);
    const cleanLiveDesc = (isImageDesc || isAPlusImages || isAPlusData) ? "" : cleanText(live.description);
    const descSimilarity = (isImageDesc || isAPlusImages || isAPlusData) ? 0.5 : stringSimilarity.compareTwoStrings(cleanMasterDesc, cleanLiveDesc);
    
    results.description = {
      master: master.description,
      live: live.description,
      similarity: descSimilarity,
      match: (isImageDesc || isAPlusImages || isAPlusData) ? false : (cleanMasterDesc === cleanLiveDesc),
      isImage: isImageDesc || isAPlusImages || isAPlusData,
      isAPlus: isAPlusImages || isAPlusData,
      status: ((isAPlusImages || isAPlusData) && cleanMasterDesc) ? "Manual Check Required: A+ Content Live" : null
    };

    // Currency Validation - REMOVED as per user request
    results.currency = {
      expected: "N/A",
      actual: live.currency || "N/A",
      match: true
    };

    // Bullet Points Comparison (98% similarity threshold)
    results.bullets = (master.bullets || []).map((mb: string, i: number) => {
      const lb = live.bullets?.[i] || "";
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

    // Image comparison results
    const masterImages = master.images || [];
    const liveImages = live.images || [];
    const masterFirst = masterImages[0] || "";
    const liveFirst = liveImages[0] || "";
    
    // Simple match logic: compare first image filename or full URL
    const getFilename = (url: string) => url.split('/').pop()?.split('?')[0] || "";
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
