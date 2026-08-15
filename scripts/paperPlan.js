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
// v4: baseline pins the fleet cap to 1,000,000 (heavy items — the R→120 fleet
// tail, 10 Gbps transfer rows — exceed the 100k default and silently truncated
// with "too many satellites"); baselines also now derive from FACTORY defaults
// (simUi._factoryDefaults) rather than the runtime-mutated slidersData values.
// v5: b2-junction-recal pins junction rings OFF (manual / 0 / 0) — BASE's auto
// growth absorbs the very saturation knee the item measures, and every growth
// round rebuilds the fleet, stretching live settles. Live-exec rows are also
// now validated at record time (settle + build-freshness + design-drift guards
// in simUi) and archive flagged `measureFailed` instead of passing as clean —
// pre-v5 live sets could contain silently stale rows (rAF-starved hidden tab).
// v6: ADDS the three fig14 probe-grid items (coverage-probe capacity+latency
// distributions × 16 geometry cells for 2-ring transfer / 40-ring transfer /
// concentric R50, all ≈10 Gbps at ×128) — probe items force live exec and the
// runner drives the coverage field per item; rows carry a `coverage` block.
// estMin values recalibrated from the v2 campaign's measured wall times (see
// TIME MODEL below). No semantics changed for the 8 existing items — their v5
// sets remain valid; the version chip will read stale but re-measuring them is
// only needed for their own failed rows.
// v7: MATCHED-CAPACITY RULE (Julien, after the deck's slide-20 mismatch —
// conc R28 @2 Gbps vs transfer @10 Gbps was uncomparable): every head-to-head
// item group compares the three systems at ONE capacity point. The fig13
// geometry grids are now the matched 1 Gbps trio (conc R22 ≈ 1.03 Gbps /
// 2-ring @1 Gbps / NEW 40-ring @1 Gbps — the deck's slide-20 basis and the
// V1 program point); the probe grids stay the matched ≈10 Gbps trio (conc
// R50 ≈ 9.8 / 2-ring / 40-ring — the paper's Table-1/Fig-14 point). The old
// 10 Gbps 2-ring grid survives as b3-grid-tran-10g: its stronger worst-cell
// flow dip (84.5% @10G vs 93% @1G) is the demand-dependent junction
// saturation §13 discusses — a per-family finding, not a head-to-head.
// v8: ADDS v1-ships-conc-1g — concentric R22 ≈1 Gbps coverage-probe item
// (per-ship capacity+latency distributions at the V1 program point, 16
// geometry cells). Feeds §17's ship-service claim (currently an estimate)
// and the concentric companion of Table 1. Earth↔Mars latency at this
// point is already measured by the fig13 matched 1 Gbps grids.
export const PLAN_VERSION = 8;

// TIME MODEL (fitted on the v2 campaign's 103 clean timed rows, 2026-07-30):
// per-scenario settle wall time is LINEAR in fleet size — t ≈ 0.64 ms × sats
// (R² = 0.74; residual spread ×0.35–×13, the tail = extra sizing rounds) — and
// a flow solve adds a family-dependent constant: ≈ +30 s (transfer) / +120 s
// (concentric lattice — denser flow graph). Sat count predicts better than the
// link-count proxy for settles; rows now record `linkCount` so a proper
// link-based flow model can be fitted from v3 data on. estMin per item ≈
// Σ cells × t(expected sats), rounded up.

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
  { key: "simulation.maxSatCount", value: 6, shown: "1,000,000 (10^6)",
    why: "Fleet cap raised above every item's need (the R→120 fleet tail approaches 3×10⁵ sats; 10 Gbps transfer rows ~10⁵): at the 100k default, heavy items truncate the build (\"too many satellites\") and measure a capped fleet." },
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
    estMin: 4,
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
    estMin: 3,
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
    estMin: 15,
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
    estMin: 40,
  },
  // ── fig13: the MATCHED 1 Gbps geometry-grid trio (v7 rule). One capacity
  //    point across all three systems — conc R22 ≈ 1.03 Gbps on the measured
  //    ridge, both transfer grids at 1 Gbps total — so Fig 13 / deck slide 20
  //    compare like for like (latency, delivered fraction AND fleet size).
  {
    id: "fig13-grid-conc",
    title: "Concentric R22 geometry grid ×16 @ ≈1 Gbps (flow ON)",
    feeds: "Fig 13 + §13 G2 + deck slide 20: capacity invariance, latency by geometry group, matched-capacity fleet — measured 2026-07-31: routed 1.029 Gbps invariant, flow 94–108%, 13,054 sats",
    family: "Contoured concentric",
    // Geometry ×16 places the planets by angle, decoupled from any calendar —
    // the date-independence device the paper's Fig 13 is built on. In live
    // exec (the default) the runner steps the MAIN-UI placement sliders
    // (Geometry + Earth/Mars angle offsets) per cell — real sliders, real sim;
    // in worker exec the sens placement axis sweeps the grid in one run.
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 22, end: 22, step: 1 }],
      rate: null,
      placement: "geometry-16",
      flow: { budgetSec: 90 },
    },
    estMin: 15,
  },
  {
    id: "fig13-grid-tran",
    title: "Transfer 2-ring geometry grid ×16 @ 1 Gbps (flow ON)",
    feeds: "Fig 13 transfer half + §13 G2 + deck slide 20 — measured 2026-07-31: routed 1.005 Gbps invariant, flow 93–100%, 9,601 sats",
    family: "Contoured transfer",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 2, end: 2, step: 1 }],
      rate: { mode: "total", start: 1000, end: 1000, step: 1 },
      placement: "geometry-16",
      flow: { budgetSec: 90 },
    },
    estMin: 8,
  },
  {
    id: "fig13-grid-tran40",
    title: "Transfer 40-ring geometry grid ×16 @ 1 Gbps (flow ON)",
    feeds: "Fig 13 / deck slide 20 third column — measured 2026-07-31: routed 1.046 Gbps invariant, flow 93–100%, 24,823 sats",
    family: "Contoured transfer",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 40, end: 40, step: 1 }],
      rate: { mode: "total", start: 1000, end: 1000, step: 1 },
      placement: "geometry-16",
      flow: { budgetSec: 90 },
    },
    estMin: 12,
  },
  {
    id: "b3-grid-tran-10g",
    title: "Transfer 2-ring geometry grid ×16 @ 10 Gbps (flow ON)",
    feeds: "§13 rotated-geometry junction saturation: the worst-cell delivered fraction is DEMAND-dependent (84.5% in the M0 cells @10 Gbps vs 93% @1 Gbps) — a per-family finding, kept OUT of the matched head-to-head trio",
    family: "Contoured transfer",
    sliders: { ...BASE },
    sens: {
      ringSegs: [{ start: 2, end: 2, step: 1 }],
      rate: { mode: "total", start: 10000, end: 10000, step: 1 },
      placement: "geometry-16",
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
    estMin: 20,
  },
  {
    id: "b2-junction-recal",
    title: "Junction window-law recalibration (single ring × rate)",
    feeds: "§10 J(n) + w(x) recalibration — the raw junction-pair angle arrays (junctionAngles) ride every entry, live and worker alike (runPipeline attaches them too)",
    family: "Contoured transfer",
    // Junction rings OFF: the knee IS the measurement — §10's window law is
    // fitted on the natural (junction-ring-free) planet↔relay window, and
    // BASE's auto growth widens exactly the bottleneck being measured. The
    // relay/junction complex stays the bottleneck; planet rings auto-size to
    // match it (BASE planet_sizing) so supporting capacity sits at/above it.
    sliders: { ...BASE,
      "adapted_eccentric_rings.junction-ring-mode": "manual",
      "adapted_eccentric_rings.junction-ring-count": 0,
      "adapted_eccentric_rings.junction-ring-count-mars": 0,
    },
    sens: {
      ringSegs: [{ start: 1, end: 1, step: 1 }],
      rate: { mode: "inring", start: 500, end: 16000, step: 3875 },
      placement: "current",
      flow: false,
    },
    estMin: 5,
  },
  {
    id: "eq13-planet-law",
    title: "Planetary-ring law N ∝ r·√T (no runs needed)",
    feeds: "Eq (13) / §11 validation",
    manual: true,
    note: "No dedicated sweep: every auto-sized entry in every set archives the sized rate (sized block) with earthSats/marsSats. Fitting N against √T across ALL sets validates Eq (13) over the full capacity range — an analysis step on data the other items already produce.",
  },
  // ── fig14 probe grids: coverage-probe capacity + latency DISTRIBUTIONS per
  //    geometry cell, the three head-to-head scenarios at ≈10 Gbps / ×128.
  //    probes: {count, seed} makes the runner enable + configure the coverage
  //    field for the item and FORCES live exec (the field is measured on the
  //    main thread against the displayed window — worker scenarios never build
  //    it). Every row archives a `coverage` block: per-connected-probe Mbps to
  //    the network and end-to-end to each planet, plus the matching latencies
  //    (500 probes, seed 1 — same cloud for all three scenarios and all cells).
  {
    id: "fig14-probes-tran2",
    title: "Coverage probes ×16 geom — transfer 2 rings @ 10 Gbps",
    feeds: "Fig 14 / Table 1 ship columns / §13 G3 — probe capacity+latency distributions per geometry cell",
    family: "Contoured transfer",
    sliders: { ...BASE },
    probes: { count: 500, seed: 1 },
    sens: {
      ringSegs: [{ start: 2, end: 2, step: 1 }],
      rate: { mode: "total", start: 10000, end: 10000, step: 1 },
      placement: "geometry-16",
      flow: false,
    },
    estMin: 8,
  },
  {
    id: "fig14-probes-tran40",
    title: "Coverage probes ×16 geom — transfer 40 rings @ 10 Gbps",
    feeds: "Fig 14 / Table 1 ship columns / §13 G3 — the many-ring transfer coverage case",
    family: "Contoured transfer",
    sliders: { ...BASE },
    probes: { count: 500, seed: 1 },
    sens: {
      ringSegs: [{ start: 40, end: 40, step: 1 }],
      rate: { mode: "total", start: 10000, end: 10000, step: 1 },
      placement: "geometry-16",
      flow: false,
    },
    heavy: true,
    estMin: 18,
  },
  {
    id: "fig14-probes-conc",
    title: "Coverage probes ×16 geom — concentric R50 (≈10 Gbps)",
    feeds: "Fig 14 / §13 G3 — concentric coverage at the matched capacity (ridge: R50 ≈ 9.8 Gbps)",
    family: "Contoured concentric",
    sliders: { ...BASE },
    probes: { count: 500, seed: 1 },
    sens: {
      ringSegs: [{ start: 50, end: 50, step: 1 }],
      rate: null,
      placement: "geometry-16",
      flow: false,
    },
    heavy: true,
    estMin: 14,
  },
  {
    id: "v1-ships-conc-1g",
    title: "V1 ship service — concentric R22 probes ×16 geom (≈1 Gbps)",
    feeds: "§17 V1 ship-service claim (measured, replaces the shared-Mbps estimate) + Table 1 concentric companion: per-ship access capacity and latency distributions at the V1 program point. Earth↔Mars latency at R22 ≈1 Gbps is already covered by fig13-grid-conc.",
    family: "Contoured concentric",
    sliders: { ...BASE },
    probes: { count: 500, seed: 1 },
    sens: {
      ringSegs: [{ start: 22, end: 22, step: 1 }],
      rate: null,
      placement: "geometry-16",
      flow: false,
    },
    estMin: 8,
  },
  {
    id: "fig14-coverage",
    title: "Coverage Monte-Carlo (probe field)",
    feeds: "Fig 14, Table 1 ship columns, §13 G3",
    manual: true,
    note: "SUPERSEDED for the 16-geometry × 3-scenario grid by the runnable fig14-probes-* items above. Manual path (other configs): set the config, enable Coverage probes, let the sim settle, then Save from the Archive tab (coverage distributions are captured automatically).",
  },
  {
    id: "fig6-optimized",
    title: "Optimized ring placement",
    feeds: "Fig 6, §8.5 optimized law",
    manual: true,
    note: "Optimizer runs (10,000 steps per R at R = 10–40): use the Optimized sensitivity sweep with the band solver configured per §8.5 — hours per point, not suited to the sequential runner.",
  },
];
