"use client";

/**
 * Keypad — WhatsApp-lock-style circular numeric keypad.
 * Big 62px touch targets, haptic tick per key, press-scale feedback.
 * Used for the everyday MPIN unlock (way faster + more native than
 * the OS keyboard) and works everywhere (no special APIs needed).
 */
import { Delete } from "lucide-react";

interface KeypadProps {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  disabled?: boolean;
  /** Optional footer slot (e.g. "Forgot MPIN?") aligned under the grid. */
  footer?: React.ReactNode;
}

export function haptic(ms = 8) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate?.(ms);
    }
  } catch { /* unsupported — fine */ }
}

const SUBS: Record<string, string> = {
  "1": "",
  "2": "ABC",
  "3": "DEF",
  "4": "GHI",
  "5": "JKL",
  "6": "MNO",
  "7": "PQRS",
  "8": "TUV",
  "9": "WXYZ",
  "0": "+",
};

export default function Keypad({ onDigit, onBackspace, disabled, footer }: KeypadProps) {
  const key = (label: string) => (
    <button
      type="button"
      className="kp-key"
      disabled={disabled}
      onClick={() => {
        haptic();
        onDigit(label);
      }}
      aria-label={label}
    >
      <span className="flex flex-col items-center leading-none">
        {label}
        <span className="kp-sub">{SUBS[label] ?? "\u00A0"}</span>
      </span>
    </button>
  );

  return (
    <div className="w-full">
      <div className="kp-grid">
        {key("1")}
        {key("2")}
        {key("3")}
        {key("4")}
        {key("5")}
        {key("6")}
        {key("7")}
        {key("8")}
        {key("9")}
        <div className="kp-key kp-key-blank" aria-hidden />
        {key("0")}
        <button
          type="button"
          className="kp-key"
          disabled={disabled}
          onClick={() => {
            haptic(12);
            onBackspace();
          }}
          aria-label="Backspace"
        >
          <Delete className="w-6 h-6" strokeWidth={1.8} />
        </button>
      </div>
      {footer && <div className="mt-6 text-center">{footer}</div>}
    </div>
  );
}
