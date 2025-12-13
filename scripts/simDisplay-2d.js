/***********************************************
 * simDisplay-2d.js
 *
 * 2D (canvas-based) display of the solar system,
 * with pan and zoom (mouse & touch).
 ***********************************************/

import { SimSolarSystem } from "./simSolarSystem.js?v=4.3";
import { createCarModel } from "./modelCar.js?v=4.3";

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

    // === Draw Sun ===
    const sunData = this.solarSystemData.sun;
    const sunRadiusAU = kmTo3D(sunData.diameterKm / 2) * sunScaleFactor;
    const sunDisplayRadius = sunRadiusAU * 0.1 * this.zoom;
    this.ctx.save();
    this.ctx.fillStyle = "#DDDD00";
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, sunDisplayRadius, 0, 2 * Math.PI);
    this.ctx.fill();
    this.ctx.restore();

    // === Draw Planets ===
    for (let planetData of this.solarSystemData.planets) {
      if (planetData.name === "Tesla") continue;
      const pos = this.planetPositions[planetData.name];
      if (!pos) continue;

      // Convert from AU to canvas coords
      const planetX = centerX - auTo3D(pos.x) * scaleAUtoPX;
      const planetY = centerY + auTo3D(pos.y) * scaleAUtoPX;

      // Planet radius
      const planetRadiusAU = kmTo3D(planetData.diameterKm / 2) * planetScaleFactor;
      const planetDisplayRadius = planetRadiusAU * 0.1 * this.zoom;

      // Draw
      this.ctx.save();
      this.ctx.fillStyle = "#000000";
      this.ctx.beginPath();
      this.ctx.arc(planetX, planetY, planetDisplayRadius, 0, 2 * Math.PI);
      this.ctx.fill();
      this.ctx.restore();
    }

    // === Draw Satellites (example) ===
    if (this.satelliteColorMode !== "None") {
      const satSize = 4 * satelliteScaleFactor;
      for (let satellite of this.satellites) {
        const pos = this.satellitePositions[satellite.name];
        if (!pos) continue;

        const satX = centerX - auTo3D(pos.x) * scaleAUtoPX;
        const satY = centerY + auTo3D(pos.y) * scaleAUtoPX;
        // small square
        this.ctx.save();
        this.ctx.fillStyle = "gray";
        this.ctx.fillRect(satX - satSize / 2, satY - satSize / 2, satSize, satSize);
        this.ctx.restore();
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

      console.log("Max flow:", maxFlow, "Min flow:", minFlow);

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
  }
}
