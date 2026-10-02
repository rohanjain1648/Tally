import { useEffect, useState } from "react";
import { AlertTriangle, Check, CircleSlash, Clock, ImageIcon, Loader2 } from "lucide-react";
import { api, type Approval, type ViewItem } from "./api";
import { ApprovalSlip, Markdown, toolLabel } from "./components";
import { useLive } from "./live";

const STATE_ICON = {
  running: <Loader2 size={15} className="spin" aria-label="Running" />,
  done: <Check size={15} aria-label="Done" />,
  error: <AlertTriangle size={15} aria-label="Error" />,
  pending: <Clock size={15} aria-label="Waiting for approval" />,
  denied: <CircleSlash size={15} aria-label="Not done" />,
};

/** A one-line, human description of a tool call's arguments. */
function describeInput(name: string, input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "list_invoices") return [i.status && String(i.status).toLowerCase(), i.client && `for ${i.client}`].filter(Boolean).join(" ");
  if (name === "get_invoice" || name === "send_invoice" || name === "send_reminder" || name === "cancel_invoice") return String(i.invoice_id ?? "");
  if (name === "list_transactions") return i.days ? `last ${i.days} days` : "";
  if (name === "create_invoice") return `${i.recipient_name ?? ""}`;
  if (name === "refund_payment") return `${i.payment_id ?? ""}`;
  if (name === "create_payment_link") return `${i.description ?? ""}`;
  if (name === "create_retainer") return `${i.client_name ?? ""}`;
  return "";
}

function ToolRow({ item, approval }: { item: Extract<ViewItem, { kind: "tool" }>; approval?: Approval }) {
  const [open, setOpen] = useState(false);
  if (approval && (item.state === "pending" || approval.status !== "pending")) {
    return (
      <div className="thread-slip">
        <ApprovalSlip approval={approval} compact />
      </div>
    );
  }
  return (
    <div className={`toolrow toolrow-${item.state}`}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {STATE_ICON[item.state]}
        <span>{toolLabel(item.name)}</span>
        <small>{describeInput(item.name, item.input)}</small>
      </button>
      {open && <pre>{JSON.stringify({ input: item.input, result: item.result }, null, 2)}</pre>}
    </div>
  );
}

export function Thread({
  items,
  liveText,
  liveThinking,
  running,
}: {
  items: ViewItem[];
  liveText: string;
  liveThinking: string;
  running: boolean;
}) {
  const { versions } = useLive();
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const approvalIds = items.flatMap((i) => (i.kind === "tool" && i.approvalId ? [i.approvalId] : [])).join(",");

  useEffect(() => {
    if (!approvalIds) return;
    api
      .get<Approval[]>("/api/approvals?status=all")
      .then((list) => setApprovals(Object.fromEntries(list.map((a) => [a.id, a]))))
      .catch(() => {});
  }, [approvalIds, versions.approvals]);

  return (
    <div className="thread">
      {items.map((item, i) => {
        if (item.kind === "user")
          return (
            <div key={i} className="msg msg-user">
              {item.images > 0 && (
                <span className="attach">
                  <ImageIcon size={14} /> attachment
                </span>
              )}
              {item.text}
            </div>
          );
        if (item.kind === "assistant")
          return (
            <div key={i} className="msg msg-agent">
              <Markdown text={item.text} />
            </div>
          );
        if (item.kind === "thinking")
          return (
            <details key={i} className="thinking">
              <summary>How Tally reasoned</summary>
              <Markdown text={item.text} />
            </details>
          );
        return <ToolRow key={item.id} item={item} approval={item.approvalId ? approvals[item.approvalId] : undefined} />;
      })}
      {liveThinking && !liveText && (
        <div className="thinking thinking-live">
          <Loader2 size={14} className="spin" /> {liveThinking.split("\n").filter(Boolean).at(-1)?.slice(0, 160)}
        </div>
      )}
      {liveText && (
        <div className="msg msg-agent">
          <Markdown text={liveText} />
        </div>
      )}
      {running && !liveText && !liveThinking && (
        <div className="typing" aria-label="Tally is working">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
