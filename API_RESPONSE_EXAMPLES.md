# API Response Examples & Expected Output

## Bol.com Audit Endpoint - AFTER FIX

### Request
```bash
POST /api/audit/bol
Content-Type: application/json

{
  "ean": "8720618516647",
  "masterData": {
    "title": "iPhone 15 Pro Max",
    "description": "Latest Apple smartphone with A17 Pro chip",
    "images": ["https://example.com/image1.jpg"],
    "price": "1299.99",
    "shipping": "1 Day",
    "variations": 1,
    "hasAPlus": 0,
    "bullets": []
  }
}
```

### Expected Response (SUCCESS)
```json
{
  "liveData": {
    "title": "Apple iPhone 15 Pro Max 256GB",
    "description": "Powerful A17 Pro chip with enhanced performance capabilities",
    "price": "1299.99",
    "shipping": "1 Days",
    "rawShipping": "Uiterlijk maandag 24 april in huis",
    "variations": 1,
    "hasAPlus": 0,
    "images": [
      "https://media.s-bol.com/large/xyz123.jpg"
    ],
    "bullets": ["Fast processor", "Great camera"]
  },
  "auditResult": {
    "title": {
      "master": "iPhone 15 Pro Max",
      "live": "Apple iPhone 15 Pro Max 256GB",
      "similarity": 0.87,
      "match": false
    },
    "description": {
      "master": "Latest Apple smartphone with A17 Pro chip",
      "live": "Powerful A17 Pro chip with enhanced performance capabilities",
      "similarity": 0.92,
      "match": false
    },
    "price": {
      "master": "1299.99",
      "live": "1299.99",
      "match": true
    },
    "shipping": {
      "master": "1 Day",
      "live": "1 Days",
      "similarity": 0.95,
      "match": false
    }
  }
}
```

### Key Indicators of Success
✅ No "IP adres is geblokkeerd" error
✅ Price populated (not "N/A")
✅ Shipping calculated (not "N/A")
✅ Description extracted
✅ Images found and returned

---

## Amazon Audit Endpoint - AFTER FIX

### Request
```bash
POST /api/audit/amazon
Content-Type: application/json

{
  "asin": "B0DCML8P92",
  "marketplace": "amazon.com",
  "masterData": {
    "title": "Samsung 65 Inch QLED TV",
    "description": "Premium QLED display with Quantum Processor 4K",
    "images": ["https://example.com/image1.jpg"],
    "price": "$799.99",
    "shipping": "2 Days",
    "variations": 0,
    "hasAPlus": 1,
    "bullets": [
      "Quantum Processor 4K",
      "120Hz refresh rate",
      "Smart TV with Alexa"
    ]
  }
}
```

### Expected Response (SUCCESS)
```json
{
  "liveData": {
    "title": "Samsung 65-Inch QLED TV 4K Smart Television",
    "description": "Experience stunning picture quality with Samsung's Quantum Processor...",
    "price": "$799.99",
    "listPrice": "$899.99",
    "currency": "",
    "shipping": "2 Days",
    "rawShipping": "Arrives Monday, April 22",
    "variations": 0,
    "hasAPlus": 1,
    "images": [
      "https://m.media-amazon.com/images/I/71XYZ123.jpg"
    ],
    "bullets": [
      "Quantum Processor 4K - Advanced upscaling",
      "120Hz Refresh Rate - Ultra-smooth gaming",
      "Alexa Built-In - Smart TV features"
    ]
  },
  "auditResult": {
    "title": {
      "master": "Samsung 65 Inch QLED TV",
      "live": "Samsung 65-Inch QLED TV 4K Smart Television",
      "similarity": 0.98,
      "match": true
    },
    "description": {
      "master": "Premium QLED display with Quantum Processor 4K",
      "live": "Experience stunning picture quality with Samsung's Quantum Processor...",
      "similarity": 0.85,
      "match": false
    },
    "price": {
      "master": "$799.99",
      "live": "$799.99",
      "match": true
    },
    "shipping": {
      "master": "2 Days",
      "live": "2 Days",
      "similarity": 1.0,
      "match": true
    },
    "bullets": [
      {
        "master": "Quantum Processor 4K",
        "live": "Quantum Processor 4K - Advanced upscaling",
        "similarity": 0.98,
        "match": true
      },
      {
        "master": "120Hz refresh rate",
        "live": "120Hz Refresh Rate - Ultra-smooth gaming",
        "similarity": 0.97,
        "match": true
      }
    ]
  }
}
```

### Key Indicators of Success
✅ Price populated (not "N/A")
✅ Shipping populated (not "N/A")
✅ Description extracted
✅ Variations detected correctly
✅ Bullets compared with >0.98 similarity = "Yes"

---

## Google Sheets Save Endpoint - AFTER FIX

### Request
```bash
POST /api/sheets/save-audit
Content-Type: application/json

{
  "mode": "bol",
  "identifier": "8720618516647",
  "marketplace": "bol.com",
  "masterData": { ... },
  "auditResult": { ... }
}
```

### Expected Google Sheet Row Output

| Field | Value | Status |
|-------|-------|--------|
| EAN | 8720618516647 | ✓ |
| Marketplace | Bol.com | ✓ |
| Title match | Yes* | ✓ |
| Description match | Yes* | ✓ |
| Price | 1299.99 | ✓ |
| Shipping Time | 1 Days | ✓ |
| A+ Content | Available | ✓ |
| Variation | Yes | ✓ |
| Main Image | =IMAGE("https://media.s-bol.com/...") | ✓ |
| Live Image 1 | =IMAGE("https://media.s-bol.com/...") | ✓ |

*Shows "Yes" when similarity ≥ 98% after cleanText()

---

## Error Scenarios - BEFORE vs AFTER

### Scenario 1: Bol.com IP Block

**BEFORE FIX**:
```json
{
  "error": "Bol.com blocked the request",
  "name": "Error"
}
```
❌ Transaction ends in failure

**AFTER FIX**:
```json
{
  "liveData": { ... success data ... },
  "auditResult": { ... }
}
```
✅ Auto-retried with new proxy, succeeded on attempt 2

---

### Scenario 2: Amazon Price N/A

**BEFORE FIX**:
```json
{
  "liveData": {
    "price": "N/A",
    "shipping": "N/A"
  }
}
```
❌ Cannot determine if price matches

**AFTER FIX**:
```json
{
  "liveData": {
    "price": "$799.99",
    "shipping": "2 Days"
  },
  "auditResult": {
    "price": { "master": "$799.99", "live": "$799.99", "match": true }
  }
}
```
✅ Price extracted and matched

---

### Scenario 3: Description Matching

**BEFORE FIX** (exact match required):
```
Master: "Premium display with 4K processor"
Live:   "Premium display with 4K processor - Amazing features!"
Match:  "No" (not exact)
```
❌ Shows "No" even though 95% similar

**AFTER FIX** (98% threshold):
```
Master: "Premium display with 4K processor"
Live:   "Premium display with 4K processor - Amazing features!"
After cleaning: "Premium display with 4K processor"
                "Premium display with 4K processor Amazing features"
Similarity: 0.98+ = Match: "Yes" ✅
```
✅ Shows "Yes" for similar content

---

## Console Log Examples - What to Look For

### Successful Bol.com Audit
```
Starting Bol Audit for EAN: 8720618516647 (Attempt 1)
Using Antigravity NL Residential Proxy for Bol.com
Navigating to: https://www.bol.com/nl/nl/s/?searchtext=8720618516647
Waiting 3 seconds for JavaScript execution...
Extracted Title: Apple iPhone 15 Pro Max 256GB
Extracted Price: 1299.99
Has Variations: 1
Description Length: 342
Images Found: 3
```
✅ All indicators present

### Successful Amazon Audit
```
Starting Amazon Audit for ASIN: B0DCML8P92
Using randomUserAgent for anonymity
Navigating to: https://www.amazon.com/dp/B0DCML8P92
Extracted Raw Shipping: Arrives Monday, April 22
Extracted ${amazonBullets.length} Amazon Bullets
Price: $799.99
Shipping: 2 Days
```
✅ All data extracted

---

## Expected Behavior Changes

### Before Fix
| Scenario | Behavior |
|----------|----------|
| Bol IP blocked | Immediate error, no retry |
| Amazon price N/A | Returns N/A, no fallback |
| Amazon shipping N/A | Returns N/A, no fallback |
| Description match | Requires 100% exact match |
| Similar content | Shows "No" |

### After Fix
| Scenario | Behavior |
|----------|----------|
| Bol IP blocked | Retry up to 3 times with new proxy |
| Amazon price N/A | Try 8+ selectors before giving up |
| Amazon shipping N/A | Try 16+ selectors before giving up |
| Description match | 98% similarity = "Yes" |
| Similar content | Shows "Yes" if 98%+ match |

---

## Testing Commands

### Quick Test - Bol.com
```bash
EAN="8720618516647"
curl -X POST http://localhost:3000/api/audit/bol \
  -H "Content-Type: application/json" \
  -d '{
    "ean":"'$EAN'",
    "masterData":{
      "title":"Test","description":"Test","price":"10","shipping":"1 Day",
      "images":["https://example.com/img.jpg"],"variations":0,"hasAPlus":0,"bullets":[]
    }
  }' | jq '.liveData.price'
```

### Quick Test - Amazon
```bash
ASIN="B0DCML8P92"
curl -X POST http://localhost:3000/api/audit/amazon \
  -H "Content-Type: application/json" \
  -d '{
    "asin":"'$ASIN'","marketplace":"amazon.com",
    "masterData":{
      "title":"Test","description":"Test","price":"$99","shipping":"2 Days",
      "images":["https://example.com/img.jpg"],"variations":0,"hasAPlus":0,"bullets":[]
    }
  }' | jq '.liveData.price'
```

### Expected Output
```
"$799.99"  ✅ (was: "N/A" before fix)
```

---

**Document Version**: 1.0
**Last Updated**: 2026-04-21
**Applicable To**: Railway Production Environment v2.0+
