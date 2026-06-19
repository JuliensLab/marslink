// bandSolver.js — optimizer for the adapted-ring distribution equalizer.
//
// The 10 density-band weights shape where the adapted relay rings sit between
// Earth and Mars. Their effect on the relay's aggregate capacity
// (routeSummary.totalThroughput) is nonlinear and multimodal, and the search
// space (10 continuous weights) is far too large to grid-search. So we run a
// batch-parallel simulated-annealing search: each generation proposes a batch of
// perturbed candidates (evaluated concurrently across the worker pool), greedily
// follows the best, and — while the temperature is high — occasionally accepts a
// worse move or a random restart to escape local optima. Spacing is scale-free
// (the builder normalizes the weights), so we keep candidates at a fixed mean to
// keep the perturbations well-conditioned.
//
// The objective and the parallel evaluation live in the caller: `evaluate` maps a
// weight vector to a Promise of its score (higher = better). This module is pure
// search logic with no DOM or worker knowledge, so it stays testable and ownable.

const NB = 10;
const MEAN = 50; // weights normalized to this mean (sum = NB*MEAN) each step

/** Standard normal via Box–Muller. */
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Clamp every weight to [0,100], then rescale so the mean is MEAN. */
function normalize(w) {
  const c = w.map((x) => Math.min(100, Math.max(0, x)));
  const sum = c.reduce((a, b) => a + b, 0);
  if (sum <= 0) return new Array(NB).fill(MEAN);
  const k = (NB * MEAN) / sum;
  return c.map((x) => Math.min(100, x * k));
}

function perturb(w, sigma) {
  return normalize(w.map((x) => x + gaussian() * sigma));
}

function randomWeights() {
  return normalize(Array.from({ length: NB }, () => Math.random() * 100));
}

/**
 * Maximize `evaluate` over the 10 band weights with batch-parallel SA.
 *
 * @param {object}   o
 * @param {number[]} o.initialWeights      starting weights (length 10)
 * @param {(w:number[])=>Promise<number>} o.evaluate  objective, higher = better
 * @param {(s:object)=>void} [o.onProgress] called after every generation
 * @param {()=>boolean}      [o.shouldStop] return true to halt early
 * @param {number} [o.maxEvals=300]  evaluation budget (incl. the baseline)
 * @param {number} [o.batchSize=8]   candidates proposed & evaluated per generation
 * @returns {Promise<{weights:number[], objective:number, evals:number, baseline:number}>}
 */
export async function solveBandDistribution({
  initialWeights,
  evaluate,
  onProgress = () => {},
  shouldStop = () => false,
  maxEvals = 300,
  batchSize = 8,
}) {
  let current = normalize((initialWeights && initialWeights.length === NB ? initialWeights : new Array(NB).fill(MEAN)).slice());
  let curObj = await evaluate(current);
  let evals = 1;

  const baseline = curObj;
  let best = current.slice();
  let bestObj = curObj;
  let generation = 0;

  onProgress({ best, bestObj, curObj, baseline, evals, maxEvals, generation, temperature: 1 });

  while (evals < maxEvals && !shouldStop()) {
    // Temperature 1 → 0 over the budget. High T = large perturbations + worse-move
    // and restart acceptance (explore); low T = small steps, greedy (refine).
    const T = Math.max(0.0, 1 - evals / maxEvals);
    const sigma = 3 + 32 * T; // weight-units of Gaussian step

    const n = Math.min(batchSize, maxEvals - evals);
    const batch = [];
    for (let i = 0; i < n; i++) {
      // Reserve ~1 slot per generation for a random restart while it's still warm.
      if (i === n - 1 && Math.random() < 0.25 * T) batch.push(randomWeights());
      else batch.push(perturb(current, sigma));
    }

    const objs = await Promise.all(batch.map((w) => evaluate(w)));
    evals += batch.length;

    let bi = 0;
    for (let i = 1; i < objs.length; i++) if (objs[i] > objs[bi]) bi = i;
    const cand = batch[bi], candObj = objs[bi];

    // Metropolis acceptance against the current state, scaled relative to the
    // objective magnitude so it's unit-agnostic (Mbps today, anything tomorrow).
    const accept =
      candObj >= curObj ||
      (T > 0 && Math.random() < Math.exp((candObj - curObj) / (Math.max(1e-9, Math.abs(curObj)) * 0.05 * T)));
    if (accept) { current = cand; curObj = candObj; }
    if (candObj > bestObj) { best = cand.slice(); bestObj = candObj; }

    generation++;
    onProgress({ best, bestObj, curObj, baseline, evals, maxEvals, generation, temperature: T });
  }

  return { weights: best, objective: bestObj, evals, baseline };
}
