# Pre-Deployment Checklist - Bol.com & Amazon Fixes

## ✅ Code Changes Verified

- [x] **Antigravity Proxy Integration**
  - Configured for NL residential proxies
  - Environment variable: `ANTIGRAVITY_API_KEY`
  - Fallback proxy support maintained

- [x] **IP Block Detection & Retry**
  - Detects "IP adres is geblokkeerd" error
  - Auto-retry up to 3 times
  - Proxy rotation on each retry

- [x] **Cookie Management**
  - Clears before adding new cookies (Amazon)
  - Clears before adding new cookies (Bol.com)
  - Prevents session tracking

- [x] **Amazon Price Extraction**
  - 8+ fallback selectors added
  - Primary: `#corePriceDisplay_desktop_feature_div`
  - Fallbacks: buybox, priceblock, color price, etc.

- [x] **Amazon Shipping Extraction**
  - Extended from 13 to 16+ selectors
  - Primary: `#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_ID`
  - Alternative: `#delivery-message`

- [x] **Human-Like Delay**
  - 3-second wait after page load
  - Allows full JavaScript execution
  - Better Bol.com React content capture

- [x] **Bol.com Description Extraction**
  - Added `#pdp_description` priority
  - Includes `.js_product_description` fallback
  - Better handling of React-rendered content

- [x] **Variation Detection**
  - Amazon: Added `.js_attribute_selector`
  - Bol: Enhanced label/option counting
  - More robust detection

- [x] **Data Comparison (98% Threshold)**
  - Title: 0.98 (98%) similarity ✅
  - Description: 0.98 (98%) similarity ✅
  - Bullet Points: Changed to 0.98 threshold ✅
  - Shipping: Changed to 0.98 threshold ✅

- [x] **Text Cleaning**
  - Removes HTML tags ✅
  - Removes URLs ✅
  - Normalizes diacritics ✅
  - Removes non-breaking spaces ✅
  - Removes ALL non-alphanumeric chars ✅
  - Normalizes case & spaces ✅

---

## ✅ Environment Variables Required

Before deploying, ensure these are set in Railway Dashboard:

```
☐ ANTIGRAVITY_API_KEY              (Get from Antigravity AI)
☐ GOOGLE_SERVICE_ACCOUNT_EMAIL     (Already configured?)
☐ GOOGLE_PRIVATE_KEY               (Already configured?)

Optional (Fallback):
☐ PROXY_SERVER                     (Alternative proxy URL)
☐ PROXY_USERNAME                   (Alternative proxy auth)
☐ PROXY_PASSWORD                   (Alternative proxy auth)
```

---

## 🚀 Deployment Steps

### Step 1: Pre-Deployment Verification
- [ ] Backup current `server.ts` file
- [ ] Review all changes in TECHNICAL_CHANGES.md
- [ ] Verify Antigravity API key is valid
- [ ] Test Antigravity proxy connection (if available)

### Step 2: Update Environment Variables
- [ ] Log into Railway Dashboard
- [ ] Navigate to Variables section
- [ ] Add/Update: `ANTIGRAVITY_API_KEY`
- [ ] Verify existing Google Sheets credentials present
- [ ] Save variables

### Step 3: Deploy Code
- [ ] Option A: Upload `server.ts` to Railway
  - [ ] Log into Railway
  - [ ] Upload updated `server.ts`
  - [ ] Trigger redeploy
  
- OR Option B: Git Push
  - [ ] `git add server.ts`
  - [ ] `git commit -m "Fix: Bol IP block, Amazon price/shipping, 98% threshold"`
  - [ ] `git push origin main`

### Step 4: Verify Deployment
- [ ] Check Railway deployment status (should show "Healthy" ✅)
- [ ] Review deployment logs for errors
- [ ] Wait 2-3 minutes for full startup

### Step 5: Test Endpoints

#### Test Bol.com (IP Block Fix)
```bash
# Should NOT return "IP adres is geblokkeerd" error
curl -X POST https://your-railway-app/api/audit/bol \
  -H "Content-Type: application/json" \
  -d '{"ean":"8720618516647","masterData":{...}}'
```
Expected: ✅ Successful response with product data

#### Test Amazon (Price Fix)
```bash
# Price should NOT be "N/A"
curl -X POST https://your-railway-app/api/audit/amazon \
  -H "Content-Type: application/json" \
  -d '{"asin":"B08FAKE","marketplace":"amazon.com","masterData":{...}}'
```
Expected: ✅ Price and Shipping populated

#### Test Google Sheets Matching
```bash
# Description match should show "Yes" if ≥98% similar
curl -X POST https://your-railway-app/api/sheets/save-audit \
  -H "Content-Type: application/json" \
  -d '{"mode":"bol",...}'
```
Expected: ✅ Google Sheet shows "Yes" for matches

### Step 6: Monitor Logs
- [ ] Check for "Using Antigravity NL Residential Proxy" messages
- [ ] Verify no "IP_BLOCKED" errors appear repeatedly
- [ ] Confirm prices are extracted (not N/A)
- [ ] Verify shipping days are calculated

### Step 7: Run Quality Tests
- [ ] Test 3-5 Bol.com products
- [ ] Test 3-5 Amazon products
- [ ] Verify Google Sheet descriptions show "Yes"
- [ ] Check Antigravity dashboard for proxy usage

---

## 🆘 Troubleshooting Guide

### Issue: IP Block Still Occurs
```
Signs: Error message "IP adres is geblokkeerd"
Fix:
1. Verify ANTIGRAVITY_API_KEY is set correctly
2. Check Antigravity account has active NL residential proxies
3. Check proxy account hasn't exceeded rate limits
4. Review Railway logs for proxy connection errors
```

### Issue: Price Returns "N/A"
```
Signs: Amazon price shows "N/A" in results
Fix:
1. Check if Amazon page structure changed
2. Manually verify Amazon product loads in browser
3. Check for CAPTCHA detection in logs
4. May need to add new selector to price list
```

### Issue: Shipping Returns "N/A"
```
Signs: Amazon shipping shows "N/A" in results
Fix:
1. Manually check Amazon product has shipping info
2. Verify right-side buybox is visible
3. Check delivery date is not hidden/collapsed
4. May need to add new selector
```

### Issue: Google Sheet Shows "No" Instead of "Yes"
```
Signs: Description match shows "No" but content looks similar
Fix:
1. Check similarity score (should be ≥0.98)
2. Verify cleanText() is removing non-alphanumeric
3. Check for hidden characters/formatting in source
4. May need to adjust threshold (currently 0.98)
```

### Issue: Deployment Failed
```
Signs: Railway shows error or deployment stuck
Fix:
1. Check for syntax errors in server.ts
2. Verify package.json dependencies are correct
3. Check Railway logs for specific error
4. Revert to previous version if needed
```

---

## 📊 Expected Performance Metrics

After successful deployment:

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| Bol.com IP Block Rate | ~80% | <5% | <1% |
| Amazon Price N/A Rate | ~30% | <5% | <1% |
| Amazon Shipping N/A Rate | ~40% | <5% | <1% |
| Google Sheet Match Rate | ~60% | >90% | >95% |
| Description Match "Yes" | ~50% | >85% | >90% |
| Avg Response Time | 45s | 50s | <60s |

---

## 📞 Support Information

If issues persist after deployment:

1. **Check Logs**: `Railway Dashboard → Logs → Search for error messages`
2. **Verify Environment**: All required variables set and correct
3. **Test Endpoints**: Use curl commands to test each function
4. **Review Code**: Check TECHNICAL_CHANGES.md for implementation details
5. **Contact**: Refer to DEPLOYMENT_GUIDE.md for troubleshooting

---

## ✨ Post-Deployment Verification

After 1 hour of deployment:
- [ ] Check if no repeated IP block errors
- [ ] Verify prices are populating
- [ ] Confirm Google Sheets has "Yes" values
- [ ] Monitor proxy usage is reasonable
- [ ] No spike in error rate

After 24 hours:
- [ ] Run batch test on 20+ products
- [ ] Verify sustained success rate >95%
- [ ] Check cost of proxy usage is acceptable
- [ ] Confirm no rate limiting from Bol/Amazon
- [ ] Archive logs for audit trail

---

## 🎯 Success Criteria

Deployment is successful when:

✅ Bol.com audits complete without IP block errors (after retries)
✅ Amazon prices appear in results (not N/A)
✅ Amazon shipping times appear in results (not N/A)
✅ Google Sheet shows "Yes" for matching descriptions
✅ Response times remain under 60 seconds
✅ No increase in error rate
✅ Proxy usage is within expected limits

---

**Status**: Ready for Deployment ✅
**Last Updated**: 2026-04-21
**Estimated Deployment Time**: 5-10 minutes
**Expected Maintenance Window**: 2-3 minutes downtime
