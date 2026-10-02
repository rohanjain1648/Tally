import { config } from "../config.js";
import { store, type MockState } from "../store.js";
import {
  PayPalError,
  type Invoice,
  type InvoiceInput,
  type PayPalGateway,
  type PaymentLink,
  type RetainerResult,
  type Transaction,
} from "./types.js";

/**
 * In-process PayPal simulator so Tally runs with zero credentials.
 * It mirrors the behaviour Tally relies on from the sandbox: invoice lifecycle, orders, captures,
 * refunds and transactions. Checkout and invoice payment pages are served by Tally under /pay/mock/*.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => isoDate(new Date(Date.now() + n * 86_400_000));
const round = (n: number) => Math.round(n * 100) / 100;
const rid = (prefix: string, len = 17) =>
  prefix + Array.from({ length: len }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("");

function state(): MockState {
  if (!store.data.mock) {
    store.data.mock = { invoices: [], transactions: [], seq: 1000 };
    seed(store.data.mock);
    store.save();
  }
  return store.data.mock;
}

function seed(s: MockState) {
  const mk = (
    name: string,
    email: string,
    items: [string, number, number][],
    status: Invoice["status"],
    issuedDaysAgo: number,
    dueInDays: number,
  ) => {
    const total = round(items.reduce((sum, [, q, p]) => sum + q * p, 0));
    const inv: Invoice = {
      id: rid("INV2-", 16),
      number: String(++s.seq),
      status,
      recipient: { name, email },
      items: items.map(([n, quantity, unit_amount]) => ({ name: n, quantity, unit_amount })),
      currency: config.currency,
      total,
      amount_due: status === "PAID" ? 0 : total,
      invoice_date: daysFromNow(-issuedDaysAgo),
      due_date: daysFromNow(dueInDays - issuedDaysAgo),
      payment_ids: [],
    };
    inv.payer_url = `${config.publicUrl}/pay/mock-invoice/${inv.id}`;
    if (status === "PAID") {
      const txId = rid("", 17);
      inv.payment_ids = [txId];
      inv.paid_date = daysFromNow(-issuedDaysAgo + 3);
      s.transactions.push({
        id: txId,
        date: new Date(inv.paid_date).toISOString(),
        amount: total,
        currency: inv.currency,
        status: "COMPLETED",
        type: "T0007",
        counterparty: name,
        note: `Invoice #${inv.number}`,
      });
    }
    s.invoices.push(inv);
  };
  mk("Acme Coffee Roasters", "ops@acmecoffee.example", [["Packaging redesign", 1, 1250], ["Print-ready files", 1, 200]], "PAID", 34, 14);
  mk("Sam Patel", "sam.patel@example.com", [["Portrait session", 2, 160]], "PAID", 12, 7);
  mk("Acme Coffee Roasters", "ops@acmecoffee.example", [["Seasonal menu boards", 4, 170]], "SENT", 23, 14);
  mk("Northwind Bikes", "accounts@northwind.example", [["Logo refresh", 1, 850], ["Brand guidelines PDF", 1, 125]], "SENT", 37, 14);
  mk("Bloom Studio", "hello@bloomstudio.example", [["Website design — phase 1", 1, 2200]], "SENT", 9, 14);
  mk("Lena Okafor", "lena@okafor.example", [["Wedding invitation suite", 1, 450]], "DRAFT", 1, 14);
}

function find(id: string) {
  const inv = state().invoices.find((i) => i.id === id || i.number === id);
  if (!inv) throw new PayPalError(`Invoice ${id} not found`, 404);
  return inv;
}

export class MockPayPal implements PayPalGateway {
  readonly mode = "mock" as const;

  async listInvoices() {
    return [...state().invoices].reverse();
  }

  async getInvoice(id: string) {
    return find(id);
  }

  async createInvoice(input: InvoiceInput) {
    const s = state();
    const subtotal = input.items.reduce((sum, it) => sum + it.quantity * it.unit_amount, 0);
    const total = round(subtotal * (1 + (input.tax_percent ?? 0) / 100));
    const invDate = input.invoice_date ? new Date(input.invoice_date) : new Date();
    const inv: Invoice = {
      id: rid("INV2-", 16),
      number: String(++s.seq),
      status: "DRAFT",
      recipient: { name: input.recipient_name, email: input.recipient_email },
      items: input.items,
      currency: input.currency ?? config.currency,
      total,
      amount_due: total,
      invoice_date: isoDate(invDate),
      due_date: isoDate(new Date(invDate.getTime() + (input.due_in_days ?? 14) * 86_400_000)),
      note: input.note,
      payment_ids: [],
    };
    inv.payer_url = `${config.publicUrl}/pay/mock-invoice/${inv.id}`;
    s.invoices.push(inv);
    store.save();
    return inv;
  }

  async sendInvoice(id: string) {
    const inv = find(id);
    if (inv.status !== "DRAFT" && inv.status !== "SCHEDULED") {
      throw new PayPalError(`Invoice ${inv.number} is ${inv.status}; only drafts can be sent`, 422);
    }
    inv.status = "SENT";
    store.save();
    return inv;
  }

  async remindInvoice(id: string) {
    const inv = find(id);
    if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(inv.status)) {
      throw new PayPalError(`Invoice ${inv.number} is ${inv.status}; reminders need an unpaid sent invoice`, 422);
    }
  }

  async cancelInvoice(id: string) {
    const inv = find(id);
    if (["PAID", "MARKED_AS_PAID", "CANCELLED"].includes(inv.status)) {
      throw new PayPalError(`Invoice ${inv.number} is ${inv.status} and cannot be cancelled`, 422);
    }
    inv.status = "CANCELLED";
    store.save();
  }

  async recordPayment(id: string, opts: { amount?: number }) {
    const inv = find(id);
    const amount = opts.amount ?? inv.amount_due;
    inv.amount_due = round(Math.max(0, inv.amount_due - amount));
    inv.status = inv.amount_due === 0 ? "MARKED_AS_PAID" : "PARTIALLY_PAID";
    inv.paid_date = isoDate(new Date());
    store.save();
    return inv;
  }

  /** Called by the simulated payer page: the buyer pays the invoice through "PayPal". */
  payInvoice(id: string) {
    const inv = find(id);
    if (inv.amount_due <= 0) return { invoice: inv, transaction: null };
    const tx: Transaction = {
      id: rid("", 17),
      date: new Date().toISOString(),
      amount: inv.amount_due,
      currency: inv.currency,
      status: "COMPLETED",
      type: "T0007",
      counterparty: inv.recipient.name,
      note: `Invoice #${inv.number}`,
    };
    state().transactions.push(tx);
    inv.payment_ids.push(tx.id);
    inv.amount_due = 0;
    inv.status = "PAID";
    inv.paid_date = isoDate(new Date());
    store.save();
    return { invoice: inv, transaction: tx };
  }

  async createPaymentLink(input: { amount: number; currency?: string; description: string }): Promise<PaymentLink> {
    const orderId = rid("", 17);
    return {
      order_id: orderId,
      approve_url: `${config.publicUrl}/pay/mock/${orderId}`,
      amount: input.amount,
      currency: input.currency ?? config.currency,
      description: input.description,
      status: "PAYER_ACTION_REQUIRED",
      created_at: new Date().toISOString(),
    };
  }

  async captureOrder(orderId: string) {
    const link = store.data.paymentLinks.find((l) => l.order_id === orderId);
    if (!link) throw new PayPalError(`Order ${orderId} not found`, 404);
    const tx: Transaction = {
      id: rid("", 17),
      date: new Date().toISOString(),
      amount: link.amount,
      currency: link.currency,
      status: "COMPLETED",
      type: "T0006",
      counterparty: "buyer@personal.example",
      note: link.description,
    };
    state().transactions.push(tx);
    store.save();
    return { capture_id: tx.id, status: "COMPLETED", payer_email: "buyer@personal.example" };
  }

  async refundCapture(captureId: string, opts: { amount?: number; note?: string }) {
    const s = state();
    const original = s.transactions.find((t) => t.id === captureId);
    if (!original) throw new PayPalError(`Capture ${captureId} not found`, 404);
    const refunded = s.transactions.filter((t) => t.type === "T1107" && t.note?.includes(captureId)).reduce((a, t) => a - t.amount, 0);
    const amount = opts.amount ?? original.amount - refunded;
    if (amount <= 0 || amount + refunded > original.amount + 0.001) {
      throw new PayPalError(`Refund of ${amount} exceeds the refundable balance of ${round(original.amount - refunded)}`, 422);
    }
    const refundId = rid("", 17);
    s.transactions.push({
      id: refundId,
      date: new Date().toISOString(),
      amount: -round(amount),
      currency: original.currency,
      status: "COMPLETED",
      type: "T1107",
      counterparty: original.counterparty,
      note: `Refund of ${captureId}${opts.note ? ` — ${opts.note}` : ""}`,
    });
    const inv = s.invoices.find((i) => i.payment_ids.includes(captureId));
    if (inv) inv.status = amount + refunded >= original.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
    store.save();
    return { refund_id: refundId, status: "COMPLETED" };
  }

  async listTransactions(days: number) {
    const since = Date.now() - days * 86_400_000;
    return state()
      .transactions.filter((t) => new Date(t.date).getTime() >= since)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async createRetainer(input: { name: string; subscriber_email: string }): Promise<RetainerResult> {
    const subId = rid("I-", 12);
    return {
      product_id: rid("PROD-", 12),
      plan_id: rid("P-", 20),
      subscription_id: subId,
      approve_url: `${config.publicUrl}/pay/mock/${subId}?kind=subscription&name=${encodeURIComponent(input.name)}`,
    };
  }
}
