// Live game-state feed with a polling fallback.
//
// Server-Sent Events give instant updates, but some corporate proxies
// (TLS-inspecting clients such as Netskope/Zscaler) buffer an open-ended
// response until it ends, so the browser never receives a single event.
// connectLive() tries SSE first; if nothing arrives quickly, or the stream
// errors, it switches to polling /state, which returns a complete JSON
// response every time and therefore passes through any proxy.
(function () {
  'use strict';
  var SSE_GRACE_MS = 2500;
  var POLL_MS = 700;

  window.connectLive = function connectLive(onState, opts) {
    opts = opts || {};
    var mode = 'sse';
    var es = null;
    var pollTimer = null;
    var graceTimer = null;

    function apply(state) {
      if (state && typeof state === 'object') onState(state);
    }

    function startPolling(reason) {
      if (mode === 'poll') return;
      mode = 'poll';
      if (es) { try { es.close(); } catch (e) {} es = null; }
      clearTimeout(graceTimer);
      if (opts.onMode) opts.onMode('poll', reason);
      var tick = function () {
        fetch('/state', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(apply)
          .catch(function () {})
          .then(function () { pollTimer = setTimeout(tick, POLL_MS); });
      };
      tick();
    }

    if (typeof EventSource === 'undefined') {
      startPolling('no EventSource');
    } else {
      try {
        es = new EventSource('/events');
        es.onmessage = function (e) {
          clearTimeout(graceTimer);
          try { apply(JSON.parse(e.data)); } catch (err) {}
        };
        es.onerror = function () { startPolling('sse error'); };
        graceTimer = setTimeout(function () { startPolling('sse silent'); }, SSE_GRACE_MS);
      } catch (e) {
        startPolling('sse unavailable');
      }
    }

    return {
      mode: function () { return mode; },
      close: function () {
        clearTimeout(graceTimer);
        clearTimeout(pollTimer);
        if (es) { try { es.close(); } catch (e) {} }
      },
    };
  };
})();
