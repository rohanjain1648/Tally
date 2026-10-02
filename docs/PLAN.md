# Tally — Hackathon Research, Ideation & Implementation Plan

Hackathon: **Build What's Next with PayPal and AI** (Devpost, deadline **Nov 12, 2026 2:00pm PST**)

---

## 1. Research — what the judges actually require

| Requirement | How Tally satisfies it |
|---|---|
| Meaningfully integrate ≥1 PayPal technology | PayPal REST APIs in sandbox: **Invoicing v2** (create / send / remind / cancel / QR / list), **Orders v2** (payment links + capture), **Payments v2** (refunds), **Catalog + Subscriptions v1** (retainer plans), **Transaction Search (Reporting)**, **Webhooks** (INVOICING.INVOICE.PAID, PAYMENT.CAPTURE.COMPLETED). |
| Meaningfully incorporate AI | Claude (Opus 5.5) runs as a **tool-using agent** over the PayPal APIs, plus **vision extraction** (photo or email → structured invoice) and a **daily cash briefing** that proposes actions. |
| Working prototype | Runs locally with one command; a built-in **PayPal simulator** (`PAYPAL_MODE=mock`) lets judges run it with no PayPal keys; set sandbox keys to use the real PayPal sandbox. Deployable to Render (`render.yaml`). |
| Documentation | README with setup, architecture, tools used, and a demo script. |
| Public repo + license | MIT `LICENSE` at the repo root. |
| Demo video < 3 min | Script in §7. |

**Judging criteria → design response**

- *Technological implementation*: a real agent loop (manual Claude tool-use loop with pause/resume for approvals). It calls 6 PayPal API families and handles webhooks.
- *Design*: a complete product shell (Today, Capture, Agent, Invoices, Guardrails, Activity), not a chat box over an API.
- *Potential impact*: the audience is solo businesses: freelancers, tradespeople, tutors and makers. They lose hours chasing payments and mistype invoices, and they often lack a back office. Tally turns "I did the job" into "I got paid".
- *Innovation*: the core novelty is **guarded agency**. Public reviews of PayPal's own Agent Toolkit point out that it has *no automatic human-confirmation gate*. Tally adds a **policy engine between the LLM and the money**: read actions run freely, low-risk writes auto-run within limits, and everything else becomes an approval card with the agent's reasoning attached. Every action is written to an audit trail.
- *Presentation*: the demo has one clear "wow" path, *photo of a scribbled job sheet → PayPal invoice in the client's inbox → paid → agent logs it*.

**Prize surfaces targeted:** Overall placing, Best Use of PayPal + AI, Best Use of Agentic Commerce (guarded agent payments + MCP exposure, stretch goal), Most Impactful, Best Use of Render (deployment).

---

## 2. Ideation (shortlist and why Tally won)

| Idea | Strengths | Why not chosen |
|---|---|---|
| AI receipt bill-splitter → PayPal requests | Fun demo | Crowded idea; shallow PayPal usage |
| Autonomous dispute-defender | High value for merchants | Disputes are hard to create and demo in sandbox |
| Shopping agent with spending mandates | Strong on agentic commerce | Needs merchant catalogs and vaulting; hard to make reliable for judges |
| **Tally: guarded AI back office for solo businesses** | Real audience and pain, deep multi-API PayPal use, every step demoable in sandbox, a clear novelty angle (guardrails) | **Chosen** |

---

## 3. Product — Tally

> *"You do the work. Tally gets you paid."*

### Core features
1. **Capture → Invoice**: paste an email or WhatsApp message, or upload a photo of a handwritten job sheet or quote. Claude extracts the client, line items, tax, due date and deposit into a structured draft. You review it, and one click creates and sends a PayPal invoice.
2. **Agent chat**: "Invoice Acme $1,200 for the logo, net 15", "Who still owes me?", "Refund half of Sam's last payment", "Set up a $300/month retainer for Bloom Studio". Claude calls PayPal tools, and the policy engine gates every write.
3. **Guardrails (policy engine)**: an auto-approve threshold, per-action rules (always ask for refunds and cancels), a daily outbound cap and a client allowlist. Pending actions appear as **approval cards** showing the agent's rationale, the exact parameters, and approve/reject buttons. The agent resumes after the decision.
4. **Today briefing**: the agent reviews invoices and transactions to produce cash in, outstanding and overdue totals. It proposes actions (reminders with tone matched to lateness, follow-ups), each of which goes through the same approval flow.
5. **Invoices & payments ledger**: live PayPal data and status chips, with a pay link and QR code per invoice.
6. **Activity / audit log**: every tool call, policy decision, approval, webhook event and outcome.
7. **Webhooks**: an `INVOICE.PAID` event marks the invoice paid, logs it, and surfaces it on Today.
8. *(Stretch)* **MCP server**: exposes Tally's guarded PayPal tools to any MCP client (e.g. Claude Desktop). External agents get the same guardrails, so writes land in Tally's approval queue.

---

## 4. Architecture

```
React (Vite) SPA ──REST/SSE──► Express API (TypeScript, tsx)
                                  │
         ┌────────────────────────┼─────────────────────────┐
         ▼                        ▼                         ▼
   Agent runtime            Extraction                Webhook handler
 (Claude tool loop,      (Claude vision +            (PayPal events → store)
  pause/resume)           structured output)
         │
         ▼
   Policy engine ──► approval queue (store) ──► UI approval cards
         │
         ▼
   PayPal gateway (interface)
     ├─ LivePayPal  → api-m.sandbox.paypal.com (OAuth2 client credentials)
     └─ MockPayPal  → in-process simulator (same shapes)
         │
         ▼
   JSON file store (data/tally.json): conversations, pending actions, audit, policy, events
```

Key decisions:
- **Manual tool loop, not the tool runner**: we must *suspend* a conversation mid-turn while a human approves, persist it, and resume later (possibly after a restart). History is append-only, so Opus 5.5 thinking blocks stay valid.
- **Parallel tool calls**: auto-approved calls run at once. Gated calls are held, and once every call in that assistant turn is resolved, all `tool_result`s are sent back in one user message.
- **Model**: `claude-opus-5-5`, adaptive thinking, effort `medium` for chat and `low` for extraction, with server-side refusal fallbacks (`fallbacks: "default"`).
- **Money safety**: amounts are validated server-side, the LLM never sees credentials, and policy is enforced in code, not in the prompt.

---

## 5. Implementation plan (milestones)

| # | Milestone | Deliverables |
|---|---|---|
| M1 | Scaffold | npm workspace, TS config, Express + Vite, env config, JSON store |
| M2 | PayPal gateway | OAuth token cache; invoices, orders, refunds, subscriptions, transactions; mock simulator with identical interface |
| M3 | Policy engine | Risk classification per tool, rule evaluation, decision + reason, unit tests |
| M4 | Agent runtime | Tool registry, Claude loop with SSE streaming, pause/resume on approvals, audit logging |
| M5 | Extraction | Image/text → `InvoiceDraft` via structured outputs; review form → create + send |
| M6 | Briefing | Metrics plus Claude-generated summary and proposed actions → approval queue |
| M7 | Web UI | Today, Capture, Agent, Invoices, Guardrails, Activity; responsive; polished design |
| M8 | Webhooks | `/api/webhooks/paypal` with signature verification in live mode; mock "simulate payment" |
| M9 | Docs & deploy | README, LICENSE, `.env.example`, `render.yaml`, demo script |
| M10 | Stretch | MCP server exposing guarded tools |

---

## 6. Setup checklist (owner actions)

1. Create a PayPal Developer account → Apps & Credentials → **Sandbox** → create an app → copy the Client ID and Secret.
2. Create an Anthropic API key.
3. `cp .env.example .env`, fill in the keys, and set `PAYPAL_MODE=sandbox`.
4. `npm install && npm run dev` → http://localhost:5173
5. Deploy: push to GitHub → Render "New Blueprint" → set env vars → add the webhook URL `https://<app>.onrender.com/api/webhooks/paypal` in the PayPal app's webhook settings.

---

## 7. Demo video script (≤ 2:45)

1. **0:00 Problem (20s)**: "Solo pros lose about 5 hours a week to invoicing and chasing payments."
2. **0:20 Capture (40s)**: upload a photo of a handwritten job sheet. Line items appear; approve; a real PayPal sandbox invoice is sent and its link opens.
3. **1:00 Agent + guardrails (50s)**: "Refund $80 to Sam and remind everyone who's overdue." Reminders auto-run (under policy); the refund produces an approval card with the agent's reasoning. Approve it, and the agent resumes and confirms.
4. **1:50 Paid (25s)**: pay the invoice as the sandbox buyer. The webhook flips it to Paid and Today updates.
5. **2:15 Today + audit (20s)**: the briefing and the full audit trail.
6. **2:35 Close (10s)**: who it's for, and what's next (MCP for external agents).
