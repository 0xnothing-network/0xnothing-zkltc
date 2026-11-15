(() => {
  try {
    const theme = localStorage.getItem("0xn.wallet.theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    } else if (theme === "system") {
      // Same rule as src/ui/lib/theme.ts: follow the operating system's choice.
      const light = window.matchMedia("(prefers-color-scheme: light)").matches;
      document.documentElement.dataset.theme = light ? "light" : "dark";
    }
  } catch {
    // Persistent settings remain authoritative; this mirror only avoids a flash.
  }
})();
