(() => {
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    if (typeof input !== "string") return originalFetch(input, init);

    const url = new URL(input, window.location.href);
    if (url.origin === window.location.origin) {
      if (url.pathname === "/api/staging/status") {
        url.pathname = "/admin-data/status";
      } else if (url.pathname.startsWith("/api/admin/")) {
        url.pathname = `/admin-data/${url.pathname.slice("/api/admin/".length)}`;
      }
    }

    return originalFetch(url.href, init);
  };
})();
