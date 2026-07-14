// sensitivityPool.js — a pool of simWorker.js workers for parallel sensitivity sweeps.
//
// Each scenario in a sweep is independent (a distinct ring/tech/date point), so we
// fan them out across a pool of module workers. Each worker runs the full scenario
// pipeline (ring-sizing feedback loop + flow + latency) via the "computeScenario"
// message and posts back "scenario-result". The pool throttles to one in-flight job
// per worker and drains a queue as workers free up.

export class SensitivityPool {
  /**
   * @param {number} [size] worker count; defaults to ~half the logical cores
   *   (saturating all cores starves the renderer), capped at the logical core
   *   count (the UI clamps user input to the same max).
   * @param {object} [opts]
   * @param {number} [opts.memBudgetMB] cumulative estimated worker-heap budget. All
   *   workers share ONE ~4GB V8 pointer-compression cage with the main thread
   *   (Chrome M92+), so their heap is additive; exceeding it crashes the renderer
   *   ("Aw, Snap! Out of Memory"). We admit jobs only while the sum of their
   *   estimated heap stays under this budget. Defaults to ~60% of the cage,
   *   leaving headroom for the main thread, result deserialization, GC lag, and
   *   per-scenario estimate error.
   * @param {number} [opts.memBudgetPct=60] budget as a percentage of the heap cage,
   *   used when memBudgetMB is not given.
   */
  constructor(size, opts = {}) {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    this.size = Math.max(1, Math.min(size || Math.floor(cores / 2), cores));
    const heapLimitMB = (typeof performance !== "undefined" && performance.memory)
      ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : 4096;
    // Budget as a fraction of the shared heap cage (default 60%); memBudgetMB, if
    // given, overrides with an absolute cap.
    const frac = opts.memBudgetPct > 0 ? Math.min(100, opts.memBudgetPct) / 100 : 0.6;
    this.memBudgetMB = opts.memBudgetMB || Math.floor(heapLimitMB * frac);
    this.inFlightMB = 0;
    this.queue = [];
    this.pending = new Map(); // requestId -> entry
    this.idCounter = 0;
    this.stopped = false;
    this.workers = [];
    // Fired whenever a worker starts or finishes a job, so the UI can show live
    // utilization: ({ active, size, queued, pending, inFlightMB, memBudgetMB }) => void
    this.onActivity = null;
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(new URL("./simWorker.js?v=4.38", import.meta.url), { type: "module" });
      const slot = { worker, busy: false };
      worker.onmessage = (e) => this._onMessage(slot, e.data);
      worker.onerror = (e) => this._onWorkerError(slot, e);
      this.workers.push(slot);
    }
  }

  _emit() {
    if (!this.onActivity) return;
    let active = 0;
    for (const slot of this.workers) if (slot.busy) active++;
    this.onActivity({ active, size: this.size, queued: this.queue.length, pending: this.pending.size, inFlightMB: Math.round(this.inFlightMB), memBudgetMB: this.memBudgetMB });
  }

  _release(entry) {
    this.inFlightMB -= entry.estMB || 0;
    if (this.inFlightMB < 0) this.inFlightMB = 0;
  }

  _onMessage(slot, msg) {
    if (!msg || (msg.type !== "scenario-result" && msg.type !== "scenario-error")) return;
    slot.busy = false;
    const entry = this.pending.get(msg.requestId);
    if (entry) {
      this.pending.delete(msg.requestId);
      this._release(entry);
      if (msg.type === "scenario-error") entry.reject(new Error(msg.message || "scenario failed"));
      else entry.resolve(msg);
    }
    this._emit();
    this._pump();
  }

  _onWorkerError(slot, e) {
    slot.busy = false;
    // Fail whichever job this slot was running, then keep the pool going.
    for (const [id, entry] of this.pending) {
      if (entry.slot === slot) {
        this.pending.delete(id);
        this._release(entry);
        entry.reject(new Error(e && e.message ? e.message : "worker error"));
        break;
      }
    }
    this._pump();
  }

  /**
   * Submit one scenario job. Resolves with the worker's scenario-result message,
   * or with null if the pool was stopped before this job started.
   * @param {object} job { uiConfig, simDate, scenarioId, flowCalctimeMs?, maxIterations? }
   * @param {number} [estMB] estimated peak worker heap for this scenario (for the
   *   cumulative memory budget); 0 means "doesn't count against the budget".
   */
  submit(job, estMB = 0) {
    return new Promise((resolve, reject) => {
      if (this.stopped) { resolve(null); return; }
      const requestId = ++this.idCounter;
      this.queue.push({ requestId, job, estMB, resolve, reject, slot: null });
      this._pump();
    });
  }

  _pump() {
    if (this.stopped) return;
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const next = this.queue[0];
      if (!next) break;
      // Memory admission: don't start a job that would push estimated cumulative
      // worker heap past the budget — unless nothing is running, so a single
      // oversized scenario can't deadlock the queue.
      const est = next.estMB || 0;
      if (this.inFlightMB > 0 && this.inFlightMB + est > this.memBudgetMB) break;
      this.queue.shift();
      slot.busy = true;
      next.slot = slot;
      this.inFlightMB += est;
      this.pending.set(next.requestId, next);
      slot.worker.postMessage({ type: "computeScenario", requestId: next.requestId, ...next.job });
    }
    this._emit();
  }

  /** Soft stop: drop queued (not-yet-started) jobs; let in-flight jobs finish. */
  stop() {
    this.stopped = true;
    for (const entry of this.queue) entry.resolve(null);
    this.queue = [];
  }

  /** Hard stop: terminate all workers immediately and release them. */
  terminate() {
    this.stopped = true;
    this.queue = [];
    this.inFlightMB = 0;
    for (const slot of this.workers) {
      try { slot.worker.terminate(); } catch {}
    }
    this.workers = [];
    this.pending.clear();
  }
}
