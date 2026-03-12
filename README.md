# Project Scout

**Lead Intelligence Platform for A&E + SMA Design**

A custom lead generation and intelligence platform that discovers, organizes, scores, and monitors project opportunities across Western Montana.

## Quick Start

```bash
npm install
npm run dev
```

Opens at [http://localhost:3000](http://localhost:3000).

## Architecture

| Layer | Technology | Directory |
|---|---|---|
| Frontend | React 18 + Vite | `src/` |
| Backend | Vercel Serverless Functions (Node.js 18) | `backend/api/` |
| Persistence | Browser localStorage (frontend), stateless (backend) | — |
| Intelligence | Rule-based scoring + optional AI (Anthropic/OpenAI) | `backend/api/scan.js` |

## Deployment

### Frontend (GitHub Pages / Cloudflare Pages / Vercel)

```bash
npm run build       # outputs to dist/
```

Deploy `dist/` to any static host.

### Backend (Vercel)

```bash
npm i -g vercel
vercel --prod
```

The `vercel.json` routes `/api/*` to `backend/api/` and includes a daily cron.

### Environment Variables (Vercel)

| Variable | Required? | Description |
|---|---|---|
| `ASANA_ACCESS_TOKEN` | For Asana sync | Personal access token |
| `AI_API_KEY` | For AI classification | Anthropic or OpenAI key |
| `AI_PROVIDER` | No | `anthropic` (default) or `openai` |

### After Deployment

1. Go to Settings in Project Scout
2. Enter your Vercel deployment URL in **Backend Endpoint**
3. Click **Backfill** to run the first live intelligence scan
4. Leads from real government sources appear in Active Leads

See [DEPLOY.md](DEPLOY.md) for the complete deployment and smoke test guide.

## File Structure

```
project-scout/
├── index.html                     # HTML entry
├── package.json                   # Dependencies (react, lucide-react, vite)
├── vite.config.js                 # Vite build config
├── vercel.json                    # Vercel routes + cron
├── .gitignore
│
├── public/
│   └── favicon.svg                # PS icon
│
├── src/
│   ├── main.jsx                   # React DOM mount
│   ├── App.jsx                    # Root component
│   ├── ProjectScout.jsx           # Full application (2600+ lines)
│   └── index.css                  # Global styles + animations
│
└── backend/
    ├── api/
    │   └── scan.js                # Self-contained serverless endpoint
    ├── config/
    │   └── index.js               # Env var defaults
    └── services/                  # Reference modules (not imported by scan.js)
        ├── aiService.js
        ├── asanaCheck.js
        ├── deduplication.js
        ├── evidenceEngine.js
        ├── scoringEngine.js
        ├── searchPipeline.js
        └── sourceFetcher.js
```

## Features

- **36 seeded Western Montana intelligence sources** (city/county agendas, state procurement, school boards, airports, economic development, media)
- **16 search focus points** covering all A&E + SMA market sectors
- **32 target organizations** (government, healthcare, education, contractors, developers)
- **Multi-factor lead scoring** (relevance, pursuit readiness, source confidence)
- **Evidence timeline** tracking signal history per lead
- **Project Initiation Prep** fields mapping to the Asana PIF form
- **Asana board sync** for automatic lead matching
- **Full CRUD** for leads, sources, focus points, target organizations
- **Persistent state** via localStorage
- **Live source fetching** when backend is deployed
- **Fallback mode** for client-side operation without backend

## License

Internal tool for A&E + SMA Design. Not for public distribution.
