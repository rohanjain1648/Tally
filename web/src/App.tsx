import { useEffect, useState } from "react";
import { Activity, Camera, FileText, MessageSquare, ShieldCheck, Sun } from "lucide-react";
import { api, type Approval, type Status } from "./api";
import { TallyMark } from "./components";
import { Toasts, useLive } from "./live";
import { Today } from "./pages/Today";
import { Capture } from "./pages/Capture";
import { Agent } from "./pages/Agent";
import { Invoices } from "./pages/Invoices";
import { Guardrails } from "./pages/Guardrails";
import { ActivityLog } from "./pages/Activity";

const ROUTES = [
  { id: "today", label: "Today", icon: Sun },
  { id: "capture", label: "Capture", icon: Camera },
  { id: "agent", label: "Ask Tally", icon: MessageSquare },
  { id: "invoices", label: "Invoices", icon: FileText },
  { id: "guardrails", label: "Guardrails", icon: ShieldCheck },
  { id: "activity", label: "Activity", icon: Activity },
] as const;
export type RouteId = (typeof ROUTES)[number]["id"];

const parseHash = (): { route: RouteId; param?: string } => {
  const [route, param] = location.hash.replace(/^#\/?/, "").split("/");
  return { route: (ROUTES.some((r) => r.id === route) ? route : "today") as RouteId, param: param ? decodeURIComponent(param) : undefined };
};
export const navigate = (route: RouteId, param?: string) => {
  location.hash = `/${route}${param ? `/${encodeURIComponent(param)}` : ""}`;
};

export function App() {
  const [{ route, param }, setLoc] = useState(parseHash);
  const [status, setStatus] = useState<Status | null>(null);
  const [pending, setPending] = useState(0);
  const { versions } = useLive();

  useEffect(() => {
    const onHash = () => setLoc(parseHash());
    window.addEventListener("hashchange", onHash);
    api.get<Status>("/api/status").then(setStatus).catch(() => setStatus(null));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api.get<Approval[]>("/api/approvals").then((a) => setPending(a.length)).catch(() => {});
  }, [versions.approvals]);

  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [route]);

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav className="side" aria-label="Main">
        <div className="brand">
          <TallyMark />
          <div>
            <strong>Tally</strong>
            <span>{status?.businessName ?? "Your business"}</span>
          </div>
        </div>
        <ul>
          {ROUTES.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <a href={`#/${id}`} aria-current={route === id ? "page" : undefined}>
                <Icon size={18} aria-hidden="true" />
                <span>{label}</span>
                {id === "today" && pending > 0 && (
                  <em className="count" aria-label={`${pending} waiting for approval`}>
                    {pending}
                  </em>
                )}
              </a>
            </li>
          ))}
        </ul>
        {status && (
          <div className="env">
            <span className={`dot ${status.paypalMode === "sandbox" ? "dot-live" : "dot-sim"}`} />
            {status.paypalMode === "sandbox" ? "PayPal sandbox" : "PayPal simulator"}
            <br />
            <span className={`dot ${status.aiReady ? "dot-live" : "dot-off"}`} />
            {status.aiReady ? "Groq connected" : "Groq not connected"}
          </div>
        )}
      </nav>

      <main id="main" tabIndex={-1}>
        {status && !status.aiReady && (
          <div className="banner">
            Groq isn’t connected, so Capture, Ask Tally and the briefing are switched off. Add <code>GROQ_API_KEY</code> to{" "}
            <code>.env</code> and restart.
          </div>
        )}
        {route === "today" && <Today />}
        {route === "capture" && <Capture />}
        {route === "agent" && <Agent conversationId={param} />}
        {route === "invoices" && <Invoices status={status} />}
        {route === "guardrails" && <Guardrails />}
        {route === "activity" && <ActivityLog />}
      </main>
      <Toasts />
    </div>
  );
}
