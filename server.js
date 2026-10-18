/* ============================================================
   Presentable short-link display
   Intercepts every time the generated link is set, and
   replaces it with a short /p/abc123 URL.
============================================================ */
(function () {
  window.addEventListener('load', () => {
    const input = document.getElementById('generatedLink');
    if (!input) return;

    const originalSet = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    ).set;

    const orig = input.value;
    input.value = orig;

    Object.defineProperty(input, 'value', {
      get() { return this.getAttribute('data-display') || ''; },
      set(v) {
        const longUrl = String(v || '');
        if (!longUrl) {
          this.setAttribute('data-display', '');
          return;
        }
        if (longUrl.length <= 60 || longUrl.startsWith('/p/')) {
          this.setAttribute('data-display', longUrl);
          return;
        }
        fetch('/api/shorten', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: longUrl })
        })
          .then(r => r.json())
          .then(d => {
            this.setAttribute('data-display', d.shortUrl || longUrl);
          })
          .catch(() => {
            this.setAttribute('data-display', longUrl);
          });
      },
      configurable: true
    });
  });
})();

