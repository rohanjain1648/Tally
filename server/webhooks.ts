import { normalizeInvoice } from "./paypal/live.js";
import { store } from "./store.js";
import { emitUi } from "./bus.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const money = (v: number, c = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(v);

/** Apply a PayPal webhook event (real, or synthesized by the simulator) to Tally's state and UI. */
export function handleWebhookEvent(event: any, verified: boolean) {
  const type: string = event?.event_type ?? "UNKNOWN";
  const res = event?.resource ?? {};
  let summary = event?.summary ?? type;

  switch (type) {
    case "INVOICING.INVOICE.PAID": {
      const inv = res.invoice ? normalizeInvoice(res.invoice) : null;
      if (inv) {
        summary = `${inv.recipient.name} paid invoice #${inv.number} (${money(inv.total, inv.currency)})`;
        emitUi({ type: "toast", tone: "success", title: "Invoice paid", body: summary });
      }
      emitUi({ type: "invoices_changed" });
      break;
    }
    case "PAYMENT.CAPTURE.COMPLETED": {
      const orderId = res.supplementary_data?.related_ids?.order_id;
      const link = store.data.paymentLinks.find((l) => l.order_id === orderId);
      if (link) {
        link.status = "COMPLETED";
        link.capture_id ??= res.id;
      }
      summary = `Payment received: ${money(Number(res.amount?.value ?? 0), res.amount?.currency_code)}`;
      emitUi({ type: "toast", tone: "success", title: "Payment captured", body: summary });
      emitUi({ type: "invoices_changed" });
      break;
    }
    case "PAYMENT.CAPTURE.REFUNDED":
    case "INVOICING.INVOICE.CANCELLED":
    case "INVOICING.INVOICE.REFUNDED":
      emitUi({ type: "invoices_changed" });
      break;
    case "BILLING.SUBSCRIPTION.ACTIVATED":
      summary = `Retainer subscription ${res.id} is active`;
      emitUi({ type: "toast", tone: "success", title: "Retainer activated", body: summary });
      break;
  }

  store.audit({
    source: "webhook",
    kind: "webhook",
    decision: verified ? "verified" : "unverified",
    summary: `${type}: ${summary}`,
    detail: { id: event?.id, event_type: type, resource_type: event?.resource_type },
  });
  emitUi({ type: "audit_changed" });
}
