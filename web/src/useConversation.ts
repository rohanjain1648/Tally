import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ConversationView, type ViewItem } from "./api";

type ToolState = Extract<ViewItem, { kind: "tool" }>["state"];

/**
 * Loads a conversation and follows its live event stream: text and reasoning deltas stream in,
 * tool calls update in place, and the stored view is refetched whenever a turn settles.
 */
export function useConversation(id: string | undefined) {
  const [view, setView] = useState<ConversationView | null>(null);
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [toolStates, setToolStates] = useState<Record<string, { state: ToolState; approvalId?: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const reloadTimer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const v = await api.get<ConversationView>(`/api/conversations/${id}`);
      setView(v);
      setLiveText("");
      setLiveThinking("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(reload, 120);
  }, [reload]);

  useEffect(() => {
    setView(null);
    setToolStates({});
    if (!id) return;
    void reload();
    const es = new EventSource(`/api/conversations/${id}/stream`);
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      switch (e.type) {
        case "text":
          setLiveText((t) => t + e.delta);
          break;
        case "thinking":
          setLiveThinking((t) => t + e.delta);
          break;
        case "tool_call":
          setToolStates((s) => ({ ...s, [e.id]: { state: "running" } }));
          scheduleReload();
          break;
        case "tool_result":
          setToolStates((s) => ({ ...s, [e.id]: { state: e.state, approvalId: e.approvalId } }));
          break;
        case "status":
          setView((v) => (v ? { ...v, status: e.status } : v));
          if (e.status !== "running") scheduleReload();
          break;
        case "error":
          setError(e.message);
          break;
        case "turn_end":
          scheduleReload();
          break;
      }
    };
    return () => {
      es.close();
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    };
  }, [id, reload, scheduleReload]);

  // Safety net: if the stream connected late and missed the end of a turn, polling catches up.
  const running = view?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(async () => {
      if (!id) return;
      const v = await api.get<ConversationView>(`/api/conversations/${id}`).catch(() => null);
      if (v && v.status !== "running") void reload();
    }, 4000);
    return () => window.clearInterval(t);
  }, [running, id, reload]);

  // Overlay live tool states onto the stored view (stored results arrive only when a round finishes).
  const items: ViewItem[] = (view?.items ?? []).map((it) =>
    it.kind === "tool" && toolStates[it.id] && (it.state === "running" || it.state === "pending")
      ? { ...it, state: toolStates[it.id].state, approvalId: toolStates[it.id].approvalId ?? it.approvalId }
      : it,
  );

  return { view, items, liveText, liveThinking, error, reload, setView };
}
