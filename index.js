// FreightIQ Backend — Reasoning Agent Proxy + Tender History API
// Forwards reasoning requests to Groq's API (Llama 3.3 70B) with auth, and
// persists tender decisions to a Supabase Postgres database.
// All secrets are held as env vars — never exposed to the browser.
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
// We use the service_role key here (server-side only). It bypasses Row Level
// Security, which is what we want — the Express service is the trusted boundary.
// If the env vars aren't set, we set supabase to null and let the tender
// endpoints return a clear error instead of crashing the whole service.
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

// ---- Health check ----------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    service: "FreightIQ Reasoning Agent + Tender History API",
    model: "llama-3.3-70b-versatile (Groq)",
    status: "online",
    supabase: supabase ? "configured" : "not configured",
    endpoints: ["POST /api/reason", "POST /api/tender", "GET /api/tender-history"],
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
// Writes a single tender decision to the tender_history table. The browser
// posts a JSON body matching the table schema; we map fields and insert.
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
// Returns recent tenders. Supports ?limit=N (1..500, default 50) and
// ?carrier=NAME (substring match, case-insensitive).
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`FreightIQ backend listening on port ${PORT}`);
});
