export interface LineItem {
  name: string;
  description?: string;
  quantity: number;
  unit_amount: number;
}

export interface Invoice {
  id: string;
  number: string;
  status: string;
  display_status: string;
  recipient: { name: string; email: string };
  items: LineItem[];
  currency: string;
  total: number;
  amount_due: number;
  invoice_date: string;
  due_date: string;
  note?: string;
  payer_url?: string;
  payment_ids: string[];
  paid_date?: string;
  overdue: boolean;
  days_overdue: number;
}

export interface Approval {
  id: string;
  conversationId: string | null;
  toolUseId: string | null;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  reason: string;
  amount: number | null;
  currency: string;
  policyReasons: string[];
  source: "agent" | "briefing" | "human" | "webhook" | "mcp";
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  result?: { ok: boolean; content: string };
  createdAt: string;
  decidedAt?: string;
}

export type ViewItem =
  | { kind: "user"; text: string; images: number }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; state: "running" | "done" | "error" | "pending" | "denied"; result?: unknown; approvalId?: string };

export interface ConversationView {
  id: string;
  title: string;
  kind: "chat" | "briefing";
  status: "idle" | "running" | "awaiting_approval" | "error";
  error?: string;
  updatedAt: string;
  items: ViewItem[];
}

export interface Summary {
  currency: string;
  outstanding_total: number;
  outstanding_count: number;
  overdue_total: number;
  overdue_count: number;
  collected_last_30_days: number;
  drafts: number;
  oldest_overdue: { id: string; number: string; client: string; amount_due: number; days_overdue: number }[];
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

export interface Dashboard {
  summary: Summary;
  clients: ClientSummary[];
  recent: Invoice[];
  pendingApprovals: number;
  briefing: ConversationView | null;
}

export interface Status {
  aiProvider?: string;
  businessName: string;
  currency: string;
  paypalMode: "sandbox" | "mock";
  aiReady: boolean;
  model: string;
  webhookVerification: boolean;
}

export type RuleMode = "auto" | "ask" | "block";
export interface Policy {
  autoApproveLimit: number;
  dailyAutoLimit: number;
  requireApprovalForNewClients: boolean;
  rules: Record<string, RuleMode>;
}

export interface AuditEntry {
  id: string;
  at: string;
  source: Approval["source"];
  kind: "tool" | "policy" | "approval" | "webhook" | "system";
  tool?: string;
  decision?: string;
  summary: string;
  detail?: unknown;
  ok?: boolean;
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

export interface InvoiceDraft {
  client_name: string;
  client_email: string | null;
  items: { name: string; description: string; quantity: number; unit_amount: number }[];
  currency: string;
  due_in_days: number;
  tax_percent: number;
  note: string;
  confidence: "high" | "medium" | "low";
  missing: string[];
  summary: string;
}

export interface FilePayload {
  mediaType: string;
  base64: string;
  name: string;
  previewUrl: string;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
};

export function readFile(file: File): Promise<FilePayload> {
  return new Promise((resolve, reject) => {
    if (file.size > 10 * 1024 * 1024) return reject(new Error("That file is over 10 MB. Try a smaller photo."));
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mediaType: file.type || "application/octet-stream", base64: url.split(",")[1] ?? "", name: file.name, previewUrl: url });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const money = (n: number | null | undefined, currency = "USD") =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);

export const shortDate = (iso?: string) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

export const timeAgo = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return shortDate(iso);
};
