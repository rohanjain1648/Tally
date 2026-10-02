import { useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, Plus, X } from "lucide-react";
import { api, readFile, timeAgo, type ConversationView, type FilePayload } from "../api";
import { useLive } from "../live";
import { Thread } from "../Thread";
import { useConversation } from "../useConversation";
import { navigate } from "../App";

interface ConvSummary {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

const STARTERS = [
  "Who owes me money right now?",
  "Chase everyone who’s overdue, nicely.",
  "Invoice Bloom Studio $1,400 for phase 2 product pages, net 30.",
  "Sam asked for $80 back on his portrait session. Refund it.",
  "Set up a $300/month retainer for Acme Coffee Roasters.",
  "Make me a $150 deposit link for a logo consultation.",
];

export function Agent({ conversationId }: { conversationId?: string }) {
  const { toast } = useLive();
  const [list, setList] = useState<ConvSummary[]>([]);
  const [text, setText] = useState(() => {
    const prefill = sessionStorage.getItem("tally:prefill") ?? "";
    sessionStorage.removeItem("tally:prefill");
    return prefill;
  });
  const [file, setFile] = useState<FilePayload | null>(null);
  const [sending, setSending] = useState(false);
  const conv = useConversation(conversationId);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = () => api.get<ConvSummary[]>("/api/conversations").then(setList).catch(() => {});
  useEffect(() => {
    void loadList();
  }, [conversationId, conv.view?.status]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conv.items.length, conv.liveText.length > 0, conv.view?.status]);

  async function send(message = text) {
    if ((!message.trim() && !file) || sending) return;
    setSending(true);
    try {
      let id = conversationId;
      if (!id) {
        id = (await api.post<ConversationView>("/api/conversations")).id;
        navigate("agent", id);
      }
      await api.post(`/api/conversations/${id}/messages`, {
        text: message,
        file: file ? { mediaType: file.mediaType, base64: file.base64 } : undefined,
      });
      setText("");
      setFile(null);
      if (id === conversationId) await conv.reload();
    } catch (e) {
      toast({ tone: "warning", title: "Message not sent", body: (e as Error).message });
    } finally {
      setSending(false);
    }
  }

  const status = conv.view?.status;
  const busy = status === "running";
  const blocked = status === "awaiting_approval";
  const empty = !conversationId || (conv.view && conv.items.length === 0);

  return (
    <div className="agent">
      <aside className="convs" aria-label="Conversations">
        <button className="btn btn-quiet btn-wide" onClick={() => navigate("agent")}>
          <Plus size={16} /> New conversation
        </button>
        <ul>
          {list.map((c) => (
            <li key={c.id}>
              <a href={`#/agent/${c.id}`} aria-current={c.id === conversationId ? "page" : undefined}>
                <span>{c.title}</span>
                <small>{c.status === "awaiting_approval" ? "Waiting for you" : timeAgo(c.updatedAt)}</small>
              </a>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat" aria-label="Ask Tally">
        <div className="chat-scroll">
          {empty ? (
            <div className="starters">
              <h1>What needs doing?</h1>
              <p>
                Tally can look things up, bill clients, chase payments, issue refunds and set up retainers in your PayPal account. Anything
                outside your guardrails comes back to you as a slip to approve.
              </p>
              <div className="starter-list">
                {STARTERS.map((s) => (
                  <button key={s} className="chip chip-lg" onClick={() => void send(s)} disabled={sending}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Thread items={conv.items} liveText={conv.liveText} liveThinking={conv.liveThinking} running={busy} />
          )}
          {conv.view?.status === "error" && conv.view.error && <p className="error-text">Something went wrong: {conv.view.error}</p>}
          {conv.error && <p className="error-text">{conv.error}</p>}
          <div ref={endRef} />
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {blocked && <p className="composer-note">Tally is waiting for your decision on the slip above.</p>}
          {file && (
            <span className="attach-chip">
              <Paperclip size={14} /> {file.name}
              <button type="button" aria-label="Remove attachment" onClick={() => setFile(null)}>
                <X size={14} />
              </button>
            </span>
          )}
          <div className="composer-row">
            <button type="button" className="icon-btn" aria-label="Attach a photo" onClick={() => fileRef.current?.click()} disabled={busy || blocked}>
              <Paperclip size={18} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setFile(await readFile(f).catch(() => null));
                e.target.value = "";
              }}
            />
            <textarea
              rows={1}
              value={text}
              placeholder={blocked ? "Approve or reject the slip first" : "Ask Tally to bill, chase, refund or look something up…"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={busy || blocked}
              aria-label="Message"
            />
            <button className="send" type="submit" disabled={busy || blocked || sending || (!text.trim() && !file)} aria-label="Send">
              <ArrowUp size={18} />
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
