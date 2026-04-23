import re
import codecs

with codecs.open('server.ts', 'r', 'utf-8') as f:
    content = f.read()

proxy_inject = """      const launchOptions: any = { 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      };
      if (process.env.PROXY_SERVER) {
        launchOptions.proxy = {
          server: process.env.PROXY_SERVER,
          username: process.env.PROXY_USERNAME,
          password: process.env.PROXY_PASSWORD
        };
      }
      browser = await chromium.launch(launchOptions);"""

content = re.sub(r'browser = await chromium\.launch\(\{[\s\S]*?\}\);', proxy_inject, content)

content = content.replace("corePriceDiv.find('.a-price span.a-offscreen').first().text().trim();", "corePriceDiv.find('.a-price span.a-offscreen').first().text().trim() || corePriceDiv.find('.a-color-price').first().text().trim();")

content = content.replace("'#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',", "'#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID',\n        '#delivery-message',\n        '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',")

content = content.replace("const variationSelectors = [", "const variationSelectors = [\n        '.swatches',\n        '.inline-twister-row',")

content = content.replace("await page.waitForSelector('.js_product_media_items, .pdp-images, [data-test=\"product-main-image\"]', { timeout: 10000 }).catch(() => null);", "await page.waitForSelector('.js_product_media_items, .pdp-images, [data-test=\"product-main-image\"], #pdp_description', { timeout: 15000 }).catch(() => null);")

content = content.replace("document.querySelector('[data-test=\"variant-selector\"]') ||", "document.querySelector('.js_attribute_selector') ||\n          document.querySelector('[data-test=\"variant-selector\"]') ||")

content = content.replace("document.querySelector('.delivery-promise') ||", "document.querySelector('.js_delivery_info') || \n                                document.querySelector('.ui-delivery-info') || \n                                document.querySelector('.delivery-promise') ||")

content = content.replace("'[data-test=\"description\"]',", "'div.js_product_description',\n            'section.product-description',\n            '[data-test=\"description\"]',")

with codecs.open('server.ts', 'w', 'utf-8') as f:
    f.write(content)
