# Railway Deployment Guide - Bol.com IP Block Fix & Amazon Price/Shipping Restoration

## Overview of Changes
This deployment includes comprehensive fixes for:
1. ✅ Bol.com IP block bypass with residential proxies
2. ✅ Amazon price/shipping N/A issue resolution  
3. ✅ Improved description & variation extraction
4. ✅ 98% similarity threshold for Google Sheets matching

---

## Step 1: Update Environment Variables in Railway

Navigate to your Railway project dashboard and add/update these variables:

### Antigravity Proxy (Recommended for Bol.com)
```
ANTIGRAVITY_API_KEY = your-antigravity-api-key-here
```
Get your API key from Antigravity AI portal at: https://antigravityai.com/dashboard

### Fallback Proxy Configuration (optional, if not using Antigravity)
```
PROXY_SERVER = http://proxy-server-url:port
PROXY_USERNAME = your-proxy-username
PROXY_PASSWORD = your-proxy-password
```

### Google Sheets Credentials (already configured, verify exists)
```
GOOGLE_SERVICE_ACCOUNT_EMAIL = your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY = -----BEGIN PRIVATE KEY-----\n...your key...\n-----END PRIVATE KEY-----
```

---

## Step 2: Deploy Updated Code

### Option A: Direct File Upload
1. Copy the updated `server.ts` to your Railway project root
2. In Railway Dashboard → Settings → Redeploy
3. Select "Redeploy from Git" or upload files

### Option B: Git Push
1. Replace your local `server.ts` with the updated version
2. Commit changes: `git add server.ts && git commit -m "Fix: IP block bypass, price/shipping extraction"`
3. Push to Railway: `git push origin main`

---

## Step 3: Verify Deployment

After deployment, test these endpoints:

### Test Bol.com Audit (IP Block Fix)
```bash
curl -X POST http://your-railway-url/api/audit/bol \
  -H "Content-Type: application/json" \
  -d '{
    "ean": "8720618516647",
    "masterData": {
      "title": "Test Product",
      "description": "Test description",
      "images": ["https://example.com/image.jpg"],
      "price": "19.99",
      "shipping": "1 Day",
      "variations": 0,
      "hasAPlus": 0,
      "bullets": []
    }
  }'
```

### Test Amazon Audit (Price/Shipping Fix)
```bash
curl -X POST http://your-railway-url/api/audit/amazon \
  -H "Content-Type: application/json" \
  -d '{
    "asin": "B08FAKE123",
    "marketplace": "amazon.com",
    "masterData": {
      "title": "Test Product",
      "description": "Test description",
      "images": ["https://example.com/image.jpg"],
      "price": "29.99",
      "shipping": "2 Days",
      "variations": 0,
      "hasAPlus": 0,
      "bullets": []
    }
  }'
```

---

## Step 4: Monitor Logs

Check Railway logs for:

### Success Indicators
- ✅ "Using Antigravity NL Residential Proxy for Bol.com"
- ✅ "Waiting 3 seconds for JavaScript execution..."
- ✅ Price extracted (not "N/A")
- ✅ Shipping days calculated correctly

### Warning Signs to Check
- ❌ "IP_BLOCKED" errors → Antigravity key may be invalid
- ❌ Price still "N/A" → Check if Amazon page structure changed
- ❌ Shipping "N/A" → May need selector updates

---

## Step 5: Verify Google Sheets Integration

Test the Google Sheets save functionality:

```bash
curl -X POST http://your-railway-url/api/sheets/save-audit \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "bol",
    "identifier": "8720618516647",
    "marketplace": "bol.com",
    "masterData": {...},
    "auditResult": {...}
  }'
```

Expected behavior:
- Description "match" field = "Yes" (if 98%+ similarity after cleaning)
- Price & Shipping also show "Yes" when similar
- Images extracted and displayed

---

## Key Implementation Details

### Bol.com IP Block Handling
- Automatically retries up to 3 times with new proxy IPs
- Detects "IP adres is geblokkeerd" error
- Clears cookies between attempts
- Uses NL residential proxies only (no data center IPs)

### Amazon Price/Shipping Extraction
- **Price**: Tries 10+ different selectors before returning N/A
- **Shipping**: Right-side buybox + additional 5 fallback locations
- All selectors cleaned and normalized before comparison

### 98% Similarity Matching
- `cleanText()` removes: `&nbsp;`, `-`, `•`, special characters
- Normalizes: diacritics, case, whitespace
- Converts "No" → "Yes" when similarity ≥ 98%

---

## Troubleshooting

### If Bol.com still shows IP block:
1. Verify `ANTIGRAVITY_API_KEY` is set correctly
2. Check Antigravity account has active NL residential proxies
3. Review Railway logs for specific error message
4. Consider using alternative proxy with NL rotation

### If Amazon price still N/A:
1. Manually check the Amazon product page structure
2. Add new selector to the price extraction list if needed
3. Check if Amazon is blocking the browser (CAPTCHA detected)
4. Verify Playwright stealth plugin is enabled

### If Google Sheets shows "No" instead of "Yes":
1. Verify similarity threshold is set to 0.98 (98%)
2. Check cleanText() is removing all non-alphanumeric chars
3. Review similarity score in audit result (should be ≥ 0.98)

---

## Rollback Plan

If issues arise:
1. Revert to previous `server.ts` version
2. Redeploy from git: `git revert HEAD`
3. Keep Antigravity credentials for future attempts

---

## Next Steps After Deployment

1. ✅ Run test audits on 5-10 products
2. ✅ Verify Google Sheet shows correct "Yes" values
3. ✅ Monitor proxy usage in Antigravity dashboard
4. ✅ Check for any error patterns in Railway logs
5. ✅ Adjust timeouts if pages load slowly in your region

---

**Deployment Status**: Ready for production
**Last Updated**: 2026-04-21
**Expected Downtime**: ~2-3 minutes during deployment
