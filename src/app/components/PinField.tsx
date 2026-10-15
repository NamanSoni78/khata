"use client";

import { useEffect, useRef } from "react";

/**
 * PinField — WhatsApp/banking-style PIN & OTP entry.
 * Renders N boxes (dots for secrets, digits for OTP) over one real input,
 * so the native numeric keyboard works on every phone.
 * v4: filled composer-style boxes, display-font digits, breathing active box.
 */
interface PinFieldProps {
  length: number;
  value: string;
  onChange: (v: string) => void;
  /** true = show dots (MPIN), false = show digits (OTP) */
  secret?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  inputMode?: "numeric" | "text";
  autoComplete?: string;
  onComplete?: (v: string) => void;
  /** applies error shake styling to the boxes */
  error?: boolean;
}

export default function PinField({
  length,
  value,
  onChange,
  secret = true,
  autoFocus = false,
  disabled = false,
  inputMode = "numeric",
  autoComplete = "one-time-code",
  onComplete,
  error = false,
}: PinFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const digits = value.slice(0, length);
  const activeIdx = digits.length;

  useEffect(() => {
    if (autoFocus) {
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);

  return (
    <div
      className={`relative select-none ${error ? "anim-shake" : ""}`}
      onClick={() => !disabled && inputRef.current?.focus()}
      role="group"
      aria-label={`${length} digit code`}
    >
      <div className="flex justify-center gap-2">
        {Array.from({ length }).map((_, i) => {
          const d = digits[i];
          const filled = d !== undefined;
          const isActive = i === activeIdx && !disabled;
          return (
            <div
              key={i}
              className={`w-[46px] rounded-2xl border-[1.5px] flex items-center justify-center text-[22px] font-semibold font-display tnum transition-all duration-150 ${
                error
                  ? "border-destructive/70 bg-destructive/5"
                  : filled
                    ? "border-transparent bg-[var(--field)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.04)]"
                    : isActive
                      ? "border-[var(--primary)] bg-card scale-[1.05] shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--primary)_16%,transparent)]"
                      : "border-transparent bg-[var(--field)]"
              }`}
              style={{ height: "54px" }}
            >
              {filled ? (
                secret ? (
                  <span
                    className="w-[11px] h-[11px] rounded-full bg-foreground anim-pop-in"
                    key={d + i}
                  />
                ) : (
                  <span className="tnum">{d}</span>
                )
              ) : isActive ? (
                <span className="w-[11px] h-[11px] rounded-full border-2 border-[var(--primary)]/60 anim-breathe" />
              ) : (
                <span className="w-[11px] h-[11px]" />
              )}
            </div>
          );
        })}
      </div>
      <input
        ref={inputRef}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCorrect="off"
        autoCapitalize="none"
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, length);
          onChange(v);
          if (v.length === length) onComplete?.(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Backspace" && value.length > 0 && e.currentTarget.value === "") {
            onChange(value.slice(0, -1));
          }
        }}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}
