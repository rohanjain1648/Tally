import { config } from "../config.js";
import {
  PayPalError,
  type Invoice,
  type InvoiceInput,
  type InvoiceStatus,
  type PayPalGateway,
  type PaymentLink,
  type RetainerResult,
  type Transaction,
} from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const money = (value: number, currency: string) => ({ currency_code: currency, value: value.toFixed(2) });
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (days: number, from = new Date()) => new Date(from.getTime() + days * 86_400_000);

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { given_name: parts[0] };
  return { given_name: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
}

/** PayPal reporting wants e.g. 2026-09-01T00:00:00-0000 (no milliseconds). */
const reportingDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "-0000");

export function normalizeInvoice(raw: any): Invoice {
  const detail = raw.detail ?? {};
  const billing = raw.primary_recipients?.[0]?.billing_info ?? {};
  const name =
    billing.name?.full_name ??
    [billing.name?.given_name, billing.name?.surname].filter(Boolean).join(" ") ??
    billing.business_name;
  const total = Number(raw.amount?.value ?? 0);
  const status = raw.status as InvoiceStatus;
  const paidStatuses = ["PAID", "MARKED_AS_PAID", "REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED"];
  const due =
    raw.due_amount?.value != null ? Number(raw.due_amount.value) : paidStatuses.includes(status) ? 0 : total;
  const txns: any[] = raw.payments?.transactions ?? [];
  return {
    id: raw.id,
    number: detail.invoice_number ?? raw.id,
    status,
    recipient: { name: name || billing.business_name || billing.email_address || "Unknown", email: billing.email_address ?? "" },
    items: (raw.items ?? []).map((it: any) => ({
      name: it.name,
      description: it.description,
      quantity: Number(it.quantity ?? 1),
      unit_amount: Number(it.unit_amount?.value ?? 0),
    })),
    currency: detail.currency_code ?? raw.amount?.currency_code ?? config.currency,
    total,
    amount_due: due,
    invoice_date: detail.invoice_date ?? "",
    due_date: detail.payment_term?.due_date ?? detail.invoice_date ?? "",
    note: detail.note,
    payer_url: detail.metadata?.recipient_view_url,
    payment_ids: txns.map((t) => t.payment_id).filter(Boolean),
    paid_date: txns[0]?.payment_date,
  };
}

export class LivePayPal implements PayPalGateway {
  readonly mode = "sandbox" as const;
  private token: { value: string; expiresAt: number } | null = null;

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64");
    const res = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(`PayPal auth failed: ${body.error_description ?? res.statusText}`, res.status, body);
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(path.startsWith("http") ? path : `${config.paypal.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const issues = (data?.details ?? []).map((d: any) => d.description ?? d.issue).filter(Boolean);
      const msg = [data?.message ?? data?.name ?? res.statusText, ...issues].join(" — ");
      throw new PayPalError(`PayPal ${method} ${path.split("?")[0]} failed (${res.status}): ${msg}`, res.status, data);
    }
    return data as T;
  }

  async listInvoices(): Promise<Invoice[]> {
    const out: Invoice[] = [];
    for (let page = 1; page <= 5; page++) {
      const data = await this.request("GET", `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`);
      out.push(...(data.items ?? []).map(normalizeInvoice));
      if (!data.total_pages || page >= data.total_pages) break;
    }
    return out;
  }

  async getInvoice(id: string) {
    return normalizeInvoice(await this.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`));
  }

  async createInvoice(input: InvoiceInput) {
    const currency = input.currency ?? config.currency;
    const invoiceDate = input.invoice_date ? new Date(input.invoice_date) : new Date();
    const body = {
      detail: {
        currency_code: currency,
        invoice_date: isoDate(invoiceDate),
        note: input.note,
        payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: isoDate(addDays(input.due_in_days ?? 14, invoiceDate)) },
      },
      invoicer: { business_name: config.businessName },
      primary_recipients: [
        { billing_info: { name: splitName(input.recipient_name), email_address: input.recipient_email } },
      ],
      items: input.items.map((it) => ({
        name: it.name.slice(0, 200),
        description: it.description?.slice(0, 1000),
        quantity: String(it.quantity),
        unit_amount: money(it.unit_amount, currency),
        unit_of_measure: "QUANTITY",
        ...(input.tax_percent ? { tax: { name: "Tax", percent: String(input.tax_percent) } } : {}),
      })),
      configuration: { allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false },
    };
    const created = await this.request("POST", "/v2/invoicing/invoices", body);
    // Some sandbox responses return only a link even with Prefer: return=representation.
    if (created?.id) return normalizeInvoice(created);
    if (created?.href) return normalizeInvoice(await this.request("GET", created.href));
    throw new PayPalError("PayPal did not return the created invoice", 500, created);
  }

  async sendInvoice(id: string, opts: { subject?: string; note?: string }) {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
      subject: opts.subject,
      note: opts.note,
      send_to_invoicer: false,
      send_to_recipient: true,
    });
    return this.getInvoice(id);
  }

  async remindInvoice(id: string, opts: { subject?: string; note?: string }) {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
      subject: opts.subject,
      note: opts.note,
      send_to_invoicer: false,
      send_to_recipient: true,
    });
  }

  async cancelInvoice(id: string, opts: { note?: string }) {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, {
      subject: "Invoice cancelled",
      note: opts.note,
      send_to_invoicer: false,
      send_to_recipient: true,
    });
  }

  async recordPayment(id: string, opts: { method: "CASH" | "BANK_TRANSFER" | "CHECK" | "OTHER"; amount?: number; note?: string }) {
    const inv = await this.getInvoice(id);
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
      method: opts.method,
      payment_date: isoDate(new Date()),
      note: opts.note,
      amount: money(opts.amount ?? inv.amount_due, inv.currency),
    });
    return this.getInvoice(id);
  }

  async createPaymentLink(input: { amount: number; currency?: string; description: string }): Promise<PaymentLink> {
    const currency = input.currency ?? config.currency;
    const order = await this.request("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ amount: money(input.amount, currency), description: input.description.slice(0, 127) }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: config.businessName.slice(0, 127),
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: `${config.publicUrl}/pay/return`,
            cancel_url: `${config.publicUrl}/pay/cancel`,
          },
        },
      },
    });
    const approve = order.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href;
    return {
      order_id: order.id,
      approve_url: approve,
      amount: input.amount,
      currency,
      description: input.description,
      status: order.status,
      created_at: new Date().toISOString(),
    };
  }

  async captureOrder(orderId: string) {
    const res = await this.request("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});
    const capture = res.purchase_units?.[0]?.payments?.captures?.[0];
    return { capture_id: capture?.id, status: capture?.status ?? res.status, payer_email: res.payer?.email_address };
  }

  async refundCapture(captureId: string, opts: { amount?: number; currency?: string; note?: string }) {
    const res = await this.request("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      ...(opts.amount ? { amount: money(opts.amount, opts.currency ?? config.currency) } : {}),
      note_to_payer: opts.note?.slice(0, 255),
    });
    return { refund_id: res.id, status: res.status };
  }

  async listTransactions(days: number): Promise<Transaction[]> {
    const end = new Date();
    const start = addDays(-Math.min(Math.max(days, 1), 31), end);
    const data = await this.request(
      "GET",
      `/v1/reporting/transactions?start_date=${encodeURIComponent(reportingDate(start))}&end_date=${encodeURIComponent(
        reportingDate(end),
      )}&fields=transaction_info,payer_info&page_size=100`,
    );
    return (data.transaction_details ?? []).map((t: any) => ({
      id: t.transaction_info.transaction_id,
      date: t.transaction_info.transaction_initiation_date,
      amount: Number(t.transaction_info.transaction_amount?.value ?? 0),
      currency: t.transaction_info.transaction_amount?.currency_code ?? config.currency,
      status: { S: "COMPLETED", P: "PENDING", V: "REVERSED", D: "DENIED" }[t.transaction_info.transaction_status as string] ?? t.transaction_info.transaction_status,
      type: t.transaction_info.transaction_event_code,
      counterparty: t.payer_info?.payer_name?.alternate_full_name ?? t.payer_info?.email_address,
      note: t.transaction_info.transaction_note ?? t.transaction_info.transaction_subject,
    }));
  }

  async createRetainer(input: {
    name: string;
    amount: number;
    currency?: string;
    interval: "WEEK" | "MONTH";
    subscriber_name: string;
    subscriber_email: string;
  }): Promise<RetainerResult> {
    const currency = input.currency ?? config.currency;
    const product = await this.request("POST", "/v1/catalogs/products", {
      name: input.name.slice(0, 127),
      type: "SERVICE",
      category: "SOFTWARE",
    });
    const plan = await this.request("POST", "/v1/billing/plans", {
      product_id: product.id,
      name: input.name.slice(0, 127),
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: input.interval, interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: money(input.amount, currency) },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    });
    const sub = await this.request("POST", "/v1/billing/subscriptions", {
      plan_id: plan.id,
      subscriber: { name: splitName(input.subscriber_name), email_address: input.subscriber_email },
      application_context: {
        brand_name: config.businessName.slice(0, 127),
        user_action: "SUBSCRIBE_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: `${config.publicUrl}/pay/return`,
        cancel_url: `${config.publicUrl}/pay/cancel`,
      },
    });
    return {
      product_id: product.id,
      plan_id: plan.id,
      subscription_id: sub.id,
      approve_url: sub.links?.find((l: any) => l.rel === "approve")?.href,
    };
  }

  /** https://developer.paypal.com/api/rest/webhooks/rest/ — verify-webhook-signature */
  async verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
    if (!config.paypal.webhookId) return false;
    const res = await this.request("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    });
    return res?.verification_status === "SUCCESS";
  }
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}
