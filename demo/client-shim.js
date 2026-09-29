// Runs inside each demo iframe before the app: sends /api/* requests and
// live streams to the in-browser backend in the parent page. Everything else
// (map routing, OCR model download) still goes to the real network.
(function () {
  const server = window.parent.sehatServer;
  const realFetch = window.fetch.bind(window);

  window.fetch = function (input, opts) {
    const url = typeof input === 'string' ? input : input.url;
    return url.startsWith('/api/') ? server.fetch(url, opts) : realFetch(input, opts);
  };

  window.EventSource = class DemoEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      setTimeout(() => {
        this.onopen?.();
        this.unsubscribe = server.stream(url, (event, data) => {
          for (const fn of this.listeners[event] || []) fn({ data });
        }, () => this.onerror?.());
      }, 0);
    }
    addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); }
    close() { this.unsubscribe?.(); }
  };
})();
