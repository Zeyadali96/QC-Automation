import re
import codecs

with codecs.open('server.ts', 'r', 'utf-8') as f:
    content = f.read()

# 1. User Agent Randomization
ua_script = """      const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/122.0.0.0 Safari/537.36'
      ];
      const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
      const context = await browser.newContext({
        userAgent: randomUserAgent,"""

content = re.sub(r'const context = await browser\.newContext\(\{\s+userAgent: \'[^\']+\',', ua_script, content, count=0)

# Add webdriver = false to both Amazon and Bol just before page.goto
webdriver_script = """      const page = await context.newPage();
      await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });"""
content = re.sub(r'const page = await context\.newPage\(\);', webdriver_script, content)

# 2. Amazon cookies zip code override
content = content.replace("value: '\"LND:SW1A 1AA\"'", "value: '\"LND:NW1 6XE\"'")

# 3. Amazon Wait-until #ppd
# Replace the wait for #productTitle
content = content.replace("await page.waitForSelector('#productTitle', { timeout: 15000 })", "await page.waitForSelector('#ppd', { timeout: 15000 })")

# 4. Bol Wait-until .pdp-header
# Replace the wait for product indicators
content = content.replace("await page.waitForSelector('div#pdp_main_section, [data-test=\"title\"], h1.page-title, #buyBlockSlot', { timeout: 30000 })", "await page.waitForSelector('.pdp-header, div#pdp_main_section, [data-test=\"title\"]', { timeout: 30000 })")

# Bol Lazy Load Scroll
bol_scroll = """      // Scroll to media container to trigger lazy loading
      await page.evaluate(() => {
        window.scrollBy(0, 500);
        setTimeout(() => window.scrollBy(0, -500), 100);
        const media = document.querySelector('.js_product_media_items') || """
content = content.replace("""      // Scroll to media container to trigger lazy loading\n      await page.evaluate(() => {\n        const media = document.querySelector('.js_product_media_items') ||""", bol_scroll)

# 5. Amazon Price fallbacks
content = content.replace("const corePriceDiv = $('#corePriceDisplay_desktop_feature_div, #apex_desktop_price_feature_div');", "const corePriceDiv = $('#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #apex_desktop_price_feature_div');")

# 6. Amazon Shipping fallbacks
content = content.replace("'#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID',", "'#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID',\n        'span[data-amazon-delivery-date]',\n        '#deliveryBlockMessage',")

# 7. Bol clean function update for 100% exact match
clean_text_orig = """    // 5. Aggressive Alphanumeric filter (Removes symbols like ™, ®, ©, bullets, punctuation)
    cleaned = cleaned.replace(/[^a-zA-Z0-9\s]/g, '');
    
    // 6. Normalize casing and multiple spaces
    return cleaned.toLowerCase().trim().replace(/\s+/g, ' ');"""

clean_text_new = """    // 5. Aggressive Alphanumeric filter (Removes symbols like ™, ®, ©, bullets, punctuation)
    cleaned = cleaned.replace(/[^a-zA-Z0-9]/g, '');
    
    // 6. Normalize casing and multiple spaces
    return cleaned.toLowerCase().trim();"""
content = content.replace(clean_text_orig, clean_text_new)

with codecs.open('server.ts', 'w', 'utf-8') as f:
    f.write(content)
