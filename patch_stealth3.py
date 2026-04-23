import re

def flex_replace():
    with open('server.ts', 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Bol Wait logic
    bol_wait = """      // Wait for network idle to ensure hydration
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
    
    # We find the start and end tokens
    start_str = "// Ensure we are on a product page"
    end_str = "await page.waitForTimeout(2000);"
    
    s_idx = content.find(start_str)
    e_idx = content.find(end_str, s_idx)
    if s_idx != -1 and e_idx != -1:
        # replace block
        content = content[:s_idx] + bol_wait + content[e_idx + len(end_str):]
        print("Bol wait replaced!")

    # 2. Bol Selectors
    start_desc = "const descSelectors = ["
    end_desc = "'[data-test=\"description\"]',"
    s_desc = content.find(start_desc)
    e_desc = content.find(end_desc, s_desc)
    if s_desc != -1 and e_desc != -1:
        bol_desc = """          const descSelectors = [
            'div[data-test="description"]',
            'div.js_product_description',
            '#pdp_description',
            'section.product-description',"""
        content = content[:s_desc] + bol_desc + content[e_desc + len(end_desc):]
        print("Bol description replaced!")

    # 3. Amazon Session Cookie Fix (Ensure session-id zip code logic explicitly exists) 
    # Not purely requested but requested in prompt (NW1 6XE). The code uses sp-cdn with NW1 6XE already. We'll leave it as we already checked it.

    with open('server.ts', 'w', encoding='utf-8') as f:
        f.write(content)

flex_replace()
