/*
 * The Lukashian Calendar — JavaScript port of The Lukashian Calendar Mechanism.
 *
 * This file is a translation into JavaScript of the Java reference
 * implementation found at https://github.com/The-Lukashian-Calendar/lukashian
 * (org.lukashian:lukashian on Maven Central). The translated portions are
 * the StandardEarthMillisecondStoreDataProvider, the
 * StandardMarsMillisecondStoreDataProvider, the leap-second handling from
 * MillisecondStoreData, and the year/day/instant lookup logic from Year.java,
 * Day.java and Instant.java. The functional behaviour of The Lukashian Calendar
 * Mechanism is preserved as required by the license.
 *
 * --------------------------------------------------------------------------
 * Copyright (c) 2018-2026 (5918-5926 in Lukashian years)
 * All rights reserved.
 *
 * The Lukashian Calendar and The Lukashian Calendar Mechanism are registered
 * at the Benelux Office for Intellectual Property, registration number 120712.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, the above registration notice, this list of conditions
 *    and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, the above registration notice, this list of conditions
 *    and the following disclaimer in the documentation and/or other materials
 *    provided with the distribution.
 * 3. All materials mentioning features or use of this software,
 *    The Lukashian Calendar or the underlying Lukashian Calendar Mechanism,
 *    with or without modification, must refer to the Calendar as "The
 *    Lukashian Calendar" and to the Calendar Mechanism as "The Lukashian
 *    Calendar Mechanism".
 * 4. Renaming of source code, binary form, The Lukashian Calendar or The
 *    Lukashian Calendar Mechanism, with or without modification, is explicitly
 *    disallowed. Any copies, extracts, code excerpts, forks, redistributions
 *    or translations into other languages of source code, binary form,
 *    the functional behaviour of The Lukashian Calendar as defined by source code or
 *    the functional behaviour of The Lukashian Calendar Mechanism as defined by source
 *    code, with or without modification, must refer to the Calendar
 *    as "The Lukashian Calendar" and to the Calendar Mechanism as "The
 *    Lukashian Calendar Mechanism".
 * 5. Any copies, extracts, code excerpts, forks, redistributions
 *    or translations into other languages of source code, binary form,
 *    the functional behaviour of The Lukashian Calendar as defined by source code or
 *    the functional behaviour of The Lukashian Calendar Mechanism as defined by source
 *    code, with or without modification, may not include modifications that
 *    change the functional behaviour of The Lukashian Calendar Mechanism as
 *    implemented by source code.
 *
 * THIS SOFTWARE IS PROVIDED BY COPYRIGHT HOLDER ''AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL COPYRIGHT HOLDER BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 * --------------------------------------------------------------------------
 */

// ─────────────────────────── Constants ───────────────────────────
const BEEPS_PER_DAY = 10000;
const MILLIS_PER_DAY = 24 * 3600 * 1000;

// ─────────────────────────── Math helpers ───────────────────────────
const { sin, cos, atan2, PI } = Math;
const toRadians = (deg) => (deg * PI) / 180;
const toDegrees = (rad) => (rad * 180) / PI;
const normalize = (degrees) => {
  const mod = degrees % 360;
  return mod < 0 ? mod + 360 : mod;
};
const arcsecToDegree = (arcseconds) => arcseconds / 3600;

// Returns the index of the first element >= target. Equivalent to
// Java's Arrays.binarySearch insertion-point logic, simplified for our use.
function lowerBound(sortedArr, target) {
  let lo = 0;
  let hi = sortedArr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedArr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ─────────────────────────── Leap seconds (from MillisecondStoreData) ───────────────────────────
const LEAP_SECONDS_UNIX_MS = (() => {
  const secondsSince1900WithLeapSecond = [
    2287785600, 2303683200, 2335219200, 2366755200, 2398291200,
    2429913600, 2461449600, 2492985600, 2524521600, 2571782400,
    2603318400, 2634854400, 2698012800, 2776982400, 2840140800,
    2871676800, 2918937600, 2950473600, 2982009600, 3029443200,
    3076704000, 3124137600, 3345062400, 3439756800, 3550089600,
    3644697600, 3692217600,
  ];
  const NTP_TO_UNIX_OFFSET_S = 2208988800;
  return secondsSince1900WithLeapSecond.map((s) => (s - NTP_TO_UNIX_OFFSET_S) * 1000);
})();

// ─────────────────────────── Earth provider ───────────────────────────
// Translated from StandardEarthMillisecondStoreDataProvider.java.
const EARTH_PROVIDER = (() => {
  const A = [
    485, 203, 199, 182, 156, 136, 77, 74, 70, 58, 52, 50, 45, 44, 29, 18, 17,
    16, 14, 12, 12, 12, 9, 8,
  ];
  const B = [
    324.96, 337.23, 342.08, 27.85, 73.14, 171.52, 222.54, 296.72, 243.58,
    119.81, 297.17, 21.02, 247.54, 325.15, 60.93, 155.12, 288.79, 198.04,
    199.76, 95.39, 287.11, 320.81, 227.73, 15.45,
  ];
  const C = [
    1934.136, 32964.467, 20.186, 445267.112, 45036.886, 22518.443, 65928.934,
    3034.906, 9037.513, 33718.147, 150.678, 2281.226, 29929.562, 31555.956,
    4443.417, 67555.328, 4562.452, 62894.029, 31436.921, 14577.848, 31931.756,
    34777.259, 1222.114, 16859.074,
  ];

  function getJdeMillisAtEndOfYear(year) {
    let jde0;
    if (year < 4900) {
      const y = (year - 3900) / 1000;
      jde0 =
        1721414.39987 +
        365242.88257 * y -
        0.00769 * y * y -
        0.00933 * y * y * y -
        0.00006 * y * y * y * y;
    } else {
      const y = (year - 5900) / 1000;
      jde0 =
        2451900.05952 +
        365242.74049 * y -
        0.06223 * y * y -
        0.00823 * y * y * y +
        0.00032 * y * y * y * y;
    }

    const t = (jde0 - 2451545.0) / 36525;
    const w = t * 35999.373 - 2.47;
    const dL = 0.0334 * cos(toRadians(w)) + 0.0007 * cos(toRadians(2 * w)) + 1;

    let s = 0;
    for (let i = 0; i < 24; i++) {
      s += A[i] * cos(toRadians(B[i] + C[i] * t));
    }

    const jde = jde0 + (0.00001 * s) / dL;
    return Math.trunc(jde * MILLIS_PER_DAY);
  }

  /**
   * Computes the equation-of-time correction in milliseconds at the given
   * mean-solar-day JDE millis. Translated verbatim from the Java day-loop body.
   */
  function computeEotMillis(jdeMillisOfCurrentMeanSolarDay) {
    const deltaT = jdeMillisOfCurrentMeanSolarDay / (24 * 3600 * 1000) - 2451545.0;

    const deltaTC = deltaT / 36525;
    const deltaTC2 = deltaTC * deltaTC;
    const deltaTC3 = deltaTC2 * deltaTC;

    const deltaTM = deltaTC / 10;
    const deltaTM2 = deltaTM * deltaTM;
    const deltaTM3 = deltaTM2 * deltaTM;
    const deltaTM4 = deltaTM3 * deltaTM;
    const deltaTM5 = deltaTM4 * deltaTM;

    const deltaT10M = deltaTM / 10;
    const deltaT10M2 = deltaT10M * deltaT10M;
    const deltaT10M3 = deltaT10M2 * deltaT10M;
    const deltaT10M4 = deltaT10M3 * deltaT10M;
    const deltaT10M5 = deltaT10M4 * deltaT10M;
    const deltaT10M6 = deltaT10M5 * deltaT10M;
    const deltaT10M7 = deltaT10M6 * deltaT10M;
    const deltaT10M8 = deltaT10M7 * deltaT10M;
    const deltaT10M9 = deltaT10M8 * deltaT10M;
    const deltaT10M10 = deltaT10M9 * deltaT10M;

    const lSun = normalize(
      280.4664567 +
        360007.6982779 * deltaTM +
        0.03032028 * deltaTM2 +
        deltaTM3 / 49931 -
        deltaTM4 / 15300 -
        deltaTM5 / 2000000
    );

    const omega =
      125.04452 -
      1934.136261 * deltaTC +
      0.0020708 * deltaTC2 +
      deltaTC3 / 450000;

    const lMoon = 218.3165 + 481267.8813 * deltaTC;

    const deltaPsi = arcsecToDegree(
      -17.2 * sin(toRadians(omega)) -
        1.32 * sin(toRadians(2 * lSun)) -
        0.23 * sin(toRadians(2 * lMoon)) +
        0.21 * sin(toRadians(2 * omega))
    );

    const deltaEpsilon = arcsecToDegree(
      9.2 * cos(toRadians(omega)) +
        0.57 * cos(toRadians(2 * lSun)) +
        0.1 * cos(toRadians(2 * lMoon)) -
        0.09 * cos(toRadians(2 * omega))
    );

    const epsilonZero = arcsecToDegree(
      82800 +
        1560 +
        21.448 -
        4680.93 * deltaT10M -
        1.55 * deltaT10M2 +
        1999.25 * deltaT10M3 -
        51.38 * deltaT10M4 -
        249.67 * deltaT10M5 -
        39.05 * deltaT10M6 +
        7.12 * deltaT10M7 +
        27.87 * deltaT10M8 +
        5.79 * deltaT10M9 +
        2.45 * deltaT10M10
    );

    const epsilon = epsilonZero + deltaEpsilon;

    const m = 357.52911 + 35999.05029 * deltaTC - 0.0001537 * deltaTC2;

    const c =
      (1.914602 - 0.004817 * deltaTC - 0.000014 * deltaTC2) * sin(toRadians(m)) +
      (0.019993 - 0.000101 * deltaTC) * sin(toRadians(2 * m)) +
      0.000289 * sin(toRadians(3 * m));

    const dot = lSun + c;
    const gamma = dot - 0.00569 - 0.00478 * sin(toRadians(omega));

    const alpha = normalize(
      toDegrees(atan2(cos(toRadians(epsilon)) * sin(toRadians(gamma)), cos(toRadians(gamma))))
    );

    const eotDegrees =
      lSun - 0.0057183 - alpha + deltaPsi * cos(toRadians(epsilon));

    let eotMinutes = (eotDegrees * 24 * 60) / 360;
    if (eotMinutes > 20) eotMinutes -= 24 * 60;
    else if (eotMinutes < -20) eotMinutes += 24 * 60;

    return Math.trunc(eotMinutes * 60 * 1000);
  }

  // Mean-solar-day length, taking into account the slowing rotation of the Earth.
  const centurialIncreaseInNanos = 1_700_000;
  const dailyIncreaseInNanos = centurialIncreaseInNanos / (100 * 365.25);
  const lengthOfMeanSolarDayAtYear5900InNanos = 86_400_002_000_000;
  const increaseBetweenEpochAndYear5900InNanos = centurialIncreaseInNanos * 59;
  const lengthOfMeanSolarDayAtEpochInNanos =
    lengthOfMeanSolarDayAtYear5900InNanos - increaseBetweenEpochAndYear5900InNanos;

  /**
   * Analytical jump to the JDE millis at the start of mean-solar-day N (0-based).
   * Equivalent to running the Java day-loop for N iterations from the calendar
   * epoch, but in O(1).
   */
  function jdeMillisAtStartOfMeanSolarDay(N, jdeMillisAtStartOfCalendar) {
    // sum_{k=0}^{N-1} (L0 + dailyIncrease * k)
    //   = N * L0 + dailyIncrease * N * (N-1) / 2
    const accumulatedNanos =
      N * lengthOfMeanSolarDayAtEpochInNanos +
      (dailyIncreaseInNanos * N * (N - 1)) / 2;
    return jdeMillisAtStartOfCalendar + Math.trunc(accumulatedNanos / 1_000_000);
  }

  return {
    unixEpochOffsetMs: 185208761225352,
    averageDayMillis: 86_400_000,
    averageYearDays: 365.2422,
    yearWindow: { min: 1, max: 7000 }, // years to precompute boundaries for
    getJdeMillisAtEndOfYear,
    computeEotMillis,
    jdeMillisAtStartOfMeanSolarDay,
  };
})();

// ─────────────────────────── Mars provider ───────────────────────────
// Translated from StandardMarsMillisecondStoreDataProvider.java.
const MARS_PROVIDER = (() => {
  const ALPHA = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.002, 0.0018];
  const TAU = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493];
  const PHI = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095];

  const EPOCH_SOLSTICE_INDEX = 38;
  const MARTIAN_SOUTHERN_SOLSTICE_MJDS = [
    6197.109, 6884.078, 7571.06, 8258.049, 8944.979, 9631.969, 10318.974,
    11005.929, 11692.879, 12379.887, 13066.853, 13753.824, 14440.832,
    15127.803, 15814.749, 16501.737, 17188.701, 17875.653, 18562.688,
    19249.687, 19936.629, 20623.597, 21310.583, 21997.519, 22684.513,
    23371.515, 24058.485, 24745.458, 25432.453, 26119.388, 26806.362,
    27493.375, 28180.343, 28867.287, 29554.288, 30241.272, 30928.229,
    31615.237, 32302.219, 32989.166, 33676.143, 34363.122, 35050.06,
    35737.08, 36424.091, 37111.039, 37797.994, 38484.989, 39171.928,
    39858.909, 40545.917, 41232.895, 41919.863, 42606.86, 43293.81,
    43980.768, 44667.783, 45354.763, 46041.703, 46728.688, 47415.685,
    48102.632, 48789.632, 49476.625, 50163.575, 50850.54, 51537.531,
    52224.466, 52911.471, 53598.497, 54285.458, 54972.406, 55659.403,
    56346.353, 57033.314, 57720.323, 58407.306, 59094.272, 59781.261,
    60468.226, 61155.167, 61842.176, 62529.169, 63216.112, 63903.083,
    64590.096, 65277.045, 65964.037, 66651.04, 67337.998, 68024.952,
    68711.945, 69398.886, 70085.868, 70772.9, 71459.872, 72146.812,
    72833.799, 73520.764, 74207.71, 74894.717, 75581.712, 76268.684,
    76955.667, 77642.65, 78329.583, 79016.582, 79703.585, 80390.535,
    81077.491, 81764.505, 82451.461, 83138.435, 83825.44, 84512.406,
    85199.352, 85886.342, 86573.299, 87260.264, 87947.3, 88634.29,
    89321.231, 90008.206, 90695.188, 91382.126, 92069.125, 92756.128,
    93443.101, 94130.072, 94817.062, 95503.994, 96190.974, 96877.984,
    97564.947, 98251.894,
  ];

  function getJdeMillisAtEndOfYear(year) {
    const mjd = MARTIAN_SOUTHERN_SOLSTICE_MJDS[EPOCH_SOLSTICE_INDEX + year];
    const jde = mjd + 2400000.5;
    return Math.trunc(jde * MILLIS_PER_DAY);
  }

  const lengthOfMeanSolarDayInMillis = Math.trunc(24 * 3600 * 1000 * 1.02749125);

  function jdeMillisAtStartOfMeanSolarDay(N, jdeMillisAtStartOfCalendar) {
    return jdeMillisAtStartOfCalendar + N * lengthOfMeanSolarDayInMillis;
  }

  function computeEotMillis(jdeMillisOfCurrentMeanSolarDay) {
    const deltaT = jdeMillisOfCurrentMeanSolarDay / (24 * 3600 * 1000) - 2451545.0;

    const m = 19.3871 + 0.52402073 * deltaT;
    const alphaFMS = 270.3871 + 0.524038496 * deltaT;

    let perturbers = 0;
    for (let i = 0; i < 7; i++) {
      perturbers += ALPHA[i] * cos(toRadians((0.985626 * deltaT) / TAU[i] + PHI[i]));
    }

    const vMinusM =
      (10.691 + 0.0000003 * deltaT) * sin(toRadians(m)) +
      0.623 * sin(toRadians(2 * m)) +
      0.05 * sin(toRadians(3 * m)) +
      0.005 * sin(toRadians(4 * m)) +
      0.0005 * sin(toRadians(5 * m)) +
      perturbers;

    const ls = alphaFMS + vMinusM;

    const eotDegrees =
      2.861 * sin(toRadians(2 * ls)) -
      0.071 * sin(toRadians(4 * ls)) +
      0.002 * sin(toRadians(6 * ls)) -
      vMinusM;

    const eotHours = (eotDegrees * 24) / 360;
    return Math.trunc(eotHours * 3600 * 1000);
  }

  return {
    unixEpochOffsetMs: 715805078401,
    averageDayMillis: 88_775_244, // 1 sol in ms
    averageYearDays: 668.5991,
    yearWindow: {
      min: 1,
      max: MARTIAN_SOUTHERN_SOLSTICE_MJDS.length - (EPOCH_SOLSTICE_INDEX + 1),
    },
    getJdeMillisAtEndOfYear,
    computeEotMillis,
    jdeMillisAtStartOfMeanSolarDay,
  };
})();

// ─────────────────────────── Store ───────────────────────────
//
// One instance per planet. Computes year boundaries for the full year window,
// and day boundaries for a sub-window of years (default ±60 around "now"),
// avoiding the multi-million-day full enumeration done by the Java reference.
class LukashianStore {
  constructor(provider, dayWindowYears = 60) {
    this.provider = provider;
    this.jdeMillisAtStartOfCalendar = provider.getJdeMillisAtEndOfYear(0);

    // Year boundaries (1-indexed: yearEpochMilliseconds[year-1] = end of year)
    this.yearEpochMilliseconds = [];
    for (let year = provider.yearWindow.min; year <= provider.yearWindow.max; year++) {
      this.yearEpochMilliseconds.push(
        provider.getJdeMillisAtEndOfYear(year) - this.jdeMillisAtStartOfCalendar
      );
    }

    // Day boundaries (windowed, indexed by epoch-day relative to dayMin).
    // We compute days from the start of (currentYear - dayWindowYears) to the
    // end of (currentYear + dayWindowYears). currentYear is derived from the
    // wall clock at construction time.
    const nowEpochMs = this.fromUnixToLukashianEpochMs(Date.now());
    const yearAtNow = this._yearForEpochMs(nowEpochMs);
    const yearMin = Math.max(provider.yearWindow.min, yearAtNow - dayWindowYears);
    const yearMax = Math.min(provider.yearWindow.max, yearAtNow + dayWindowYears);

    const yearMinStartMs = yearMin > 1 ? this.yearEpochMilliseconds[yearMin - 2] : 0;
    const yearMaxEndMs = this.yearEpochMilliseconds[yearMax - 1];

    // Estimate the day index range that covers [yearMinStartMs, yearMaxEndMs].
    const N0 = Math.max(0, Math.floor(yearMinStartMs / provider.averageDayMillis) - 5);
    const N1 = Math.ceil(yearMaxEndMs / provider.averageDayMillis) + 5;

    // EOT offset is computed once at the very first day of the calendar
    // (currentDay == 0), independent of the iterative accumulation.
    const jdeMillisDay0 = provider.jdeMillisAtStartOfMeanSolarDay(0, this.jdeMillisAtStartOfCalendar);
    this.eotOffsetMillis = jdeMillisDay0 - this.jdeMillisAtStartOfCalendar - provider.computeEotMillis(jdeMillisDay0);

    // Day window: dayEpochMilliseconds[i] = end-of-epoch-day (N0 + 1 + i)
    // (indexing follows the Java convention where epochDay 1 = first day after epoch)
    this.dayMinEpochDay = N0 + 1; // first epoch-day index represented in the array
    this.dayEpochMilliseconds = new Array(Math.max(0, N1 - N0));
    for (let i = 0; i < this.dayEpochMilliseconds.length; i++) {
      const N = N0 + 1 + i; // currentDay value used inside the Java loop body
      const jdeMs = provider.jdeMillisAtStartOfMeanSolarDay(N, this.jdeMillisAtStartOfCalendar);
      const eotMs = provider.computeEotMillis(jdeMs);
      const trueMs = jdeMs - eotMs;
      this.dayEpochMilliseconds[i] = trueMs - this.jdeMillisAtStartOfCalendar - this.eotOffsetMillis;
    }

    this.windowEpochMsMin = this.dayEpochMilliseconds[0] || 0;
    this.windowEpochMsMax = this.dayEpochMilliseconds[this.dayEpochMilliseconds.length - 1] || 0;
  }

  /**
   * Converts a Unix-epoch ms (incorrect, leap-second-free) to a Lukashian-
   * epoch ms (correct), per MillisecondStoreData.getLukashianEpochMilliseconds.
   */
  fromUnixToLukashianEpochMs(unixEpochMs) {
    const idx = lowerBound(LEAP_SECONDS_UNIX_MS, unixEpochMs + 1);
    return unixEpochMs + idx * 1000 + this.provider.unixEpochOffsetMs;
  }

  _yearForEpochMs(epochMs) {
    // Returns the 1-indexed Lukashian year that contains epochMs.
    // Equivalent to MillisecondStoreData.getYearForEpochMilliseconds.
    const idx = lowerBound(this.yearEpochMilliseconds, epochMs);
    return Math.min(idx + 1, this.provider.yearWindow.max);
  }

  /**
   * Converts a Unix epoch millisecond into a Lukashian instant.
   * Returns { year, day, beeps } or null if outside the precomputed day window.
   */
  fromUnixMillis(unixEpochMs) {
    const epochMs = this.fromUnixToLukashianEpochMs(unixEpochMs);

    // Year
    const year = this._yearForEpochMs(epochMs);
    if (year < 1 || year > this.provider.yearWindow.max) return null;

    // Bail out if outside the precomputed day window
    if (epochMs < this.windowEpochMsMin || epochMs > this.windowEpochMsMax) return null;

    // Find the epoch day that contains epochMs (1-indexed in Java; we use the
    // local array index here and translate at the very end).
    const dayLocalIdx = lowerBound(this.dayEpochMilliseconds, epochMs);
    if (dayLocalIdx >= this.dayEpochMilliseconds.length) return null;

    // Day-in-year — replicates getFirstDayOfYearInEpochForm + getDayNumber.
    const yearStartMs = year > 1 ? this.yearEpochMilliseconds[year - 2] + 1 : 1;
    let runningLocalIdx = lowerBound(this.dayEpochMilliseconds, yearStartMs);
    if (runningLocalIdx >= this.dayEpochMilliseconds.length) return null;

    const startOfRunningDayMs =
      runningLocalIdx === 0 && this.dayMinEpochDay === 1
        ? 1
        : (runningLocalIdx === 0
            ? 1 // beginning of window — assume the previous day already ended
            : this.dayEpochMilliseconds[runningLocalIdx - 1] + 1);

    if (startOfRunningDayMs < yearStartMs) {
      runningLocalIdx += 1; // running day started in the previous year
    }

    const dayNumber = dayLocalIdx - runningLocalIdx + 1;
    if (dayNumber < 1) return null;

    // Proportion-of-day → beeps
    const dayStartMs =
      dayLocalIdx === 0
        ? this.dayMinEpochDay === 1
          ? 1
          : Math.max(1, this.windowEpochMsMin + 1)
        : this.dayEpochMilliseconds[dayLocalIdx - 1] + 1;
    const dayEndMs = this.dayEpochMilliseconds[dayLocalIdx];
    const dayLengthMs = dayEndMs - dayStartMs + 1;
    const millisIntoDay = epochMs - dayStartMs;
    const proportion = Math.max(0, Math.min(1, millisIntoDay / dayLengthMs));
    const beeps = Math.floor(proportion * BEEPS_PER_DAY);

    return { year, day: dayNumber, beeps };
  }

  format(date) {
    const result = this.fromUnixMillis(date instanceof Date ? date.getTime() : date);
    if (!result) return null;
    return `${result.year}-${String(result.day).padStart(3, "0")} ${String(result.beeps).padStart(4, "0")}`;
  }
}

// ─────────────────────────── Public clock ───────────────────────────
export class LukashianClock {
  constructor() {
    this.earth = null;
    this.mars = null;
    this.ready = false;
    // Build asynchronously so the constructor doesn't block startup paint.
    this.readyPromise = new Promise((resolve) => {
      // Defer to next microtask so the JS event loop yields once.
      setTimeout(() => {
        try {
          this.earth = new LukashianStore(EARTH_PROVIDER, 150);
          this.mars = new LukashianStore(MARS_PROVIDER, 80);
          this.ready = true;
        } catch (err) {
          console.warn("[LukashianClock] Failed to initialize:", err);
        }
        resolve();
      }, 0);
    });
  }

  formatEarth(date) {
    if (!this.earth) return null;
    return this.earth.format(date);
  }

  formatMars(date) {
    if (!this.mars) return null;
    return this.mars.format(date);
  }
}
