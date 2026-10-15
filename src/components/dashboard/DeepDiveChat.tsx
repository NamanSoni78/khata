"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { Loader2, Send, Sparkles } from "lucide-react";
import { InlineChartReveal, type ChartSpec } from "@/components/charts/InlineChart";
import Markdown from "@/components/chat/Markdown";

interface ChatMsg {
  id: number;
  role: "user" | "assistant";
  text: string;
  chartSpec?: ChartSpec | null;
}

let msgId = 0;

/**
 * Dashboard AI deep-dive chat.
 * - Posts to /api/dashboard/deep-dive
 * - Renders assistant reply text first
 * - If the agent included a [CHART:{...}] marker, renders a "Show as chart"
 *   reveal button (text first, then chart offer).
 */
export default function DeepDiveChat() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const send = async (preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text || loading) return;
    setInput("");
    const next: ChatMsg[] = [...messages, { id: ++msgId, role: "user", text }];
    setMessages(next);
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/deep-dive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMessages([
          ...next,
          { id: ++msgId, role: "assistant", text: j.error ?? "The assistant couldn't respond. Please try again." },
        ]);
        return;
      }
      setMessages([
        ...next,
        {
          id: ++msgId,
          role: "assistant",
          text: j.reply || "Done.",
          chartSpec: j.chartSpec ?? null,
        },
      ]);
    } catch (e: any) {
      toast.error(e?.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const SUGGESTIONS = [
    "Break down my expenses this month by category",
    "Income vs expense trend over the last 3 months",
    "How much money did I send to friends in the last 3 months?",
    "Create a mindmap of my investment accounts",
  ];

  return (
    <div className="bg-card border border-border rounded-2xl">
      <div className="px-5 pt-5 pb-3 flex items-start gap-2.5">
        <span className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
          <Sparkles className="w-4 h-4" />
        </span>
        <div>
          <h2 className="font-semibold text-sm text-foreground">Analysis agent</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Analytical questions about your money — real numbers, charts offered when useful. Understands IPO, SIP, FD, demat and 50+ terms.
          </p>
          <p className="text-[11px] text-muted-foreground/80 mt-1">
            This conversation is separate from your everyday app chat — export both anytime from “Export chat history”.
          </p>
        </div>
      </div>
      <div className="px-5 pb-5 space-y-3">
        <div
          ref={scrollRef}
          className="border border-border rounded-xl p-3.5 max-h-[420px] overflow-y-auto space-y-2.5 bg-muted/30"
        >
          {messages.length === 0 && (
            <div className="space-y-2 py-2">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className={`press w-full text-left text-xs text-muted-foreground bg-card border border-border rounded-xl px-3.5 py-2.5 hover:border-ring/60 hover:text-foreground transition-colors anim-fade-up-d${Math.min(i + 1, 3)}`}
                >
                  &ldquo;{s}&rdquo;
                </button>
              ))}
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} anim-msg-in`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-[var(--primary-deep)] text-white rounded-br-md"
                    : "bg-primary/[0.06] dark:bg-primary/[0.12] border border-primary/15 dark:border-primary/20 text-foreground rounded-bl-md"
                }`}
              >
                <Markdown text={m.text} />
                {m.chartSpec && <InlineChartReveal spec={m.chartSpec} />}
              </div>
            </div>
          ))}
          {loading && (
            <div className="text-xs text-muted-foreground flex items-center gap-2 py-1">
              <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
              <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
              <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
            </div>
          )}
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1 rounded-2xl bg-background border border-border focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/30 transition-all">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything about your finances…"
              className="w-full resize-none bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/75 focus:outline-none min-h-[44px] max-h-[120px]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </div>
          <button
            onClick={() => send()}
            disabled={loading || !input.trim()}
            className="press shrink-0 w-11 h-11 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-95 transition-opacity"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
