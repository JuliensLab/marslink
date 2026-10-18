// Minimal regression check for the launcher Δv fix (audit 2026-10-18, top item 1).
// Run:  node --experimental-default-type=module tests/check-deltav.mjs
// (Node ≥ 20.10; the browser modules are plain ES modules without "type": "module".)
//
// Asserts the physics invariant that was broken (reaching any heliocentric ring
// from LEO costs at least the Earth-escape burn) and pins the corrected
// headline f-Trade cells so an accidental revert is caught.
import assert from "node:assert/strict";

const root = new URL("../scripts/", import.meta.url).href;
const { calculateHohmannDeltaV_km_s, leoDepartureDeltaV_km_s } = await import(root + "simDeltaV.js");
const ft = await import(root + "simFTrade.js");
const { SimDeployment } = await import(root + "simDeployment.js");

let n = 0;
const near = (got, want, tol, msg) => { n++; assert.ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} ± ${tol}`); };

// 1. Patched-conics LEO departure (300 km parking orbit).
near(leoDepartureDeltaV_km_s(0), 3.200, 0.002, "LEO → escape (C3 = 0)");
near(leoDepartureDeltaV_km_s(0, 3.2), 3.2, 1e-12, "slider escape value returned exactly at v∞ = 0");
near(leoDepartureDeltaV_km_s(2.945), 3.590, 0.002, "LEO → Mars-class v∞ 2.945 km/s");
for (const v of [0.1, 0.5, 1, 1.667, 2.927, 5]) {
  n++; assert.ok(leoDepartureDeltaV_km_s(v, 3.2) > 3.2, `burn for v∞=${v} must exceed escape`);
}

// 2. f-Trade deployment profile per section (paper Table 4 / A.3 basis).
const a = ft.DEFAULTS;
const conc = ft.deployFor("concentric relay", 2000, a);
const tr = ft.deployFor("transfer rings", 2000, a);
const pl = ft.deployFor("planetary rings", 2000, a);
near(conc.dv, 3.33, 0.01, "concentric launcher Δv");
near(tr.dv, 3.59, 0.01, "transfer launcher Δv");
near(pl.dv, 3.44, 0.01, "planetary-ring launcher Δv (Earth/Mars blend)");
for (const d of [conc, tr, pl]) { n++; assert.ok(d.dv >= a.escapeDvKmS, "every section ≥ escape"); }
near(conc.launchesPerSat, 0.22, 0.005, "concentric launches per satellite");
near(tr.launchesPerSat, 0.24, 0.006, "transfer launches per satellite");
// Legacy switch still reproduces the 21 Aug 2026 draft basis.
near(ft.deployFor("concentric relay", 2000, { ...a, legacyHelioDv: true }).dv, 1.667, 0.001, "legacy concentric Δv");

// 3. Headline program costs (×100 laser factor).
const t100 = ft.terminalForFactor(100, a);
near(ft.programCostB("concentric", 1, 100, t100, a).totalB, 30.9, 0.1, "V1: concentric 1 Gbps ×100 ($B)");
near(ft.programCostB("transfer", 1000, 100, t100, a).totalB, 378.5, 0.5, "V2: 2-ring transfer 1 Tbps ×100 ($B)");
const legacy = { ...a, legacyHelioDv: true };
near(ft.programCostB("concentric", 1, 100, t100, legacy).totalB, 26.86, 0.01, "legacy V1 reproduces draft");
near(ft.programCostB("transfer", 1000, 100, t100, legacy).totalB, 353.25, 0.01, "legacy V2 reproduces draft");

// 4. Simulator deployment model: Starship burn from LEO ≥ escape for every ring.
const d = new SimDeployment([{ name: "Earth", a: 1.0, e: 0.0167, i: 0 }]);
d.setSatelliteMassConfig(1000, 50, { ring_earth: 3, ring_mars: 3, circular_rings: 5, eccentric_rings: 3 });
for (const r of [
  { ringName: "ring_earth", a: 1.0, e: 0.0167, i: 0 },
  { ringName: "ring_circ_10", a: 1.26, e: 0, i: 0 },
  { ringName: "ring_mars", a: 1.524, e: 0.0934, i: 1.85 },
  { ringName: "ring_ecce_0", a: 1.262, e: 0.2076, i: 0 },
]) {
  const p = d.getMissionProfile([{ ...r, satCount: 1000, apsides: { apo_pctEarth: 1 } }]).byOrbit[0];
  const burn = p.orbits.starshipLeoBurn_km_per_s;
  n++; assert.ok(burn >= d.escapeBurnDvKmS - 1e-9, `${r.ringName}: Starship LEO burn ${burn} < escape`);
  const out = p.vehicles.Starship.maneuvers.find((m) => m.label.startsWith("1st Hohmann maneuver from LEO (outbound)"));
  n++; assert.equal(out.deltaV_km_per_s, burn, `${r.ringName}: outbound maneuver uses the LEO burn`);
}

console.log(`check-deltav: ${n} assertions passed`);
