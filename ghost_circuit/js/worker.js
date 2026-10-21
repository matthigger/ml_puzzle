// Web worker: Python (Pyodide) runs here, so a slow or endless estimator
// never freezes the page; Stop terminates this worker and starts a new one.
//
// Messages in:  { id, cmd, args }, cmd one of load / run / replay /
//               results / notebook / unzip
// Messages out: { id, result } (a JSON string from py/runner.py, or text),
//               { id, error }, { id, progress: [done, n, right, off] },
//               { ready: true } once Python is up, { fatal } if it failed.

// a module worker (see shared/py.js): pyodide.mjs is the supported way in
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

// "?v=<build>" on the worker's URL, passed on so a new build's Python files
// aren't served from the browser cache
const version = self.location.search;

let py, runner;

async function init() {
  py = await loadPyodide({ indexURL: PYODIDE });
  // the circuits are numpy arrays
  await py.loadPackage("numpy");
  for (const f of ["ghost_circuit.py", "runner.py"]) {
    const resp = await fetch(new URL("../py/" + f + version, self.location));
    if (!resp.ok) throw new Error(`could not fetch ${f}: ${resp.status}`);
    py.FS.writeFile("/home/pyodide/" + f, await resp.text());
  }
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
  runner = py.pyimport("runner");
}

const ready = init().then(
  () => postMessage({ ready: true }),
  err => { postMessage({ fatal: String(err) }); throw err; });

// one command at a time: a load awaits package downloads, and a second
// message mustn't start meanwhile
let queue = Promise.resolve();
onmessage = e => { queue = queue.then(() => handle(e.data)); };

async function handle({ id, cmd, args }) {
  try {
    await ready;
    let result;
    const progress = (...p) => postMessage({ id, progress: p });
    if (cmd === "notebook") {
      result = runner.notebook_source(args.text);
    } else if (cmd === "unzip") {
      result = runner.unzip(args.bytes);
    } else if (cmd === "load") {
      // scikit-learn, scipy, pandas, ...: fetched the first time they're
      // used
      const all = [args.source, ...Object.values(args.helpers)].join("\n");
      await py.loadPackagesFromImports(all);
      result = runner.load(args.source, JSON.stringify(args.helpers));
    } else if (cmd === "run") {
      result = runner.run(args.name, JSON.stringify(args.setup), progress,
                          args.every || 10);
    } else if (cmd === "replay") {
      result = runner.replay(args.name, JSON.stringify(args.setup), args.idx);
    } else if (cmd === "results") {
      result = runner.results(args.name, JSON.stringify(args.setup),
                              args.run, progress, args.every || 10);
    } else {
      throw new Error("unknown command " + cmd);
    }
    postMessage({ id, result });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
}
