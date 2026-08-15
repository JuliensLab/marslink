// simFTrade.js — analytic laser-technology-factor trade panel.
//
// Computes, from the paper's scaling laws ONLY (no simulation), the fleet size
// and program cost of the concentric and 2-ring-transfer families over a grid
// of laser factors f and capacity targets, plus a component-based model of the
// first-terminal cost as a function of f (telescope / laser / modulation /
// receiver / converter, cost-optimal allocation of the f budget across them).
//
// Anchors: laws at f = ×128 (paper Sections 8–11); cost model = the simulator's
// stated unit assumptions (paper Table 3); Starlink-class terminal as the ×1
// baseline (monostatic, 75 mm class); Wright's law un-applied from the volume
// price to recover the first-unit terminal cost. Launch follows the website's
// deployment model analytically (simDeployment.js): per-section Hohmann Δv,
// Starship does the first burn and returns, satellites do the second burn
// electrically, tankers refill the mission propellant in LEO.

import { calculateHohmannDeltaV_km_s } from "./simDeltaV.js?v=5.60";

export const DEFAULTS = {
  // Decade ladder; ×1 = Starlink-class hardware as-is. Measurements behind the
  // scaling laws were run at f = ×128 — decade values are exact linear rescales.
  factors: [1, 10, 100, 1000, 1e4, 1e5],
  capsGbps: [1, 1000, 1e6],
  ringCount: 2,            // transfer rings (user-selectable, default 2)
  // Scaling-law constants, all quoted at f = ×128
  concA: 1.89e-5,          // optimized concentric fit: T = concA·S^concP  [Gbps]
  concP: 1.26,
  kT: 1.07e-7,             // transfer: T = kT·S²/R  [Gbps]
  planetK: 5469,           // planetary rings, both planets: S = planetK·√T(Gbps)
  // Per-link max data rate. NOT physics — an electronics/architecture knob:
  // Starlink's demonstrated 100 Gbps is the ×1 anchor; TBIRD flew 200 Gbps
  // from a CubeSat (Schieler 2023), NICT demonstrated 2 Tbps with small
  // flight-class terminals (2025), DLR 13.16 Tbps over 10.45 km of atmosphere
  // by 54-channel WDM, and ESA HydRON targets Tbps ISLs. Raising it = more
  // WDM channels behind the same monostatic telescope, priced per channel in
  // terminalForFactor below.
  lineRateGbps: 100,
  concFloorRelay: 1000,    // flag concentric cells whose relay count drops below this
  // Program-cost model (paper Table 3)
  busFirstM: 5,            // $M, first satellite bus
  extrasConcM: 1.0,        // $M, solar+radiator first-unit (concentric relay)
  extrasTransferM: 1.65,   // $M, aphelion arrays + perihelion radiators (transfer)
  extrasPlanetM: 1.35,     // $M, planetary rings (Earth-ring 1.0 / Mars-ring 1.65 average)
  extrasJunctionM: 1.0,    // $M, junction rings
  termVolM: 0.05,          // $M, Starlink-class terminal at volume — deduced from published
                           // satellite unit costs (~$0.25-1M for V1.5/V2 mini) at 3 ISLs per
                           // satellite on an RF-dominated payload; ISLs are a small line item
  starlinkN0: 10000,       // terminals over which that volume price was learned
  wright: 0.85,            // progress ratio per production doubling
  launchFirstM: 20,        // $M, first Starship-class flight (economics.launch-cost-slider)
  satsPerFlight: 37,       // legacy model only: 1 flight per ≈37 sats, tankers incl.
  satMassKg: 2000,         // ≈2 t satellite class (dry bus + propellant)
  includeLaunch: true,     // add launch cost (deployment-model flights under Wright's law)
  // Deployment model (mirrors simDeployment.js analytically)
  leoPayloadT: 100,        // t to LEO per launch; also a tanker's propellant delivery
  starshipDryT: 120,       // t (simDeployment vehicleProperties.starship)
  starshipPropCapT: 1200,  // t propellant capacity
  starshipIspS: 370,       // s
  landingPropT: 20,        // t reserved for deorbit + landing
  escapeDvKmS: 3.2,        // LEO → Earth-SOI escape (simDeployment.ESCAPE_BURN_DV_KM_S)
  concMeanA: 1.26,         // AU, satellite-weighted mean concentric ring
  transferA: 1.26,         // AU + e of the tangency transfer ellipse (Fig 9)
  transferE: 0.206,
  marsA: 1.524,            // AU, Mars planetary ring
  junctionSats: 0,         // transfer-family junction rings: no closed form; 0 = plane-node pair
  // Terminals per satellite, per network section
  termsConc: 5,            // concentric relay: 2 radial + 2 in-ring + 1 access
  termsTransfer: 3,
  termsPlanet: 3,
  termsJunction: 2,
  // Component model of one terminal (shares of the FIRST-unit cost)
  shares: { telescope: 0.35, laser: 0.20, modem: 0.15, receiver: 0.15, converter: 0.05, structure: 0.10 },
  apertureMm: 75,          // ×1 baseline aperture (monostatic, tx+rx shared)
  laserW: 2,               // ×1 baseline optical transmit power (assumption)
  // Telescope cost ∝ (D/D0)^betaD (f contribution: D⁴). Evidence: space OTA
  // ≈ D^1.8–2.0 (Stahl et al. 2010, doi:10.1117/1.3430603; van Belle, Meinel &
  // Meinel 2004, doi:10.1117/12.552181), ground observatories D^2.5–2.8
  // (Meinel 1979, Opt. Eng. 18, 645). Terminal-level default 2.25 = the space
  // band's center plus the pointing burden (beamwidth ∝ λ/D tightens with D).
  betaD: 2.25,
  betaP: 0.8,              // laser + converter cost ∝ (P/P0)^betaP  (f contribution: P)
  rhoGain: 20,             // coherent → photon-counting + coding headroom (bounded)
  lossGain: 2,             // recoverable optics/pointing losses (bounded)
  wallPlug: 0.15,          // optical W per electrical W
  busPerKwM: 0.2,          // $M per kW (solar 0.1 + radiator 0.1), first-unit rates
  massKg: 10,              // ×1 baseline terminal mass
  legacyTerminals: false,  // true = flat $0.2M first-unit terminals (paper Table 4 model)
};

/* ───────────────────────── model ───────────────────────── */

// Cost-optimal terminal for factor f: engage the bounded cheap levers first
// (photon efficiency + losses), then split the remainder between aperture
// (gain D⁴, cost ∝ D^betaD) and laser power (gain P, cost ∝ P^betaP + bus kW)
// by 1-D search. Returns hardware first cost, bus-power adder, mass, D, P.
export function terminalForFactor(f, a = DEFAULTS) {
  const firstM = a.termVolM * Math.pow(a.starlinkN0, -Math.log2(a.wright));
  const s = a.shares;
  const cheap = Math.min(f, a.rhoGain * a.lossGain);
  const pcEngaged = cheap > 4; // photon-counting receive chain in play
  const fRem = Math.max(1, f / cheap);

  let best = null;
  const steps = 400;
  const dmMax = Math.pow(fRem, 0.25);
  for (let i = 0; i <= steps; i++) {
    const dm = Math.pow(dmMax, i / steps);          // D/D0 ∈ [1, fRem^¼]
    const pm = fRem / Math.pow(dm, 4);              // P/P0 makes up the rest
    const optW = a.laserW * pm;
    const busKw = (optW / a.wallPlug - a.laserW / a.wallPlug) / 1000;
    // Extra WDM channels raise the line rate past 100 Gbps: per channel, one
    // more transceiver chain (laser + modem + converter) behind the SAME
    // telescope — electronics, not optics (TBIRD/NICT/HydRON path).
    const wdmExtra = Math.max(0, Math.ceil(a.lineRateGbps / 100) - 1);
    const hwM =
      firstM * (
        s.telescope * Math.pow(dm, a.betaD) +
        (s.laser + s.converter) * Math.pow(pm, a.betaP) +
        (s.modem + s.receiver) * (pcEngaged ? 2 : 1) +
        s.structure +
        wdmExtra * (s.laser + s.modem + s.converter));
    const busM = busKw * a.busPerKwM;
    if (!best || hwM + busM < best.hwM + best.busM) {
      best = { hwM, busM, dm, pm, optW,
        elecW: optW / a.wallPlug,
        apertureMm: a.apertureMm * dm,
        massKg: a.massKg * (0.4 * Math.pow(dm, 2.5) + 0.2 * Math.pow(pm, 0.8) + 0.4)
          + 2 * wdmExtra }; // ~2 kg of electronics per extra WDM channel
    }
  }
  return { firstBaseM: firstM, pcEngaged, ...best };
}

// Network sections per family from the ×128-anchored laws (rescaled linearly
// in f), each with its own terminal count and solar/radiator extras. The
// family total is the SUM of its sections' scaling laws.
export function sectionsFor(family, tGbps, f, a = DEFAULTS) {
  const scale = f / 128;
  const planet = { name: "planetary rings",
    S: a.planetK * Math.sqrt(tGbps) / Math.sqrt(scale),
    k: a.termsPlanet, extrasM: a.extrasPlanetM };
  if (family === "concentric") {
    return [
      { name: "concentric relay", S: Math.pow(tGbps / (a.concA * scale), 1 / a.concP),
        k: a.termsConc, extrasM: a.extrasConcM },
      planet,
    ];
  }
  const out = [
    { name: "transfer rings", S: Math.sqrt((tGbps * a.ringCount) / (a.kT * scale)),
      k: a.termsTransfer, extrasM: a.extrasTransferM },
    planet,
  ];
  if (a.junctionSats > 0) {
    out.push({ name: "junction rings", S: a.junctionSats, k: a.termsJunction, extrasM: a.extrasJunctionM });
  }
  return out;
}

export function fleetFor(family, tGbps, f, a = DEFAULTS) {
  const secs = sectionsFor(family, tGbps, f, a);
  return { relay: secs[0].S, planet: secs[1].S,
    total: secs.reduce((s, x) => s + x.S, 0), sections: secs };
}

// Deployment profile for one section (mirrors simDeployment.js analytically).
// The Starship performs the section's first burn and a symmetric return; the
// satellites fly the second Hohmann burn, inclination, station-keeping and
// end-of-life return on their own electric propulsion (inside their ≈2 t).
// Tankers refill the full mission propellant in LEO before departure.
export function deployFor(sectionName, satKg, a = DEFAULTS) {
  let dv;
  if (sectionName === "concentric relay") {
    dv = calculateHohmannDeltaV_km_s({ a: 1, e: 0, i: 0 }, { a: a.concMeanA, e: 0, i: 0 }).deltaV1;
  } else if (sectionName === "planetary rings") {
    // Earth ring: SOI-escape burn; Mars ring: Hohmann injection. Weight by the
    // Eq-13 split N ∝ r: Mars share 1.524/(1+1.524).
    const dvM = calculateHohmannDeltaV_km_s({ a: 1, e: 0, i: 0 }, { a: a.marsA, e: 0, i: 0 }).deltaV1;
    const wM = a.marsA / (1 + a.marsA);
    dv = (1 - wM) * a.escapeDvKmS + wM * dvM;
  } else { // transfer + junction rings: ellipse injection at the Earth-orbit perihelion
    const h = calculateHohmannDeltaV_km_s({ a: 1, e: 0, i: 0 }, { a: a.transferA, e: a.transferE, i: 0 });
    dv = Math.max(h.deltaV1, h.deltaV2);
  }
  const ve = 9.81 * a.starshipIspS / 1000;          // km/s exhaust velocity
  const E = Math.exp(dv / ve);
  const base = a.starshipDryT + a.landingPropT;     // mass after payload release, incl. landing reserve
  const satT = satKg / 1000;
  const nPay = Math.floor(a.leoPayloadT / satT);
  const nProp = Math.floor(
    (a.starshipPropCapT - a.landingPropT - (E - 1) * base * (1 + E)) / ((E - 1) * satT));
  const n = Math.max(1, Math.min(nPay, nProp));
  const propTotal = a.landingPropT + base * (E - 1) + (base * E + n * satT) * (E - 1);
  const tankers = Math.ceil(propTotal / a.leoPayloadT);
  return { dv, n, tankers, propTotal, launchesPerSat: (1 + tankers) / n };
}

// Program cost with Wright's law: hardware per section (each section's
// first-unit satellite = bus + its extras + its terminal count × first
// terminal), launch pooled over mass-derived flight count.
export function programCostB(family, tGbps, f, term, a = DEFAULTS) {
  const w = 1 + Math.log2(a.wright); // ≈ 0.7655
  const secs = sectionsFor(family, tGbps, f, a);
  const S = secs.reduce((s, x) => s + x.S, 0);
  let hwB, launchB;
  if (a.legacyTerminals) {
    // Paper Table 4 model: one lump first-unit per family, flat $0.2M terminals
    // (concentric = 5M bus + 5×0.2M terminals + 1.0M solar/radiator, per the
    // corrected 5-terminal budget; transfer = 5 + 3×0.2 + 1.65).
    const firstSatM = family === "concentric" ? 7.0 : 7.25;
    hwB = (firstSatM * Math.pow(S, w)) / w / 1000;
    launchB = a.includeLaunch
      ? (a.launchFirstM * Math.pow(S / a.satsPerFlight, w)) / w / 1000 : 0;
  } else {
    const termFirstM = term.hwM + term.busM;
    hwB = secs.reduce((sum, x) =>
      sum + ((a.busFirstM + x.extrasM + x.k * termFirstM) * Math.pow(x.S, w)) / w, 0) / 1000;
    const launches = secs.reduce((sum, x) => {
      const satKg = a.satMassKg + x.k * Math.max(0, term.massKg - a.massKg);
      return sum + x.S * deployFor(x.name, satKg, a).launchesPerSat;
    }, 0);
    launchB = a.includeLaunch
      ? (a.launchFirstM * Math.pow(launches, w)) / w / 1000 : 0;
  }
  return { S, totalB: hwB + launchB, hwB, launchB };
}

/* ───────────────────────── flags ───────────────────────── */

function cellFlags(family, tGbps, f, fleet, a) {
  const flags = [];
  if (family === "transfer") {
    const perPath = tGbps / (2 * a.ringCount);
    if (perPath > a.lineRateGbps) {
      flags.push(`line rate: ${fmt(perPath)} Gbps per path > ${fmt(a.lineRateGbps)} Gbps cap`);
    }
  }
  if (family === "concentric" && fleet.relay < a.concFloorRelay) {
    flags.push("below concentric structural floor");
  }
  if (tGbps > 2 * a.lineRateGbps) {
    flags.push(`planetary rings need layering or a higher line rate (aggregate > 2 × ${fmt(a.lineRateGbps)} Gbps per ring)`);
  }
  return flags;
}

/* ─────────────────────── rendering ─────────────────────── */

export const fmt = (n) => {
  if (!isFinite(n)) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 3e6 ? 1 : 2) + "M";
  if (n >= 1e4) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
};
export const fmtB = (b) => (b >= 1000 ? "$" + (b / 1000).toFixed(1) + "T" : b >= 10 ? "$" + Math.round(b) + "B" : "$" + b.toFixed(1) + "B");
const fmtF = (f) => "×" + (f >= 1e4 ? f.toExponential(0).replace("e+", "e") : f.toLocaleString("en-US"));
const capLabel = (t) => (t >= 1e6 ? t / 1e6 + " Pbps" : t >= 1000 ? t / 1000 + " Tbps" : t + " Gbps");

function familyTable(family, a) {
  const rows = a.factors.map((f) => {
    const term = terminalForFactor(f, a);
    const cells = a.capsGbps.map((t) => {
      const fleet = fleetFor(family, t, f, a);
      const cost = programCostB(family, t, f, term, a);
      const flags = cellFlags(family, t, f, fleet, a);
      const mark = flags.length ? ` <span class="ftrade-flag" title="${flags.join("; ")}">⚑</span>` : "";
      return `<td>${fmt(cost.S)} sats<br>${fmtB(cost.totalB)}${mark}</td>`;
    }).join("");
    return `<tr><td>${fmtF(f)}</td>${cells}</tr>`;
  }).join("");
  const caps = a.capsGbps.map((t) => `<th>${capLabel(t)}</th>`).join("");
  const title = family === "concentric"
    ? "Concentric rings"
    : `Transfer rings — R&nbsp;=&nbsp;<input type="number" class="ftrade-inline" data-key="ringCount"
         value="${a.ringCount}" min="1" step="1" title="Transfer ring count (default 2)">`;
  return `<h3>${title}</h3>
    <table><thead><tr><th>Laser factor</th>${caps}</tr></thead><tbody>${rows}</tbody></table>`;
}

function ladderTable(a) {
  const rows = a.factors.map((f) => {
    const t = terminalForFactor(f, a);
    return `<tr><td>${fmtF(f)}</td>
      <td>${Math.round(t.apertureMm)} mm</td>
      <td>${t.optW < 10 ? t.optW.toFixed(1) : Math.round(t.optW)} W opt / ${Math.round(t.elecW)} W elec</td>
      <td>${t.pcEngaged ? "photon-counting" : "coherent"}</td>
      <td>${Math.round(t.massKg)} kg</td>
      <td>$${(t.hwM + t.busM).toFixed(2)}M</td></tr>`;
  }).join("");
  return `<h3>First-terminal cost ladder (component model)</h3>
    <table><thead><tr><th>Laser factor</th><th>Aperture</th><th>Laser power</th><th>Receive</th><th>Mass</th><th>First terminal</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function deployTable(a, term) {
  const secs = [
    ["concentric relay", a.termsConc], ["transfer rings", a.termsTransfer],
    ["planetary rings", a.termsPlanet], ["junction rings", a.termsJunction],
  ];
  const rows = secs.map(([name, k]) => {
    const satKg = a.satMassKg + k * Math.max(0, term.massKg - a.massKg);
    const d = deployFor(name, satKg, a);
    return `<tr><td>${name}</td><td>${d.dv.toFixed(2)} km/s</td>
      <td>${Math.round(satKg)} kg</td><td>${d.n}</td><td>${d.tankers}</td>
      <td>${(100 * d.launchesPerSat).toFixed(1)}</td></tr>`;
  }).join("");
  return `<h3>Deployment model per section (terminals at the ×100 rung)</h3>
    <table><thead><tr><th>Section</th><th>Starship Δv</th><th>Sat mass</th>
    <th>Sats / flight</th><th>Tankers / flight</th><th>Launches / 100 sats</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

const FIELDS = [
  ["lineRateGbps", "Per-link max rate (Gbps)", 1,
   "Not physics — an electronics knob. Demonstrated beyond 100 Gbps: TBIRD 200 Gbps from a CubeSat, " +
   "NICT 2 Tbps with small flight-class terminals (2025), DLR 13.16 Tbps over 10.45 km by 54-channel WDM; " +
   "ESA HydRON targets Tbps ISLs. Extra 100 Gbps channels are priced into the terminal (one transceiver " +
   "chain each, telescope shared)."],
  ["launchFirstM", "First flight ($M)", 1,
   "Matches the economics panel's launch-cost slider default ($20M first Starship-class flight)."],
  ["satMassKg", "Satellite mass class (kg)", 100],
  ["leoPayloadT", "Payload to LEO per launch (t)", 10,
   "Also a tanker's propellant delivery per launch. The simulator's sliders default to 200 t; " +
   "100 t is the conservative near-term figure. At 200 t the model reproduces the paper's ≈37 sats/flight."],
  ["starshipIspS", "Starship Isp (s)", 5],
  ["landingPropT", "Landing propellant reserve (t)", 5],
  ["junctionSats", "Junction-ring satellites (transfer)", 500,
   "No closed form in the paper; the plane-node pair needs none (0). Counted at 2 terminals per satellite."],
  ["termVolM", "Terminal volume cost ($M)", 0.01],
  ["starlinkN0", "Volume learned over (units)", 1],
  ["wright", "Wright progress ratio", 0.01],
  ["apertureMm", "Baseline aperture (mm)", 1],
  ["laserW", "Baseline laser (W optical)", 0.5],
  ["betaD", "Telescope cost exponent βD", 0.05,
   "Space telescope assemblies ≈ D^1.8–2.0 (Stahl et al. 2010; van Belle, Meinel & Meinel 2004); " +
   "ground observatories D^2.5–2.8 (Meinel 1979). Default 2.25 adds the pointing burden — " +
   "beamwidth ∝ λ/D, so aiming tightens as the aperture grows."],
  ["betaP", "Laser cost exponent βP", 0.1],
  ["rhoGain", "Photon-efficiency headroom ×", 1],
];

export function renderFTradePanel(body) {
  if (body.dataset.rendered) { refresh(body); return; }
  body.dataset.rendered = "1";
  const a = (body._assumptions = { ...DEFAULTS, shares: { ...DEFAULTS.shares } });

  const inputs = FIELDS.map(([key, label, step, tip]) =>
    `<label class="ftrade-field"${tip ? ` title="${tip}"` : ""}>${label}${tip ? " ⓘ" : ""}
       <input type="number" data-key="${key}" value="${a[key]}" step="${step}" min="0">
     </label>`).join("");

  body.innerHTML = `
    <div class="report ftrade">
      <p class="muted">Analytic technology-factor trade — <strong>scaling laws only, no simulation</strong>.
      Each family's fleet is the sum of its network sections' scaling laws, anchored at f = ×128
      (concentric relay: optimized fit, 5 terminals/sat · transfer rings: S²/R, 3 · planetary rings: 3 ·
      junction rings: 2), and capacities rescale linearly in f. Program cost = per-section hardware +
      mass-aware launch under Wright's law. The first-terminal cost is rebuilt per f from components
      (telescope · laser · modulation · receiver · converter), un-learning the Starlink-class volume
      price back to a first unit. ⚑ marks cells that violate a stated assumption (hover for which).</p>
      <div class="ftrade-form">
        ${inputs}
        <label class="ftrade-field ftrade-check">
          <input type="checkbox" data-key="includeLaunch"${a.includeLaunch ? " checked" : ""}> Include launch cost
        </label>
        <label class="ftrade-field ftrade-check">
          <input type="checkbox" data-key="legacyTerminals"${a.legacyTerminals ? " checked" : ""}> Flat $0.2M terminals (baseline comparison)
        </label>
        <div class="ftrade-field ftrade-check">
          <button type="button" class="btn ftrade-reset" title="Restore every assumption to the Starlink-anchored defaults">Reset to Starlink baseline</button>
        </div>
      </div>
      <div class="ftrade-out"></div>
    </div>`;

  body.querySelectorAll("input[data-key]").forEach((el) => {
    el.addEventListener("input", () => {
      const key = el.dataset.key;
      if (el.type === "checkbox") a[key] = el.checked;
      else if (el.value !== "" && isFinite(+el.value)) a[key] = +el.value;
      refresh(body);
    });
  });
  // The ring-count input lives inside the re-rendered output — delegate, and
  // restore focus after the refresh replaces the element under the cursor.
  body.querySelector(".ftrade-out").addEventListener("input", (e) => {
    if (e.target.dataset.key !== "ringCount") return;
    const v = parseInt(e.target.value, 10);
    if (v >= 1) a.ringCount = v;
    refresh(body);
    body.querySelector('input[data-key="ringCount"]').focus(); // number inputs don't support selection ranges
  });
  body.querySelector(".ftrade-reset").addEventListener("click", () => {
    Object.assign(a, DEFAULTS, { shares: { ...DEFAULTS.shares } });
    body.querySelectorAll("input[data-key]").forEach((el) => {
      if (el.type === "checkbox") el.checked = a[el.dataset.key];
      else el.value = a[el.dataset.key];
    });
    refresh(body);
  });
  refresh(body);
}

function refresh(body) {
  const a = body._assumptions;
  const out = body.querySelector(".ftrade-out");
  out.innerHTML =
    ladderTable(a) +
    deployTable(a, terminalForFactor(100, a)) +
    familyTable("concentric", a) +
    familyTable("transfer", a) +
    `<p class="muted">Anchors: Starlink-class ×1 baseline (monostatic ${DEFAULTS.apertureMm} mm-class,
     100 Gbps; volume price un-learned over ${fmt(a.starlinkN0)} units →
     first unit $${(a.termVolM * Math.pow(a.starlinkN0, -Math.log2(a.wright))).toFixed(2)}M).
     DSOC flight transceiver (22 cm, 4 W, photon-counting; program $206M) bounds the flagship end.
     Telescope cost exponent βD: space assemblies ≈ D^1.8–2.0 (Stahl et al. 2010; van Belle,
     Meinel &amp; Meinel 2004), ground D^2.5–2.8 (Meinel 1979); the default adds the λ/D pointing
     burden. Terminal budget per satellite — concentric relay 5: two radial (relay chain), two
     azimuthal (in-ring links: aggregate parallel routes for an in-transit spacecraft; later the
     feeders into V2 transfer rings), one dedicated to in-transit spacecraft; transfer 3: two
     in-ring, one opportunistic (by position: planetary-ring junction / cross-ring link / spacecraft
     service); planetary rings 3; junction rings 2. Satellite bus, launch, planetary-ring and relay
     laws as in the paper's cost model. Launch mirrors the website's deployment model analytically:
     per section, the Starship flies the first Hohmann burn (transfer-family: the ellipse injection;
     Earth ring: the 3.2 km/s escape) with a symmetric return and a ${DEFAULTS.landingPropT} t landing
     reserve; the satellites fly the second burn, inclination, station-keeping and end-of-life return
     on their own electric propulsion; tanker count = mission propellant ÷ the per-launch payload;
     every launch (deploy + tanker) is priced under Wright's law.</p>`;
}
