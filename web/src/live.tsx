import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Channel = "invoices" | "approvals" | "audit";
interface Toast {
  id: number;
  tone: "success" | "info" | "warning";
  title: string;
  body?: string;
}

interface LiveState {
  versions: Record<Channel, number>;
  toasts: Toast[];
  bump: (c: Channel) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

const LiveContext = createContext<LiveState | null>(null);
let toastSeq = 0;

/** Subscribes to server events once and fans them out as per-channel version counters. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [versions, setVersions] = useState<Record<Channel, number>>({ invoices: 0, approvals: 0, audit: 0 });
  const [toasts, setToasts] = useState<Toast[]>([]);

  const bump = (c: Channel) => setVersions((v) => ({ ...v, [c]: v[c] + 1 }));
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const toast = (t: Omit<Toast, "id">) => {
    const id = ++toastSeq;
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), 6000);
  };

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      if (e.type === "invoices_changed") bump("invoices");
      if (e.type === "approvals_changed") bump("approvals");
      if (e.type === "audit_changed") bump("audit");
      if (e.type === "toast") toast(e);
    };
    return () => es.close();
  }, []);

  return <LiveContext.Provider value={{ versions, toasts, bump, toast, dismiss }}>{children}</LiveContext.Provider>;
}

export function useLive() {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive outside LiveProvider");
  return ctx;
}

export function Toasts() {
  const { toasts, dismiss } = useLive();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast-${t.tone}`} onClick={() => dismiss(t.id)}>
          <strong>{t.title}</strong>
          {t.body && <span>{t.body}</span>}
        </button>
      ))}
    </div>
  );
}
