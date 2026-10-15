/**
 * Curated catalog of common LLM providers + models.
 *
 * Used by the admin panel's per-agent config cards to render "preset" chip
 * buttons. Clicking a preset fills in provider + baseUrl + model + sensible
 * defaults (maxTokens, maxTokensMode, toolCallingSupported). API key is left
 * untouched — admin enters it separately.
 *
 * Keep this list curated: ~8-10 entries that cover 95% of admin needs.
 * Add new entries when popular new models ship.
 */

export interface ModelPreset {
  /** Short label rendered on the chip (≤24 chars) */
  label: string;
  /** Longer description shown in the title tooltip */
  description: string;
  provider: "openai-compatible" | "anthropic";
  baseUrl: string;
  model: string;
  /** Recommended max_tokens for chat completions */
  maxTokens: number;
  /** Reasoning models (o1/o3) need max_completion_tokens instead of max_tokens */
  maxTokensMode: "max_tokens" | "max_completion_tokens";
  /** Most modern providers support native function-calling. Set false for Gemma etc. */
  toolCallingSupported: boolean;
  /** Recommended temperature */
  temperature: number;
  /** Optional note shown beneath the chips row */
  note?: string;
  /** Cost badge color hint */
  cost: "free" | "cheap" | "moderate" | "premium";
}

/**
 * General-purpose presets — for daily + dashboard + STT agents.
 */
export const GENERAL_PRESETS: ModelPreset[] = [
  {
    label: "Groq llama-3.3-70b",
    description: "Free tier (rate-limited). Excellent reasoning + native tool-calling. Best default for production agents.",
    provider: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: true,
    temperature: 0.5,
    cost: "free",
  },
  {
    label: "Groq llama-3.1-8b",
    description: "Free tier, ultra-fast (~150 tokens/sec). Use for STT-classification or low-latency daily chat.",
    provider: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.1-8b-instant",
    maxTokens: 2000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: true,
    temperature: 0.4,
    cost: "free",
  },
  {
    label: "OpenAI gpt-4o",
    description: "Paid, best reasoning + multimodal (vision-capable for OCR). Best for dashboard deep-dive + mindmap agentic edits.",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: true,
    temperature: 0.4,
    cost: "premium",
  },
  {
    label: "OpenAI gpt-4o-mini",
    description: "Paid, cheap (~30x cheaper than gpt-4o), still vision-capable. Good balance for daily chat.",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    maxTokens: 2000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: true,
    temperature: 0.5,
    cost: "cheap",
  },
  {
    label: "OpenAI o3-mini",
    description: "Paid, reasoning model. Use max_completion_tokens (not max_tokens). Slower but stronger multi-step reasoning for complex multi-leg txns.",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "o3-mini",
    maxTokens: 8000,
    maxTokensMode: "max_completion_tokens",
    toolCallingSupported: true,
    temperature: 0.6,
    cost: "moderate",
  },
  {
    label: "Anthropic Sonnet",
    description: "Paid, Claude 3.5 Sonnet. Strong reasoning + native tool-calling + vision-capable (for OCR).",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-20241022",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: true,
    temperature: 0.4,
    cost: "premium",
  },
  {
    label: "Anthropic Haiku",
    description: "Paid, Claude 3.5 Haiku — cheaper than Sonnet, fast, good for daily chat.",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-haiku-20241022",
    maxTokens: 2000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: true,
    temperature: 0.5,
    cost: "cheap",
  },
  {
    label: "DeepSeek V3",
    description: "Paid, very cheap, strong reasoning + tool-calling. Hosted in China — verify data residency.",
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: true,
    temperature: 0.4,
    cost: "cheap",
  },
  {
    label: "Gemma 3 27B (Groq)",
    description: "Free tier. NO native tool-calling — uses the built-in JSON fallback mode. Strong multilingual (Hinglish) understanding. Turn 'tool calling' OFF for this model.",
    provider: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "gemma-3-27b-it",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: false, // Gemma has no native function-calling → JSON fallback
    temperature: 0.5,
    cost: "free",
  },
  {
    label: "OpenRouter Gemini 2.5 Flash",
    description: "Paid via OpenRouter. Google Gemini 2.5 Flash — multimodal (vision-capable for OCR), fast, cheap.",
    provider: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-2.5-flash-preview",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: true,
    temperature: 0.4,
    cost: "cheap",
  },
];

/**
 * OCR-specific presets — must be vision-capable.
 * Excludes: text-only models (DeepSeek, Gemma, all llama-3.x — none support vision).
 */
export const OCR_PRESETS: ModelPreset[] = [
  {
    label: "OpenAI gpt-4o",
    description: "Best vision-capable default. Handles messy handwritten receipts + dense bank statements.",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: false, // OCR uses chatCompleteVision — not chat tool-calling
    temperature: 0.2, // low temp for deterministic extraction
    cost: "premium",
  },
  {
    label: "OpenAI gpt-4o-mini",
    description: "Cheaper alternative. Slightly less accurate on handwriting but fine for clean printed statements.",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    maxTokens: 2000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: false,
    temperature: 0.2,
    cost: "cheap",
  },
  {
    label: "Anthropic Sonnet",
    description: "Claude 3.5 Sonnet — strong on dense bank statements with mixed layouts.",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-20241022",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: false,
    temperature: 0.2,
    cost: "premium",
  },
  {
    label: "OpenRouter Gemini 2.5 Flash",
    description: "Cheapest vision-capable option via OpenRouter. Strong on Indian-language receipts (Hindi/Hinglish OCR).",
    provider: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-2.5-flash-preview",
    maxTokens: 4000,
    maxTokensMode: "max_tokens",
    toolCallingSupported: false,
    temperature: 0.2,
    cost: "cheap",
  },
];

/**
 * Apply a preset to the current agent config, preserving user-set fields
 * (apiKey, systemPrompt) where the preset doesn't override.
 */
export function applyPreset<T extends {
  provider: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  maxTokensMode: string;
  toolCallingSupported: boolean;
  temperature: number;
}>(current: T, preset: ModelPreset): T {
  return {
    ...current,
    provider: preset.provider as T["provider"],
    baseUrl: preset.baseUrl,
    model: preset.model,
    maxTokens: preset.maxTokens,
    maxTokensMode: preset.maxTokensMode as T["maxTokensMode"],
    toolCallingSupported: preset.toolCallingSupported,
    temperature: preset.temperature,
    // apiKey + systemPrompt preserved
  };
}

/** Cost chip color tokens (light-theme friendly) */
export const COST_STYLES: Record<ModelPreset["cost"], string> = {
  free: "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
  cheap: "border-teal-300 bg-teal-50 text-teal-700 hover:bg-teal-100",
  moderate: "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100",
  premium: "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100",
};
