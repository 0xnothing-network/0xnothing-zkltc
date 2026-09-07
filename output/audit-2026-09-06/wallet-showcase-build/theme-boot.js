(() => {
  try {
    const theme = localStorage.getItem("0xn.wallet.theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  } catch {
    // Persistent settings remain authoritative; this mirror only avoids a flash.
  }
})();
