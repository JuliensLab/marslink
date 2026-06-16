// sensitivityPool.js — a pool of simWorker.js workers for parallel sensitivity sweeps.
//
// Each scenario in a sweep is independent (a distinct ring/tech/date point), so we
// fan them out across a pool of module workers. Each worker runs the full scenario
// pipeline (ring-sizing feedback loop + flow + latency) via the "computeScenario"
// message and posts back "scenario-result". The pool throttles to one in-flight job
// per worker and drains a queue as workers free up.

export class SensitivityPool {
  /**
   * @param {number} [size] worker count; defaults to hardwareConcurrency-1, capped at
   *   the logical core count (the UI clamps user input to the same max).
   */
  constructor(size) {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    this.size = Math.max(1, Math.min(size || cores - 1, cores));
    this.queue = [];
    this.pending = new Map(); // requestId -> entry
    this.idCounter = 0;
    this.stopped = false;
    this.workers = [];
    // Fired whenever a worker starts or finishes a job, so the UI can show live
    // utilization: ({ active, size, queued, pending }) => void
    this.onActivity = null;
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(new URL("./simWorker.js?v=4.6", import.meta.url), { type: "module" });
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
    this.onActivity({ active, size: this.size, queued: this.queue.length, pending: this.pending.size });
  }

  _onMessage(slot, msg) {
    if (!msg || (msg.type !== "scenario-result" && msg.type !== "scenario-error")) return;
    slot.busy = false;
    const entry = this.pending.get(msg.requestId);
    if (entry) {
      this.pending.delete(msg.requestId);
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
   */
  submit(job) {
    return new Promise((resolve, reject) => {
      if (this.stopped) { resolve(null); return; }
      const requestId = ++this.idCounter;
      this.queue.push({ requestId, job, resolve, reject, slot: null });
      this._pump();
    });
  }

  _pump() {
    if (this.stopped) return;
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const next = this.queue.shift();
      if (!next) break;
      slot.busy = true;
      next.slot = slot;
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
    for (const slot of this.workers) {
      try { slot.worker.terminate(); } catch {}
    }
    this.workers = [];
    this.pending.clear();
  }
}
