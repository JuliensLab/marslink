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

const MEAN = 50; // weights normalized to this mean (sum = count*MEAN) each step

/** Standard normal via Box–Muller. */
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Clamp to [lo,100], rescale toward a mean of MEAN to strip the overall-scale
 * dimension (which the consumer normalizes away anyway, so it's a wasted degree of
 * freedom for the search), then re-apply the floor so `lo` is honoured exactly.
 */
function normalize(w, lo = 0) {
  let c = w.map((x) => Math.min(100, Math.max(lo, x)));
  const sum = c.reduce((a, b) => a + b, 0);
  if (sum <= 0) return new Array(w.length).fill(Math.max(lo, MEAN));
  const k = (w.length * MEAN) / sum;
  return c.map((x) => Math.min(100, Math.max(lo, x * k)));
}

function perturb(w, sigma, lo = 0) {
  return normalize(w.map((x) => x + gaussian() * sigma), lo);
}

function randomWeights(lo = 0, n = 10) {
  return normalize(Array.from({ length: n }, () => lo + Math.random() * (100 - lo)), lo);
}

/**
 * Maximize `evaluate` over the 10 band weights with batch-parallel SA.
 *
 * @param {object}   o
 * @param {number[]} o.initialWeights      starting weights (length 10)
 * @param {(w:number[])=>Promise<number>} o.evaluate  objective, higher = better
 * @param {(s:object)=>void} [o.onProgress] called after every generation
 * @param {()=>boolean}      [o.shouldStop] return true to halt early
 * The objective is a capacity/latency blend. `evaluate` returns the (already
 * geometry-aggregated) metrics {capacity, latency} for a weight vector; this module
 * scalarizes them with `alpha` (0 = pure capacity, 1 = pure latency) using
 * range-normalization so the blend is unit-agnostic and the slider is balanced.
 * For the pure endpoints no normalization is needed (a monotone rescale doesn't
 * move the argmax), so calibration is skipped — keeping α=0 as fast as before.
 *
 * @param {number[]} o.initialWeights      starting weights (length 10)
 * @param {(w:number[])=>Promise<{capacity:number,latency:number}>} o.evaluate
 * @param {(s:object)=>void} [o.onProgress]
 * @param {()=>boolean}      [o.shouldStop]
 * @param {number} [o.maxEvals=300]  candidate-evaluation budget
 * @param {number} [o.batchSize=8]   candidates per generation
 * @param {number} [o.minValue=0]    per-band floor
 * @param {number} [o.alpha=0]       0 = capacity, 1 = latency, between = blend
 * @param {number} [o.calibrationFrac=0.2] share of the budget spent finding the
 *   capacity/latency ranges (blended modes only) before the ranges are frozen
 * @returns {Promise<{weights:number[], metrics:object, baseline:object, score:number, baselineScore:number, evals:number, alpha:number}>}
 */
export async function solveBandDistribution({
  initialWeights,
  evaluate,
  onProgress = () => {},
  shouldStop = () => false,
  maxEvals = 300,
  batchSize = 8,
  minValue = 0,
  alpha = 0,
  calibrationFrac = 0.2,
}) {
  const lo = Math.min(100, Math.max(0, minValue || 0));
  const a = Math.min(1, Math.max(0, alpha || 0));
  const pure = a <= 0 ? "cap" : a >= 1 ? "lat" : null; // skip normalization at the ends
  const evalAll = (ws) => Promise.all(ws.map((w) => evaluate(w)));
  // The number of weights (= density anchors the optimizer searches) is whatever the
  // caller seeds; everything below is count-agnostic.
  const bandCount = initialWeights && initialWeights.length >= 2 ? initialWeights.length : 10;

  let current = normalize((initialWeights && initialWeights.length === bandCount ? initialWeights : new Array(bandCount).fill(MEAN)).slice(), lo);
  const baseM = await evaluate(current);
  let evals = 1;

  // ── Calibration (blended modes only): sample random layouts to bracket the
  //    achievable capacity/latency ranges, then freeze them so the scalarized
  //    objective is stationary (shifting ranges would break simulated annealing).
  let capMin = baseM.capacity, capMax = baseM.capacity, latMin = baseM.latency, latMax = baseM.latency;
  const observe = (m) => {
    if (!m) return;
    if (isFinite(m.capacity)) { capMin = Math.min(capMin, m.capacity); capMax = Math.max(capMax, m.capacity); }
    if (isFinite(m.latency)) { latMin = Math.min(latMin, m.latency); latMax = Math.max(latMax, m.latency); }
  };
  const samples = [{ w: current.slice(), m: baseM }];
  if (!pure) {
    const nCal = Math.min(maxEvals, Math.max(2 * batchSize, Math.round(maxEvals * calibrationFrac)));
    while (evals < nCal && !shouldStop()) {
      const n = Math.min(batchSize, nCal - evals);
      const ws = [];
      for (let i = 0; i < n; i++) ws.push(randomWeights(lo, bandCount));
      const ms = await evalAll(ws);
      evals += n;
      ws.forEach((w, i) => { observe(ms[i]); samples.push({ w, m: ms[i] }); });
      onProgress({ phase: "calibrating", evals, maxEvals, temperature: 1, metrics: baseM, baseline: baseM, score: 0, baselineScore: 0 });
    }
  }
  const capRange = (capMax - capMin) || 1;
  const latRange = (latMax - latMin) || 1;
  const score = (m) => {
    if (!m) return -Infinity;
    if (pure === "cap") return m.capacity;
    if (pure === "lat") return isFinite(m.latency) ? -m.latency : -Infinity;
    const sc = Math.min(1, Math.max(0, (m.capacity - capMin) / capRange));
    const sl = isFinite(m.latency) ? Math.min(1, Math.max(0, (latMax - m.latency) / latRange)) : 0;
    return (1 - a) * sc + a * sl;
  };

  const baselineScore = score(baseM);
  // Seed the search from the best layout seen so far (baseline or a calibration hit).
  let bestW = current.slice(), bestM = baseM, bestS = baselineScore;
  for (const s of samples) { const sc = score(s.m); if (sc > bestS) { bestS = sc; bestM = s.m; bestW = s.w.slice(); } }
  current = bestW.slice();
  let curS = bestS, curM = bestM;

  onProgress({ phase: "optimizing", evals, maxEvals, temperature: 1, metrics: bestM, baseline: baseM, score: bestS, baselineScore });

  while (evals < maxEvals && !shouldStop()) {
    // Temperature 1 → 0 over the remaining budget: hot = big steps + worse-move /
    // restart acceptance (explore), cold = small greedy steps (refine).
    const T = Math.max(0, 1 - evals / maxEvals);
    const sigma = 3 + 32 * T;

    const n = Math.min(batchSize, maxEvals - evals);
    const ws = [];
    for (let i = 0; i < n; i++) {
      if (i === n - 1 && Math.random() < 0.25 * T) ws.push(randomWeights(lo, bandCount));
      else ws.push(perturb(current, sigma, lo));
    }
    const ms = await evalAll(ws);
    evals += n;

    let bi = 0, biS = score(ms[0]);
    for (let i = 1; i < ms.length; i++) { const s = score(ms[i]); if (s > biS) { biS = s; bi = i; } }
    const candW = ws[bi], candM = ms[bi], candS = biS;

    // Metropolis acceptance, scaled by the objective magnitude so it behaves the
    // same for raw capacity (Mbps), negative latency (s) or the [0,1] blend.
    const accept =
      candS >= curS ||
      (T > 0 && Math.random() < Math.exp((candS - curS) / (Math.max(1e-9, Math.abs(curS) || 1) * 0.05 * T)));
    if (accept) { current = candW; curS = candS; curM = candM; }
    if (candS > bestS) { bestS = candS; bestW = candW.slice(); bestM = candM; }

    onProgress({ phase: "optimizing", evals, maxEvals, temperature: T, metrics: bestM, baseline: baseM, score: bestS, baselineScore });
  }

  return { weights: bestW, metrics: bestM, baseline: baseM, score: bestS, baselineScore, evals, alpha: a };
}
