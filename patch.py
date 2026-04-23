import os; f=open('old_server.ts', 'r', encoding='utf-8'); c=f.read(); f.close();

c=c.replace('images: uniqueImages\n      };', 'images: uniqueImages.length > 0 ? [uniqueImages[0]] : []\n      };')

c=c.replace('const firstProductLink = await page.getAttribute(firstProductSelector, \'href\').catch(() => null);', 'const el = await page.waitForSelector(firstProductSelector, { timeout: 10000 }).catch(() => null);\n        const firstProductLink = el ? await el.getAttribute(\'href\') : null;')

c=c.replace('server: { middlewareMode: true },', 'server: { middlewareMode: true, allowedHosts: true },')

f=open('server.ts', 'w', encoding='utf-8'); f.write(c); f.close()
