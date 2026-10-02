import { Router } from "express";
import { config } from "./config.js";
import { mock, paypal } from "./paypal/index.js";
import { store } from "./store.js";
import { handleWebhookEvent } from "./webhooks.js";
import { emitUi } from "./bus.js";

/** Server-rendered pages the payer sees: checkout return/cancel and (in mock mode) a PayPal simulator. */
export const pages = Router();

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (v: number, c = config.currency) => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(v);

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f4ef;--card:#fff;--ink:#1d1b16;--muted:#6b665c;--accent:#0f6b4f;--line:#e4e0d6}
@media (prefers-color-scheme:dark){:root{--bg:#14130f;--card:#1e1c17;--ink:#f1eee6;--muted:#a39e92;--accent:#3fbf8f;--line:#33302a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;max-width:440px;width:100%}
.tag{display:inline-block;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);border:1px dashed var(--line);border-radius:999px;padding:2px 10px;margin-bottom:12px}
h1{font-size:22px;margin:0 0 6px}p{color:var(--muted);margin:6px 0}.amt{font-size:36px;font-weight:700;margin:16px 0}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}td{padding:6px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right}
button,a.btn{display:block;width:100%;text-align:center;margin-top:16px;padding:12px;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:600;font-size:16px;cursor:pointer;text-decoration:none}
a.link{color:var(--accent)}
</style></head><body><div class="card">${body}</div></body></html>`;
}

pages.get("/pay/return", async (req, res) => {
  const orderId = String(req.query.token ?? "");
  const subscriptionId = req.query.subscription_id ? String(req.query.subscription_id) : null;
  if (subscriptionId) {
    handleWebhookEvent({ event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: subscriptionId }, summary: "Subscription approved by client" }, false);
    return res.send(page("Retainer confirmed", `<h1>You're subscribed</h1><p>Thanks! Your retainer with ${esc(config.businessName)} is set up.</p>`));
  }
  const link = store.data.paymentLinks.find((l) => l.order_id === orderId);
  if (!link) return res.status(404).send(page("Not found", `<h1>Payment not found</h1><p>We couldn't find this checkout.</p>`));
  try {
    if (link.status !== "COMPLETED") {
      const cap = await paypal.captureOrder(orderId);
      link.status = cap.status;
      link.capture_id = cap.capture_id;
      link.payer_email = cap.payer_email;
      store.save();
      handleWebhookEvent(
        {
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          resource: { id: cap.capture_id, amount: { value: String(link.amount), currency_code: link.currency }, supplementary_data: { related_ids: { order_id: orderId } } },
        },
        false,
      );
    }
    res.send(
      page(
        "Payment complete",
        `<h1>Payment complete</h1><p>${esc(link.description)}</p><div class="amt">${money(link.amount, link.currency)}</div><p>Paid to ${esc(config.businessName)}. You can close this window.</p>`,
      ),
    );
  } catch (err) {
    res.status(502).send(page("Payment problem", `<h1>We couldn't complete the payment</h1><p>${esc((err as Error).message)}</p>`));
  }
});

pages.get("/pay/cancel", (_req, res) => {
  res.send(page("Payment cancelled", `<h1>Payment cancelled</h1><p>No money was taken.</p>`));
});

// ───────────── mock-mode PayPal simulator ─────────────

pages.get("/pay/mock/:id", (req, res) => {
  if (!mock) return res.status(404).end();
  const id = req.params.id;
  if (req.query.kind === "subscription") {
    return res.send(
      page(
        "Approve subscription",
        `<span class="tag">PayPal simulator · mock mode</span><h1>${esc(req.query.name)}</h1><p>${esc(config.businessName)} is asking you to set up a recurring payment.</p>
<a class="btn" href="/pay/return?subscription_id=${encodeURIComponent(id)}">Agree & subscribe</a>`,
      ),
    );
  }
  const link = store.data.paymentLinks.find((l) => l.order_id === id);
  if (!link) return res.status(404).send(page("Not found", "<h1>Checkout not found</h1>"));
  res.send(
    page(
      "Checkout",
      `<span class="tag">PayPal simulator · mock mode</span><h1>Pay ${esc(config.businessName)}</h1><p>${esc(link.description)}</p>
<div class="amt">${money(link.amount, link.currency)}</div><a class="btn" href="/pay/return?token=${encodeURIComponent(id)}">Pay now</a>`,
    ),
  );
});

pages.get("/pay/mock-invoice/:id", async (req, res) => {
  if (!mock) return res.status(404).end();
  try {
    const inv = await mock.getInvoice(req.params.id);
    const rows = inv.items.map((i) => `<tr><td>${esc(i.name)} × ${i.quantity}</td><td>${money(i.quantity * i.unit_amount, inv.currency)}</td></tr>`).join("");
    const paid = inv.amount_due <= 0;
    res.send(
      page(
        `Invoice #${inv.number}`,
        `<span class="tag">PayPal simulator · mock mode</span><h1>Invoice #${esc(inv.number)}</h1><p>From ${esc(config.businessName)} to ${esc(inv.recipient.name)} · due ${esc(inv.due_date)}</p>
<table>${rows}</table><div class="amt">${money(paid ? inv.total : inv.amount_due, inv.currency)}</div>
${paid ? "<p><strong>Paid — thank you!</strong></p>" : inv.status === "DRAFT" || inv.status === "CANCELLED" ? `<p>This invoice is ${inv.status.toLowerCase()}.</p>` : `<form method="post" action="/pay/mock-invoice/${encodeURIComponent(inv.id)}/pay"><button>Pay with PayPal (simulated)</button></form>`}`,
      ),
    );
  } catch {
    res.status(404).send(page("Not found", "<h1>Invoice not found</h1>"));
  }
});

pages.post("/pay/mock-invoice/:id/pay", (req, res) => {
  if (!mock) return res.status(404).end();
  try {
    const { invoice } = mock.payInvoice(req.params.id);
    handleWebhookEvent(
      {
        id: `WH-SIM-${Date.now()}`,
        event_type: "INVOICING.INVOICE.PAID",
        resource_type: "invoices",
        resource: {
          invoice: {
            id: invoice.id,
            status: "PAID",
            detail: { invoice_number: invoice.number, currency_code: invoice.currency },
            primary_recipients: [{ billing_info: { name: { full_name: invoice.recipient.name }, email_address: invoice.recipient.email } }],
            amount: { value: String(invoice.total), currency_code: invoice.currency },
          },
        },
      },
      false,
    );
    emitUi({ type: "invoices_changed" });
    res.redirect(`/pay/mock-invoice/${encodeURIComponent(invoice.id)}`);
  } catch (err) {
    res.status(400).send(page("Error", `<h1>Payment failed</h1><p>${esc((err as Error).message)}</p>`));
  }
});
