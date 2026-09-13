/** ✓ / ✗ / — 표시. 색과 문자로 이중 표기(접근성). */
export function Checkmark({ ok, size = "md" }: { ok: boolean | undefined | null; size?: "md" | "lg" }) {
  const dim = size === "lg" ? "h-9 w-9 text-xl" : "h-7 w-7 text-base";
  if (ok === undefined || ok === null) {
    return (
      <span className={`inline-flex ${dim} items-center justify-center rounded-full bg-line text-muted`} aria-label="확인 안 함">
        —
      </span>
    );
  }
  return ok ? (
    <span className={`inline-flex ${dim} items-center justify-center rounded-full bg-pass-soft font-bold text-pass`} aria-label="통과">
      ✓
    </span>
  ) : (
    <span className={`inline-flex ${dim} items-center justify-center rounded-full bg-fail-soft font-bold text-fail`} aria-label="실패">
      ✗
    </span>
  );
}
