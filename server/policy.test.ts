import { describe, expect, it } from "vitest";
import { defaultPolicy, evaluatePolicy } from "./policy.js";

const base = { knownClient: true, autoApprovedToday: 0 };

describe("evaluatePolicy", () => {
  it("auto-runs a small invoice send to a known client", () => {
    const d = evaluatePolicy(defaultPolicy(), { ...base, tool: "send_invoice", amount: 120 });
    expect(d.decision).toBe("allow");
  });

  it("asks when the amount is above the auto-approve limit", () => {
    const d = evaluatePolicy(defaultPolicy(), { ...base, tool: "send_invoice", amount: 1200 });
    expect(d.decision).toBe("ask");
    expect(d.reasons.join(" ")).toMatch(/auto-approve limit/);
  });

  it("asks for new clients when the rule is on", () => {
    const d = evaluatePolicy(defaultPolicy(), {
      ...base,
      tool: "send_reminder",
      amount: 50,
      knownClient: false,
      recipientEmail: "new@client.com",
    });
    expect(d.decision).toBe("ask");
    expect(d.reasons[0]).toMatch(/new client/);
  });

  it("always asks for refunds by default, even small ones", () => {
    const d = evaluatePolicy(defaultPolicy(), { ...base, tool: "refund_payment", amount: 5 });
    expect(d.decision).toBe("ask");
  });

  it("denies blocked tools", () => {
    const policy = defaultPolicy();
    policy.rules.refund_payment = "block";
    expect(evaluatePolicy(policy, { ...base, tool: "refund_payment", amount: 5 }).decision).toBe("deny");
  });

  it("respects the daily autopilot cap", () => {
    const d = evaluatePolicy(defaultPolicy(), { ...base, tool: "create_payment_link", amount: 200, autoApprovedToday: 900 });
    expect(d.decision).toBe("ask");
    expect(d.reasons[0]).toMatch(/autopilot cap/);
  });

  it("drafting an invoice ignores amount limits", () => {
    const d = evaluatePolicy(defaultPolicy(), { ...base, tool: "create_invoice", amount: 99999 });
    expect(d.decision).toBe("allow");
  });

  it("propose-only mode never auto-runs", () => {
    const d = evaluatePolicy(defaultPolicy(), { ...base, tool: "send_reminder", amount: 10, proposeOnly: true });
    expect(d.decision).toBe("ask");
  });
});
