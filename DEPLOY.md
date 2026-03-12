# Project Scout — Deployment & Smoke Test Guide

---

## 1. EXACT DEPLOYMENT STEPS

### Prerequisites
- Node.js 18+ installed
- Vercel CLI: `npm i -g vercel`
- A Vercel account (free tier works)
- Git (optional, for repo-based deploy)

### Deploy the Backend

```bash
# From the project-scout directory:
cd project-scout

# Deploy to Vercel
vercel

# When prompted:
#   - Set up and deploy? Y
#   - Which scope? (your account)
#   - Link to existing project? N
#   - Project name: project-scout-api
#   - Directory: ./
#   - Override settings? N

# Note the deployment URL, e.g.: https://project-scout-api-xxxxx.vercel.app

# For production deployment:
vercel --prod
```

### Verify Deployment

```bash
# Health check — should return JSON with { ok: true, version: "1.0.0" }
curl https://YOUR-URL.vercel.app/api/scan?action=status
```

Expected response:
```json
{ "ok": true, "lastRun": null, "time": "2026-03-08T...", "version": "1.0.0" }
```

If you get a 404, verify that `vercel.json` routes are correct and `backend/api/scan.js` exists.

---

## 2. REQUIRED ENVIRONMENT VARIABLES

Set via Vercel dashboard (Settings → Environment Variables) or CLI:

| Variable | Required? | Purpose | Example |
|---|---|---|---|
| `ASANA_ACCESS_TOKEN` | For Asana check | Asana personal access token | `1/123456789:abc...` |
| `ASANA_PROJECT_ID` | No (default: 1203575716271060) | Project Requests board ID | `1203575716271060` |
| `AI_API_KEY` | For AI classification | Anthropic or OpenAI key | `sk-ant-...` |
| `AI_PROVIDER` | No (default: anthropic) | `anthropic` or `openai` | `anthropic` |

```bash
# Set via CLI:
vercel env add ASANA_ACCESS_TOKEN   # paste token when prompted
vercel env add AI_API_KEY           # paste key when prompted
vercel --prod                       # redeploy to pick up env vars
```

---

## 3. FRONTEND SETTINGS TO ENTER

After deployment, open Project Scout in the browser and go to **Settings**:

| Field | Value |
|---|---|
| **Backend Endpoint** | `https://YOUR-URL.vercel.app` (no trailing slash) |
| **AI Provider** | `anthropic` or `openai` |
| **AI API Key** | Your API key (only needed if not set as env var) |
| **Asana Access Token** | Your Asana token (only needed if not set as env var) |

Once Backend Endpoint is set, the connection badge should change from "Fallback mode" to "Configured (unverified)".

---

## 4. SMOKE TEST STEPS (in order)

### Test 1: Backend Health Check
**Action:** Click nothing — just verify the status endpoint.
```bash
curl https://YOUR-URL.vercel.app/api/scan?action=status
```
**Expected:** `{ "ok": true }` with a timestamp.
**If it fails:** Check Vercel deployment logs. Common issues: build errors, missing Node 18.

---

### Test 2: Single Source Fetch (fetch-one)
**Action:** Test one source fetch through the backend.
```bash
curl -X POST https://YOUR-URL.vercel.app/api/scan?action=fetch-one \
  -H "Content-Type: application/json" \
  -d '{
    "source": {
      "url": "https://vendor.mt.gov",
      "name": "Montana State Procurement",
      "category": "State Procurement",
      "geography": "Statewide",
      "keywords": ["architectural", "engineering", "RFQ", "RFP", "design services"],
      "priority": "critical"
    }
  }'
```

**Expected successful response:**
```json
{
  "ok": true,
  "fetch": { "status": 200, "title": "...", "length": 15000, "error": null },
  "keywords": { "pass": true, "n": 4, "kw": ["rfq", "rfp", "design services", "architectural"] },
  "leads": [ { "id": "lead-...", "title": "...", "leadOrigin": "live", ... } ],
  "logs": [ "Fetching: https://vendor.mt.gov", "✓ 200 — 15000 chars...", ... ]
}
```

**What to check:**
- `ok: true` means the URL was reachable
- `fetch.length > 0` means content was parsed
- `keywords.pass: true` means signal terms were found
- `leads` array contains extracted candidates (may be empty if no patterns match)
- `logs` shows step-by-step what happened

**If it fails:**
- `ok: false` with `fetch.error: "Timeout"` → site is slow or blocking
- `ok: false` with `fetch.error: "fetch failed"` → Node can't reach the URL
- `keywords.pass: false` → site content didn't contain enough signal terms

---

### Test 3: Agenda Source Fetch
```bash
curl -X POST https://YOUR-URL.vercel.app/api/scan?action=fetch-one \
  -H "Content-Type: application/json" \
  -d '{
    "source": {
      "url": "https://www.ci.missoula.mt.us/148/City-Council",
      "name": "Missoula City Council",
      "category": "City Council",
      "geography": "Missoula",
      "county": "Missoula County",
      "keywords": ["infrastructure", "public works", "facility", "capital", "bond"],
      "priority": "high"
    }
  }'
```

---

### Test 4: Higher Ed Source Fetch
```bash
curl -X POST https://YOUR-URL.vercel.app/api/scan?action=fetch-one \
  -H "Content-Type: application/json" \
  -d '{
    "source": {
      "url": "https://www.fvcc.edu/about/board-of-trustees",
      "name": "FVCC Board of Trustees",
      "category": "Higher Ed Capital",
      "geography": "Kalispell",
      "county": "Flathead County",
      "keywords": ["capital", "building", "campus", "facility", "construction", "science"],
      "priority": "high"
    }
  }'
```

---

### Test 5: Full Backfill (via UI)
**Action:** In Project Scout → Settings → Intelligence Engine → Click **Backfill**

**Expected behavior:**
1. Mode badge shows "LIVE" (not "Local/Fallback")
2. Log panel shows real fetch attempts for each source
3. Each source shows `✓ XXXX chars` or `✗ error`
4. Keywords are counted per source
5. Leads with `leadOrigin: 'live'` appear in Active Leads tab
6. Results summary shows fetch successes/failures count

**What good looks like:**
```
═══ BACKFILL — 36 sources ═══
[1/36] Missoula County Commission Agendas (https://www.missoulacounty.us/government/commission)
  ✓ 23451 chars — "Missoula County Commissioners"
  → 6 keywords: capital improvement, facility, bond, renovation, building, infrastructure
  → 2 candidate(s)
    ✚ NEW: Missoula County — planned renovation of county facility...
[2/36] City of Missoula Development Services...
...
═══ DONE in 45.2s ═══
Sources: 28 ok, 8 failed | Signals: 12 sources with hits
Leads: +15 new, 3 updated, 0 blocked, 4 duped
```

---

### Test 6: Daily Scan (via UI)
**Action:** Settings → Intelligence Engine → Click **Daily Scan**
**Expected:** Same as backfill but processes up to 15 sources. Respects freshness filter.

---

### Test 7: Asana Check (via UI)
**Action:** Settings → Asana Board Check → Click **Check Asana Now**

**If token is configured:**
- Log shows `Asana: fetching project 1203575716271060...`
- Log shows `Asana: XX tasks`
- Any matches show with confidence percentage
- Matched leads auto-move to Submitted to Asana tab

**If no token:**
- Log shows `Asana: no token configured`
- Badge says "Not configured"
- No silent fake results

---

## 5. WHAT SUCCESSFUL RESULTS LOOK LIKE

### Active Leads Tab After First Backfill
- Mix of seed leads (no origin badge) and new leads with green **LIVE** badges
- Live leads have real content in descriptions: actual text from government pages
- Evidence timelines show "Live fetch — [source name]" entries
- AI Reason shows specific keywords and org matches

### Settings Page After Successful Run
- Connection badges: Backend = "Configured", AI/Asana = appropriate status
- Run History shows entry with timestamp, "connected" mode, lead counts
- Engine results bar shows LIVE mode badge with fetch success/failure counts

---

## 6. LIKELY FAILURES AND CAUSES

| Symptom | Likely Cause | Fix |
|---|---|---|
| `fetch.error: "Timeout"` | Government site is slow (>15s) | Increase timeout in scan.js `fetchUrl()` or skip that source |
| `fetch.status: 403` | Site blocks automated requests | Try different User-Agent or skip the source |
| `fetch.status: 0` or `"fetch failed"` | DNS/network issue on Vercel | Check if URL is accessible from your browser |
| `keywords.pass: false` for all sources | Content extraction stripped too much | Check `fetch.length` — if very small, HTML parsing may need adjustment |
| `leads: []` even when keywords pass | Regex patterns don't match the page's sentence structure | Normal for some page types — the patterns are designed for agenda/procurement prose |
| CORS error in browser console | Backend endpoint URL is wrong | Verify the URL has no trailing slash and matches your Vercel deployment |
| `Asana HTTP 401` | Token expired or invalid | Generate a new Asana personal access token |
| `Asana HTTP 403` | Token doesn't have access to the project | Verify the token owner has access to the Project Requests board |
| Backend returns 404 | Route configuration issue | Verify `vercel.json` routes point to `backend/api/$1` |

---

## 7. HOW TO DIAGNOSE ISSUES

### Check Vercel Function Logs
```bash
vercel logs --follow
```
Every scan.js call logs to `console.log` with `[PS]` prefix. Look for these in the Vercel dashboard under Functions → scan → Logs.

### Check Frontend Logs
The engine log panel in Settings shows every step. Look for:
- `✓` = success
- `✗` = failure with reason
- `→` = analysis result
- `✚ NEW` = lead created
- `↻` = existing lead updated
- `⊘` = lead blocked (Not Pursued)

### Test Individual Sources
Use `fetch-one` to test any source in isolation before running a full scan:
```bash
curl -X POST YOUR-URL/api/scan?action=fetch-one \
  -H "Content-Type: application/json" \
  -d '{"source":{"url":"https://SITE","name":"Test","category":"Other","keywords":["test"]}}'
```

### Reset Persisted Data
If you need to start fresh in the browser:
```javascript
// In browser console:
Object.keys(localStorage).filter(k=>k.startsWith('ps_')).forEach(k=>localStorage.removeItem(k));
location.reload();
```
