// bandSolver.js — optimizer for the adapted-ring distribution equalizer.
//
// The 10 density-band weights shape where the adapted relay rings sit between
// Earth and Mars. Their effect on the relay's aggregate capacity
// (routeSummary.totalThroughput) is nonlinear and multimodal, and the search
// space (10 continuous weights) is far too large to grid-search. So we run a
// batch-parallel simulated-annealing search: each generation proposes a batch of
// perturbed candidates (evaluated concurrently across the worker pool), greedily
// follows the best, and — while the temperature is high — occasionally accepts a
// worse move or a random restart to escape local optima. Each proposal jitters
// either every free input at once or, with `singleCoord`, one randomly-chosen input
// per step (Gibbs-style). Spacing is scale-free
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
 * Clamp each weight to [lo,100]. The search vector may concatenate several curves
 * (ring density + Earth↔Mars blend curves); the blend values are absolute
 * percentages, so we must NOT rescale toward a shared mean (that would couple the
 * curves). The density is scale-free anyway, so a plain clamp serves both.
 */
function normalize(w, lo = 0) {
  return w.map((x) => Math.min(100, Math.max(lo, isFinite(x) ? x : MEAN)));
}

function perturb(w, sigma, lo = 0) {
  return normalize(w.map((x) => x + gaussian() * sigma), lo);
}

/** Single-coordinate proposal: jitter exactly one randomly-chosen weight PER segment,
 *  leaving the rest untouched. A Gibbs-style move — each changed input is accepted/
 *  rejected on its own merit, often better-conditioned than perturbing everything.
 *  `segs` (index ranges) makes one move touch one value per chart, so multi-chart runs
 *  explore every chart each step; default = the whole vector as a single segment (one
 *  value total). */
function perturbOne(w, sigma, lo = 0, segs = null) {
  const out = w.slice();
  const ranges = segs && segs.length ? segs : [{ start: 0, length: w.length }];
  for (const seg of ranges) {
    if (!(seg.length > 0)) continue;
    const i = seg.start + ((Math.random() * seg.length) | 0);
    out[i] += gaussian() * sigma;
  }
  return normalize(out, lo);
}

/** Perturb every weight within the given segments (charts), leaving the rest fixed —
 *  the "all dims" move restricted to one or more charts. */
function perturbAll(w, sigma, lo, segs) {
  const out = w.slice();
  for (const seg of segs) for (let k = 0; k < (seg.length || 0); k++) out[seg.start + k] += gaussian() * sigma;
  return normalize(out, lo);
}

/** "Same x" proposal: pick ONE control-point index (x), shared across charts, and jitter
 *  that point on every chart that has it free (independent jitter per chart). Uses each
 *  segment's `free` x-index list to align the same x across differently-shaped curves;
 *  falls back to positions when `free` is absent. */
function perturbSameX(w, sigma, lo, segs) {
  const out = w.slice();
  const xsOf = (seg) => seg.free || Array.from({ length: seg.length || 0 }, (_, i) => i);
  const xs = new Set();
  for (const seg of segs) for (const x of xsOf(seg)) xs.add(x);
  const xList = [...xs];
  if (!xList.length) return normalize(out, lo);
  const x = xList[(Math.random() * xList.length) | 0];
  for (const seg of segs) {
    const pos = xsOf(seg).indexOf(x);
    if (pos >= 0) out[seg.start + pos] += gaussian() * sigma;
  }
  return normalize(out, lo);
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
 * @param {string[]} [o.moveModes=["all"]] allowed proposal scopes — ONE is picked at
 *   random each generation: "all" (all charts, all values), "all-1chart" (one random
 *   chart, all its values), "single-1chart" (one random chart, one of its values), or
 *   "samex" (one shared control-point x jittered on every chart). The mode (and the
 *   chart for the "1 chart" modes) is chosen once per generation.
 * @param {number} [o.stepScale=1] multiplier on the per-step Gaussian perturbation
 *   size — below 1 = smaller, smoother proposals; above 1 = bolder jumps
 * @param {Array<{start:number,length:number}>} [o.segments] index ranges of each chart's
 *   free values; in singleCoord mode one value is jittered per segment (per chart)
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
  moveModes = ["all"],
  onBatch = () => {},
  stepScale = 1,
  segments = null,
}) {
  const lo = Math.min(100, Math.max(0, minValue || 0));
  const a = Math.min(1, Math.max(0, alpha || 0));
  const sScale = stepScale > 0 ? stepScale : 1; // scales the proposed per-step move size
  const pure = a <= 0 ? "cap" : a >= 1 ? "lat" : null; // skip normalization at the ends
  const evalAll = (ws) => Promise.all(ws.map((w) => evaluate(w)));
  // The number of weights (= density anchors the optimizer searches) is whatever the
  // caller seeds; everything below is count-agnostic.
  const bandCount = initialWeights && initialWeights.length >= 2 ? initialWeights.length : 10;
  // Index ranges of each chart's free values in the concatenated vector. In singleCoord
  // mode the proposal jitters one value PER segment (per chart), so multi-chart runs move
  // every chart each step; default = the whole vector as a single segment (one value total).
  const segs = segments && segments.length ? segments : [{ start: 0, length: bandCount }];

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
      onBatch(ws);
      const ms = await evalAll(ws);
      evals += n;
      ws.forEach((w, i) => { observe(ms[i]); samples.push({ w, m: ms[i] }); });
      onProgress({ phase: "calibrating", evals, maxEvals, temperature: 1, metrics: baseM, baseline: baseM, score: 0, baselineScore: 0, currentWeights: current.slice() });
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

  onProgress({ phase: "optimizing", evals, maxEvals, temperature: 1, metrics: bestM, baseline: baseM, score: bestS, baselineScore, currentWeights: current.slice(), bestWeights: bestW.slice() });

  while (evals < maxEvals && !shouldStop()) {
    // Temperature 1 → 0 over the remaining budget: hot = big steps + worse-move /
    // restart acceptance (explore), cold = small greedy steps (refine). stepScale
    // shrinks/grows the whole step so proposals can be made smoother or bolder.
    const T = Math.max(0, 1 - evals / maxEvals);
    const sigma = (3 + 32 * T) * sScale;

    const n = Math.min(batchSize, maxEvals - evals);
    // Pick ONE allowed move type at random for this whole generation (so the batch is
    // coherent). Mode → which charts a proposal touches and how many values per chart;
    // for the "1 chart" modes also pick one random chart, shared across the batch.
    const mode = moveModes[(Math.random() * moveModes.length) | 0] || "all";
    const oneChart = mode === "all-1chart" || mode === "single-1chart";
    const allDims = mode === "all" || mode === "all-1chart";
    const sameX = mode === "samex";
    const genSegs = oneChart ? [segs[(Math.random() * segs.length) | 0]] : segs;
    const ws = [];
    for (let i = 0; i < n; i++) {
      if (i === n - 1 && Math.random() < 0.25 * T) ws.push(randomWeights(lo, bandCount));
      else if (sameX) ws.push(perturbSameX(current, sigma, lo, segs));
      else if (allDims) ws.push(oneChart ? perturbAll(current, sigma, lo, genSegs) : perturb(current, sigma, lo));
      else ws.push(perturbOne(current, sigma, lo, genSegs));
    }
    onBatch(ws);
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

    onProgress({ phase: "optimizing", evals, maxEvals, temperature: T, metrics: bestM, baseline: baseM, score: bestS, baselineScore, currentWeights: current.slice(), bestWeights: bestW.slice() });
  }

  return { weights: bestW, metrics: bestM, baseline: baseM, score: bestS, baselineScore, evals, alpha: a };
}
