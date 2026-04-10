// launchPlanner.js
//
// Builds a per-flight deployment plan using:
//   - A deficit round-robin scheduler across three pools (earth, mars, relay)
//   - Round-robin relay sub-selection across relay rings
//   - Per-flight Hohmann transfers using Earth's instantaneous heliocentric
//     distance (r1) and the target ring's heliocentric distance at arrival (r2)
//   - Per-flight profile computation through simDeployment.getFlightProfile
//     so payload (sats-per-flight) and tanker count vary with delta-V
//
// Output: a Map<ringName, Array<flight>> where each flight carries launchDate,
// arrivalDate, per-flight delta-V, profile (vehicles/propellant), sats deployed,
// cycleSize (1 + tankersPerFlight), and the two burn positions (for charting).

import { calculateHohmannDeltaV_km_s } from "./simDeltaV.js?v=4.3";
import { helioCoords, positionFromSolarAngle } from "./simOrbits.js?v=4.3";
import { hohmannGeometry, earthPositionAt } from "./hohmannTransfer.js?v=4.3";
import { ESCAPE_BURN_DV_KM_S } from "./simDeployment.js?v=4.3";

const MS_PER_DAY = 86400000;

function classifyRing(ringName) {
  if (ringName === "ring_earth") return "earth";
  if (ringName === "ring_mars") return "mars";
  return "relay";
}

/**
 * For a given launch date, resolve the arrival date and heliocentric r2 at
 * arrival by iterating the Hohmann transfer time a few times. Works for both
 * Mars and relay rings (anything with real Keplerian elements).
 *
 * Returns { r1, r2, arrivalDate, transferDays, earthPos, targetPos }.
 */
function resolveTransferGeometry(launchDate, earthElements, targetElements) {
  const earthPos = earthPositionAt(earthElements, launchDate);
  let r1 = Math.sqrt(earthPos.x * earthPos.x + earthPos.y * earthPos.y);
  if (!Number.isFinite(r1) || r1 <= 0) r1 = 1; // sane fallback

  // --- Hohmann: burn 2 is always 180° from burn 1 ---
  //
  // 1. Earth's heliocentric angle at departure.
  const earthAngleDeg = ((Math.atan2(earthPos.y, earthPos.x) * 180 / Math.PI) % 360 + 360) % 360;
  // 2. The arrival point is 180° opposite on the target orbit.
  const arrivalAngleDeg = (earthAngleDeg + 180) % 360;
  // 3. Read the target orbit's actual position at that angle. This gives
  //    burn 2's heliocentric XY and — crucially — the correct r2 for
  //    eccentric target orbits.
  let r2;
  let targetPos;
  if (targetElements) {
    const p = positionFromSolarAngle(targetElements, arrivalAngleDeg);
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      targetPos = { x: p.x, y: p.y };
      r2 = Math.sqrt(p.x * p.x + p.y * p.y);
    }
  }
  if (!r2 || !Number.isFinite(r2) || r2 <= 0) {
    r2 = targetElements && typeof targetElements.a === "number" ? targetElements.a : 1;
    targetPos = { x: -r2 * Math.cos(earthAngleDeg * Math.PI / 180),
                  y: -r2 * Math.sin(earthAngleDeg * Math.PI / 180) };
  }
  // 4. Transfer time from Hohmann formula.
  const geom = hohmannGeometry(r1, r2);
  const transferDays = Number.isFinite(geom.transferTimeDays) && geom.transferTimeDays > 0
    ? geom.transferTimeDays : 0;
  const arrivalDate = new Date(launchDate.getTime() + transferDays * MS_PER_DAY);

  return { r1, r2, arrivalDate, transferDays, earthPos, targetPos };
}

/**
 * Build a synthetic orbit pair for `calculateHohmannDeltaV_km_s` that uses
 * instantaneous radii as if both orbits were circular, preserving the target
 * ring's inclination so the plane-change cost is still computed.
 */
function computeOutboundDeltaVForTransfer(r1, r2, targetInclinationDeg) {
  return calculateHohmannDeltaV_km_s(
    { a: r1, e: 0, i: 0 },
    { a: r2, e: 0, i: targetInclinationDeg || 0 }
  );
}

/**
 * Plan all deployment flights for all rings.
 *
 * @param {Object} opts
 * @param {Array}  opts.orderedRings - result-tree entries (must contain ringName + satCount)
 * @param {Map<string,Object>} opts.ringElementsByName - real Keplerian elements per ring
 * @param {Object} opts.earthElements
 * @param {Object} opts.schedule - createLaunchSchedule() result
 * @param {Object} opts.simDeployment - configured SimDeployment instance
 * @returns {{ ringFlights: Map<string, Array>, stats: Object }}
 */
export function planLaunches({ orderedRings, ringElementsByName, earthElements, schedule, simDeployment }) {
  // --- Pool setup ----------------------------------------------------------
  const poolTargets = { earth: 0, mars: 0, relay: 0 };
  const poolDelivered = { earth: 0, mars: 0, relay: 0 };
  const ringPool = new Map();
  const ringTarget = new Map();
  const ringDelivered = new Map();
  const ringFlights = new Map();

  for (const tree of orderedRings) {
    const pool = classifyRing(tree.ringName);
    ringPool.set(tree.ringName, pool);
    ringTarget.set(tree.ringName, tree.satCount);
    ringDelivered.set(tree.ringName, 0);
    ringFlights.set(tree.ringName, []);
    poolTargets[pool] += tree.satCount;
  }

  // Relay rings in report order (for round-robin sub-selection)
  const relayRings = orderedRings.filter((t) => classifyRing(t.ringName) === "relay");
  let relayCursor = 0;

  const earthRing = orderedRings.find((t) => t.ringName === "ring_earth");
  const marsRing = orderedRings.find((t) => t.ringName === "ring_mars");

  // Rings that failed to produce a valid flight profile get quarantined so
  // we don't repeatedly retry them and so earlier rings in the pool stay
  // schedulable. Sats in infeasible rings are subtracted from their pool
  // targets so the scheduler doesn't stall waiting for an unreachable total.
  const infeasibleRings = new Set();
  const markRingInfeasible = (ringName) => {
    if (infeasibleRings.has(ringName)) return;
    infeasibleRings.add(ringName);
    const pool = ringPool.get(ringName);
    const target = ringTarget.get(ringName) || 0;
    const delivered = ringDelivered.get(ringName) || 0;
    // Shrink the pool target to the already-delivered count so the ratio
    // check and pool-full check both see this ring as done.
    poolTargets[pool] -= (target - delivered);
    ringTarget.set(ringName, delivered);
    console.warn(`[launchPlanner] Ring ${ringName} marked infeasible (delivered ${delivered}/${target}).`);
  };

  // --- Scheduler loop ------------------------------------------------------
  let launchCounter = 0;
  let safety = 0;
  const SAFETY_MAX = 200000;

  while (safety++ < SAFETY_MAX) {
    // Figure out which pools still have capacity
    const candidates = [];
    if (earthRing && !infeasibleRings.has("ring_earth") && poolDelivered.earth < poolTargets.earth) {
      candidates.push({ pool: "earth", ratio: poolTargets.earth > 0 ? poolDelivered.earth / poolTargets.earth : 1 });
    }
    if (marsRing && !infeasibleRings.has("ring_mars") && poolDelivered.mars < poolTargets.mars) {
      candidates.push({ pool: "mars", ratio: poolTargets.mars > 0 ? poolDelivered.mars / poolTargets.mars : 1 });
    }
    if (poolTargets.relay > 0 && poolDelivered.relay < poolTargets.relay) {
      candidates.push({ pool: "relay", ratio: poolDelivered.relay / poolTargets.relay });
    }
    if (candidates.length === 0) break;

    // Pick the pool most behind its trend; on ties, prefer earth > mars > relay
    // (which matches the "report order" priority)
    candidates.sort((a, b) => a.ratio - b.ratio);
    const nextPool = candidates[0].pool;

    // Resolve destination ring for this launch
    let ring = null;
    if (nextPool === "earth") {
      ring = earthRing;
    } else if (nextPool === "mars") {
      ring = marsRing;
    } else {
      // Round-robin over relay rings that still need sats and aren't infeasible
      for (let attempt = 0; attempt < relayRings.length; attempt++) {
        const cand = relayRings[relayCursor];
        relayCursor = (relayCursor + 1) % relayRings.length;
        if (infeasibleRings.has(cand.ringName)) continue;
        if (ringDelivered.get(cand.ringName) < ringTarget.get(cand.ringName)) {
          ring = cand;
          break;
        }
      }
    }
    if (!ring) {
      // Relay pool has delivered < target but every relay ring is full or
      // infeasible — shouldn't happen in practice, but bail on the relay pool
      // rather than the entire scheduler so earth/mars can keep going.
      if (nextPool === "relay") {
        poolTargets.relay = poolDelivered.relay; // mark pool satisfied
        continue;
      }
      break;
    }

    // --- Per-flight delta-V + profile (iterative) -------------------------
    // There is a circular dependency:
    //   launchDate → Earth position → r1, r2 → delta-V → profile → cycleSize → launchDate
    // We iterate until cycleSize stabilises (usually 1-2 rounds).
    const targetElements = ringElementsByName.get(ring.ringName) || null;
    let cycleSize = 1; // initial guess (no tankers)
    let flightProfile = null;
    let outboundDeltaV, r1, r2, transferDays, earthPos, burn2Pos, arrivalDate, launchDate;
    let converged = false;

    for (let attempt = 0; attempt < 5; attempt++) {
      // Deployment date = last slot of the tanker+starship cycle
      const deploymentSlot = launchCounter + cycleSize;
      launchDate = schedule.dateForLaunchNumber(deploymentSlot) || schedule.startDate;

      if (ring.ringName === "ring_earth") {
        earthPos = earthPositionAt(earthElements, launchDate);
        r1 = Math.sqrt(earthPos.x * earthPos.x + earthPos.y * earthPos.y);
        r2 = r1;
        transferDays = 0;
        burn2Pos = earthPos;
        arrivalDate = new Date(launchDate.getTime());
        outboundDeltaV = {
          deltaV1: ESCAPE_BURN_DV_KM_S,
          deltaV2: 0,
          deltaV_inclination: 0,
          totalDeltaV: ESCAPE_BURN_DV_KM_S,
        };
      } else {
        const g = resolveTransferGeometry(launchDate, earthElements, targetElements);
        r1 = g.r1;
        r2 = g.r2;
        transferDays = g.transferDays;
        earthPos = g.earthPos;
        burn2Pos = g.targetPos;
        arrivalDate = g.arrivalDate;
        outboundDeltaV = computeOutboundDeltaVForTransfer(r1, r2, targetElements ? targetElements.i : 0);
      }

      // Compute remaining sats to decide the sat cap for this flight
      const remainingInRing = ringTarget.get(ring.ringName) - ringDelivered.get(ring.ringName);

      let newProfile;
      try {
        // First pass: uncapped, to find max payload capacity at this delta-V
        newProfile = simDeployment.getFlightProfile(targetElements || ring, outboundDeltaV);
      } catch (err) {
        console.warn(`[launchPlanner] getFlightProfile failed for ${ring.ringName} (dv=${outboundDeltaV.totalDeltaV}): ${err.message}`);
        markRingInfeasible(ring.ringName);
        break;
      }
      if (!newProfile || !newProfile.satCountPerDeploymentFlight || newProfile.satCountPerDeploymentFlight <= 0) {
        console.warn(`[launchPlanner] getFlightProfile returned 0 payload for ${ring.ringName} (dv=${outboundDeltaV.totalDeltaV}).`);
        markRingInfeasible(ring.ringName);
        break;
      }

      const maxSats = newProfile.satCountPerDeploymentFlight;
      const actualSats = Math.min(maxSats, remainingInRing);

      // Re-run with exact count if needed (last flight of a ring)
      if (actualSats < maxSats) {
        try {
          newProfile = simDeployment.getFlightProfile(targetElements || ring, outboundDeltaV, actualSats);
        } catch (err) {
          // Fall through with the uncapped profile
        }
      }

      const newCycleSize = 1 + countTankers(newProfile.vehicles);
      flightProfile = newProfile;

      if (newCycleSize === cycleSize) {
        converged = true;
        break;
      }
      cycleSize = newCycleSize;
    }

    if (!flightProfile || infeasibleRings.has(ring.ringName)) continue;

    const satsThisFlight = Math.max(0, Math.min(
      flightProfile.satCountPerDeploymentFlight,
      ringTarget.get(ring.ringName) - ringDelivered.get(ring.ringName)
    ));
    if (satsThisFlight <= 0) {
      markRingInfeasible(ring.ringName);
      continue;
    }

    const tankersPerFlight = countTankers(flightProfile.vehicles);

    // Commit the flight to the last slot of its tanker cycle.
    launchCounter += cycleSize;
    const deploymentLaunchN = launchCounter;
    // Re-anchor arrival to the committed launch date
    const committedArrival = new Date(launchDate.getTime() + transferDays * MS_PER_DAY);

    ringDelivered.set(ring.ringName, ringDelivered.get(ring.ringName) + satsThisFlight);
    poolDelivered[nextPool] += satsThisFlight;

    ringFlights.get(ring.ringName).push({
      flightIdx: ringFlights.get(ring.ringName).length + 1,
      launchNumber: deploymentLaunchN,
      pool: nextPool,
      launchDate,
      arrivalDate: committedArrival,
      transferDays,
      earthPos,
      burn2Pos,
      r1,
      r2,
      outboundDeltaV,
      cycleSize,
      tankersPerFlight,
      satsThisFlight,
      profile: flightProfile,
    });
  }

  if (safety >= SAFETY_MAX) {
    console.warn("[launchPlanner] Hit safety cap — scheduler did not terminate cleanly.");
  }

  // Diagnostic summary so we can see at a glance what got scheduled and why.
  const perRingSummary = [];
  for (const tree of orderedRings) {
    const flights = ringFlights.get(tree.ringName) || [];
    perRingSummary.push({
      ring: tree.ringName,
      pool: ringPool.get(tree.ringName),
      flights: flights.length,
      delivered: ringDelivered.get(tree.ringName) || 0,
      target: tree.satCount,
      infeasible: infeasibleRings.has(tree.ringName),
    });
  }
  console.log("[launchPlanner] plan summary:", {
    totalLaunches: launchCounter,
    poolTargets: { ...poolTargets },
    poolDelivered: { ...poolDelivered },
    rings: perRingSummary,
  });

  return {
    ringFlights,
    stats: {
      totalLaunches: launchCounter,
      poolTargets,
      poolDelivered,
    },
  };
}

/**
 * Count tanker vehicles in a profile's `vehicles` object.
 */
export function countTankers(vehicles) {
  return Object.keys(vehicles || {}).filter((k) => k.startsWith("Tanker")).length;
}

/**
 * Sum per-flight data for a ring into a ring-level aggregate that the existing
 * report UI can consume. Produces fields mirroring resultTrees so the totals
 * tables can be built from the aggregate.
 */
export function aggregateRingFromFlights(ringName, flights) {
  let deploymentFlights_count = flights.length;
  let satCount = 0;
  let totalTankers = 0;
  // Sum propellant by type across all flights (aggregate self-propulsion + tanker-carried
  // propellant through the 1st-flight cost model the report already uses).
  const propellant = {}; // { propellantType: { selfPropulsion_kg, tankerPropellant_kg } }

  for (const f of flights) {
    satCount += f.satsThisFlight;
    totalTankers += f.tankersPerFlight;
    for (const [vehicleId, data] of Object.entries(f.profile.vehicles)) {
      if (!propellant[data.propellantType]) {
        propellant[data.propellantType] = { selfPropulsion_kg: 0, tankerPropellant_kg: 0 };
      }
      // "data.count" on Tanker groupings is absent for a single flight — treat as 1.
      const count = data.count ? data.count : 1;
      propellant[data.propellantType].selfPropulsion_kg += count * (data.propellantLoaded_kg || 0);
      propellant[data.propellantType].tankerPropellant_kg += count * (data.tankerPropellant_kg || 0);
    }
  }

  // Representative per-flight sats — report UI displays this; we show an average.
  const avgSatsPerFlight =
    deploymentFlights_count > 0 ? Math.round(satCount / deploymentFlights_count) : 0;
  const avgTankersPerFlight =
    deploymentFlights_count > 0 ? totalTankers / deploymentFlights_count : 0;

  return {
    ringName,
    satCount,
    deploymentFlights_count,
    satCountPerDeploymentFlight: avgSatsPerFlight,
    tankersPerFlight: avgTankersPerFlight,
    totalTankerFlights: totalTankers,
    propellant,
  };
}
