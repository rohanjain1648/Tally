/**
 * Guardrails between the model and the money.
 *
 * The model never decides whether an action runs. Every write tool call is evaluated here, in code,
 * against the owner's policy. The outcome is "allow" (run now), "ask" (queue for a human), or "deny".
 */

export const WRITE_TOOLS = [
  "create_invoice",
  "send_invoice",
  "send_reminder",
  "cancel_invoice",
  "record_offline_payment",
  "create_payment_link",
  "refund_payment",
  "create_retainer",
] as const;

export type WriteTool = (typeof WRITE_TOOLS)[number];
export type RuleMode = "auto" | "ask" | "block";

export interface Policy {
  /** Money-moving actions at or below this amount may run without asking. */
  autoApproveLimit: number;
  /** Total value Tally may auto-approve per day, across all money-moving actions. */
  dailyAutoLimit: number;
  /** Ask before billing or messaging someone who has never been invoiced before. */
  requireApprovalForNewClients: boolean;
  rules: Record<WriteTool, RuleMode>;
}

export const defaultPolicy = (): Policy => ({
  autoApproveLimit: 250,
  dailyAutoLimit: 1000,
  requireApprovalForNewClients: true,
  rules: {
    create_invoice: "auto",
    send_invoice: "auto",
    send_reminder: "auto",
    cancel_invoice: "ask",
    record_offline_payment: "ask",
    create_payment_link: "auto",
    refund_payment: "ask",
    create_retainer: "ask",
  },
});

export const TOOL_LABELS: Record<WriteTool, string> = {
  create_invoice: "Create invoice draft",
  send_invoice: "Send invoice",
  send_reminder: "Send payment reminder",
  cancel_invoice: "Cancel invoice",
  record_offline_payment: "Record offline payment",
  create_payment_link: "Create payment link",
  refund_payment: "Issue refund",
  create_retainer: "Create retainer subscription",
};

/** Tools that do not move money or contact anyone; the amount limits do not apply to them. */
const NO_MONEY: ReadonlySet<WriteTool> = new Set(["create_invoice"]);
/** Tools that contact a client, so the new-client rule applies. */
const CONTACTS_CLIENT: ReadonlySet<WriteTool> = new Set(["send_invoice", "send_reminder", "create_retainer"]);

export interface PolicyContext {
  tool: WriteTool;
  amount: number | null;
  recipientEmail?: string | null;
  knownClient: boolean;
  /** Value already auto-approved today. */
  autoApprovedToday: number;
  /** Briefing mode: the agent may only propose; nothing runs without a human. */
  proposeOnly?: boolean;
}

export interface PolicyDecision {
  decision: "allow" | "ask" | "deny";
  reasons: string[];
}

const fmt = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function evaluatePolicy(policy: Policy, ctx: PolicyContext): PolicyDecision {
  const mode = policy.rules[ctx.tool] ?? "ask";
  if (mode === "block") {
    return { decision: "deny", reasons: [`"${TOOL_LABELS[ctx.tool]}" is blocked by your guardrails.`] };
  }

  const reasons: string[] = [];
  if (ctx.proposeOnly) reasons.push("Briefing mode: proposals always need your approval.");
  if (mode === "ask") reasons.push(`Your guardrails say always ask before "${TOOL_LABELS[ctx.tool]}".`);

  if (!NO_MONEY.has(ctx.tool) && ctx.amount != null) {
    if (ctx.amount > policy.autoApproveLimit) {
      reasons.push(`${fmt(ctx.amount)} is above your auto-approve limit of ${fmt(policy.autoApproveLimit)}.`);
    } else if (ctx.autoApprovedToday + ctx.amount > policy.dailyAutoLimit) {
      reasons.push(
        `Would exceed today's autopilot cap (${fmt(ctx.autoApprovedToday)} of ${fmt(policy.dailyAutoLimit)} used).`,
      );
    }
  }

  if (policy.requireApprovalForNewClients && CONTACTS_CLIENT.has(ctx.tool) && !ctx.knownClient) {
    reasons.push(`${ctx.recipientEmail ?? "This recipient"} is a new client.`);
  }

  if (reasons.length) return { decision: "ask", reasons };
  return {
    decision: "allow",
    reasons: [
      NO_MONEY.has(ctx.tool) || ctx.amount == null
        ? `"${TOOL_LABELS[ctx.tool]}" is on autopilot.`
        : `${fmt(ctx.amount)} is within your auto-approve limit.`,
    ],
  };
}
