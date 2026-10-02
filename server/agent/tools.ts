import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { paypal, type Invoice } from "../paypal/index.js";
import { cashSummary, clientsFrom, invoiceView, isOpen, isOverdue, isPaid } from "../books.js";
import { store, type ToolOutcome } from "../store.js";
import type { WriteTool } from "../policy.js";

const reason = z
  .string()
  .min(3)
  .describe("One short sentence, written for the business owner, explaining why you are taking this action.");
const invoiceId = z.string().describe("PayPal invoice id (e.g. INV2-XXXX) or the invoice number shown to the user.");
const lineItem = z.object({
  name: z.string().min(1).describe("Short item name, e.g. 'Logo design'"),
  description: z.string().optional(),
  quantity: z.number().positive(),
  unit_amount: z.number().nonnegative().describe("Price per unit in the invoice currency, e.g. 120.5"),
});

const money = (n: number, c = config.currency) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
const ok = (data: unknown): ToolOutcome => ({ ok: true, content: JSON.stringify(data) });

async function resolveInvoice(id: string): Promise<Invoice> {
  const trimmed = id.replace(/^#/, "").trim();
  if (trimmed.startsWith("INV")) return paypal.getInvoice(trimmed);
  const match = (await paypal.listInvoices()).find((i) => i.number === trimmed);
  if (!match) throw new Error(`No invoice with number ${trimmed}`);
  return paypal.getInvoice(match.id);
}

export interface PolicyInfo {
  amount: number | null;
  currency: string;
  recipientEmail: string | null;
  summary: string;
}

interface ToolBase<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
}
export interface ReadTool<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  kind: "read";
  run(input: z.infer<S>): Promise<ToolOutcome>;
}
export interface WriteToolDef<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  kind: "write";
  name: WriteTool;
  describe(input: z.infer<S>): Promise<PolicyInfo>;
  run(input: z.infer<S>): Promise<ToolOutcome>;
}
export type ToolDef = ReadTool | WriteToolDef;

const read = <S extends z.ZodType>(t: Omit<ReadTool<S>, "kind">): ReadTool => ({ kind: "read", ...t }) as ReadTool;
const write = <S extends z.ZodType>(t: Omit<WriteToolDef<S>, "kind">): WriteToolDef =>
  ({ kind: "write", ...t }) as unknown as WriteToolDef;

export const TOOLS: ToolDef[] = [
  // ───────────── read ─────────────
  read({
    name: "get_cash_summary",
    description:
      "Snapshot of the business's receivables from PayPal invoicing: outstanding and overdue totals, cash collected in the last 30 days, drafts, and the oldest overdue invoices.",
    schema: z.object({}),
    run: async () => ok(cashSummary(await paypal.listInvoices())),
  }),
  read({
    name: "list_invoices",
    description:
      "List PayPal invoices, optionally filtered by status bucket and/or client name or email. Returns id, number, client, totals, due date, status and days overdue.",
    schema: z.object({
      status: z.enum(["ALL", "DRAFT", "OUTSTANDING", "OVERDUE", "PAID", "CANCELLED"]).optional(),
      client: z.string().optional().describe("Case-insensitive match against client name or email"),
    }),
    run: async ({ status = "ALL", client }) => {
      let list = await paypal.listInvoices();
      if (status === "DRAFT") list = list.filter((i) => i.status === "DRAFT");
      if (status === "OUTSTANDING") list = list.filter(isOpen);
      if (status === "OVERDUE") list = list.filter(isOverdue);
      if (status === "PAID") list = list.filter(isPaid);
      if (status === "CANCELLED") list = list.filter((i) => i.status === "CANCELLED");
      if (client) {
        const q = client.toLowerCase();
        list = list.filter((i) => i.recipient.name.toLowerCase().includes(q) || i.recipient.email.toLowerCase().includes(q));
      }
      return ok(
        list.slice(0, 50).map((i) => {
          const v = invoiceView(i);
          return {
            id: v.id,
            number: v.number,
            client: v.recipient.name,
            email: v.recipient.email,
            total: v.total,
            amount_due: v.amount_due,
            currency: v.currency,
            invoice_date: v.invoice_date,
            due_date: v.due_date,
            status: v.display_status,
            days_overdue: v.days_overdue,
          };
        }),
      );
    },
  }),
  read({
    name: "get_invoice",
    description: "Full details of one invoice including line items, payer link and PayPal payment ids (needed for refunds).",
    schema: z.object({ invoice_id: invoiceId }),
    run: async ({ invoice_id }) => ok(invoiceView(await resolveInvoice(invoice_id))),
  }),
  read({
    name: "list_clients",
    description: "Clients derived from invoice history with billed, paid, outstanding and overdue totals.",
    schema: z.object({}),
    run: async () => ok(clientsFrom(await paypal.listInvoices())),
  }),
  read({
    name: "list_transactions",
    description:
      "Recent PayPal account transactions (payments received, refunds) from the Transaction Search API. Payment ids here can be refunded.",
    schema: z.object({ days: z.number().int().min(1).max(31).default(30) }),
    run: async ({ days }) => ok(await paypal.listTransactions(days)),
  }),
  read({
    name: "list_payment_links",
    description: "PayPal checkout links Tally has created, with status and capture ids.",
    schema: z.object({}),
    run: async () => ok(store.data.paymentLinks.slice(0, 50)),
  }),

  // ───────────── write (policy-gated) ─────────────
  write({
    name: "create_invoice",
    description:
      "Create a PayPal invoice as a DRAFT (nothing is sent to the client). Follow with send_invoice to deliver it. Use the client's exact email.",
    schema: z.object({
      recipient_name: z.string().min(1),
      recipient_email: z.email(),
      items: z.array(lineItem).min(1),
      due_in_days: z.number().int().min(0).max(120).optional().describe("Defaults to 14"),
      tax_percent: z.number().min(0).max(30).optional(),
      note: z.string().optional().describe("Note shown to the client on the invoice"),
      reason,
    }),
    describe: async (i) => {
      const subtotal = i.items.reduce((s, it) => s + it.quantity * it.unit_amount, 0);
      const total = subtotal * (1 + (i.tax_percent ?? 0) / 100);
      return {
        amount: Math.round(total * 100) / 100,
        currency: config.currency,
        recipientEmail: i.recipient_email,
        summary: `Draft invoice for ${i.recipient_name} — ${money(total)} (${i.items.length} item${i.items.length > 1 ? "s" : ""})`,
      };
    },
    run: async ({ reason: _r, ...i }) => {
      const inv = await paypal.createInvoice(i);
      return ok({ created: true, id: inv.id, number: inv.number, status: inv.status, total: inv.total, due_date: inv.due_date });
    },
  }),
  write({
    name: "send_invoice",
    description: "Send a DRAFT PayPal invoice to the client by email. PayPal hosts the payment page.",
    schema: z.object({ invoice_id: invoiceId, message: z.string().optional().describe("Optional personal note in the email"), reason }),
    describe: async ({ invoice_id }) => {
      const inv = await resolveInvoice(invoice_id);
      return {
        amount: inv.amount_due,
        currency: inv.currency,
        recipientEmail: inv.recipient.email,
        summary: `Send invoice #${inv.number} (${money(inv.amount_due, inv.currency)}) to ${inv.recipient.name} <${inv.recipient.email}>`,
      };
    },
    run: async ({ invoice_id, message }) => {
      const inv = await resolveInvoice(invoice_id);
      const sent = await paypal.sendInvoice(inv.id, { subject: `Invoice #${inv.number} from ${config.businessName}`, note: message });
      return ok({ sent: true, id: sent.id, number: sent.number, status: sent.status, payer_url: sent.payer_url });
    },
  }),
  write({
    name: "send_reminder",
    description:
      "Email a payment reminder for an unpaid, already-sent invoice. Match the tone to how late it is: friendly if just due, firmer if long overdue. Never threatening.",
    schema: z.object({
      invoice_id: invoiceId,
      subject: z.string().min(3).max(100),
      message: z.string().min(10).max(1000).describe("The reminder email body"),
      reason,
    }),
    describe: async ({ invoice_id }) => {
      const inv = await resolveInvoice(invoice_id);
      return {
        amount: inv.amount_due,
        currency: inv.currency,
        recipientEmail: inv.recipient.email,
        summary: `Remind ${inv.recipient.name} about invoice #${inv.number} (${money(inv.amount_due, inv.currency)} due ${inv.due_date})`,
      };
    },
    run: async ({ invoice_id, subject, message }) => {
      const inv = await resolveInvoice(invoice_id);
      await paypal.remindInvoice(inv.id, { subject, note: message });
      return ok({ reminded: true, number: inv.number, client: inv.recipient.name });
    },
  }),
  write({
    name: "cancel_invoice",
    description: "Cancel a sent or draft invoice that should no longer be paid. The client is notified.",
    schema: z.object({ invoice_id: invoiceId, message: z.string().optional(), reason }),
    describe: async ({ invoice_id }) => {
      const inv = await resolveInvoice(invoice_id);
      return {
        amount: inv.amount_due,
        currency: inv.currency,
        recipientEmail: inv.recipient.email,
        summary: `Cancel invoice #${inv.number} for ${inv.recipient.name} (${money(inv.amount_due, inv.currency)})`,
      };
    },
    run: async ({ invoice_id, message }) => {
      const inv = await resolveInvoice(invoice_id);
      await paypal.cancelInvoice(inv.id, { note: message });
      return ok({ cancelled: true, number: inv.number });
    },
  }),
  write({
    name: "record_offline_payment",
    description: "Mark an invoice as paid (fully or partly) when the client paid outside PayPal, e.g. cash or bank transfer.",
    schema: z.object({
      invoice_id: invoiceId,
      method: z.enum(["CASH", "BANK_TRANSFER", "CHECK", "OTHER"]),
      amount: z.number().positive().optional().describe("Defaults to the full amount due"),
      reason,
    }),
    describe: async ({ invoice_id, amount }) => {
      const inv = await resolveInvoice(invoice_id);
      const amt = amount ?? inv.amount_due;
      return {
        amount: amt,
        currency: inv.currency,
        recipientEmail: inv.recipient.email,
        summary: `Record ${money(amt, inv.currency)} offline payment on invoice #${inv.number} (${inv.recipient.name})`,
      };
    },
    run: async ({ invoice_id, method, amount }) => {
      const inv = await resolveInvoice(invoice_id);
      const updated = await paypal.recordPayment(inv.id, { method, amount });
      return ok({ recorded: true, number: updated.number, status: updated.status, amount_due: updated.amount_due });
    },
  }),
  write({
    name: "create_payment_link",
    description:
      "Create a one-off PayPal checkout link (Orders API) for a fixed amount, e.g. a deposit or a quick sale. Share the returned URL with the payer.",
    schema: z.object({
      amount: z.number().positive(),
      description: z.string().min(3).max(127).describe("What the payment is for — shown at checkout"),
      reason,
    }),
    describe: async ({ amount, description }) => ({
      amount,
      currency: config.currency,
      recipientEmail: null,
      summary: `Payment link for ${money(amount)} — "${description}"`,
    }),
    run: async ({ amount, description }) => {
      const link = await paypal.createPaymentLink({ amount, description });
      store.data.paymentLinks.unshift(link);
      store.save();
      return ok({ order_id: link.order_id, url: link.approve_url, amount: link.amount, status: link.status });
    },
  }),
  write({
    name: "refund_payment",
    description:
      "Refund a captured PayPal payment, fully or partially. Use a payment id from get_invoice (payment_ids), list_transactions, or list_payment_links (capture_id).",
    schema: z.object({
      payment_id: z.string().min(5).describe("PayPal capture / transaction id"),
      amount: z.number().positive().optional().describe("Omit for a full refund"),
      note_to_payer: z.string().max(255).optional(),
      reason,
    }),
    describe: async ({ payment_id, amount }) => {
      const tx = (await paypal.listTransactions(31)).find((t) => t.id === payment_id);
      const link = store.data.paymentLinks.find((l) => l.capture_id === payment_id);
      const amt = amount ?? tx?.amount ?? link?.amount ?? null;
      const who = tx?.counterparty ?? link?.payer_email ?? "the payer";
      return {
        amount: amt,
        currency: tx?.currency ?? config.currency,
        recipientEmail: null,
        summary: `Refund ${amt != null ? money(amt) : "full amount"} of payment ${payment_id} to ${who}`,
      };
    },
    run: async ({ payment_id, amount, note_to_payer }) => {
      const res = await paypal.refundCapture(payment_id, { amount, note: note_to_payer });
      return ok({ refunded: true, ...res });
    },
  }),
  write({
    name: "create_retainer",
    description:
      "Set up a recurring retainer with PayPal Subscriptions: creates a catalog product, a billing plan and a subscription, and returns an approval link for the client.",
    schema: z.object({
      client_name: z.string().min(1),
      client_email: z.email(),
      service_name: z.string().min(3).max(127).describe("e.g. 'Monthly design retainer'"),
      amount: z.number().positive(),
      interval: z.enum(["WEEK", "MONTH"]),
      reason,
    }),
    describe: async (i) => ({
      amount: i.amount,
      currency: config.currency,
      recipientEmail: i.client_email,
      summary: `${money(i.amount)}/${i.interval.toLowerCase()} retainer "${i.service_name}" for ${i.client_name}`,
    }),
    run: async (i) => {
      const res = await paypal.createRetainer({
        name: i.service_name,
        amount: i.amount,
        interval: i.interval,
        subscriber_name: i.client_name,
        subscriber_email: i.client_email,
      });
      return ok({ created: true, ...res });
    },
  }),
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool definitions in the shape the Messages API expects. */
export function claudeTools(): Anthropic.Beta.BetaTool[] {
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.kind === "write" ? `${t.description} [Guarded: subject to the owner's approval policy.]` : t.description,
      input_schema: { type: "object", ...schema } as Anthropic.Beta.BetaTool.InputSchema,
    };
  });
}
