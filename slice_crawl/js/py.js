// Py: the page's handle on the Python worker (js/worker.js).
//
//   Py.call(cmd, args, onProgress) -> Promise of the parsed result
//   Py.stop()                      kill the worker (and whatever it was
//                                  running), start a fresh one
//   Py.onStatus = fn(state, text)  state: starting / ready / failed
//
// After a stop the new worker has none of the student's code loaded; the
// page reloads it before the next run.

const Py = (function () {
  let worker, nextId = 1;
  const pending = new Map();
  const api = { onStatus: () => {}, ready: false };

  function start() {
    api.ready = false;
    api.onStatus("starting", "Starting Python...");
    const v = typeof BUILD !== "undefined" && BUILD ? BUILD.sha : Date.now();
    worker = new Worker("js/worker.js?v=" + v, { type: "module" });
    worker.onmessage = e => {
      const m = e.data;
      if (m.ready) {
        api.ready = true;
        api.onStatus("ready", "Python ready");
        return;
      }
      if (m.fatal) {
        api.onStatus("failed", "Python failed to start");
        for (const p of pending.values()) p.reject(new Error(m.fatal));
        pending.clear();
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      if (m.progress) { if (p.onProgress) p.onProgress(...m.progress); return; }
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(p.raw ? m.result : JSON.parse(m.result));
    };
    worker.onerror = e => {
      api.onStatus("failed", "Python failed to start");
      console.error(e);
    };
  }

  api.call = function (cmd, args, onProgress, raw = false) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress, raw });
      worker.postMessage({ id, cmd, args });
    });
  };

  api.stop = function () {
    worker.terminate();
    for (const p of pending.values()) p.reject(new Error("stopped"));
    pending.clear();
    start();
  };

  api.start = start;
  return api;
})();
