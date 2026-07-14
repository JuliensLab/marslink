/***********************************************
 * simDisplay-2d.js
 *
 * 2D (canvas-based) display of the solar system,
 * with pan and zoom (mouse & touch).
 ***********************************************/

import { SimSolarSystem } from "./simSolarSystem.js?v=4.35";
import { createCarModel } from "./modelCar.js?v=4.35";
import { positionFromSolarAngle } from "./simOrbits.js?v=4.35";
import { stationKeepingAccel, GM, sampleThrustField, marchingSquares, satSchemeT, rampRGB, OVER_BUDGET_RGB, isThrustScheme, satStationKeeping, satTotalProp, G0, SECONDS_PER_YEAR } from "./simStationKeeping.js?v=4.35";

// Per-option style for the Display "Reference lines". tag===null → label both endpoints
// with their angle (a symmetric node line); otherwise label only the n1 end with the tag.
const REFERENCE_LINE_STYLES = {
  "Closest approach": { color: "#5dd6a0", tag: "closest" },
  "Mars apsides": { color: "#4fc3d8", tag: "peri" },
  "Plane nodes": { color: "#d8b85a", tag: null },
  "Earth apsides": { color: "#e0795a", tag: "E peri" },
};

/**
 * Converts astronomical units (AU) to 3D units using a scale factor.
 * Retained here for compatibility with the existing code,
 * though in this 2D version, it just returns the same value.
 *
 * @param {number} au - Distance in astronomical units.
 * @returns {number} Distance in "3D units" (in practice, the same number here).
 */
export function auTo3D(au) {
  return au;
}

/**
 * Converts kilometers to astronomical units (AU).
 *
 * @param {number} km - Distance in kilometers.
 * @returns {number} Distance in AU.
 */
export function kmToAu(km) {
  return km / 149597871;
}

/**
 * Converts kilometers to "3D units" (AU in this case).
 *
 * @param {number} km - Distance in kilometers.
 * @returns {number} Distance in "3D units" (AU).
 */
export function kmTo3D(km) {
  return kmToAu(km);
}

/**
 * Scaling factors (these remain for consistency,
 * though 2D display might not rely on them exactly
 * in the same way).
 */
export let sunScaleFactor = 1;
export let planetScaleFactor = 1;
export let satelliteScaleFactor = 1;

// Superscript formatting for compact iso-thrust labels (e.g. "3.7×10⁻⁷ m/s²").
const _SUP = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
function supStr(n) {
  return String(n).split("").map((ch) => _SUP[ch] || ch).join("");
}
function formatAccel(a) {
  const exp = Math.floor(Math.log10(a));
  const mant = a / Math.pow(10, exp);
  return `${mant.toFixed(1)}×10${supStr(exp)} m/s²`;
}

// Format a duration given in years into the largest sensible unit: years → months
// → days → hours → minutes (so a < 1 yr station-keeping life reads naturally).
function fmtDuration(yr) {
  if (!isFinite(yr)) return "∞";
  const f = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
  if (yr >= 1) return f(yr) + "y";
  const mo = yr * 12;
  if (mo >= 1) return f(mo) + "mo";
  const d = yr * 365.25;
  if (d >= 1) return f(d) + "d";
  const h = d * 24;
  if (h >= 1) return f(h) + "h";
  return f(h * 60) + "min";
}

export class SimDisplay {
  /**
   * Creates an instance of SimDisplay (2D).
   *
   * @param {HTMLElement} container - The DOM element to which the canvas will be appended.
   *                                   Defaults to document.body if not provided.
   */
  constructor(container = document.body) {
    this.styles = {
      links: {
        inactive: { color: 0xff0000, opacity: 0.1 },
        active: {
          colormax: 0xff0000,
          colormin: 0x7799ff,
          opacity: 0.8,
          gbpsmax: 1,
          gbpsmin: 0.1,
        },
      },
    };

    // === Create Canvas for 2D rendering ===
    this.canvas = document.createElement("canvas");
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    container.appendChild(this.canvas);

    // Get 2D drawing context
    this.ctx = this.canvas.getContext("2d");

    // === Solar System Data ===
    this.simSolarSystem = new SimSolarSystem();
    this.solarSystemData = this.simSolarSystem.getSolarSystemData();

    // Maintain references for usage
    this.planets = {};
    this.possibleLinks = [];
    this.activeLinks = [];
    this.planetPositions = {};
    this.thrustBodies = []; // bodies whose gravity is contoured in 2D ([] = hidden)
    this.satPhysics = null; // ringName -> { dryMass, nRing, skPropRing, aThreshold, ports }
    this.skCfg = { F: 0.17, tm: 15, maxN: 64, n: 5, isp: 2500, capacity: 1500 };
    this.showPlanetOrbits = false;
    this.geoOrbits = []; // bodies whose planet-centric orbit circle is drawn — geo/areostationary + Moon (true scale)
    this.satLabelMode = false; // per-satellite value labels (S key)
    this.satThrusterMax = 1;   // fleet max thruster count (Thrusters colour scale)
    this.satLaserMax = 1;      // fleet max laser terminals (Lasers colour scale)
    this.satLaserValues = [1];
    this.satellitePositions = [];
    this.satellites = [];

    // --- NEW: Store pan and zoom state ---
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;

    // --- NEW: Mouse and touch state for dragging ---
    this.isDragging = false;
    this.isTouchDragging = false;
    this.lastX = 0;
    this.lastY = 0;
    // For pinch-zoom (optional):
    this.touchDistance = 0; // tracks distance between 2 fingers

    // === Resize Listener ===
    window.addEventListener("resize", this.onWindowResize.bind(this), false);

    // --- NEW: Setup mouse / touch event listeners ---
    this.setupInteractionEvents();

    // === Begin Animation Loop ===
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  dispose() {
    if (this.canvas) {
      this.canvas.remove(); // Remove the 2D canvas
    }
  }
  /**
   * --- NEW: Setup mouse and touch event listeners for pan & zoom. ---
   */
  setupInteractionEvents() {
    // Prevent default gestures on the canvas for mobile (esp. pinch/zoom).
    this.canvas.style.touchAction = "none";

    // Mouse down
    this.canvas.addEventListener("mousedown", (e) => {
      // Only start dragging if Ctrl is pressed (per requirement)
      // if (e.ctrlKey) {
      this.isDragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // }
    });

    // Mouse move
    this.canvas.addEventListener("mousemove", (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.panX += dx;
        this.panY += dy;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    });

    // Mouse up
    this.canvas.addEventListener("mouseup", () => {
      this.isDragging = false;
    });

    // Mouse wheel for zoom
    // Use { passive: false } so we can prevent default scroll.
    // Mouse wheel for zoom where the mouse is pointing
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();

        // 1) Get mouse position in canvas coords
        const mouseX = e.clientX;
        const mouseY = e.clientY;

        // Save old zoom so we can compute ratio
        const oldZoom = this.zoom;
        const zoomFactor = 1.05;

        // 2) Zoom in if scrolling up, out if scrolling down
        if (e.deltaY < 0) {
          this.zoom *= zoomFactor;
        } else {
          this.zoom /= zoomFactor;
        }
        // (Optional) clamp zoom
        // this.zoom = Math.max(0.05, Math.min(this.zoom, 50));

        // 3) Convert the mouse position to "world" coordinates before the zoom change
        //
        //    Remember your drawing transform is:
        //      canvasX = (width/2 + panX) - worldX * (baseScaleAUtoPX * zoom)
        //      canvasY = (height/2 + panY) + worldY * (baseScaleAUtoPX * zoom)
        //
        //    So we invert that to get:
        //      worldX = (centerX - canvasX) / (baseScaleAUtoPX * zoom)
        //      worldY = (canvasY - centerY) / (baseScaleAUtoPX * zoom)
        //
        const { width, height } = this.canvas;

        const baseScaleAUtoPX = 300; // or whatever base scale you use
        const oldCenterX = width / 2 + this.panX;
        const oldCenterY = height / 2 + this.panY;

        const worldX = (oldCenterX - mouseX) / (baseScaleAUtoPX * oldZoom);
        const worldY = (mouseY - oldCenterY) / (baseScaleAUtoPX * oldZoom);

        // 4) After changing the zoom, compute new panX/panY so that
        //    "worldX, worldY" still appears under the mouseX, mouseY.
        //
        //    We want:
        //       mouseX = newCenterX - worldX * (baseScaleAUtoPX * newZoom)
        //       mouseY = newCenterY + worldY * (baseScaleAUtoPX * newZoom)
        //
        //    newCenterX = (width/2 + this.panX)
        //    newCenterY = (height/2 + this.panY)
        //
        const newZoom = this.zoom;
        const newScaleAUtoPX = baseScaleAUtoPX * newZoom;

        // Solve for panX so that the canvasX stays the same for worldX.
        //   mouseX = (width/2 + panX) - worldX * newScaleAUtoPX
        // => panX   = mouseX + worldX * newScaleAUtoPX - width/2
        this.panX = mouseX + worldX * newScaleAUtoPX - width / 2;

        // Solve for panY so that the canvasY stays the same for worldY.
        //   mouseY = (height/2 + panY) + worldY * newScaleAUtoPX
        // => panY   = mouseY - worldY * newScaleAUtoPX - height/2
        this.panY = mouseY - worldY * newScaleAUtoPX - height / 2;
      },
      { passive: false }
    );

    // Touch start
    this.canvas.addEventListener("touchstart", (e) => {
      // If single touch => drag
      if (e.touches.length === 1) {
        this.isTouchDragging = true;
        this.lastX = e.touches[0].clientX;
        this.lastY = e.touches[0].clientY;
      }
      // If two touches => pinch-zoom
      else if (e.touches.length === 2) {
        this.isTouchDragging = false;
        this.touchDistance = this.getTouchDistance(e.touches);
      }
    });

    // Touch move
    this.canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1 && this.isTouchDragging) {
        const dx = e.touches[0].clientX - this.lastX;
        const dy = e.touches[0].clientY - this.lastY;
        this.panX += dx;
        this.panY += dy;
        this.lastX = e.touches[0].clientX;
        this.lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        // pinch-zoom
        const newDist = this.getTouchDistance(e.touches);
        const zoomFactor = newDist / this.touchDistance;
        this.zoom *= zoomFactor;
        // optionally clamp zoom
        // this.zoom = Math.max(0.05, Math.min(this.zoom, 50));

        this.touchDistance = newDist;
      }
      e.preventDefault();
    });

    // Touch end
    this.canvas.addEventListener("touchend", (e) => {
      if (e.touches.length === 0) {
        this.isTouchDragging = false;
      }
      // If 1 finger lifts but 1 remains, you might want to reset pinch state
      if (e.touches.length < 2) {
        this.touchDistance = 0;
      }
    });
  }

  /**
   * --- NEW: Utility to get distance between two touch points (for pinch-zoom). ---
   */
  getTouchDistance(touches) {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Sets up satellites in an internal array for 2D rendering.
   * @param {Array} satellites - Array of satellite objects with properties:
   *                             { color, position, name }.
   */
  setSatellites(satellites) {
    this.satellites = satellites;
  }

  setLinksColors(type) {
    // Set the links material based on the type
    this.linksColorsType = type;
    this.drawSolarSystem();
  }

  setSatelliteColorMode(mode) {
    // 2D display doesn't use satellite colors
    this.satelliteColorMode = mode;
    this.drawSolarSystem();
  }

  setThrustBodies(value) {
    // Accept a comma string ("Sun,Earth") or an array of body names.
    const arr = Array.isArray(value) ? value : String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
    this.thrustBodies = arr;
    this.drawSolarSystem();
  }

  setSatellitePhysics(map, cfg) {
    this.satPhysics = map;
    if (cfg) this.skCfg = cfg;
  }

  setPlanetOrbits(value) {
    this.showPlanetOrbits = Array.isArray(value) ? value.length > 0 : !!(value && String(value).length);
    this.drawSolarSystem();
  }

  // Reference lines: a comma-list (or array) of enabled option labels + an angles map
  // { "<label>": {n1, n2} } for all options. Draws only the enabled ones.
  setReferenceLines(value, angles) {
    this.referenceLines = Array.isArray(value) ? value : String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
    this.referenceLineAngles = angles || {};
    this.drawSolarSystem();
  }

  setGeostationaryOrbits(value) {
    this.geoOrbits = Array.isArray(value) ? value : String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
    this.drawSolarSystem();
  }

  setSatLabelMode(on) {
    this.satLabelMode = !!on;
    this.drawSolarSystem();
  }

  /** Short value string for a satellite under the current colour mode (S labels). */
  satLabelText(satellite, pos) {
    const mode = this.satelliteColorMode;
    if (mode === "Quad") {
      const sa = ((((satellite.position && satellite.position.solarAngle) || 0) % 360) + 360) % 360;
      return "Q" + Math.floor(sa / 90);
    }
    if (mode === "Zone") {
      const z = satellite.orbitalZone;
      return z ? ({ INSIDE_EARTH: "<E", BETWEEN_EARTH_AND_MARS: "E–M", OUTSIDE_MARS: ">M", EARTH_RING: "Er", MARS_RING: "Mr" }[z] || "?") : "?";
    }
    if (mode === "Suit") {
      const s = satellite.suitable;
      if (!s) return "–";
      const e = s.includes("Earth"), m = s.includes("Mars");
      return e && m ? "EM" : e ? "E" : m ? "M" : "–";
    }
    const ring = this.satPhysics && this.satPhysics[satellite.ringName];
    if (!ring) return null;
    if (mode === "Lasers") return String(ring.ports || 0);
    const a = stationKeepingAccel(pos, this.planetPositions);
    const isPlanetary = satellite.ringName === "ring_earth" || satellite.ringName === "ring_mars";
    const { N, skProp, m } = satStationKeeping(a, ring.dryMass, ring, isPlanetary, this.skCfg);
    const favail = N * this.skCfg.F;
    if (mode === "Thrusters") return String(N);
    if (mode === "Accel") return a.toExponential(1);
    if (mode === "Thrust") { const mn = m * a * 1000; return (mn < 10 ? mn.toFixed(1) : Math.round(mn)) + "mN"; }
    if (mode === "Thrust%") return Math.round((m * a) / favail * 100) + "%";
    if (mode === "Time") {
      const mThr = m - skProp; // mass once SK propellant is spent
      const yr = (a > 0 && mThr > 0) ? (this.skCfg.isp * G0 / a) * Math.log(m / mThr) / SECONDS_PER_YEAR : Infinity;
      return fmtDuration(yr);
    }
    if (mode === "Mass") return Math.round(m) + "kg";
    if (mode === "SKprop") return Math.round(skProp) + "kg";
    if (mode === "Totprop") return Math.round(satTotalProp(ring, skProp, isPlanetary)) + "kg";
    return null;
  }

  /**
   * Sets the size factors for sun and planets.
   *
   * @param {number} sunFactor - Multiplier for sun size.
   * @param {number} planetsFactor - Multiplier for planets size.
   */
  setSizeFactors(sunFactor, planetsFactor, satellitesFactor) {
    sunScaleFactor = 1 * sunFactor;
    planetScaleFactor = 1 * planetsFactor;
    satelliteScaleFactor = 1 * satellitesFactor;
  }

  /**
   * Updates the positions of planets and satellites (in 2D memory).
   * @param {Object} planets - An object mapping planet names to objects like { name, position }.
   * @param {Array} satellites - Array of satellite objects [{ name, position }, ...].
   */
  updatePositions(planets, satellites) {
    // Store planet positions
    for (let planet of Object.values(planets)) {
      this.planetPositions[planet.name] = planet.position;
    }

    // Store satellite positions
    this.satellitePositions = {};
    for (let satellite of satellites) {
      this.satellitePositions[satellite.name] = satellite.position;
    }

    // Update links so they know where to draw
    this.updateLinksPositions();
  }

  /**
   * Updates the list of all possible links (inactive + active).
   * @param {Array} links - Array of link objects.
   */
  updatePossibleLinks(links) {
    this.possibleLinks = links;
  }

  /**
   * Updates the list of active links.
   * @param {Array} links - Array of link objects.
   */
  updateActiveLinks(links) {
    this.activeLinks = links;
  }

  /**
   * Updates link positions - in 2D, this simply triggers re-render
   * with the new data stored in `possibleLinks` and `activeLinks`.
   */
  updateLinksPositions() {
    // Nothing special needed here; data is read each draw cycle.
  }

  /**
   * Handles window resize events to adjust the canvas size.
   */
  onWindowResize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  /**
   * Clears all objects from a given group (not used in 2D).
   * This is retained for API compatibility with the 3D version.
   * @param {Object} group - Unused in 2D.
   */
  clearGroup(group) {
    // Not applicable in 2D canvas, but kept for compatibility.
  }

  /**
   * The animation loop for continuously rendering the 2D scene.
   */
  animate() {
    // Clear the canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw the solar system scene in 2D
    this.drawSolarSystem();

    // Request the next frame
    requestAnimationFrame(this.animate);
  }

  /**
   * Draw 20 iso-acceleration contours of the combined gravity field
   * a = Σ G·M/ρ² of the user-selected bodies (`this.thrustBodies`, a subset of
   * Sun/Earth/Mars/Jupiter). Levels are log-spaced across the field's actual
   * range, so 20 zones are always visible. A coarse global grid handles the
   * smooth far field; a fine sub-grid sampled in a box around each body keeps the
   * tight near-body contours smooth instead of polygonal. Cached (throttled) —
   * only the AU→screen transform runs per frame, so pan/zoom stay cheap.
   *
   * @param {number} centerX - screen x of the Sun (px)
   * @param {number} centerY - screen y of the Sun (px)
   * @param {number} scale   - AU→px scale factor (baseScale * zoom)
   */
  drawThrustZones(centerX, centerY, scale) {
    const N = 20;            // always 20 zones
    const GRID = 180;        // coarse grid samples per axis
    const GRIDF = 160;       // fine grid samples per axis (per body)

    const bodies = this.thrustBodies || [];
    const sig = bodies.slice().sort().join(",");

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!this._contour) this._contour = { ms: -1e9, sig: null, colors: [], segs: [], labels: [] };
    const c = this._contour;
    // Recompute the (slowly-varying) field+contours only on body change or throttle.
    if (c.sig !== sig || now - c.ms > 400) {
      if (!this._contourField || this._contourField.length !== GRID * GRID) {
        this._contourField = new Float32Array(GRID * GRID);
      }
      if (!this._fineField || this._fineField.length !== GRIDF * GRIDF) {
        this._fineField = new Float32Array(GRIDF * GRIDF);
      }
      // Selected bodies → { name: G·M }, positions (Sun at origin), and box centres.
      const gmSel = {}, posSel = {}, centers = [];
      let maxDist = 0;
      for (const name of bodies) {
        if (GM[name] === undefined) continue;
        const pos = name === "Sun" ? { x: 0, y: 0, z: 0 } : this.planetPositions[name];
        if (!pos) continue;
        gmSel[name] = GM[name];
        posSel[name] = pos;
        centers.push(pos);
        const d = Math.hypot(pos.x, pos.y);
        if (d > maxDist) maxDist = d;
      }

      // Region grows to enclose the farthest selected body (e.g. Jupiter ~5.2 AU);
      // the ±2.2 AU floor keeps inner-system resolution high for inner-only sets.
      const R = Math.max(2.2, maxDist + 0.8);
      const x0 = -R, y0 = -R;
      const dx = (2 * R) / (GRID - 1), dy = dx;
      const RBOX = Math.max(0.2, dx * 6); // fine box spans ~6 coarse cells

      // --- Coarse global field + adaptive log-spaced levels ---
      const field = this._contourField;
      sampleThrustField(field, GRID, GRID, x0, y0, dx, dy, posSel, gmSel);
      let fmin = Infinity, fmax = 0;
      for (let i = 0; i < field.length; i++) { const v = field[i]; if (v < fmin) fmin = v; if (v > fmax) fmax = v; }
      const levels = [];
      if (fmax > 0 && fmax > fmin) {
        const lnMin = Math.log10(Math.max(fmin, fmax * 1e-9)); // guard a tiny/zero floor
        const lnMax = Math.log10(fmax);
        for (let i = 0; i < N; i++) {
          const t = (i + 0.5) / N;
          levels.push(Math.pow(10, lnMin + t * (lnMax - lnMin)));
        }
      }

      c.colors = levels.map((L, i) => {
        // Green (low) → amber → red (high), spread evenly over the 20 zones.
        const t = N > 1 ? i / (N - 1) : 0;
        const r = Math.round(220 * Math.min(1, t * 2));
        const g = Math.round(160 * Math.min(1, (1 - t) * 2));
        return `rgb(${r},${g},0)`;
      });

      // --- Segments per level: coarse OUTSIDE the body boxes, fine INSIDE them ---
      const inBox = (mx, my) => {
        for (let b = 0; b < centers.length; b++) {
          if (Math.abs(mx - centers[b].x) < RBOX && Math.abs(my - centers[b].y) < RBOX) return true;
        }
        return false;
      };
      const segsByLevel = levels.map(() => []);
      const tmp = [];
      for (let li = 0; li < levels.length; li++) {
        tmp.length = 0;
        marchingSquares(field, GRID, GRID, x0, y0, dx, dy, levels[li], tmp);
        const segs = segsByLevel[li];
        for (let k = 0; k < tmp.length; k += 4) {
          const mx = (tmp[k] + tmp[k + 2]) * 0.5, my = (tmp[k + 1] + tmp[k + 3]) * 0.5;
          if (!inBox(mx, my)) segs.push(tmp[k], tmp[k + 1], tmp[k + 2], tmp[k + 3]);
        }
      }
      // Fine refinement: a high-res box around each body (all selected bodies
      // still contribute to the field, so the seam at the box edge matches).
      const fine = this._fineField;
      const dxf = (2 * RBOX) / (GRIDF - 1), dyf = dxf;
      for (let b = 0; b < centers.length; b++) {
        const fx0 = centers[b].x - RBOX, fy0 = centers[b].y - RBOX;
        sampleThrustField(fine, GRIDF, GRIDF, fx0, fy0, dxf, dyf, posSel, gmSel);
        for (let li = 0; li < levels.length; li++) {
          marchingSquares(fine, GRIDF, GRIDF, fx0, fy0, dxf, dyf, levels[li], segsByLevel[li]);
        }
      }
      c.segs = segsByLevel;

      // --- Labels: one value label per contour, ≥150px apart GLOBALLY (across all
      // levels) so tight near-body rings don't stack into an unreadable mush.
      // Outer (low) levels are placed first; positions stored in AU. ---
      const minGap2 = (150 / scale) * (150 / scale);
      const placed = [], labels = [];
      for (let li = 0; li < levels.length; li++) {
        const segs = segsByLevel[li];
        if (!segs.length) continue;
        const text = formatAccel(levels[li]);
        const color = c.colors[li];
        for (let k = 0; k < segs.length; k += 4) {
          const mx = (segs[k] + segs[k + 2]) * 0.5, my = (segs[k + 1] + segs[k + 3]) * 0.5;
          let ok = true;
          for (let p = 0; p < placed.length; p++) {
            const ex = placed[p].x - mx, ey = placed[p].y - my;
            if (ex * ex + ey * ey < minGap2) { ok = false; break; }
          }
          if (ok) { placed.push({ x: mx, y: my }); labels.push({ x: mx, y: my, text, color }); }
        }
      }
      c.labels = labels;
      c.sig = sig;
      c.ms = now;
    }

    // --- Stroke contour lines ---
    this.ctx.save();
    this.ctx.globalAlpha = 0.7;
    this.ctx.lineWidth = 1.2;
    for (let li = 0; li < c.segs.length; li++) {
      const segs = c.segs[li];
      if (!segs.length) continue;
      this.ctx.strokeStyle = c.colors[li];
      this.ctx.beginPath();
      for (let k = 0; k < segs.length; k += 4) {
        this.ctx.moveTo(centerX - segs[k] * scale, centerY + segs[k + 1] * scale);
        this.ctx.lineTo(centerX - segs[k + 2] * scale, centerY + segs[k + 3] * scale);
      }
      this.ctx.stroke();
    }
    this.ctx.restore();

    // --- Value labels (number + unit) dropped into the gaps between lines ---
    this.ctx.save();
    this.ctx.font = "12.1px sans-serif"; // 11px + 10%
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    const W = this.canvas.width, H = this.canvas.height;
    for (let p = 0; p < c.labels.length; p++) {
      const lab = c.labels[p];
      const sx = centerX - lab.x * scale;
      const sy = centerY + lab.y * scale;
      if (sx < 36 || sx > W - 36 || sy < 10 || sy > H - 10) continue; // keep clear of edges
      const tw = this.ctx.measureText(lab.text).width;
      this.ctx.globalAlpha = 0.82;
      this.ctx.fillStyle = "#FFFFFF"; // pill clears the line so the number reads
      this.ctx.fillRect(sx - tw / 2 - 3, sy - 8, tw + 6, 16);
      this.ctx.globalAlpha = 1;
      this.ctx.fillStyle = lab.color;
      this.ctx.fillText(lab.text, sx, sy);
    }
    this.ctx.restore();
  }

  /**
   * Draw the solar system (sun, planets, satellites, links) in 2D,
   * top-down view, applying the current pan & zoom transforms.
   */
  drawSolarSystem() {
    const { width, height } = this.canvas;

    // Instead of using the direct center, we allow panning:
    const centerX = width / 2 + this.panX;
    const centerY = height / 2 + this.panY;

    // We'll scale the AU->pixels with the current zoom factor
    const baseScaleAUtoPX = 300; // base scale for 1 AU -> 300px
    const scaleAUtoPX = baseScaleAUtoPX * this.zoom;

    // === Draw background (simple fill) ===
    this.ctx.save();
    this.ctx.fillStyle = "#FFFFFF";
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.restore();

    // === Draw iso-thrust zones (contours of the selected bodies' gravity field) ===
    if (this.thrustBodies && this.thrustBodies.length > 0) this.drawThrustZones(centerX, centerY, scaleAUtoPX);

    // === Draw planet orbits (true ellipses sampled from the orbital elements) ===
    if (this.showPlanetOrbits) {
      this.ctx.save();
      this.ctx.strokeStyle = "rgba(120,120,120,0.5)";
      this.ctx.lineWidth = 1;
      const SEG = 180;
      for (let planetData of this.solarSystemData.planets) {
        if (planetData.shape !== "sphere" || !(planetData.a > 0)) continue;
        const aPx = planetData.a * scaleAUtoPX;
        if (aPx < 4 || aPx > 1e5) continue; // skip degenerate / off-canvas orbits
        this.ctx.beginPath();
        for (let k = 0; k <= SEG; k++) {
          // Sweep the true ecliptic longitude → real (eccentric) heliocentric position.
          const p = positionFromSolarAngle(planetData, (k / SEG) * 360);
          const px = centerX - auTo3D(p.x) * scaleAUtoPX; // same projection as the planet meshes
          const py = centerY + auTo3D(p.y) * scaleAUtoPX;
          if (k === 0) this.ctx.moveTo(px, py);
          else this.ctx.lineTo(px, py);
        }
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    // === Draw reference lines (through the Sun, ending on Mars's orbit) ===
    if (this.referenceLines && this.referenceLines.length && this.referenceLineAngles) {
      const mars = this.solarSystemData.planets.find((p) => p.name === "Mars");
      if (mars) {
        const proj = (ang) => {
          const p = positionFromSolarAngle(mars, ang);
          return [centerX - auTo3D(p.x) * scaleAUtoPX, centerY + auTo3D(p.y) * scaleAUtoPX];
        };
        // tag === null → label both endpoints with their angle (a symmetric node line).
        const STYLES = REFERENCE_LINE_STYLES;
        this.ctx.save();
        this.ctx.lineWidth = 1.5;
        this.ctx.font = "11px ui-monospace, monospace";
        this.ctx.textAlign = "center";
        for (const key of this.referenceLines) {
          const ang = this.referenceLineAngles[key], st = STYLES[key];
          if (!ang || !st) continue;
          const [x1, y1] = proj(ang.n1), [x2, y2] = proj(ang.n2);
          this.ctx.strokeStyle = st.color;
          this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(x2, y2); this.ctx.stroke();
          this.ctx.fillStyle = st.color;
          if (st.tag === null) {
            this.ctx.fillText(`${Math.round(ang.n1)}°`, x1, y1 - 5);
            this.ctx.fillText(`${Math.round(ang.n2)}°`, x2, y2 - 5);
          } else {
            this.ctx.fillText(`${st.tag} ${Math.round(ang.n1)}°`, x1, y1 - 5);
          }
        }
        this.ctx.restore();
      }
    }

    // === Draw Sun ===
    const sunData = this.solarSystemData.sun;
    const sunRadiusAU = kmTo3D(sunData.diameterKm / 2) * sunScaleFactor;
    // Use the same AU->px scale as positions (the old *0.1 made it sub-pixel/invisible).
    // The size slider (sunScaleFactor) is baked into sunRadiusAU, so it now actually scales.
    const sunDisplayRadius = Math.max(sunRadiusAU * scaleAUtoPX, 0.5);
    this.ctx.save();
    this.ctx.fillStyle = "#DDDD00";
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, sunDisplayRadius, 0, 2 * Math.PI);
    this.ctx.fill();
    this.ctx.restore();

    // === Draw Planets ===
    const planetColors = { Earth: "#2a6fdb", Mars: "#c0392b", Tesla: "#8e44ad" };
    for (let planetData of this.solarSystemData.planets) {
      const pos = this.planetPositions[planetData.name];
      if (!pos) continue;
      const isTesla = planetData.name === "Tesla";

      // Convert from AU to canvas coords
      const planetX = centerX - auTo3D(pos.x) * scaleAUtoPX;
      const planetY = centerY + auTo3D(pos.y) * scaleAUtoPX;

      // Use the same AU->px scale as positions; the size slider (planetScaleFactor) is
      // baked into planetRadiusAU so it now actually resizes the planets.
      const planetRadiusAU = kmTo3D(planetData.diameterKm / 2) * planetScaleFactor;
      const planetDisplayRadius = isTesla ? 2.5 : Math.max(planetRadiusAU * scaleAUtoPX, 0.5);

      // Draw (Tesla/Roadster shown as a small distinct marker, not skipped)
      this.ctx.save();
      this.ctx.fillStyle = planetColors[planetData.name] || "#000000";
      this.ctx.beginPath();
      this.ctx.arc(planetX, planetY, planetDisplayRadius, 0, 2 * Math.PI);
      this.ctx.fill();
      this.ctx.restore();
    }

    // === Draw planet-centric orbit circles (true scale, around the centre body) ===
    if (this.geoOrbits && this.geoOrbits.length) {
      // radius ÷ 1 AU, the body the circle is centred on, and stroke colour. Geo/areo-
      // stationary orbits ring their own planet; the Moon's orbit is centred on Earth.
      const REF = {
        Earth: { r: 2.8185e-4, center: "Earth", color: "rgba(0,170,210,0.9)" }, // geostationary
        Mars: { r: 1.3656e-4, center: "Mars", color: "rgba(0,170,210,0.9)" }, // areostationary
        Moon: { r: 2.5696e-3, center: "Earth", color: "rgba(80,85,100,0.9)" }, // Moon (a≈384,400 km, around Earth)
        Phobos: { r: 6.2675e-5, center: "Mars", color: "rgba(80,85,100,0.9)" }, // Phobos (a≈9,376 km, around Mars)
        Deimos: { r: 1.5684e-4, center: "Mars", color: "rgba(80,85,100,0.9)" }, // Deimos (a≈23,463 km, around Mars)
      };
      this.ctx.save();
      this.ctx.lineWidth = 1;
      for (const name of this.geoOrbits) {
        const ref = REF[name];
        const pos = ref && this.planetPositions[ref.center];
        if (!ref || !pos) continue;
        const px = centerX - auTo3D(pos.x) * scaleAUtoPX;
        const py = centerY + auTo3D(pos.y) * scaleAUtoPX;
        this.ctx.strokeStyle = ref.color;
        this.ctx.beginPath();
        this.ctx.arc(px, py, ref.r * scaleAUtoPX, 0, 2 * Math.PI);
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    // === Draw Satellites (example) ===
    if (this.satelliteColorMode !== "None") {
      // Small fixed-pixel marker (0 hides). 0.5 px per size-factor unit keeps the
      // default (factor 4 → 2 px dot) visually close to the 3D satellites, which the
      // earlier 4×factor = 16 px made far too large in the top-down view.
      const satSize = Math.max(0, satelliteScaleFactor * 0.5);
      const thrustScheme = isThrustScheme(this.satelliteColorMode);
      const labelsOn = this.satLabelMode && this.satelliteColorMode !== "Neutral";
      let labelsLeft = 600; // cap to protect perf / avoid clutter when zoomed out
      if (labelsOn) {
        this.ctx.font = "9px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "bottom";
        this.ctx.fillStyle = "#222";
      }
      for (let satellite of this.satellites) {
        const pos = this.satellitePositions[satellite.name];
        if (!pos) continue;

        const satX = centerX - auTo3D(pos.x) * scaleAUtoPX;
        const satY = centerY + auTo3D(pos.y) * scaleAUtoPX;
        let fill = "gray"; // Neutral / unknown
        const cmode = this.satelliteColorMode;
        if (cmode === "Quad") {
          // Solar-angle quadrant — same palette as the 3D quadrantEmissives.
          const sa = ((((satellite.position && satellite.position.solarAngle) || 0) % 360) + 360) % 360;
          fill = ["#dd2222", "#22dd22", "#2222dd", "#666666"][Math.floor(sa / 90)] || "gray";
        } else if (cmode === "Zone") {
          // Orbital zone — same palette as the 3D orbitalZoneEmissives.
          fill = { INSIDE_EARTH: "#dd2222", BETWEEN_EARTH_AND_MARS: "#22dd22", OUTSIDE_MARS: "#2222dd", EARTH_RING: "#0066ff", MARS_RING: "#ff6600" }[satellite.orbitalZone] || "#333333";
        } else if (cmode === "Suit") {
          const s = satellite.suitable;
          fill = !s ? "#333333"
            : (s.includes("Earth") && s.includes("Mars")) ? "#22dd22"
            : s.includes("Mars") ? "#dd2222"
            : s.includes("Earth") ? "#2222dd" : "#333333";
        } else if (thrustScheme) {
          const ring = this.satPhysics && this.satPhysics[satellite.ringName];
          if (ring) {
            const a = stationKeepingAccel(pos, this.planetPositions);
            const isPlanetary = satellite.ringName === "ring_earth" || satellite.ringName === "ring_mars";
            const { N, skProp, m } = satStationKeeping(a, ring.dryMass, ring, isPlanetary, this.skCfg);
            const { t, over } = satSchemeT(this.satelliteColorMode, { a, m, skProp, favail: N * this.skCfg.F, isp: this.skCfg.isp, n: N, nMax: this.satThrusterMax, ports: ring.ports, lasersMax: this.satLaserMax, capacity: this.skCfg.capacity, nonSkFuel: ring.nonSkFuel, totProp: satTotalProp(ring, skProp, isPlanetary) });
            fill = over ? OVER_BUDGET_RGB : rampRGB(t);
          }
        }
        this.ctx.save();
        this.ctx.fillStyle = fill;
        this.ctx.fillRect(satX - satSize / 2, satY - satSize / 2, satSize, satSize);
        this.ctx.restore();

        if (labelsOn && labelsLeft > 0 && satX >= 0 && satX <= width && satY >= 0 && satY <= height) {
          const txt = this.satLabelText(satellite, pos);
          if (txt) { this.ctx.fillText(txt, satX, satY - satSize / 2 - 1); labelsLeft--; }
        }
      }
    }

    // === Draw Links ===
    if (this.linksColorsType !== "None") {
      const activeLinkSet = new Set(this.activeLinks.map((link) => link.fromId + "_" + link.toId));
      const inactiveLinks = this.possibleLinks.filter(
        (link) => !activeLinkSet.has(link.fromId + "_" + link.toId) && !activeLinkSet.has(link.toId + "_" + link.fromId)
      );
      const allLinks = [...this.activeLinks, ...inactiveLinks];

      // Compute min/max flows for color interpolation
      let flows = [];
      if (this.linksColorsType === "Flow") flows = this.activeLinks.map((link) => link.gbpsFlow);
      else if (this.linksColorsType === "Capacity") flows = allLinks.map((link) => link.gbpsCapacity);
      const maxFlow = flows.length > 0 ? Math.max(...flows) : 1;
      const minFlow = flows.length > 0 ? Math.min(...flows) : 0;
      this.lastLinkRange = { type: this.linksColorsType, min: minFlow, max: maxFlow };

      const interpolateColor = (t) => {
        const colMin = {
          r: (this.styles.links.active.colormin >> 16) & 0xff,
          g: (this.styles.links.active.colormin >> 8) & 0xff,
          b: this.styles.links.active.colormin & 0xff,
        };
        const colMax = {
          r: (this.styles.links.active.colormax >> 16) & 0xff,
          g: (this.styles.links.active.colormax >> 8) & 0xff,
          b: this.styles.links.active.colormax & 0xff,
        };
        const r = colMin.r + (colMax.r - colMin.r) * t;
        const g = colMin.g + (colMax.g - colMin.g) * t;
        const b = colMin.b + (colMax.b - colMin.b) * t;
        return `rgb(${r}, ${g}, ${b})`;
      };

      for (let link of allLinks) {
        const isActive = activeLinkSet.has(link.fromId + "_" + link.toId);

        const fromPos = this.planetPositions[link.fromId] || this.satellitePositions[link.fromId];
        const toPos = this.planetPositions[link.toId] || this.satellitePositions[link.toId];
        if (!fromPos || !toPos) {
          console.warn(`Cannot find positions for link between "${link.fromId}" and "${link.toId}"`);
          continue;
        }

        const fromX = centerX - auTo3D(fromPos.x) * scaleAUtoPX;
        const fromY = centerY + auTo3D(fromPos.y) * scaleAUtoPX;
        const toX = centerX - auTo3D(toPos.x) * scaleAUtoPX;
        const toY = centerY + auTo3D(toPos.y) * scaleAUtoPX;

        // Stroke color
        let strokeColor = "#777777"; // inactive

        // Set colors
        if ((this.linksColorsType === "Flow" && isActive) || this.linksColorsType === "Capacity") {
          // Active link: interpolate color based on flow
          let t = 0;
          let valFlow = this.linksColorsType === "Flow" ? link.gbpsFlow : link.gbpsCapacity;
          if (maxFlow > minFlow) {
            t = (valFlow - minFlow) / (maxFlow - minFlow);
          }
          strokeColor = interpolateColor(isNaN(t) ? 0 : t);
        }

        this.ctx.save();
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = (this.linksColorsType === "Flow" && isActive) || this.linksColorsType === "Capacity" ? 2 : 1;
        this.ctx.beginPath();
        this.ctx.moveTo(fromX, fromY);
        this.ctx.lineTo(toX, toY);
        this.ctx.stroke();
        this.ctx.restore();
      }
    }

    // === Draw spacecraft transfer flights (arcs + extension links + ship markers) ===
    this.drawFlights(centerX, centerY, scaleAUtoPX);

    // === Draw Monte-Carlo coverage probes (independent point cloud + access links) ===
    this.drawProbes(centerX, centerY, scaleAUtoPX);
  }

  /** Receive per-frame flight overlay data from SimMain. */
  setFlightData(data) {
    this.flightData = data || { ships: [], arcs: [], links: [] };
  }

  /**
   * Draw the spacecraft-flight overlay: transfer arcs (dashed orange), ship
   * extension links (teal), and ship markers (cyan = →Mars, magenta = →Earth,
   * grey = unconnected).
   */
  drawFlights(centerX, centerY, scale) {
    const fd = this.flightData;
    if (!fd) return;
    const X = (x) => centerX - auTo3D(x) * scale;
    const Y = (y) => centerY + auTo3D(y) * scale;

    if (fd.arcs && fd.arcs.length) {
      this.ctx.save();
      this.ctx.strokeStyle = "rgba(255,160,60,0.7)";
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([4, 3]);
      for (const arc of fd.arcs) {
        if (!arc || arc.length < 2) continue;
        this.ctx.beginPath();
        this.ctx.moveTo(X(arc[0].x), Y(arc[0].y));
        for (let i = 1; i < arc.length; i++) this.ctx.lineTo(X(arc[i].x), Y(arc[i].y));
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    if (fd.links && fd.links.length) {
      this.ctx.save();
      this.ctx.strokeStyle = "rgba(0,200,170,0.9)";
      this.ctx.lineWidth = 1.2;
      for (const l of fd.links) {
        if (!l.from || !l.to) continue;
        this.ctx.beginPath();
        this.ctx.moveTo(X(l.from.x), Y(l.from.y));
        this.ctx.lineTo(X(l.to.x), Y(l.to.y));
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    if (fd.ships && fd.ships.length) {
      this.ctx.save();
      this.ctx.lineWidth = 0.8;
      this.ctx.strokeStyle = "#001018";
      for (const s of fd.ships) {
        const sx = X(s.x), sy = Y(s.y);
        this.ctx.fillStyle = s.connected === false ? "#888888" : (s.direction === "EM" ? "#12c8ff" : "#ff4fd8");
        this.ctx.beginPath();
        this.ctx.arc(sx, sy, 3.4, 0, 2 * Math.PI);
        this.ctx.fill();
        this.ctx.stroke();
      }
      this.ctx.restore();
    }
  }

  /** Receive per-frame coverage-probe overlay data from SimMain. */
  setProbeData(data) {
    this.probeData = data || { probes: [], links: [] };
  }

  /**
   * Draw the Monte-Carlo coverage field: faint access links (probe → backbone
   * node) and the probe markers (green = linked, grey = no link, pale = not yet
   * measured). Probes are independent samples — drawn together but measured alone.
   */
  drawProbes(centerX, centerY, scale) {
    const pd = this.probeData;
    if (!pd) return;
    const X = (x) => centerX - auTo3D(x) * scale;
    const Y = (y) => centerY + auTo3D(y) * scale;

    if (pd.links && pd.links.length) {
      this.ctx.save();
      this.ctx.strokeStyle = "rgba(120,200,255,0.30)";
      this.ctx.lineWidth = 0.6;
      for (const l of pd.links) {
        if (!l.from || !l.to) continue;
        this.ctx.beginPath();
        this.ctx.moveTo(X(l.from.x), Y(l.from.y));
        this.ctx.lineTo(X(l.to.x), Y(l.to.y));
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    if (pd.probes && pd.probes.length) {
      this.ctx.save();
      for (const p of pd.probes) {
        const px = X(p.x), py = Y(p.y);
        this.ctx.fillStyle = p.connected === false ? "rgba(150,150,160,0.7)"
          : p.connected ? "rgba(90,230,170,0.92)"
          : "rgba(205,205,215,0.6)";
        this.ctx.beginPath();
        this.ctx.arc(px, py, 1.7, 0, 2 * Math.PI);
        this.ctx.fill();
      }
      this.ctx.restore();
    }
  }
}
