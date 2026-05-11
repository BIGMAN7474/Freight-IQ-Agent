# FreightIQ — Wayne Sanderson Farms Carrier Selection

Senior project (Logistics & Supply Chain Management). A working prototype of an agentic carrier-selection tool grounded in real federal data, designed for cold-chain freight at Wayne Sanderson Farms.

**Live demo:** open `FreightIQ_WSF.html` in a browser.
**Backend health:** [https://freight-iq-agent.onrender.com/](https://freight-iq-agent.onrender.com/)

---

## What it does

FreightIQ takes a load (origin, destination, equipment, commodity, pickup/delivery times) and returns three ranked carrier recommendations — one optimized for **Cost**, one for **Balanced**, one for **Reliability** — drawn from a pool of 100 real US trucking carriers. For each tender decision, it persists an immutable audit record to Postgres including the carrier's federal safety state at the moment of tender.

The system also autonomously observes weather conditions across the 15 US states Wayne Sanderson Farms ships through, updating every 15 minutes whether or not anyone is using the app.

---

## What's real

| Piece | Source | Refresh |
|---|---|---|
| Carrier roster (100 carriers) | GenLogs Top 100 Q1 2025, verified against FMCSA SAFER | Static (rebuilt quarterly) |
| FMCSA safety rating, operating status, insurance | FMCSA QCMobile API | On page load, cached 24h |
| CSA BASIC measures (Unsafe Driving, HOS, Driver Fitness, etc.) | FMCSA QCMobile `/basics` endpoint | On page load, cached 24h |
| Weather risk per WSF lane state | NOAA api.weather.gov | Every 15 min via pg_cron |
| Tender audit log | Supabase Postgres | Persisted on every tender |

102 of 103 carriers visible in the eligible pool are hydrated with real federal data on page load and marked with a green ✓ FMCSA badge. Private fleets (Walmart, UPS, FedEx, Tyson, PepsiCo, US Foods, etc.) carry real federal records but are excluded from third-party freight selection with a clear gate reason.

## What's still synthetic

- Lane history (effective rates, on-time %) per carrier — requires internal TMS integration to operationalize
- Claims history (temp deviation, physical damage, shortage) — requires internal claims data
- Reefer PM compliance dates — requires carrier maintenance system access

The system is honest about this in the in-app disclaimer banner.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (FreightIQ_WSF.html)                       │
│  ─ Scoring engine, persona logic, UI                │
│  ─ Hydrates carriers from FMCSA on load             │
│  ─ Fetches autonomous lane risk on each search      │
└─────────────────────────────────────────────────────┘
                       ↓ ↑
┌─────────────────────────────────────────────────────┐
│  Render Express service (index.js)                  │
│  ─ POST /api/reason       → Groq Llama 3.3 70B      │
│  ─ POST /api/tender       → Supabase write          │
│  ─ GET  /api/tender-history                         │
│  ─ GET  /api/carrier/:dot → FMCSA proxy             │
│  ─ GET  /api/lane-risk    → Supabase read           │
└─────────────────────────────────────────────────────┘
       ↓ ↑                ↓ ↑               ↓ ↑
┌─────────────┐    ┌──────────────┐    ┌────────────┐
│  Groq API   │    │ FMCSA QCMob. │    │  Supabase  │
│  Llama 3.3  │    │  Real fed.   │    │  Postgres  │
│   reasoning │    │  safety data │    │  + pg_cron │
└─────────────┘    └──────────────┘    └────────────┘
                                              ↓ (every 15 min)
                                       ┌────────────┐
                                       │  NOAA      │
                                       │  weather   │
                                       └────────────┘
```

All four cloud services run on free tiers. Zero recurring cost.

---

## Audit risks addressed

This build was rebuilt after a structured audit of an earlier prototype. Five risks were identified; here's where each stands:

| Risk | Original problem | Resolution |
|---|---|---|
| **Safety illusion** | Safety scores were RNG-generated, not depositionable | 102/103 carriers carry real FMCSA federal data (rating, operating status, insurance, CSA BASIC measures) hydrated on page load. Private fleets excluded with clear reasons. |
| **Deadhead curve too soft** | Linear deadhead penalty understated real cost | Replaced with HOS-aware piecewise quadratic curve, reefer-heat multiplier above 250 miles |
| **Agent is a reporter, not an observer** | "Agent" only fired on user click; couldn't observe world | pg_cron + pg_net Supabase job calls NOAA every 15 min, writes per-state severity to `lane_weather_risk` table. Frontend reads this on each search, auto-elevates weather mode at severity ≥ 0.40. Runs autonomously whether or not anyone is using the app. |
| **Balanced underweights claims** | Default 0.18 claims weight too low for frozen poultry | Commodity-aware weight profiles. Frozen poultry now weights claims at 0.22 with stricter temp-deviation gating. |
| **Single-file architecture** | Browser-only build had no persistent state | Moved tender audit to Supabase Postgres. Reasoning agent moved to Render Express. FMCSA + NOAA federal integrations through that same backend. Scoring still browser-side; that's the remaining architectural gap. |

---

## The pieces

### `FreightIQ_WSF.html`
The single-file frontend. ~6,900 lines. Contains the carrier roster, scoring engine, persona logic (Cost / Balanced / Reliability), Tender History viewer tab, NOAA observed-risk banner, FMCSA hydration on page load, and the reasoning-log streaming UI.

### `index.js`
Render Express service. ~300 lines. Proxies Groq's LLM API for the reasoning panel, proxies FMCSA's QCMobile API for live carrier data with 24h in-memory cache, and exposes the autonomously-observed weather risk from Supabase.

### `package.json`
Two dependencies: `express`, `@supabase/supabase-js`.

### Supabase (not in this repo)
Two tables:
- `tender_history` — every tender decision with full FMCSA/CSA/claims snapshot at moment of tender
- `lane_weather_risk` — autonomous NOAA observation per WSF state, refreshed every 15 minutes

Two pg_cron jobs:
- `freightiq-fire-noaa` — fires an HTTP GET to NOAA every 15 minutes
- `freightiq-refresh-weather-risk` — parses the response 2 minutes later and writes per-state severity

---

## Running it

Open `FreightIQ_WSF.html` directly in a browser. The frontend calls the Render backend over HTTPS; no local server needed.

The backend redeploys on every commit to `main`. To run locally:

```bash
npm install
GROQ_API_KEY=... SUPABASE_URL=... SUPABASE_SECRET_KEY=... FMCSA_WEBKEY=... node index.js
```

---

## Limitations and honesty

This is a prototype, not a production carrier-management system. The disclaimer banner at the top of the running app states this. Specifically:

- Scoring logic still runs in the browser — a production system would move this server-side for multi-user concurrency and auditability
- Lane history, claims history, and reefer PM data are synthetic (would require internal TMS / claims / fleet maintenance integration)
- The 100-carrier pool is the GenLogs observed-activity list, not WSF's actual carrier base
- LLM reasoning panel is illustrative; production scoring should not depend on LLM output for compliance-critical decisions
