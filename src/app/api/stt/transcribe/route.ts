import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { resolveSttConfig } from "@/lib/user-config";
import { resolveSttUrl } from "@/lib/llm/client";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/stt/transcribe  (multipart/form-data: audio=<blob>, lang?)
 *
 * Server-side proxy for OpenAI-compatible speech-to-text. The API key never
 * reaches the browser — the client records audio (MediaRecorder) and posts it
 * here; we forward it to the effective STT endpoint (user override > admin
 * default) with the resolved /audio/transcriptions URL.
 */
export async function POST(req: NextRequest) {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { engine, config } = await resolveSttConfig(user.id);
  if (engine !== "openai-compatible") {
    return NextResponse.json(
      { error: "Voice is set to the device's built-in engine — no server transcription needed." },
      { status: 400 }
    );
  }
  if (!config.baseUrl) {
    return NextResponse.json({ error: "Speech-to-text isn't configured. Ask the admin or set your own in dashboard settings." }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart audio upload" }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "No audio received" }, { status: 400 });
  }
  if (audio.size > 24 * 1024 * 1024) {
    return NextResponse.json({ error: "Recording too long — keep it under a couple of minutes." }, { status: 413 });
  }

  // Build the upstream request
  const upstream = new FormData();
  const ext = (audio.type.split("/")[1] || "webm").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "webm";
  upstream.append("file", audio, `speech.${ext}`);
  if (config.model) upstream.append("model", config.model);
  const lang = form.get("lang");
  if (typeof lang === "string" && lang) upstream.append("language", lang);
  if (typeof lang === "string" && lang) upstream.append("prompt", "Hinglish mix of Hindi and English, Indian context");

  const headers: Record<string, string> = {};
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  // extraHeaders (JSON string or object)
  try {
    const raw = (config as any).extraHeaders;
    if (raw) {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") headers[k] = v;
        }
      }
    }
  } catch { /* ignore bad extraHeaders */ }

  const url = resolveSttUrl(config.baseUrl);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: upstream,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[stt] upstream error:", res.status, text.slice(0, 300));
      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({ error: "Speech-to-text rejected the API key." }, { status: 502 });
      }
      return NextResponse.json({ error: "Speech-to-text failed — try again or use the keyboard." }, { status: 502 });
    }
    const json = await res.json().catch(() => ({}));
    const text = typeof json.text === "string" ? json.text.trim() : "";
    return NextResponse.json({ text });
  } catch (e) {
    console.error("[stt] fetch error:", e);
    return NextResponse.json({ error: "Could not reach the speech-to-text service." }, { status: 502 });
  }
}
