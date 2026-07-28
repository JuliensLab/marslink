// paperPlan.js — the paper's measurement plan: every simulation the figures and
// tables of the AA paper need, as data the "Measure all" runner executes in
// sequence through the LIVE (sliders) path. One plan item = one measurement SET
// in the archive (baseline config stored once, per-scenario entries store only
// the swept deltas + sized values + metrics).
//
// Derived from doc 7 ("Marslink - Julien 7/8"): Fig 5 (concentric scaling,
// §8.4), Fig 6 (optimized placement, §8.5), Fig 9 (transfer S² series, §9.4),
// Fig 12 (capacity vs total sats + breakevens, §13), Fig 13 (geometry/date
// invariance, §13/G2), Fig 14 (coverage Monte-Carlo, §13), Table 1 (transfer
// scenarios at 10 Gbps), Table 2 (goal summary), §10 junction window law
// (B2 recalibration). Tables 3–5 and Fig 15 are analytic (cost model on the
// measured laws) — no runs needed.
//
// Item shape the runner interprets:
//   id, title, feeds     — provenance (feeds names the figure/table served)
//   family               — "Contoured concentric" | "Contoured transfer"
//   sliders              — RAW slider values / radio labels applied before the
//                          run (the clean baseline; laser tech 7 = ×128 pow2)
//   sens.ringSegs        — ring-axis segments run sequentially into one set
//   sens.rate            — second axis {mode:"inring"|"total", start,end,step}
//   sens.placement       — "current" | {dateRangeDays, samples}
//   sens.flow            — false | {budgetSec}
//   manual + note        — listed but not runnable by the runner (yet)
//   estMin               — rough serial live-mode duration, for the panel

// Bump when the plan's items, baselines, or semantics change — recorded into
// every measurement set's `run` block so a dataset names the plan that made it.
// v3: execution mode is chosen in the panel (LIVE sliders by default — the
// correctness guarantee: every measurement drives the real sliders and the
// live sim, monitorable in the 3D view); geometry grids run live by stepping
// the main-UI placement sliders per cell.
export const PLAN_VERSION = 3;

// REPRODUCIBILITY CONTRACT: before each item the runner pins EVERY
// build-affecting input — all ~120 sliders to their slidersData defaults and
// the five adapted-ring curves to their default profiles — then applies the
// item's family and the overrides below. So each input a set records is either
// (a) a slidersData default (the documented design choice), (b) a BASE/item
// override listed here with its reason, or (c) a per-scenario value derived by
// the sizing pipeline and recorded in the entry's `sized` block. Nothing is
// inherited from whatever the live UI happened to hold.
//
// Shared overrides, each with its reason — DATA, not comments, so the plan
// overview in the UI can show the why next to the what.
export const BASE_DOC = [
  { key: "laser_technology.improvement-factor", value: 7, shown: "×128 (2^7)",
    why: "The paper's reference laser-technology factor — every quoted capacity is at ×128 and rescales linearly (§7)." },
  { key: "relay_type.planet_sizing", value: "auto", shown: "auto",
    why: "Planet rings must be sized BY the measured relay capacity (§11's sizing rule), not left at manual rates." },
  { key: "simulation.planet-placement", value: "Date", shown: "Date",
    why: "Real ephemeris placement; the grid/date items sweep placement explicitly." },
  { key: "ring_earth.side-extension-degrees-slider", value: 180, shown: "180°",
    why: "Full 360° planetary rings: §11 requires full rings so every relay route can attach around the circumference." },
  { key: "ring_mars.side-extension-degrees-slider", value: 180, shown: "180°",
    why: "Same as the Earth ring — full circumference." },
  { key: "adapted_rings.flow-solver", value: "push-relabel", shown: "push-relabel",
    why: "The only max-flow solver that works for contoured concentric (topology-aware is broken there); one solver across the whole plan keeps flow numbers comparable." },
  { key: "adapted_eccentric_rings.flow-solver", value: "push-relabel", shown: "push-relabel",
    why: "Same solver for the transfer family — comparability." },
  { key: "adapted_rings.auto_route_count", value: "yes", shown: "auto",
    why: "The concentric scaling law is measured on the auto-route ridge (§8.4); the sweet-spot item overrides this to sweep route count manually." },
  { key: "adapted_eccentric_rings.junction-ring-mode", value: "auto", shown: "auto",
    why: "Junction rings grow empirically until each ring's two-route demand is met (§10)." },
];
const BASE = Object.fromEntries(BASE_DOC.map((d) => [d.key, d.value]));

// Everything NOT listed in BASE_DOC or an item's own overrides is pinned to its
// slidersData default by the runner — the documented design choice.

export const PAPER_PLAN = [
  {
    id: "conc-sweetspot",
    title: "Concentric sweet spot — route count vs theory optimum",
    feeds: "Eqs (6)–(8) validation: T(N) peaks at N_opt ≈ 15.8·R and the peak matches the closed form — the justification for measuring the scaling law ON the auto-route ridge",
    family: "Contoured concentric",
    sliders: { ...BASE, "adapted_rings.auto_route_count": "no" },
    sens: {
      // Per-segment route sweeps bracket each ring count's predicted optimum
      // (N_opt ≈ 15.8·R): the peak's LOCATION tests Eq (7), its VALUE Eq (8).
      ringSegs: [
        { start: 4, end: 4, step: 1, route: { start: 20, end: 120, step: 20 } },
        { start: 10, end: 10, step: 1, route: { start: 60, end: 280, step: 40 } },
        { start: 20, end: 20, step: 1, route: { start: 120, end: 560, step: 80 } },
        { start: 30, end: 30, step: 1, route: { start: 180, end: 840, step: 120 } },
        { start: 40, end: 40, step: 1, route: { start: 240, end: 1120, step: 160 } },
      ],
      rate: null,
      placement: "current",
      flow: false,
    },
    estMin: 35,
  },
  {
    id: "fig5-ridge",
    title: "Concentric scaling law on the ridge",
    feeds: "Fig 5 (filled), §8.4 exponent, Table 2 G1 — wide ring-count range at the auto-route sweet spot",
    family: "Contoured concentric",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 2, end: 10, step: 2 }, { start: 15, end: 30, step: 5 }, { start: 40, end: 60, step: 10 }],
      rate: null,
      placement: "current",
      flow: false,
    },
    estMin: 15,
  },
  {
    id: "fig5-fleet",
    title: "Concentric total-fleet tail (R→120)",
    feeds: "Fig 5 (hollow), S^1.55 total-fleet exponent",
    family: "Contoured concentric",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 70, end: 120, step: 25 }],
      rate: null,
      placement: "current",
      flow: false,
    },
    heavy: true,
    estMin: 25,
  },
  {
    id: "fig9-transfer",
    title: "Transfer S² series (fixed R × in-ring rate)",
    feeds: "Fig 9, Eq (12) constants, §9.4",
    family: "Contoured transfer",
    sliders: { ...BASE },
    sens: {
      ringSegs: [
        { start: 1, end: 1, step: 1 }, { start: 2, end: 2, step: 1 }, { start: 4, end: 4, step: 1 },
        { start: 10, end: 10, step: 1 }, { start: 20, end: 20, step: 1 }, { start: 40, end: 40, step: 1 },
      ],
      rate: { mode: "inring", start: 500, end: 4000, step: 875 },
      placement: "current",
      flow: false,
    },
    estMin: 30,
  },
  {
    id: "fig13-grid-conc",
    title: "Concentric geometry grid ×16 (flow ON)",
    feeds: "Fig 13 + §13 G2: delivered capacity invariant across the synodic geometry, no conjunction blackout — the standing concentric flow-ON grid gap; also demonstrates flow ≈ routed parity",
    family: "Contoured concentric",
    // Geometry ×16 places the planets by angle, decoupled from any calendar —
    // the date-independence device the paper's Fig 13 is built on. In live
    // exec (the default) the runner steps the MAIN-UI placement sliders
    // (Geometry + Earth/Mars angle offsets) per cell — real sliders, real sim;
    // in worker exec the sens placement axis sweeps the grid in one run.
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 28, end: 28, step: 1 }],
      rate: null,
      placement: "geometry-16",
      flow: { budgetSec: 90 },
    },
    estMin: 60,
  },
  {
    id: "fig13-grid-tran",
    title: "Transfer geometry grid ×16 (flow ON)",
    feeds: "Fig 13 transfer half + §13 G2; re-measures the rotated-geometry delivered-capacity question post ring-pinning/sizing fixes",
    family: "Contoured transfer",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 2, end: 2, step: 1 }],
      rate: { mode: "total", start: 10000, end: 10000, step: 1 },
      placement: "geometry-16",
      flow: { budgetSec: 90 },
    },
    estMin: 25,
  },
  {
    id: "table1-transfer-10g",
    title: "Table 1 rows — transfer at 10 Gbps total (flow ON)",
    feeds: "Table 1, Table 2 G5, Fig 14 configs",
    family: "Contoured transfer",
    sliders: { ...BASE },
    sens: {
      ringSegs: [
        { start: 1, end: 1, step: 1 }, { start: 2, end: 2, step: 1 }, { start: 20, end: 20, step: 1 },
        { start: 40, end: 40, step: 1 }, { start: 60, end: 60, step: 1 },
      ],
      rate: { mode: "total", start: 10000, end: 10000, step: 1 },
      placement: "current",
      flow: { budgetSec: 120 },
    },
    heavy: true,
    estMin: 30,
  },
  {
    id: "b2-junction-recal",
    title: "Junction window-law recalibration (single ring × rate)",
    feeds: "§10 J(n) + w(x) recalibration — the raw junction-pair angle arrays (junctionAngles) ride every entry, live and worker alike (runPipeline attaches them too)",
    family: "Contoured transfer",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 1, end: 1, step: 1 }],
      rate: { mode: "inring", start: 500, end: 16000, step: 3875 },
      placement: "current",
      flow: false,
    },
    estMin: 12,
  },
  {
    id: "eq13-planet-law",
    title: "Planetary-ring law N ∝ r·√T (no runs needed)",
    feeds: "Eq (13) / §11 validation",
    manual: true,
    note: "No dedicated sweep: every auto-sized entry in every set archives the sized rate (sized block) with earthSats/marsSats. Fitting N against √T across ALL sets validates Eq (13) over the full capacity range — an analysis step on data the other items already produce.",
  },
  {
    id: "fig14-coverage",
    title: "Coverage Monte-Carlo (probe field)",
    feeds: "Fig 14, Table 1 ship columns, §13 G3",
    manual: true,
    note: "Probe field is live-view only: set each config (concentric ≈10 Gbps; transfer 1/2/20/40/60 rings at 10 Gbps), enable Coverage probes, let the field settle, then Save from the Archive tab (coverage distributions are captured automatically).",
  },
  {
    id: "fig6-optimized",
    title: "Optimized ring placement",
    feeds: "Fig 6, §8.5 optimized law",
    manual: true,
    note: "Optimizer runs (10,000 steps per R at R = 10–40): use the Optimized sensitivity sweep with the band solver configured per §8.5 — hours per point, not suited to the sequential runner.",
  },
];
