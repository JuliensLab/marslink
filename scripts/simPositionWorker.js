// simPositionWorker.js — Web Worker for satellite position computation
// Runs helioCoords for all satellites off the main thread.

const PI = Math.PI;
const DEG_TO_RAD = PI / 180;
const JULIAN_DAY_UNIX_EPOCH = 2440587.5;

function helioCoords(ele, dateMs) {
  const daysSinceEpoch = dateMs / 86400000; // ms to days
  const julianDay = JULIAN_DAY_UNIX_EPOCH + daysSinceEpoch;
  const D = julianDay - ele.Dele;
  const Cy = D / 36525;

  const a = ele.a + (ele.a_rate || 0) * Cy;
  const e = ele.e + (ele.e_rate || 0) * Cy;
  const i = ele.i + (ele.i_rate || 0) * Cy;
  const p = ele.p + (ele.p_rate || 0) * Cy;
  const o = ele.o + (ele.o_rate || 0) * Cy;
  const l = ele.l + (ele.l_rate || 0) * Cy;

  let M = (ele.n * D + l - p) % 360;
  if (M < 0) M += 360;

  const e2 = e * e;
  const e3 = e2 * e;
  const M_rad = M * DEG_TO_RAD;
  const sinM = Math.sin(M_rad);
  const sin2M = Math.sin(2 * M_rad);
  const sin3M = Math.sin(3 * M_rad);

  const trueAnomaly = M + (180 / PI) * ((2 * e - e3 / 4) * sinM + (5 / 4) * e2 * sin2M + (13 / 12) * e3 * sin3M);
  const trueAnomaly_rad = trueAnomaly * DEG_TO_RAD;
  const cosTrueAnomaly = Math.cos(trueAnomaly_rad);
  const r = (a * (1 - e2)) / (1 + e * cosTrueAnomaly);

  let vpo = (trueAnomaly + p - o) % 360;
  if (vpo < 0) vpo += 360;
  let solarAngle = (vpo + o) % 360;
  if (solarAngle < 0) solarAngle += 360;

  const oRad = o * DEG_TO_RAD;
  const iRad = i * DEG_TO_RAD;
  const vpoRad = vpo * DEG_TO_RAD;

  const cosORad = Math.cos(oRad);
  const sinORad = Math.sin(oRad);
  const cosVpoRad = Math.cos(vpoRad);
  const sinVpoRad = Math.sin(vpoRad);
  const cosIRad = Math.cos(iRad);
  const sinIRad = Math.sin(iRad);

  const x = r * (cosORad * cosVpoRad - sinORad * sinVpoRad * cosIRad);
  const y = r * (sinORad * cosVpoRad + cosORad * sinVpoRad * cosIRad);
  const z = r * (sinVpoRad * sinIRad);

  return { x, y, z, vpo, solarAngle };
}

// Satellite orbital element data — set via 'setSatellites' message
let satellites = null;

self.onmessage = function (e) {
  const { type, data } = e.data;

  if (type === "setSatellites") {
    // Receive serialized satellite array (orbital elements only)
    satellites = data;
    return;
  }

  if (type === "computePositions") {
    if (!satellites || satellites.length === 0) {
      self.postMessage({ type: "positions", positions: null });
      return;
    }

    const dateMs = data.dateMs;
    const count = satellites.length;
    // Pack into flat Float64Array: [x, y, z, vpo, solarAngle] per satellite
    const buf = new Float64Array(count * 5);

    for (let i = 0; i < count; i++) {
      const pos = helioCoords(satellites[i], dateMs);
      const off = i * 5;
      buf[off] = pos.x;
      buf[off + 1] = pos.y;
      buf[off + 2] = pos.z;
      buf[off + 3] = pos.vpo;
      buf[off + 4] = pos.solarAngle;
    }

    // Transfer the buffer for zero-copy
    self.postMessage({ type: "positions", buffer: buf.buffer, count }, [buf.buffer]);
  }
};
