import re

def flex_replace():
    with open('server.ts', 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Amazon Proxy Rotation
    start_str = "if (process.env.PROXY_SERVER) {\n        launchOptions.proxy = {\n          server: process.env.PROXY_SERVER,\n          username: process.env.PROXY_USERNAME,\n          password: process.env.PROXY_PASSWORD\n        };\n      }"
    
    repl = """if (process.env.ANTIGRAVITY_API_KEY) {
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
      
    content = content.replace(start_str, repl)

    with open('server.ts', 'w', encoding='utf-8') as f:
        f.write(content)

flex_replace()
