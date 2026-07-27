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

// Shared clean baseline: ×128 laser tech, auto planet sizing, full planetary
// rings, Date placement, push-relabel (the only solver that works for
// contoured concentric; transfer accepts it too), auto route count.
const BASE = {
  "laser_technology.improvement-factor": 7,          // 2^7 = ×128
  "relay_type.planet_sizing": "auto",
  "simulation.planet-placement": "Date",
  "ring_earth.side-extension-degrees-slider": 180,
  "ring_mars.side-extension-degrees-slider": 180,
  "adapted_rings.flow-solver": "push-relabel",
  "adapted_eccentric_rings.flow-solver": "push-relabel",
  "adapted_rings.auto_route_count": "yes",
  "adapted_eccentric_rings.junction-ring-mode": "auto",
};

export const PAPER_PLAN = [
  {
    id: "fig5-ridge",
    title: "Concentric ridge scaling",
    feeds: "Fig 5 (filled), §8.4 exponent, Table 2 G1",
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
    id: "fig12-flow-conc",
    title: "Concentric flow parity spots (flow ON)",
    feeds: "Fig 12 breakevens, §13 delivered capacity",
    family: "Contoured concentric",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 10, end: 10, step: 1 }, { start: 28, end: 28, step: 1 }],
      rate: null,
      placement: "current",
      flow: { budgetSec: 90 },
    },
    estMin: 12,
  },
  {
    id: "fig12-flow-tran",
    title: "Transfer flow parity spots at 1/10 Gbps (flow ON)",
    feeds: "Fig 12 breakevens, Table 1 capacity column",
    family: "Contoured transfer",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 2, end: 2, step: 1 }],
      rate: { mode: "total", start: 1000, end: 10000, step: 9000 },
      placement: "current",
      flow: { budgetSec: 90 },
    },
    estMin: 10,
  },
  {
    id: "fig13-datewindow-conc",
    title: "Concentric date-window grid (flow ON, worker)",
    feeds: "Fig 13 right + §13 G2 (no conjunction blackout), date-independent capacity export",
    family: "Contoured concentric",
    // Worker exec: the date-range placement axis is worker/main-only (live mode
    // pins placement to the main Simulation section), and worker flow is
    // trustworthy since the sizing fixed-point fix (commit 1ca356b).
    exec: "worker",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 28, end: 28, step: 1 }],
      rate: null,
      placement: { dateRangeDays: 780, samples: 13 },
      flow: { budgetSec: 90 },
    },
    estMin: 25,
  },
  {
    id: "fig13-datewindow-tran",
    title: "Transfer date-window grid (flow ON, worker)",
    feeds: "Fig 13 + §13 G2 transfer half",
    family: "Contoured transfer",
    exec: "worker",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 2, end: 2, step: 1 }],
      rate: { mode: "total", start: 10000, end: 10000, step: 1 },
      placement: { dateRangeDays: 780, samples: 13 },
      flow: { budgetSec: 90 },
    },
    estMin: 15,
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
    title: "Junction window-law recalibration (single ring × rate, worker)",
    feeds: "§10 J(n) + w(x) recalibration (junctionAngles ride worker entries)",
    family: "Contoured transfer",
    // Worker exec: the raw junction-pair angle arrays (capacityInfo.junctionAngles)
    // are collected on the worker pipeline; no flow is needed, and worker routed
    // capacity is trustworthy since the sizing fixed-point fix.
    exec: "worker",
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
