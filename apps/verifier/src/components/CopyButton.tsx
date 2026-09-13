"use client";

import { useState } from "react";
import { RESULT } from "@/lib/copy";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost min-h-9 px-3 text-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* 클립보드 권한 없음 — 무시 */
        }
      }}
      aria-label={label ?? RESULT.copy}
    >
      {done ? RESULT.copied : (label ?? RESULT.copy)}
    </button>
  );
}
