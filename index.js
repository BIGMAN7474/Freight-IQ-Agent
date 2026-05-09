// FreightIQ Backend — Reasoning Agent + Tender History + FMCSA Carrier Lookup
// Forwards reasoning requests to Groq's API (Llama 3.3 70B), persists tender
// decisions to Supabase Postgres, and proxies real-time carrier safety lookups
// through FMCSA's QCMobile API. All secrets are held as env vars.
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS: allow the HTML file to call this from any origin
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- Supabase client -------------------------------------------------------
let supabase = null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });
  console.log("Supabase client initialized");
} else {
  console.warn("Supabase not configured (missing SUPABASE_URL or SUPABASE_SECRET_KEY); tender endpoints will return 503");
}

function requireSupabase(res) {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured on server" });
    return false;
  }
  return true;
}

// ---- FMCSA in-memory cache -------------------------------------------------
// FMCSA carrier records change rarely (safety reviews are infrequent); a 24-hour
// cache is conservative and keeps us well under any rate limit. The cache is
// per-process — when Render's free tier sleeps and wakes, the cache resets,
// which is fine for a low-traffic demo.
const FMCSA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const fmcsaCache = new Map(); // dot -> { fetchedAt, data }

async function fetchFmcsaCarrier(dot) {
  const cached = fmcsaCache.get(dot);
  if (cached && Date.now() - cached.fetchedAt < FMCSA_CACHE_TTL_MS) {
    return { source: "cache", data: cached.data, fetchedAt: cached.fetchedAt };
  }
  const webKey = process.env.FMCSA_WEBKEY;
  if (!webKey) {
    throw new Error("FMCSA_WEBKEY not configured on server");
  }
  // Pull both the carrier record and the BASICs (CSA scores) in parallel.
  const carrierUrl = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${encodeURIComponent(dot)}?webKey=${encodeURIComponent(webKey)}`;
  const basicsUrl = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${encodeURIComponent(dot)}/basics?webKey=${encodeURIComponent(webKey)}`;
  const [carrierResp, basicsResp] = await Promise.all([
    fetch(carrierUrl).then((r) => r.json()).catch(() => null),
    fetch(basicsUrl).then((r) => r.json()).catch(() => null),
  ]);
  if (!carrierResp || !carrierResp.content || !carrierResp.content.carrier) {
    throw new Error("FMCSA returned no carrier record for DOT " + dot);
  }
  const c = carrierResp.content.carrier;
  // Normalize FMCSA's letter codes into the shape our HTML expects.
  const ratingLetterToLabel = { S: "Satisfactory", C: "Conditional", U: "Unsatisfactory" };
  const safetyRating = ratingLetterToLabel[c.safetyRating] || (c.safetyRating ? c.safetyRating : "Unrated");
  const operatingStatus = c.allowedToOperate === "Y" ? "Active" : "Out of Service";
  const insuranceOnFile = !!(c.bipdInsuranceOnFile && Number(c.bipdInsuranceOnFile) > 0);
  // FMCSA doesn't surface insurance expiration in this endpoint; we leave null.
  const fmcsa = {
    safetyRating,
    ratingDate: c.safetyRatingDate || null,
    operatingStatus,
    insuranceOnFile,
    insuranceExpires: null,
  };
  // CSA BASICs: response shape varies. We walk it defensively, stringify every
  // value before pattern-matching, and log raw shape on first call so we can
  // inspect what comes back if normalization misses anything.
  const csa = {
    unsafeDriving:    { measure: null, alert: false },
    hosCompliance:    { measure: null, alert: false },
    driverFitness:    { measure: null, alert: false },
    controlledSubs:   { measure: null, alert: false },
    vehicleMaint:     { measure: null, alert: false },
    crashIndicator:   { measure: null, alert: false },
  };
  if (basicsResp && basicsResp.content) {
    const items = Array.isArray(basicsResp.content) ? basicsResp.content : [basicsResp.content];
    for (const item of items) {
      if (!item) continue;
      // The "basic" subobject sometimes lives at item.basic, sometimes is item itself.
      const basic = item.basic || item;
      if (!basic || typeof basic !== "object") continue;
      // Pull whatever identifying field we can find and stringify it.
      const idRaw =
        basic.basicsType ||
        basic.basicType ||
        basic.basicsName ||
        basic.basicName ||
        basic.basic ||
        basic.type ||
        basic.name ||
        "";
      const id = String(idRaw).toLowerCase();
      const alert = basic.basicsAlertIndicator === "Y" || basic.alertIndicator === "Y" || basic.alert === "Y";
      const measureRaw = basic.basicsPercentile != null ? basic.basicsPercentile : basic.percentile != null ? basic.percentile : basic.measure;
      const measure = measureRaw != null && !isNaN(Number(measureRaw)) ? Number(measureRaw) : null;
      if (id.includes("unsafe")) csa.unsafeDriving = { measure, alert };
      else if (id.includes("fatigued") || id.includes("hours") || id.includes("hos")) csa.hosCompliance = { measure, alert };
      else if (id.includes("driver fit") || id.includes("driverfit")) csa.driverFitness = { measure, alert };
      else if (id.includes("controlled") || id.includes("substance") || id.includes("alcohol")) csa.controlledSubs = { measure, alert };
      else if (id.includes("vehicle") || id.includes("maint")) csa.vehicleMaint = { measure, alert };
      else if (id.includes("crash")) csa.crashIndicator = { measure, alert };
    }
    // Log raw shape once per DOT so we can see what FMCSA actually returns
    if (!fmcsaCache.has(dot)) {
      console.log("FMCSA BASICs raw shape for DOT", dot, JSON.stringify(items[0] || {}, null, 2).slice(0, 500));
    }
  }
  const result = {
    dotNumber: Number(dot),
    legalName: c.legalName || null,
    dbaName: c.dbaName || null,
    physicalState: c.phyState || null,
    physicalCity: c.phyCity || null,
    totalPowerUnits: c.totalPowerUnits != null ? Number(c.totalPowerUnits) : null,
    totalDrivers: c.totalDrivers != null ? Number(c.totalDrivers) : null,
    fmcsa,
    csa,
    // Echo the raw FMCSA payload so callers can dig deeper if needed
    _raw: { carrier: c, basics: basicsResp ? basicsResp.content : null },
  };
  fmcsaCache.set(dot, { fetchedAt: Date.now(), data: result });
  return { source: "live", data: result, fetchedAt: Date.now() };
}

// ---- Health check ----------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    service: "FreightIQ Reasoning Agent + Tender History + FMCSA Carrier Lookup",
    model: "llama-3.3-70b-versatile (Groq)",
    status: "online",
    supabase: supabase ? "configured" : "not configured",
    fmcsa: process.env.FMCSA_WEBKEY ? "configured" : "not configured",
    endpoints: ["POST /api/reason", "POST /api/tender", "GET /api/tender-history", "GET /api/carrier/:dot"],
  });
});

// ---- Reasoning endpoint (unchanged) ----------------------------------------
app.post("/api/reason", async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured on server" });
  }
  const { system, messages, stream = true } = req.body;
  const openaiMessages = [];
  if (system) openaiMessages.push({ role: "system", content: system });
  for (const m of messages || []) {
    openaiMessages.push({ role: m.role, content: m.content });
  }
  try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: openaiMessages,
        max_tokens: 1000,
        temperature: 0.4,
        stream,
      }),
    });
    res.status(upstream.status);
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() || "";
        for (const evt of events) {
          const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const jsonStr = dataLine.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const text = parsed.choices?.[0]?.delta?.content || "";
            if (text) {
              const anthropicEvent = {
                type: "content_block_delta",
                delta: { type: "text_delta", text },
              };
              res.write(`data: ${JSON.stringify(anthropicEvent)}\n\n`);
            }
          } catch (_) {
            /* skip malformed chunk */
          }
        }
      }
      res.end();
    } else {
      const data = await upstream.json();
      res.json(data);
    }
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---- Tender history: write -------------------------------------------------
app.post("/api/tender", async (req, res) => {
  if (!requireSupabase(res)) return;
  const body = req.body || {};
  const carrier = body.carrier || {};
  const load = body.load || {};
  const row = {
    tendered_at: body.tenderedAt || new Date().toISOString(),
    load_origin: load.origin || null,
    load_destination: load.destination || null,
    load_equipment: load.equipment || null,
    load_commodity: load.commodity || null,
    load_pickup: load.pickup || null,
    load_delivery: load.delivery || null,
    persona: body.persona || null,
    rank_chosen: body.rank != null ? Number(body.rank) : null,
    carrier_name: carrier.name || null,
    carrier_dot: carrier.dot != null ? Number(carrier.dot) : null,
    effective_rate: carrier.effectiveRate != null ? Number(carrier.effectiveRate) : null,
    safety_score: carrier.safetyScore != null ? Number(carrier.safetyScore) : null,
    on_time_pct: carrier.onTimePct != null ? Number(carrier.onTimePct) : null,
    deadhead_miles: carrier.deadheadMiles != null ? Number(carrier.deadheadMiles) : null,
    fmcsa_snapshot: carrier.fmcsa || null,
    csa_snapshot: carrier.csa || null,
    claims_snapshot: carrier.claimsBy || null,
    reefer_pm_snapshot: carrier.reeferPM || null,
    weather_alert_active: !!body.weatherAlertActive,
    tendered_by: body.tenderedBy || "demo",
  };
  if (!row.persona || !row.carrier_name || row.rank_chosen == null) {
    return res.status(400).json({ error: "persona, carrier.name, and rank are required" });
  }
  try {
    const { data, error } = await supabase
      .from("tender_history")
      .insert(row)
      .select()
      .single();
    if (error) {
      console.error("Tender insert error:", error);
      return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true, id: data.id, tendered_at: data.tendered_at });
  } catch (err) {
    console.error("Tender insert exception:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---- Tender history: read --------------------------------------------------
app.get("/api/tender-history", async (req, res) => {
  if (!requireSupabase(res)) return;
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
  const carrierFilter = (req.query.carrier || "").trim();
  try {
    let q = supabase
      .from("tender_history")
      .select("*")
      .order("tendered_at", { ascending: false })
      .limit(limit);
    if (carrierFilter) {
      q = q.ilike("carrier_name", `%${carrierFilter}%`);
    }
    const { data, error } = await q;
    if (error) {
      console.error("Tender query error:", error);
      return res.status(500).json({ error: error.message });
    }
    res.json({ tenders: data || [], count: (data || []).length });
  } catch (err) {
    console.error("Tender query exception:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---- FMCSA carrier lookup --------------------------------------------------
// Real-time federal safety data by DOT number. Cached in-memory for 24 hours.
// Returns the same fmcsa+csa shape the HTML's wsfCarrierGate expects.
app.get("/api/carrier/:dot", async (req, res) => {
  const dot = String(req.params.dot || "").trim();
  if (!/^\d{3,8}$/.test(dot)) {
    return res.status(400).json({ error: "Invalid DOT number; expected 3-8 digits" });
  }
  try {
    const result = await fetchFmcsaCarrier(dot);
    res.json({
      ok: true,
      source: result.source,
      fetched_at: new Date(result.fetchedAt).toISOString(),
      carrier: result.data,
    });
  } catch (err) {
    console.error("FMCSA fetch error:", err);
    res.status(502).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`FreightIQ backend listening on port ${PORT}`);
});
