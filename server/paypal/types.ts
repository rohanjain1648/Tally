export interface Money {
  currency_code: string;
  value: string;
}

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "UNPAID"
  | "PAID"
  | "MARKED_AS_PAID"
  | "PARTIALLY_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED"
  | "PAYMENT_PENDING";

export interface LineItem {
  name: string;
  description?: string;
  quantity: number;
  unit_amount: number;
}

/** Normalized invoice, independent of the raw PayPal shape. */
export interface Invoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  recipient: { name: string; email: string };
  items: LineItem[];
  currency: string;
  total: number;
  amount_due: number;
  invoice_date: string;
  due_date: string;
  note?: string;
  payer_url?: string;
  /** PayPal transaction/capture ids for payments made against this invoice. */
  payment_ids: string[];
  paid_date?: string;
}

export interface InvoiceInput {
  recipient_name: string;
  recipient_email: string;
  items: LineItem[];
  currency?: string;
  due_in_days?: number;
  invoice_date?: string;
  note?: string;
  tax_percent?: number;
}

export interface PaymentLink {
  order_id: string;
  approve_url: string;
  amount: number;
  currency: string;
  description: string;
  status: string;
  capture_id?: string;
  payer_email?: string;
  created_at: string;
}

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  currency: string;
  status: string;
  type: string;
  counterparty?: string;
  note?: string;
}

export interface RetainerResult {
  product_id: string;
  plan_id: string;
  subscription_id: string;
  approve_url: string;
}

/** Everything Tally needs from PayPal. Implemented by the live sandbox client and the simulator. */
export interface PayPalGateway {
  readonly mode: "sandbox" | "mock";
  listInvoices(): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice>;
  createInvoice(input: InvoiceInput): Promise<Invoice>;
  sendInvoice(id: string, opts: { subject?: string; note?: string }): Promise<Invoice>;
  remindInvoice(id: string, opts: { subject?: string; note?: string }): Promise<void>;
  cancelInvoice(id: string, opts: { note?: string }): Promise<void>;
  recordPayment(id: string, opts: { method: "CASH" | "BANK_TRANSFER" | "CHECK" | "OTHER"; amount?: number; note?: string }): Promise<Invoice>;
  createPaymentLink(input: { amount: number; currency?: string; description: string }): Promise<PaymentLink>;
  captureOrder(orderId: string): Promise<{ capture_id: string; status: string; payer_email?: string }>;
  refundCapture(captureId: string, opts: { amount?: number; currency?: string; note?: string }): Promise<{ refund_id: string; status: string }>;
  listTransactions(days: number): Promise<Transaction[]>;
  createRetainer(input: {
    name: string;
    amount: number;
    currency?: string;
    interval: "WEEK" | "MONTH";
    subscriber_name: string;
    subscriber_email: string;
  }): Promise<RetainerResult>;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}
