"use client";

import ReactMarkdown from "react-markdown";
import { memo } from "react";

/**
 * Markdown renderer for chat bubbles.
 * The agent speaks markdown (**bold**, `code`, lists, tables) — this renders it
 * cleanly inside bubbles while keeping plain-text messages pixel-identical.
 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Fast path: no markdown syntax at all → render as plain text (zero overhead)
  if (!/[*_`~#\n-]|```/.test(text)) {
    return <span className="whitespace-pre-wrap break-words">{text}</span>;
  }

  return (
    <div className="chat-markdown break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        components={{
          // Compact styling tuned for chat bubbles (globals.css carries the rest)
          p: ({ children }) => <p className="my-0 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children }) => (
            <code className="rounded bg-black/10 dark:bg-white/15 px-1 py-0.5 font-mono text-[0.85em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-1.5 overflow-x-auto rounded-lg bg-black/10 dark:bg-white/10 p-2.5 text-[0.82em] leading-snug">
              {children}
            </pre>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {children}
            </a>
          ),
          h1: ({ children }) => <p className="my-1 font-semibold">{children}</p>,
          h2: ({ children }) => <p className="my-1 font-semibold">{children}</p>,
          h3: ({ children }) => <p className="my-1 font-semibold">{children}</p>,
          table: ({ children }) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="text-[0.85em]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border-b px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
          blockquote: ({ children }) => (
            <blockquote className="my-1 border-l-2 border-current/30 pl-2 opacity-90">{children}</blockquote>
          ),
          hr: () => <hr className="my-2 opacity-30" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
