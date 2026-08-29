"use client";

import { useState } from "react";
import { Loader2, ArrowLeft, ShieldCheck } from "lucide-react";

export default function DashboardLogin() {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      if (res.ok) location.reload();
      else {
        const j = await res.json();
        setErr(j.error ?? "Login failed");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm anim-fade-up">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent text-accent-foreground mb-3">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1.5">
            Your full financial picture — sign in to continue
          </p>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5 ml-1">Username</label>
            <input
              name="username"
              value={u}
              onChange={(e) => setU(e.target.value)}
              autoComplete="username"
              className="w-full h-11 rounded-xl border border-input bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-shadow"
              placeholder="e.g. rahul"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5 ml-1">Password</label>
            <input
              name="password"
              type="password"
              value={p}
              onChange={(e) => setP(e.target.value)}
              autoComplete="current-password"
              className="w-full h-11 rounded-xl border border-input bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-shadow"
              placeholder="••••••••"
            />
          </div>
          {err && (
            <p className="text-destructive text-sm bg-destructive/10 border border-destructive/20 rounded-xl px-3.5 py-2.5 anim-pop-in">
              {err}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="press w-full h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 hover:opacity-95 transition-opacity"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Sign in
          </button>
        </form>
        <a
          href="/"
          className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mt-5 transition-colors"
        >
          <ArrowLeft className="w-3 h-3" /> back to daily app
        </a>
      </div>
    </div>
  );
}
