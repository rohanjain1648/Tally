import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { aiReady, config } from "./config.js";
import { live, paypal, PayPalError } from "./paypal/index.js";
import { cashSummary, clientsFrom, invoiceView } from "./books.js";
import { store } from "./store.js";
import { bus, type UiEvent } from "./bus.js";
import { decide, gate, runAsHuman } from "./agent/actions.js";
import { conversationView, createConversation, sendMessage, startBriefing, type ConvEvent } from "./agent/runtime.js";
import { assertImage, describeAttachment, extractInvoice } from "./ai/extract.js";
import { AiUnavailableError } from "./ai/groq.js";
import { defaultPolicy, WRITE_TOOLS, type Policy } from "./policy.js";
import { handleWebhookEvent } from "./webhooks.js";
import { toolSpecs } from "./agent/tools.js";

export const api = Router();

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    const status = err instanceof AiUnavailableError ? 503 : err instanceof PayPalError ? err.status || 502 : err instanceof z.ZodError ? 400 : 500;
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message;
    if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, message);
    if (!res.headersSent) res.status(status).json({ error: message });
  }
};

function sse(res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": connected\n\n");
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  return {
    send: (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`),
    onClose: (fn: () => void) =>
      res.on("close", () => {
        clearInterval(ping);
        fn();
      }),
  };
}

const getConv = (id: string) => {
  const conv = store.data.conversations[id];
  if (!conv) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  return conv;
};

// ───────────── status & dashboard ─────────────

api.get(
  "/status",
  h(() => ({
    businessName: config.businessName,
    currency: config.currency,
    paypalMode: config.paypal.mode,
    aiReady: aiReady(),
    aiProvider: config.ai.provider,
    model: config.ai.model,
    visionModel: config.ai.visionModel,
    webhookVerification: Boolean(config.paypal.webhookId),
  })),
);

api.get(
  "/dashboard",
  h(async () => {
    const invoices = await paypal.listInvoices();
    const briefing = store.data.briefing ? store.data.conversations[store.data.briefing.conversationId] : null;
    return {
      summary: cashSummary(invoices),
      clients: clientsFrom(invoices).slice(0, 8),
      recent: invoices.slice(0, 6).map(invoiceView),
      pendingApprovals: store.data.approvals.filter((a) => a.status === "pending").length,
      briefing: briefing ? conversationView(briefing) : null,
    };
  }),
);

// ───────────── invoices & money ─────────────

api.get("/invoices", h(async () => (await paypal.listInvoices()).map(invoiceView)));
api.get("/invoices/:id", h(async (req) => invoiceView(await paypal.getInvoice(String(req.params.id)))));
api.get("/transactions", h(async (req) => paypal.listTransactions(Number(req.query.days ?? 30))));
api.get("/payment-links", h(() => store.data.paymentLinks));

const humanInvoice = z.object({
  recipient_name: z.string().min(1),
  recipient_email: z.email(),
  items: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), quantity: z.number().positive(), unit_amount: z.number().nonnegative() })).min(1),
  due_in_days: z.number().int().min(0).max(120).optional(),
  tax_percent: z.number().min(0).max(30).optional(),
  note: z.string().optional(),
  send: z.boolean().default(true),
});

/** Human-approved invoice from the Capture screen: create the draft, then send it. */
api.post(
  "/invoices",
  h(async (req) => {
    const { send, ...draft } = humanInvoice.parse(req.body);
    const created = await runAsHuman("create_invoice", { ...draft, reason: "Created by the owner from Capture" });
    if (!created.ok) throw new Error(JSON.parse(created.content).error);
    const { id } = JSON.parse(created.content) as { id: string };
    if (send) {
      const sent = await runAsHuman("send_invoice", { invoice_id: id, reason: "Sent by the owner from Capture" });
      if (!sent.ok) throw new Error(JSON.parse(sent.content).error);
    }
    return invoiceView(await paypal.getInvoice(id));
  }),
);

api.post(
  "/invoices/:id/send",
  h(async (req) => {
    const out = await runAsHuman("send_invoice", { invoice_id: String(req.params.id), reason: "Sent by the owner" });
    if (!out.ok) throw new Error(JSON.parse(out.content).error);
    return JSON.parse(out.content);
  }),
);

// ───────────── approvals, policy, audit ─────────────

api.get(
  "/approvals",
  h((req) => (req.query.status === "all" ? store.data.approvals.slice(0, 100) : store.data.approvals.filter((a) => a.status === "pending"))),
);

api.post(
  "/approvals/:id",
  h(async (req) => {
    const { approve, note } = z.object({ approve: z.boolean(), note: z.string().optional() }).parse(req.body);
    return decide(String(req.params.id), approve, note);
  }),
);

api.get("/policy", h(() => ({ policy: store.data.policy, tools: WRITE_TOOLS })));
api.put(
  "/policy",
  h((req) => {
    const schema = z.object({
      autoApproveLimit: z.number().min(0).max(100000),
      dailyAutoLimit: z.number().min(0).max(1000000),
      requireApprovalForNewClients: z.boolean(),
      rules: z.record(z.enum(WRITE_TOOLS), z.enum(["auto", "ask", "block"])),
    });
    const next = schema.parse(req.body) as Policy;
    store.data.policy = { ...defaultPolicy(), ...next, rules: { ...defaultPolicy().rules, ...next.rules } };
    store.audit({ source: "human", kind: "system", summary: "Guardrails updated", detail: store.data.policy });
    return store.data.policy;
  }),
);

api.get("/audit", h(() => store.data.audit.slice(0, 300)));

// ───────────── agent conversations ─────────────

api.get(
  "/conversations",
  h(() =>
    Object.values(store.data.conversations)
      .filter((c) => c.kind === "chat")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({ id: c.id, title: c.title, status: c.status, updatedAt: c.updatedAt })),
  ),
);
api.post("/conversations", h(() => conversationView(createConversation("chat"))));
api.get("/conversations/:id", h((req) => conversationView(getConv(String(req.params.id)))));

const messageBody = z.object({
  text: z.string().max(8000).default(""),
  file: z.object({ mediaType: z.string(), base64: z.string().max(14_000_000) }).optional(),
});

api.post(
  "/conversations/:id/messages",
  h(async (req, res) => {
    if (!aiReady()) throw new AiUnavailableError();
    const conv = getConv(String(req.params.id));
    const { text, file } = messageBody.parse(req.body);
    if (!text.trim() && !file) throw new z.ZodError([{ code: "custom", path: ["text"], message: "Message is empty", input: text }]);
    let content = text.trim();
    if (file) {
      assertImage(file);
      const transcript = await describeAttachment(file);
      content = `${content || "Please process the attached photo."}

[Attached photo, read by Tally: ${transcript}]`;
    }
    try {
      sendMessage(conv, content);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    return { accepted: true };
  }),
);

api.get("/conversations/:id/stream", (req, res) => {
  const id = String(req.params.id);
  if (!store.data.conversations[id]) return res.status(404).end();
  const stream = sse(res);
  const listener = (e: ConvEvent) => stream.send(e);
  bus.on(`conv:${id}`, listener);
  stream.onClose(() => bus.off(`conv:${id}`, listener));
});

// ───────────── briefing & capture ─────────────

api.post(
  "/briefing",
  h(() => {
    if (!aiReady()) throw new AiUnavailableError();
    const current = store.data.briefing && store.data.conversations[store.data.briefing.conversationId];
    if (current?.status === "running") return conversationView(current);
    return conversationView(startBriefing());
  }),
);

api.post(
  "/capture",
  h(async (req) => {
    const { text, file } = messageBody.parse(req.body);
    if (!text.trim() && !file) throw new z.ZodError([{ code: "custom", path: ["text"], message: "Paste a message or attach a photo", input: text }]);
    return extractInvoice({ text: text.trim() || undefined, file });
  }),
);

// ───────────── MCP bridge (used by server/mcp.ts) ─────────────

api.get("/mcp/tools", h(() => toolSpecs()));

/** External agents call tools here. Same gate as the built-in agent: reads run, writes are policy-checked. */
api.post(
  "/mcp/call",
  h(async (req) => {
    const { name, input } = z.object({ name: z.string(), input: z.unknown() }).parse(req.body);
    const res = await gate(name, input, { source: "mcp" });
    if (res.status === "pending") {
      return {
        status: "pending_approval",
        approval_id: res.approval.id,
        message: `Queued for the owner's approval in Tally: ${res.approval.summary}. Do not retry; ask the owner to approve it.`,
      };
    }
    return { status: res.status, ok: res.outcome.ok, content: res.outcome.content };
  }),
);

// ───────────── live UI events ─────────────

api.get("/events", (_req, res) => {
  const stream = sse(res);
  const listener = (e: UiEvent) => stream.send(e);
  bus.on("ui", listener);
  stream.onClose(() => bus.off("ui", listener));
});

// ───────────── webhooks & demo ─────────────

api.post(
  "/webhooks/paypal",
  h(async (req) => {
    let verified = false;
    if (live && config.paypal.webhookId) {
      verified = await live.verifyWebhook(req.headers as Record<string, string>, req.body).catch(() => false);
      if (!verified) throw Object.assign(new PayPalError("Webhook signature verification failed", 400));
    }
    handleWebhookEvent(req.body, verified);
    return { received: true };
  }),
);

/** Mock mode only: queue the kind of proposals the agent would make, so the approval flow can be tried without an AI key. */
api.post(
  "/demo/propose",
  h(async () => {
    if (config.paypal.mode !== "mock") throw new Error("Demo proposals are only available in mock mode");
    const invoices = await paypal.listInvoices();
    const late = invoices.filter((i) => i.status === "SENT").sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
    const tx = (await paypal.listTransactions(31)).find((t) => t.amount > 0 && t.counterparty === "Sam Patel");
    const opts = { source: "briefing" as const, proposeOnly: true };
    const queued = [];
    if (late) {
      queued.push(
        await gate(
          "send_reminder",
          {
            invoice_id: late.id,
            subject: `Quick reminder: invoice #${late.number}`,
            message: `Hi ${late.recipient.name.split(" ")[0]}, just a friendly nudge that invoice #${late.number} was due on ${late.due_date}. You can pay it in one click from the invoice link. Thanks so much!`,
            reason: "It's the oldest unpaid invoice, so a polite first reminder is due.",
          },
          opts,
        ),
      );
    }
    if (tx) {
      queued.push(
        await gate(
          "refund_payment",
          { payment_id: tx.id, amount: 80, note_to_payer: "Partial refund for the reshoot", reason: "Sam asked for $80 back on the portrait session." },
          opts,
        ),
      );
    }
    return { queued: queued.filter((q) => q.status === "pending").length };
  }),
);

api.post(
  "/demo/reset",
  h(() => {
    if (config.paypal.mode !== "mock") throw new Error("Reset is only available in mock mode");
    store.reset();
    bus.emit("ui", { type: "invoices_changed" } satisfies UiEvent);
    bus.emit("ui", { type: "approvals_changed" } satisfies UiEvent);
    return { reset: true };
  }),
);
