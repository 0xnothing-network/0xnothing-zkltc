/**
 * A polite status line for screen readers. A copy button only swaps its
 * icon, which a screen reader does not report, so the result is said here.
 * One hidden region for the whole page, created on first use; it is emptied
 * first so the same words said twice are read twice.
 */
let region: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function announce(message: string): void {
  if (typeof document === "undefined" || document.body === null) return;
  if (region === null || !region.isConnected) {
    region = document.createElement("div");
    region.className = "w-sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  const target = region;
  target.textContent = "";
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    target.textContent = message;
  }, 50);
}
