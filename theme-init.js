(() => {
  try {
    const saved = localStorage.getItem('ytm-lite-color-scheme');
    if (saved === 'light' || saved === 'dark') {
      const meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) {
        meta.content = saved;
      }
    }
  } catch {
    // Ignore storage access errors; default to system preference
  }
})();
