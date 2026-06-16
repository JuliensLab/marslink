# Planet-Ring Sizing

## Objective
Size the Earth/Mars rings so their in-ring capacity **matches the relay target** for any
relay-ring + laser-tech config — converging reliably (no runaway loop, no bail), and clearly
reporting when the relay (not the planet rings) is the real limit.

## What live measurement established
- **Keep** the iterative correction — discretization (`ceil` + quadratic slider) means no closed
  form can hit the target exactly.
- **Drop** any multi-date / worst-case-date sizing — flow is **time-stable** (±5–10% over 15
  months; the relay is heliocentric, so dominant capacity is time-invariant by design).
- **Two things actually bite:** the discrete `maxDistanceAU` cliff (links vanish when spacing
  exceeds range — flow collapsed 2.4 → 1.9 → 0.57 Gbps as range dropped below spacing), and the
  fact that the **relay usually binds** (sizing Earth/Mars above the relay is wasted).
- The **slider cap** (`requiredmbpsbetweensats` max 100, quadratic ⇒ ~10 Gbps/link) is what
  blocked convergence at high tech — not a missing tech trigger. The Simple-mode tech slider
  already re-sizes (`simUi.js` `techRow` handler); Advanced stays manual by design.

## Design: seed → feasibility-clamp → short correction
The closed-form is a **seed**; the existing feedback (with its no-progress guard) does the final mile.

### 1. Closed-form seed (mostly already exists)
`_mbpsBetweenSatsForTargetCapacity` already inverts the chain. Formalize/reuse:
```
gbpsFactor = techFactor · baseGbps · baseDist²        // = simLinkBudget._gbpsFactor
s_km       = sqrt( 2 · gbpsFactor / T_gbps )          // spacing for 2·perLink = T
N_target   = ceil( π / asin( min(1, s_au / (2·apo)) ) )  // apo = a·(1+e)
```
T = `routeSummary.totalThroughput` (relay target).

### 2. Feasibility clamp (the two real constraints)
```
// (a) connectivity floor — never let spacing exceed link range:
N_connect = ceil( π / asin( min(1, maxDistanceAU / (2·apo)) ) )
N = max(N_target, N_connect)

// (b) budget ceiling — can't exceed the sat cap:
if (N · rings > maxSatCount) → clamp; flag "planet-ring-limited"
```
(a) prevents the measured fragmentation cliff. (b) makes the unreachable case explicit instead of
looping or silently bottlenecking.

### 3. Lift the slider cap
`ring_earth/ring_mars.requiredmbpsbetweensats` `max: 100` caps per-link target at ~10 Gbps. Raise
it (quadratic headroom) or have the sizer write sat counts directly in `generateSatellitesConfig`.
Net: the binding limit becomes `maxSatCount` (honest physical constraint), not a UI bound.

### 4. Keep the correction loop
`runSimpleFeedbackStep` (with the no-progress guard) stays. Good seed + lifted cap ⇒ converges in
1–2 steps; if (b) clamps it, the guard stops immediately.

## Surface
- **Relay-limited** (Earth/Mars ≥ relay): normal — more tech/rings is the lever, not bigger rings.
- **Planet-ring-limited** (clamped by 2b): warn `⚠ Mars ring capped at N sats — limits flow to X`
  via `simSatellites.satellitesTruncated` + the bottom-bar warnings area.

## Out of scope
- Multi-date / worst-case-date sizing (time-stable — unnecessary).
- Relay-ring (`adapted`) `maxDistanceAU` cliff — same bug class in `setAdaptedRingsConfig`; separate fix.
- Advanced-panel auto-sizing — Advanced stays manual.

## Verification (live)
1. Fix ring count, sweep tech 32→256× in Simple mode → in-ring tracks relay, no loop, flow scales
   until the relay binds.
2. The tech-256 case that bailed at Mars≈16.6 Gbps now reaches the relay target (or reports
   "planet-ring-limited" if `maxSatCount` binds).
3. Drop `maxDistanceAU` below spacing → sizer adds sats to stay connected (graceful degrade, no
   collapse to 0).
4. Convergence stays 1–2 steps; the "Tuning rings" readout shows E/M reaching ~103%.
