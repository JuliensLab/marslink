// simProbeController.js
//
// Main-thread orchestrator for the Monte-Carlo coverage-field overlay (Feature
// B) — the alternative to SimFlightController. Owns the probe config and the
// sampled point cloud, plus the latest independent-probe measurement.
//
// Unlike the flight fleet, probes are STATIC (they don't fly) and INDEPENDENT
// (they don't compete or relay), so per-frame work is nil: the cloud is sampled
// once per (count, seed) and re-measured on demand against the live backbone.

import { sampleProbeVolume, measureProbes } from "./simProbeField.js?v=4.32";

export class SimProbeController {
  constructor() {
    this.enabled = false;     // off by default — the flight overlay is the default view
    this.showProbes = true;
    this.config = {
      count: 500,
      seed: 1,
      portsPerProbe: 1,       // probes are edge clients; 1 terminal is the realistic default
    };
    this._points = null;
    this._cloudKey = "";
    this._meas = null;        // last measureProbes() result
    // Render-data cache (probes are static → rebuild arrays only on change).
    this._renderCache = null;
    this._renderCacheMeas = null;
    this._renderCachePoints = null;
  }

  setEnabled(on) { this.enabled = !!on; }

  /** Merge partial config. The cloud resamples lazily when count/seed change. */
  setConfig(partial) {
    Object.assign(this.config, partial);
  }

  /**
   * (Re)sample the probe volume from Earth/Mars element objects. Cheap and cached
   * by (count, seed, orbit sizes); a no-op when nothing relevant changed.
   * @returns {boolean} true if the cloud was (re)sampled this call
   */
  ensureCloud(earthEle, marsEle) {
    if (!earthEle || !marsEle) return false;
    const key = `${this.config.count}|${this.config.seed}|${earthEle.a}|${marsEle.a}`;
    if (this._points && this._cloudKey === key) return false;
    this._points = sampleProbeVolume({
      earth: earthEle, mars: marsEle,
      count: this.config.count, seed: this.config.seed,
    });
    this._cloudKey = key;
    this._meas = null; // measurement is stale for the new cloud
    return true;
  }

  /** True once a measurement has been computed for the current cloud/backbone. */
  hasMeasurement() { return !!this._meas; }

  /**
   * Render data: the probe cloud (+ per-probe connectivity flag and access links
   * once measured). CACHED — probes are static, so the arrays are rebuilt only
   * when the measurement or the cloud changes, and the SAME object is returned
   * otherwise so the caller can cheaply skip re-pushing to the display each frame.
   */
  getRenderData() {
    if (!this.enabled || !this.showProbes || !this._points) return { probes: [], links: [], count: 0 };
    if (this._renderCache && this._renderCacheMeas === this._meas && this._renderCachePoints === this._points) {
      return this._renderCache;
    }
    const meas = this._meas;
    let data;
    if (meas && meas.perProbe.length === this._points.length) {
      const probes = meas.perProbe.map((p) => ({ x: p.x, y: p.y, z: p.z, connected: p.connected }));
      const links = meas.perProbe
        .filter((p) => p.connected && p.rootPos)
        .map((p) => ({ from: { x: p.x, y: p.y, z: p.z }, to: p.rootPos }));
      data = { probes, links, count: probes.length };
    } else {
      // Not yet measured — show the raw cloud (connectivity unknown).
      data = { probes: this._points.map((p) => ({ x: p.x, y: p.y, z: p.z, connected: undefined })), links: [], count: this._points.length };
    }
    this._renderCache = data;
    this._renderCacheMeas = this._meas;
    this._renderCachePoints = this._points;
    return data;
  }

  /**
   * Measure every probe independently against the live constellation backbone.
   * Stores + returns the result; call when the topology is available (throttled).
   *
   * @param {Object} p { planets, satellites, possibleLinks, simLinkBudget }
   */
  measure({ planets, satellites, possibleLinks, simLinkBudget }) {
    if (!this.enabled || !this._points || !this._points.length) {
      this._meas = null;
      return { perProbe: [], summary: { connected: 0, unconnected: 0, total: 0 } };
    }
    this._meas = measureProbes({ points: this._points, planets, satellites, possibleLinks, simLinkBudget });
    return this._meas;
  }
}
