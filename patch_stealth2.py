import re
import codecs

def flex_replace(content, pattern, repl):
    # Regex replacement supporting any whitespaces
    return re.sub(pattern, repl, content, flags=re.DOTALL)

def patch():
    with codecs.open('server.ts', 'r', 'utf-8') as f:
        content = f.read()

    # Bol Wait logic replacement
    pattern = r"// Ensure we are on a product page\s+await page\.waitForSelector\('\.pdp-header, div#pdp_main_section, \[data-test=\"title\"\]', \{ timeout: 30000 \}\)\.catch\(\(\) => \{\s+console\.warn\(\"Product indicators not found, page might be slow or not a product page\.\"\);\s+\}\);\s+// Wait for network idle to ensure hydration\s+await page\.waitForLoadState\('load', \{ timeout: 15000 \}\)\.catch\(\(\) => null\);\s+await page\.waitForLoadState\('networkidle', \{ timeout: 15000 \}\)\.catch\(\(\) => \{\s+console\.warn\(\"Network idle timeout, proceeding with current state\.\"\);\s+\}\);\s+// Human-like delay after page load \(3 seconds\) to allow all JS to execute\s+console\.log\(\"Waiting 3 seconds for JavaScript execution\.\.\.\"\);\s+await page\.waitForTimeout\(3000\);\s+// Scroll to media container to trigger lazy loading\s+await page\.evaluate\(\(\) => \{\s+const media = document\.querySelector\('\.js_product_media_items'\) \|\|\s+document\.querySelector\('\.pdp-images'\) \|\|\s+document\.querySelector\('\.buy-block'\);\s+if \(media\) \{\s+media\.scrollIntoView\(\);\s+// Scroll a bit more to ensure thumbnails are triggered\s+window\.scrollBy\(0, 300\);\s+\}\s+\}\);\s+await page\.waitForTimeout\(2000\);"
    
    repl = """// Wait for network idle to ensure hydration
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);

      // Ensure we are on a product page (Mandatory visibility wait)
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
      
    content = flex_replace(content, pattern, repl)

    # Bol description selectors
    pattern2 = r"const descSelectors = \[\s+'#pdp_description',\s+'div\.js_product_description',\s+'section\.product-description',\s+'\[data-test=\"description\"\]',"
    repl2 = """const descSelectors = [
            'div[data-test="description"]',
            'div.js_product_description',
            '#pdp_description',
            'section.product-description',"""
    content = flex_replace(content, pattern2, repl2)
    
    with codecs.open('server.ts', 'w', 'utf-8') as f:
        f.write(content)

patch()
