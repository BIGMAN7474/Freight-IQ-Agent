# FreightIQ — Agentic AI for Cold-Chain Freight

Final project for *Agentic AI for Logistics*. Case study: **Wayne Sanderson Farms**, a USDA-regulated poultry processor moving frozen product on temperature-controlled freight.

## What it is

FreightIQ combines a deterministic carrier-scoring engine with an LLM reasoning agent. Given a load (origin, destination, equipment, commodity), it:

1. Scores ~100 carriers in parallel against three personas — Cost Optimized, Balanced Fit, Reliability Tier — using a transparent weighted formula.
2. Surfaces Top 3 / Bottom 3 per persona on the same eligible pool.
3. Invokes a reasoning agent (LLM) that reads the structured scoring matrix and produces a grounded, streamed recommendation a broker can defend.

## Architecture

Browser (FreightIQ.html) → Node.js backend (this repo) → LLM API (Groq, Llama 3.3 70B)

The deterministic engine handles the math (rates, normalization, weighted scores, gates). The LLM handles the reasoning — what trade-off to surface, which persona to recommend given the cold-chain context (USDA recall risk, DC chargeback windows, reefer breakdown exposure).

The agent is constrained by a system prompt to cite specific carriers and numbers from the scoring matrix, so it cannot hallucinate carriers or rates.

## Why this architecture

Agents shouldn't do math on rates — that needs to be deterministic and auditable. Agents *should* do reasoning over structured data — that's where they add real value. Splitting the two is how production agentic systems are actually built.

## Files

- `index.js` — Express backend, proxies the LLM call
- `package.json` — Node dependencies
- `FreightIQ.html` — single-file frontend (deterministic scoring + UI)

## Local dev
npm install
const apiKey = process.env.GROQ_API_KEY;
Server runs on http://localhost:3000

## Deployment

Deployed on Render (free tier) from this repo. The frontend HTML calls the live backend URL.

## Model

Currently running Groq's `llama-3.3-70b-versatile`. The agent layer is model-agnostic — swappable to Claude or GPT with a one-line endpoint change.
