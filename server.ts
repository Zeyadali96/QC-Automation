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
import { chromium as chromiumBase } from "playwright";
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
      
      browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
      });

      // Set regional postcodes and language preferences
      const cookies = [
        { name: 'session-id', value: '123-4567890-1234567', domain: `.${domain}`, path: '/' },
        { name: 'ubid-main', value: '123-4567890-1234567', domain: `.${domain}`, path: '/' }
      ];
      
      if (domain.endsWith('.co.uk')) {
        cookies.push({ name: 'lc-main', value: 'en_GB', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'i18n-prefs', value: 'GBP', domain: `.${domain}`, path: '/' });
        cookies.push({ name: 'sp-cdn', value: '"LND:SW1A 1AA"', domain: `.${domain}`, path: '/' });
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
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
      } catch (e: any) {
        if (e.name === 'TimeoutError') {
          console.warn("Initial navigation timed out, attempting to proceed with current content...");
        } else {
          throw e;
        }
      }
      
      // Ensure the product title is at least present
      await page.waitForSelector('#productTitle', { timeout: 15000 }).catch(() => {
        console.warn("Product title not found within 15s, page might be slow or blocked.");
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

      // Wait a bit more for dynamic elements
      await page.waitForTimeout(4000);
      
      // Extraction Strategy A: Dynamic Image JSON (Highest Res)
      const dynamicImageJson = await page.evaluate(() => {
        const img = document.querySelector('#landingImage');
        return img ? img.getAttribute('data-a-dynamic-image') : null;
      });

      let images: string[] = [];
      if (dynamicImageJson) {
        try {
          const imgMap = JSON.parse(dynamicImageJson);
          const sortedImgs = Object.keys(imgMap).sort((a, b) => {
            const resA = imgMap[a][0] * imgMap[a][1];
            const resB = imgMap[b][0] * imgMap[b][1];
            return resB - resA;
          });
          if (sortedImgs[0]) images.push(sortedImgs[0]);
        } catch (e) {
          console.warn("Failed to parse dynamic image JSON");
        }
      }

      // Extraction Strategy B: Script-based (colorImages) - High Res
      const colorImagesData = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const content = script.innerHTML;
          if (content.includes('colorImages')) {
            const match = content.match(/'colorImages':\s*({.+?}),/);
            if (match) {
              try {
                return JSON.parse(match[1].replace(/'/g, '"'));
              } catch (e) { return null; }
            }
          }
        }
        return null;
      });

      if (colorImagesData) {
        const firstColor = Object.keys(colorImagesData.initial || colorImagesData)[0];
        const colorImgs = (colorImagesData.initial || colorImagesData)[firstColor];
        if (Array.isArray(colorImgs)) {
          colorImgs.forEach((img: any) => {
            const url = img.hiRes || img.large || img.main?.['1500']?.[0];
            if (url && !images.includes(url)) images.push(url);
          });
        }
      }

      // Extraction Strategy C: Alt Images (as fallback or addition)
      const altImgUrls = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('#altImages ul li img'))
          .map((img: any) => img.getAttribute('data-old-hires') || img.src)
          .filter(src => src && src.startsWith('http'))
          .map(src => src.split('._')[0] + '.jpg'); // Early normalizer
      });
      images = [...images, ...altImgUrls];

      const uniqueImages = getUniqueImages(images);

      // Get content
      const content = await page.content();
      const $ = cheerio.load(content);




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

      // Shipping Extraction (Target: div#mir-layout-DELIVERY_BLOCK)
      const deliverySelectors = [
        '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
        '#mir-layout-DELIVERY_BLOCK',
        '#deliveryBlockMessage',
        '#pfd-desktop-PRIMARY_DELIVERY_MESSAGE_LARGE',
        '#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE',
        '#fastest_delivery_message',
        '#upsell-messaging',
        '#ddmDeliveryMessage',
        '.a-spacing-base .a-text-bold',
        '#pba-delivery-message'
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
          
          // Basic Dutch parsing for Amazon.nl
          const nlMonthMap: Record<string, number> = {
            'januari': 0, 'februari': 1, 'maart': 2, 'april': 3, 'mei': 4, 'juni': 5,
            'juli': 6, 'augustus': 7, 'september': 8, 'oktober': 9, 'november': 10, 'december': 11
          };

          const s = dateStr.toLowerCase();
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
            } else {
              // Try standard parsing
              const parsed = new Date(dateStr + ` ${currentYear}`);
              if (!isNaN(parsed.getTime())) targetDate = parsed;
            }
          }

          if (!targetDate && /morgen|tomorrow/i.test(s)) {
            targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + 1);
          }

          if (targetDate) {
            targetDate.setHours(0, 0, 0, 0);
            const todayClean = new Date();
            todayClean.setHours(0, 0, 0, 0);
            const diff = differenceInDays(targetDate, todayClean);
            shippingDaysNum = diff >= 0 ? diff : 0;
            shippingDaysStr = `${shippingDaysNum} Days`;
          }
        } catch (e) {
          console.error("Shipping parsing error:", e);
        }
      }

      // Price Extraction (Target: #corePriceDisplay_desktop_feature_div)
      let priceDisplay = "N/A";
      let listPrice = "N/A";
      
      const corePriceDiv = $('#corePriceDisplay_desktop_feature_div, #apex_desktop_price_feature_div');
      if (corePriceDiv.length) {
        priceDisplay = corePriceDiv.find('span.a-offscreen').first().text().trim() || 
                       corePriceDiv.find('.a-price span.a-offscreen').first().text().trim();
        // List Price / RRP
        listPrice = corePriceDiv.find('.a-price.a-text-price span.a-offscreen').first().text().trim() || 
                    $('.basisPrice .a-offscreen').first().text().trim() || 
                    $('.a-price-range .a-offscreen').first().text().trim() || "N/A";
      }
      
      if (!priceDisplay || priceDisplay === "N/A") {
        priceDisplay = $('#price_inside_buybox').text().trim() || 
                       $('#priceblock_ourprice').text().trim() ||
                       $('#priceblock_dealprice').text().trim() ||
                       $('input[name="items[0.base][customerVisiblePrice][displayString]"]').val() as string || "N/A";
      }

      const variationSelectors = [
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
        '.variation-group'
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
          'size:', 'color:', 'style:', 'rozmiar:', 'kolor:', 'styl:', 'grösse:', 'farbe:', 'storlek:', 'färg:',
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
          'grubość:', 'średnica:', 'głębokość:', 'tkanina:', 'zestaw:', 'opakowanie:', 'liczba:', 'częstotliwość:',
          'gwarancja:', 'platforma:', 'wersja:', 'rozdzielczość:', 'kompatybilność:', 'język:', 'kraj:', 'wiek:', 'płeć:',
          // Localized German
          'dicke:', 'durchmesser:', 'tiefe:', 'stoff:', 'set:', 'packung:', 'anzahl:', 'frequenz:', 'garantie:',
          'plattform:', 'version:', 'auflösung:', 'kompatibilität:', 'sprache:', 'land:', 'alter:', 'geschlecht:',
          // Localized Swedish
          'tjocklek:', 'diameter:', 'djup:', 'tyg:', 'set:', 'förpackning:', 'antal:', 'frekvens:', 'garanti:',
          'plattform:', 'version:', 'upplösning:', 'kompatibilitet:', 'språk:', 'land:', 'ålder:', 'kön:',
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
    try {
      const { ean, masterData } = req.body;
      const searchUrl = `https://www.bol.com/nl/nl/s/?searchtext=${ean}`;
      
      console.log(`Starting Bol Audit for EAN: ${ean}`);
      
      browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        extraHTTPHeaders: {
          'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Referer': 'https://www.google.com/'
        }
      });

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
      
      // Navigate to search results
      console.log(`Navigating to: ${searchUrl}`);
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e: any) {
        if (e.name === 'TimeoutError') {
          console.warn("Bol search navigation timed out, attempting to proceed...");
        } else {
          throw e;
        }
      }
      
      // Check for CAPTCHA or blocking
      const blockStatus = await page.evaluate(function() {
        const text = document.body.innerText;
        const title = document.title;
        if (title.includes('geblokkeerd') || text.includes('geblokkeerd') || title.includes('Access Denied')) {
          return { blocked: true, message: "Bol.com blocked the server IP. (Access Denied)" };
        }
        if (title.includes('Robot Check') || text.includes('Type the characters')) {
          return { blocked: true, message: "Amazon-style Robot Check detected." };
        }
        if (text.includes('Ben je een robot?') || text.includes('Je gaat iets te snel')) {
          return { blocked: true, message: "Bol.com bot detection triggered." };
        }
        return { blocked: false };
      });

      if (blockStatus.blocked) {
        throw new Error(blockStatus.message);
      }



      // Check if we are on a search page or product page
      let pageTitle = await page.title();
      console.log(`Page Title: ${pageTitle}`);
      
      const isSearchPage = pageTitle.includes('Alle artikelen') || 
                           pageTitle.includes('Zoekresultaten') || 
                           await page.evaluate(function() {
                             // @ts-ignore
                             if (typeof __name === 'undefined') { (window as any).__name = (t: any, v: any) => t; }
                             return !!document.querySelector('.product-list, .product-item--grid, [data-test="product-list"]');
                           });
      
      if (isSearchPage) {
        console.log("Search page detected, looking for product link...");
        // Try to find the first product link - more robust selector
        const firstProductSelector = 'a[href*="/p/"]:not([href*="javascript"]), .product-title a, a[data-test="product-title"], .product-item--grid a, .product-list a';
        await page.waitForSelector(firstProductSelector, { timeout: 10000 }).catch(() => null);
        const firstProductLink = await page.getAttribute(firstProductSelector, 'href').catch(() => null);
        
        if (firstProductLink) {
          const productUrl = firstProductLink.startsWith('http') ? firstProductLink : `https://www.bol.com${firstProductLink}`;
          console.log(`Navigating to product URL: ${productUrl}`);
          try {
            await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          } catch (e: any) {
            if (e.name === 'TimeoutError') {
              console.warn("Bol product navigation timed out, attempting to proceed...");
            } else {
              throw e;
            }
          }
        } else {
          console.warn("No product link found on search page.");
          // Fallback: try to find any link that looks like a product link
          const anyProductLink = await page.evaluate(function() {
            // @ts-ignore
            if (typeof __name === 'undefined') { (window as any).__name = (t: any, v: any) => t; }
            const links = Array.from(document.querySelectorAll('a'));
            const productLink = links.find(a => a.href.includes('/nl/nl/p/') && !a.href.includes('javascript'));
            return productLink ? productLink.getAttribute('href') : null;
          });
          
          if (anyProductLink) {
            const productUrl = anyProductLink.startsWith('http') ? anyProductLink : `https://www.bol.com${anyProductLink}`;
            console.log(`Fallback: Navigating to product URL: ${productUrl}`);
            try {
              await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            } catch (e: any) {
              if (e.name === 'TimeoutError') {
                console.warn("Bol fallback product navigation timed out, attempting to proceed...");
              } else {
                throw e;
              }
            }
          }
        }
      }

      // Ensure we are on a product page
      try {
        await page.waitForSelector('div#pdp_main_section, [data-test="title"], h1.page-title, #buyBlockSlot, .pdp-header', { timeout: 30000 });
      } catch (e) {
        // Double check block status if selector fails
        const currentTitle = await page.title();
        if (currentTitle.toLowerCase().includes('geblokkeerd') || currentTitle.toLowerCase().includes('access denied')) {
           throw new Error("Bol.com blocked the server IP. (Access Denied)");
        }
        console.warn("Product indicators not found, page might be slow or not a product page.");
      }


      // Wait for network idle to ensure hydration
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
        console.warn("Network idle timeout, proceeding with current state.");
      });

      // Extra wait for dynamic content (variations, etc.)
      await page.waitForTimeout(3000);

      // Scroll to media container to trigger lazy loading
      await page.evaluate(() => {
        const media = document.querySelector('.js_product_media_items') || 
                      document.querySelector('.pdp-images') || 
                      document.querySelector('.buy-block');
        if (media) {
          media.scrollIntoView();
          // Scroll a bit more to ensure thumbnails are triggered
          window.scrollBy(0, 300);
        }
      });
      await page.waitForTimeout(2000);

      // Wait for media container specifically
      await page.waitForSelector('.js_product_media_items, .pdp-images, [data-test="product-main-image"]', { timeout: 10000 }).catch(() => null);

      const liveDataRaw = await page.evaluate(function() {
        // @ts-ignore
        if (typeof __name === 'undefined') { (window as any).__name = (t: any, v: any) => t; }
        
        // 1. Title
        const elTitle = document.querySelector('[data-test="title"]') || document.querySelector('h1.page-title') || document.querySelector('h1');
        const title = elTitle ? (elTitle as any).innerText.trim() : "";
        
        // 2. Description
        let description = "";
        
        // Strategy A: Dedicated description div
        const descSelectors = [
          '[data-test="description"]',
          '.js_product_description',
          '.pdp-description',
          '.product-description',
          'div[itemprop="description"]',
          '#descriptionBlock',
          '.product-description-content',
          'section#description',
          '.specs-content',
          '.manufacturer-info'
        ];
        
        for (const s of descSelectors) {
          const el = document.querySelector(s);
          if (el) {
            description = (el as any).innerText.trim();
            if (description.length > 50) break;
          }
        }

        // Strategy B: All text in the main description section
        if (!description || description.length < 50) {
           const mainSection = document.querySelector('div#pdp_main_section') || document.querySelector('.pdp-header');
           if (mainSection) {
              const text = (mainSection as any).innerText || "";
              const match = text.match(/Productbeschrijving([\s\S]+?)Productspecificaties/i);
              if (match) description = match[1].trim();
           }
        }

        // 3. Price
        let price = "N/A";
        const priceSelectors = [
           '[data-test="price"]',
           '.promo-price',
           '.buy-block__price',
           '.ab-pdp-price-and-shipping__price',
           '[data-test="price-amount"]'
        ];
        for (const s of priceSelectors) {
           const el = document.querySelector(s);
           if (el) {
              price = (el as any).innerText.replace(/\s+/g, '').replace('€', '').trim().replace(',', '.');
              if (price) break;
           }
        }

        // 4. Shipping
        let shippingText = "N/A";
        const shipSelectors = [
           '[data-test="delivery-highlight"]',
           '.delivery-promise',
           '.buy-block__delivery-text',
           '.delivery-delivery-time'
        ];
        for (const s of shipSelectors) {
           const el = document.querySelector(s);
           if (el) {
              shippingText = (el as any).innerText.trim();
              if (shippingText) break;
           }
        }

        // 5. Images
        let images: string[] = [];
        const imgSelectors = [
          '.js_product_media_items img', 
          '.pdp-images img', 
          '[data-test="product-main-image"] img',
          '.product-images__item img'
        ];
        imgSelectors.forEach(s => {
          const imgEls = Array.from(document.querySelectorAll(s));
          imgEls.forEach(img => {
            const src = (img as any).src || img.getAttribute('data-src') || img.getAttribute('src');
            if (src && src.includes('media.s-bol.com')) {
               // Normalize to large version
               const largeUrl = src.replace(/\/\d+x\d+\//, "/large/").replace("/small/", "/large/").replace("/thumb/", "/large/");
               images.push(largeUrl);
            }
          });
        });

        // 6. Variations
        const hasVariations = !!(
           document.querySelector('[data-test="variant-selector"]') || 
           document.querySelector('.variant-selector') || 
           document.querySelector('.js_variant_selector') ||
           document.querySelector('.pdp-variant-selector')
        );

        return {
          title,
          description: description || "No description on detail page",
          price,
          shipping: shippingText,
          images: Array.from(new Set(images)),
          variations: hasVariations ? 1 : 0
        };
      });

      const liveData = {
        ...liveDataRaw,
        bullets: [],
        hasAPlus: false
      };

      const auditResult = performAudit(masterData, liveData, 'bol');
      res.json({ liveData, auditResult });

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
    // 1. Strip HTML tags
    let cleaned = text.replace(/<[^>]*>?/gm, '');
    
    // 2. Remove raw URLs
    cleaned = cleaned.replace(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)/gi, '');
    
    // 3. Normalize diacritics (treat ë as e, etc.)
    cleaned = cleaned.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
    
    // 4. Whitespace Normalization (replace non-breaking spaces etc with standard space)
    cleaned = cleaned.replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');
    
    // 5. Aggressive Alphanumeric filter (Removes symbols like ™, ®, ©, bullets, punctuation)
    cleaned = cleaned.replace(/[^a-zA-Z0-9\s]/g, '');
    
    // 6. Normalize casing and multiple spaces
    return cleaned.toLowerCase().trim().replace(/\s+/g, ' ');
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
        
        // Amazon High-Res Normalization
        // 1. Extract ID (e.g., 81O5H... from /images/I/81O5H....jpg)
        const idMatch = url.match(/\/I\/([A-Za-z0-9_-]+)/);
        if (idMatch) {
          imgId = idMatch[1];
          
          // 2. Construct High-Res URL (Strips sizing fragments correctly)
          // Aggressive strip of Amazon image processors like ._AC_..._ or ._SL..._
          const cleanUrl = url.split(/\.\_[A-Z][A-Z0-9,_-]{3,}\./)[0];
          if (cleanUrl.includes('/I/')) {
            processedUrl = cleanUrl + '.jpg';
          } else {
             // Fallback for non /I/ urls
             processedUrl = url.replace(/\._[A-Z0-9,_-]{5,}(\.|$|_)/, '.');
             if (!processedUrl.endsWith('.jpg')) {
                const parts = processedUrl.split('.');
                processedUrl = (parts.length > 1 ? parts.slice(0, -1).join('.') : processedUrl) + '.jpg';
             }
          }
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
      match: titleSimilarity >= 0.98
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
      match: (isImageDesc || isAPlusImages || isAPlusData) ? false : (descSimilarity >= 0.98),
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

    // Bullet Points Comparison
    results.bullets = (master.bullets || []).map((mb: string, i: number) => {
      const lb = live.bullets?.[i] || "";
      const cmb = cleanText(mb);
      const clb = cleanText(lb);
      return {
        master: mb,
        live: lb,
        similarity: stringSimilarity.compareTwoStrings(cmb, clb),
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
      server: { middlewareMode: true },
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
