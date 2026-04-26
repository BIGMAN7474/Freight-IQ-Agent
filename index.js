// FreightIQ Backend — Reasoning Agent Proxy
// Forwards reasoning requests to Groq's API (Llama 3.3 70B) with auth.
// API key is held as an env var — never exposed to the browser.

const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));

// CORS: allow the HTML file to call this from any origin
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check
app.get("/", (req, res) => {
  res.json({
    service: "FreightIQ Reasoning Agent",
    model: "llama-3.3-70b-versatile (Groq)",
    status: "online",
    endpoint: "POST /api/reason",
  });
});

// Reasoning endpoint
app.post("/api/reason", async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured on server" });
  }

  const { system, messages, stream = true } = req.body;

  // Convert Anthropic-style { system, messages } -> OpenAI-style messages array
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`FreightIQ backend listening on port ${PORT}`);
});
