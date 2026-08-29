"use client";

import { useState } from "react";
import { toast } from "sonner";
import { startRegistration } from "@simplewebauthn/browser";
import { ArrowLeft, Fingerprint, Plus, Trash2, Loader2 } from "lucide-react";

interface Props {
  username: string;
  passkeys: Array<{
    id: string;
    deviceType: string;
    createdAt: string;
    credentialIdShort: string;
  }>;
}

export default function SettingsApp({ username, passkeys: initialPasskeys }: Props) {
  const [passkeys, setPasskeys] = useState(initialPasskeys);
  const [registering, setRegistering] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Passkey registration uses the DAILY session (fingerprint prompt requires the
  // app page context), so we open the daily app for the user to complete it there.
  const register = async () => {
    setRegistering(true);
    try {
      toast.info("Opening the daily app to add your passkey…");
      window.open("/", "_blank");
    } finally {
      setRegistering(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this passkey? You'll need your MPIN or another passkey to log in next time.")) return;
    setDeletingId(id);
    try {
      const res = await fetch("/api/auth/webauthn/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: id }),
      });
      if (res.ok) {
        toast.success("Passkey removed");
        setPasskeys((p) => p.filter((pk) => pk.id !== id));
      } else {
        const e = await res.json();
        toast.error(e.error ?? "Couldn't remove passkey");
      }
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-4 py-3 sticky top-0 bg-background/90 backdrop-blur-sm z-10 safe-top">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <a
            href="/dashboard"
            className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            title="Back to dashboard"
          >
            <ArrowLeft className="w-5 h-5" />
          </a>
          <div>
            <p className="font-semibold text-sm text-foreground">Settings</p>
            <p className="text-[11px] text-muted-foreground">{username}</p>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div className="bg-card border border-border rounded-2xl anim-fade-up">
          <div className="px-5 pt-5 pb-3">
            <h2 className="font-semibold text-sm text-foreground flex items-center gap-2">
              <Fingerprint className="w-4 h-4 text-primary" /> Passkeys
            </h2>
            <p className="text-xs text-muted-foreground mt-1.5">
              Use fingerprint, Face ID, or a hardware key to unlock the daily app without typing your MPIN.
              New passkeys are added from the daily app (open it, then tap Settings → Passkeys → Add).
            </p>
          </div>
          <div className="px-5 pb-5 space-y-2">
            {passkeys.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3">No passkeys registered yet.</p>
            ) : (
              <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
                {passkeys.map((pk) => (
                  <div
                    key={pk.id}
                    className="flex items-center justify-between p-3.5 bg-muted/30"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">{pk.deviceType}</p>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">
                        {pk.credentialIdShort} · added {new Date(pk.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      </p>
                    </div>
                    <button
                      onClick={() => remove(pk.id)}
                      disabled={deletingId === pk.id}
                      className="press h-9 w-9 rounded-xl flex items-center justify-center text-destructive/80 hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                      title="Remove passkey"
                    >
                      {deletingId === pk.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={register}
              disabled={registering}
              className="press h-10 px-4 rounded-xl border border-input text-sm font-medium text-foreground flex items-center gap-2 hover:bg-accent/50 transition-colors disabled:opacity-60"
            >
              {registering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add a passkey
            </button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground/70 text-center">
          Appearance and notifications can be changed from the daily app and dashboard headers.
        </p>
      </main>
    </div>
  );
}
