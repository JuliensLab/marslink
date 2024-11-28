// simTime.js

/**
 * SimTime class manages simulated time based on real elapsed time and an acceleration factor.
 */
export class SimTime {
  /**
   * Creates an instance of SimTime.
   *
   * @param {Date} [initDate=new Date()] - The initial simulated date. Defaults to the current date and time.
   * @param {number} [timeAccelerationFactor=1] - Factor by which simulated time progresses relative to real time.
   *                                                 For example:
   *                                                 1: Real-time
   *                                                 2: Twice as fast
   *                                                 0: Paused
   */
  constructor(initDate = new Date(), timeAccelerationFactor = 1) {
    /**
     * The factor by which simulated time progresses relative to real time.
     *
     * @type {number}
     */
    this.timeAccelerationFactor = timeAccelerationFactor;

    /**
     * The initial date from which the simulation starts.
     *
     * @type {Date}
     */
    this.initDate = initDate;

    /**
     * Accumulated simulated milliseconds since the start of the simulation.
     *
     * @type {number}
     */
    this.simMsSinceStart = 0;

    /**
     * The real timestamp (in milliseconds) at the previous frame.
     *
     * @type {number}
     */
    this.previousRealMs = performance.now();
  }

  /**
   * Gets the current simulated Date based on the elapsed real time and the time acceleration factor.
   *
   * @returns {Date} The current simulated Date.
   */
  getDate() {
    // Get the current real timestamp
    const currentRealMs = performance.now();

    // Calculate the elapsed real milliseconds since the last call
    const elapsedRealMs = currentRealMs - this.previousRealMs;

    // Calculate the elapsed simulated milliseconds based on the acceleration factor
    const elapsedSimMs = elapsedRealMs * this.timeAccelerationFactor;

    // Update the previous real timestamp to the current one for the next call
    this.previousRealMs = currentRealMs;

    // Accumulate the simulated milliseconds
    this.simMsSinceStart += elapsedSimMs;

    // Calculate the current simulated date by adding the accumulated simulated milliseconds to the initial date
    const simDate = new Date(this.initDate.getTime() + this.simMsSinceStart);

    return simDate;
  }

  /**
   * Sets the time acceleration factor.
   *
   * @param {number} factor - The time acceleration factor.
   *                          For example, 2 means time runs twice as fast.
   *                          0 pauses the simulation.
   */
  setTimeAccelerationFactor(factor) {
    if (typeof factor !== "number" || isNaN(factor)) {
      throw new Error("Time acceleration factor must be a number.");
    }
    this.timeAccelerationFactor = factor;
  }
}
