import { useEffect, useState } from "react";
import { Bot, Hand, Radio, ShieldCheck, Sun, Wrench } from "lucide-react";
import { api, type AuditEntry } from "../api";
import { toolLabel } from "../components";
import { useLive } from "../live";

const SOURCE_LABEL: Record<AuditEntry["source"], string> = {
  agent: "Tally (chat)",
  briefing: "Tally (briefing)",
  human: "You",
  webhook: "PayPal webhook",
  mcp: "External agent",
};

const KIND_ICON = {
  tool: Wrench,
  policy: ShieldCheck,
  approval: Hand,
  webhook: Radio,
  system: Sun,
};

type Filter = "all" | "money" | "decisions" | "paypal";

export function ActivityLog() {
  const { versions } = useLive();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    api.get<AuditEntry[]>("/api/audit").then(setEntries).catch(() => {});
  }, [versions.audit]);

  const shown = entries.filter((e) =>
    filter === "all" ? true : filter === "money" ? e.kind === "tool" : filter === "decisions" ? e.kind === "policy" || e.kind === "approval" : e.kind === "webhook",
  );

  return (
    <div className="page">
      <header className="page-head">
        <h1>Activity</h1>
        <p>Everything Tally, you and PayPal did, newest first. Each guardrail decision is recorded with its reasons.</p>
      </header>
      <div className="tabs" role="tablist">
        {(
          [
            ["all", "Everything"],
            ["money", "Actions taken"],
            ["decisions", "Guardrail decisions"],
            ["paypal", "PayPal events"],
          ] as [Filter, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="muted">Nothing here yet. Actions show up as soon as Tally or you do something.</p>
      ) : (
        <ol className="log">
          {shown.map((e) => {
            const Icon = e.source === "agent" || e.source === "briefing" ? Bot : KIND_ICON[e.kind];
            const reasons = (e.detail as { reasons?: string[]; reason?: string } | undefined) ?? {};
            return (
              <li key={e.id} className={`log-${e.kind} ${e.ok === false ? "log-fail" : ""} ${e.decision ? `log-${e.decision}` : ""}`}>
                <span className="log-icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
                <div>
                  <p>{e.summary}</p>
                  {e.kind === "policy" && (reasons.reasons?.length || reasons.reason) && (
                    <p className="log-why">
                      {reasons.reason && <>Tally’s reason: {reasons.reason}. </>}
                      {reasons.reasons?.join(" ")}
                    </p>
                  )}
                  <small>
                    {SOURCE_LABEL[e.source]}
                    {e.tool ? `, ${toolLabel(e.tool).toLowerCase()}` : ""}, {new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </small>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
