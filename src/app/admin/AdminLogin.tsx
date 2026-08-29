"use client";

import { useState } from "react";
import { Loader2, TerminalSquare } from "lucide-react";

export default function AdminLogin() {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      if (res.ok) location.reload();
      else {
        const j = await res.json();
        setErr(j.error ?? "Invalid credentials");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-4">
      <div className="w-full max-w-sm anim-fade-up">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent text-accent-foreground mb-3">
            <TerminalSquare className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
          <p className="text-muted-foreground text-sm mt-1.5">
            Restricted — sign in with your admin credentials
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
              placeholder="admin username"
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
        <p className="text-[11px] text-muted-foreground/70 text-center mt-5">
          Credentials come from the <code className="bg-muted px-1 py-0.5 rounded">ADMIN_USERNAME</code> /{" "}
          <code className="bg-muted px-1 py-0.5 rounded">ADMIN_PASSWORD</code> environment variables.
        </p>
      </div>
    </div>
  );
}
