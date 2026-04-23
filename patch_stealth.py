import re
import codecs

def patch():
    with codecs.open('server.ts', 'r', 'utf-8') as f:
        content = f.read()

    # --- AMAZON CHANGES ---
    # 1. Amazon Proxy Rotation
    amazon_proxy_target = """      if (process.env.PROXY_SERVER) {
        launchOptions.proxy = {
          server: process.env.PROXY_SERVER,
          username: process.env.PROXY_USERNAME,
          password: process.env.PROXY_PASSWORD
        };
      }"""
    amazon_proxy_replacement = """      if (process.env.ANTIGRAVITY_API_KEY) {
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
      }"""
    content = content.replace(amazon_proxy_target, amazon_proxy_replacement)

    # 2. Amazon UA Randomization
    amazon_ua_target = """            const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/122.0.0.0 Safari/537.36'
      ];"""
    amazon_ua_replacement = """      const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      ];"""
    content = content.replace(amazon_ua_target, amazon_ua_replacement)

    # 3. Amazon Session Cookie Zip Code
    # It already pushes a sp-cdn with zip code in 'server.ts'. The user asked for "Session Cookie that includes a zip code".
    # I'll just change the Amazon Wait Logic first.
    amazon_wait_target = """      try {
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
      await page.waitForSelector('#ppd', { timeout: 15000 }).catch(() => {
        console.warn("Product title not found within 15s, page might be slow or blocked.");
      });"""
    amazon_wait_replacement = """      try {
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
      
      // Ensure the product display is fully visible (Mandatory Wait-Until)
      await page.waitForSelector('#ppd', { state: 'visible', timeout: 30000 });"""
    content = content.replace(amazon_wait_target, amazon_wait_replacement)

    # 5. Amazon Selectors
    amazon_price_target = """      // Primary selectors for core price display
      const corePriceDiv = $('#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #apex_desktop_price_feature_div');"""
    amazon_price_replacement = """      // Primary selectors for core price display
      const corePriceDiv = $('span.a-offscreen, span#price_inside_buybox, div#corePrice_feature_div');"""
    content = content.replace(amazon_price_target, amazon_price_replacement)

    amazon_shipping_target = """      const deliverySelectors = [
        '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID',
        '#delivery-message',
        'span[data-amazon-delivery-date]',
        '#deliveryBlockMessage',"""
    amazon_shipping_replacement = """      const deliverySelectors = [
        'div#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID',
        'span[data-amazon-delivery-date]',
        'div#deliveryBlockMessage',
        '#delivery-message',"""
    content = content.replace(amazon_shipping_target, amazon_shipping_replacement)

    # --- BOL CHANGES ---
    # 6. Bol Proxy Rotation
    bol_proxy_target = """        if (process.env.ANTIGRAVITY_API_KEY) {
          // Antigravity NL Residential Proxy Configuration
          // Format: http://apikey:residential-nl@proxy.antigravityai.com:8080
          const antigravityKey = process.env.ANTIGRAVITY_API_KEY;
          launchOptions.proxy = {
            server: `http://${antigravityKey}:residential-nl@proxy.antigravityai.com:8080`
          };
          console.log("Using Antigravity NL Residential Proxy for Bol.com");
        } else if (process.env.PROXY_SERVER) {
          // Standard proxy with username/password
          const proxyUrl = process.env.PROXY_SERVER;
          const username = process.env.PROXY_USERNAME;
          const password = process.env.PROXY_PASSWORD;
          launchOptions.proxy = {
            server: proxyUrl,
            username: username,
            password: password
          };
          console.log("Using standard proxy for Bol.com");
        }"""
    bol_proxy_replacement = """        if (process.env.ANTIGRAVITY_API_KEY) {
          launchOptions.proxy = {
            server: `http://${process.env.ANTIGRAVITY_API_KEY}:residential-nl@proxy.antigravityai.com:8080`
          };
          console.log("Using Antigravity NL Residential Proxy for Bol.com");
        } else if (process.env.PROXY_SERVER) {
          launchOptions.proxy = {
            server: process.env.PROXY_SERVER,
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
          };
        }"""
    content = content.replace(bol_proxy_target, bol_proxy_replacement)

    # Bol UA target is the same string, I'll use regex to fix Bol User-Agents array
    bol_ua_regex = r"const userAgents = \[\s+'Mozilla/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit/537\.36 \(KHTML, like Gecko\) Chrome/122\.0\.0\.0 Safari/537\.36',\s+'Mozilla/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit/537\.36 \(KHTML, like Gecko\) Chrome/121\.0\.0\.0 Safari/537\.36',\s+'Mozilla/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit/537\.36 \(KHTML, like Gecko\) Edge/122\.0\.0\.0 Safari/537\.36'\s+\];"
    content = re.sub(bol_ua_regex, amazon_ua_replacement, content)

    # Bol Wait Logic
    bol_wait_target = """      // Ensure we are on a product page
      await page.waitForSelector('.pdp-header, div#pdp_main_section, [data-test="title"]', { timeout: 30000 }).catch(() => {
        console.warn("Product indicators not found, page might be slow or not a product page.");
      });

      // Wait for network idle to ensure hydration
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
        console.warn("Network idle timeout, proceeding with current state.");
      });

      // Human-like delay after page load (3 seconds) to allow all JS to execute
      console.log("Waiting 3 seconds for JavaScript execution...");
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
      await page.waitForTimeout(2000);"""
    bol_wait_replacement = """      // Wait for network idle to ensure hydration
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);

      // Ensure we are on a product page (Mandatory wait for .pdp-header)
      await page.waitForSelector('.pdp-header', { state: 'visible', timeout: 30000 });

      // Human-like delay after page load (3 seconds) to allow all JS to execute
      console.log("Waiting 3 seconds for JavaScript execution...");
      await page.waitForTimeout(3000);

      // Scroll 500px down and back up instantly to trigger lazy loading
      await page.evaluate(() => {
        window.scrollBy(0, 500);
        setTimeout(() => window.scrollBy(0, -500), 100);
      });
      await page.waitForTimeout(1000);"""
    content = content.replace(bol_wait_target, bol_wait_replacement)

    # Bol description selectors
    bol_desc_target = """          const descSelectors = [
            '#pdp_description',
            'div.js_product_description',
            'section.product-description',
            '[data-test="description"]',"""
    bol_desc_replacement = """          const descSelectors = [
            'div[data-test="description"]',
            'div.js_product_description',
            '#pdp_description',
            'section.product-description',"""
    content = content.replace(bol_desc_target, bol_desc_replacement)

    # Final Map / Exact match for Sheet Integration
    # The previous cleanText kept whitespace, we strictly enforce it removes all non-alphabet bounds.
    clean_text_orig = """  function cleanText(text: string): string {
    if (!text) return "";
    // 1. Strip HTML tags
    let cleaned = text.replace(/<[^>]*>?/gm, '');
    
    // 2. Remove raw URLs
    cleaned = cleaned.replace(/https?:\\/\\/[^\\s]+\\.(jpg|jpeg|png|gif|webp|svg)/gi, '');
    
    // 3. Normalize diacritics (treat ├س as e, etc.)
    cleaned = cleaned.normalize('NFD').replace(/[\\u0300-\\u036f]/g, "");
    
    // 4. Whitespace Normalization (replace non-breaking spaces etc with standard space)
    cleaned = cleaned.replace(/[\\u00A0\\u1680\\u180E\\u2000-\\u200B\\u202F\\u205F\\u3000\\uFEFF]/g, ' ');
    
    // 5. Aggressive Alphanumeric filter (Removes symbols like ظ„ت, ┬«, ┬ر, bullets, punctuation)
    cleaned = cleaned.replace(/[^a-zA-Z0-9\\s]/g, '');
    
    // 6. Normalize casing and multiple spaces
    return cleaned.toLowerCase().trim().replace(/\\s+/g, ' ');
  }"""
    clean_text_replacement = """  function cleanText(text: string): string {
    if (!text) return "";
    let cleaned = String(text);
    // Strip everything that isn't a letter or number for exact comparison (Google Sheets Fix)
    return cleaned.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }"""
    content = content.replace(clean_text_orig, clean_text_replacement)

    # Because `cleanText` now strips spaces, `stringSimilarity.compareTwoStrings` will just evaluate exact char matches.
    # To fix "Yes/No", we ensure it returns false instead of using a fuzzy threshold, but they use 0.98 which works fine for exact matches when strings are same. 
    # Actually wait, `titleSimilarity >= 0.98` still works for exact match, but let's change them to exactly value match.
    match_targets = [
      ("match: titleSimilarity >= 0.98", "match: cleanMasterTitle === cleanLiveTitle"),
      ("match: (isImageDesc || isAPlusImages || isAPlusData) ? false : (descSimilarity >= 0.98)", "match: (isImageDesc || isAPlusImages || isAPlusData) ? false : (cleanMasterDesc === cleanLiveDesc)"),
      ("match: similarity >= 0.98", "match: cmb === clb"),
      ("match: stringSimilarity.compareTwoStrings(cleanText(master.shipping), cleanText(live.shipping)) >= 0.98", "match: cleanText(master.shipping) === cleanText(live.shipping)")
    ]
    for target, rep in match_targets:
        content = content.replace(target, rep)
    
    # Save the file
    with codecs.open('server.ts', 'w', 'utf-8') as f:
        f.write(content)

patch()
