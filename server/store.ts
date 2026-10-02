import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Invoice, PaymentLink, Transaction } from "./paypal/types.js";
import { defaultPolicy, type Policy } from "./policy.js";

export type ActionSource = "agent" | "briefing" | "human" | "webhook" | "mcp";

export interface ToolOutcome {
  ok: boolean;
  content: string;
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
  source: ActionSource;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  result?: ToolOutcome;
  createdAt: string;
  decidedAt?: string;
}

export interface Conversation {
  id: string;
  title: string;
  kind: "chat" | "briefing";
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Tool calls from the latest assistant turn that are waiting on a human decision. */
  pendingTurn: { toolUseIds: string[]; results: Record<string, ToolOutcome | null> } | null;
  status: "idle" | "running" | "awaiting_approval" | "error";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  source: ActionSource;
  kind: "tool" | "policy" | "approval" | "webhook" | "system";
  tool?: string;
  decision?: string;
  summary: string;
  detail?: unknown;
  ok?: boolean;
}

export interface MockState {
  invoices: Invoice[];
  transactions: Transaction[];
  seq: number;
}

interface Data {
  policy: Policy;
  conversations: Record<string, Conversation>;
  approvals: Approval[];
  audit: AuditEntry[];
  paymentLinks: PaymentLink[];
  briefing: { conversationId: string; createdAt: string } | null;
  mock: MockState | null;
}

const empty = (): Data => ({
  policy: defaultPolicy(),
  conversations: {},
  approvals: [],
  audit: [],
  paymentLinks: [],
  briefing: null,
  mock: null,
});

class Store {
  data: Data;
  private file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    this.file = path.resolve(file);
    this.data = empty();
    try {
      if (fs.existsSync(this.file)) {
        this.data = { ...empty(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
        this.data.policy = { ...defaultPolicy(), ...this.data.policy, rules: { ...defaultPolicy().rules, ...this.data.policy?.rules } };
      }
    } catch (err) {
      console.warn(`[store] could not read ${this.file}, starting fresh:`, err);
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 150);
  }

  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  audit(entry: Omit<AuditEntry, "id" | "at">): AuditEntry {
    const full = { id: randomUUID(), at: new Date().toISOString(), ...entry };
    this.data.audit.unshift(full);
    if (this.data.audit.length > 1000) this.data.audit.length = 1000;
    this.save();
    return full;
  }

  reset() {
    this.data = empty();
    this.save();
  }
}

export const store = new Store(config.dataFile);
export const newId = () => randomUUID();
