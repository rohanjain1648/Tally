import type { Invoice } from "./paypal/types.js";
import { store } from "./store.js";

const OPEN = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "PAYMENT_PENDING"]);
const PAID = new Set(["PAID", "MARKED_AS_PAID", "PARTIALLY_REFUNDED", "REFUNDED", "MARKED_AS_REFUNDED"]);

export const today = () => new Date().toISOString().slice(0, 10);
export const isOpen = (i: Invoice) => OPEN.has(i.status) && i.amount_due > 0;
export const isPaid = (i: Invoice) => PAID.has(i.status);
export const isOverdue = (i: Invoice) => isOpen(i) && !!i.due_date && i.due_date < today();
export const daysOverdue = (i: Invoice) =>
  isOverdue(i) ? Math.floor((Date.parse(today()) - Date.parse(i.due_date)) / 86_400_000) : 0;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function invoiceView(i: Invoice) {
  return {
    ...i,
    overdue: isOverdue(i),
    days_overdue: daysOverdue(i),
    display_status: isOverdue(i) ? "OVERDUE" : i.status,
  };
}

export interface ClientSummary {
  name: string;
  email: string;
  invoices: number;
  billed: number;
  paid: number;
  outstanding: number;
  overdue: number;
  last_invoice: string;
}

export function clientsFrom(invoices: Invoice[]): ClientSummary[] {
  const map = new Map<string, ClientSummary>();
  for (const inv of invoices) {
    if (!inv.recipient.email || inv.status === "CANCELLED") continue;
    const key = inv.recipient.email.toLowerCase();
    const c =
      map.get(key) ??
      { name: inv.recipient.name, email: inv.recipient.email, invoices: 0, billed: 0, paid: 0, outstanding: 0, overdue: 0, last_invoice: "" };
    c.invoices++;
    if (inv.status !== "DRAFT") c.billed = r2(c.billed + inv.total);
    if (isPaid(inv)) c.paid = r2(c.paid + inv.total - inv.amount_due);
    if (isOpen(inv)) c.outstanding = r2(c.outstanding + inv.amount_due);
    if (isOverdue(inv)) c.overdue = r2(c.overdue + inv.amount_due);
    if (inv.invoice_date > c.last_invoice) c.last_invoice = inv.invoice_date;
    map.set(key, c);
  }
  return [...map.values()].sort((a, b) => b.outstanding - a.outstanding || b.billed - a.billed);
}

/** A client is "known" once they have received at least one non-draft invoice. */
export function isKnownClient(invoices: Invoice[], email?: string | null) {
  if (!email) return false;
  const e = email.toLowerCase();
  return invoices.some((i) => i.recipient.email.toLowerCase() === e && i.status !== "DRAFT");
}

export function cashSummary(invoices: Invoice[]) {
  const open = invoices.filter(isOpen);
  const overdue = invoices.filter(isOverdue);
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const paid30 = invoices.filter((i) => isPaid(i) && (i.paid_date ?? i.invoice_date) >= since30);
  return {
    currency: invoices[0]?.currency ?? "USD",
    outstanding_total: r2(open.reduce((s, i) => s + i.amount_due, 0)),
    outstanding_count: open.length,
    overdue_total: r2(overdue.reduce((s, i) => s + i.amount_due, 0)),
    overdue_count: overdue.length,
    collected_last_30_days: r2(paid30.reduce((s, i) => s + i.total - i.amount_due, 0)),
    drafts: invoices.filter((i) => i.status === "DRAFT").length,
    oldest_overdue: overdue
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .slice(0, 5)
      .map((i) => ({ id: i.id, number: i.number, client: i.recipient.name, amount_due: i.amount_due, days_overdue: daysOverdue(i) })),
  };
}

/** Value auto-approved by policy today, from the audit trail. */
export function autoApprovedToday() {
  const t = today();
  return store.data.audit
    .filter((a) => a.kind === "policy" && a.decision === "allow" && a.at.startsWith(t))
    .reduce((sum, a) => sum + (((a.detail as { amount?: number } | undefined)?.amount ?? 0) || 0), 0);
}
