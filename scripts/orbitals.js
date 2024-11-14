const fixedDate = Date.now(); //new Date('2030-01-01T00:00:00'); //Date.now();
const PI = Math.PI;

export function helioCoords(ele, dayOfs) {
  // console.log("\n");
  // console.log(ele);

  var clockTime = fixedDate;

  var daysUnixEpoch = clockTime / 1000 / 60.0 / 60 / 24; //days from Unix epoch to midnight this morning
  // console.log("daysUnixEpoch "+daysUnixEpoch);

  //var hoursInDays = (clockTime.hour + (clockTime.min + clockTime.sec/60.0)/60)/24;
  //console.log("hoursInDays "+hoursInDays);

  var julianDayUnix = 2440587.5; // till Unix epoch
  // console.log("julianDayUnix "+julianDayUnix);

  var julianDay = julianDayUnix + daysUnixEpoch; // + hoursInDays;// - timeZone;//! - timeZone;
  // console.log("julianDay "+julianDay);

  var Dpos = julianDay;
  // console.log("Dpos "+Dpos);

  // Days between current position and elements
  var D = Dpos - ele.Dele + dayOfs;
  // console.log("D "+D);

  // Mean anomaly
  var M = (ele.n * D + ele.l - ele.p) % 360;
  // console.log("M "+M);

  // True anomaly
  var v =
    M +
    (180 / PI) *
      ((2 * ele.e - Math.pow(ele.e, 3) / 4) * Math.sin((M / 180) * PI) +
        (5 / 4) * Math.pow(ele.e, 2) * Math.sin(((2 * M) / 180) * PI) +
        (13 / 12) * Math.pow(ele.e, 3) * Math.sin(((3 * M) / 180) * PI));
  // console.log("v "+v);

  // Radius vector of the object
  var r = (ele.a * (1 - Math.pow(ele.e, 2))) / (1 + ele.e * Math.cos((v / 180) * PI));
  // console.log("r "+r);

  // Angle of planet from ascending node (v+p-o)
  var vpo = (v + ele.p - ele.o) % 360;
  // console.log("vpo "+vpo);

  // Heliocentric coordinates
  var X =
    r *
    (Math.cos((ele.o / 180) * PI) * Math.cos((vpo / 180) * PI) -
      Math.sin((ele.o / 180) * PI) * Math.sin((vpo / 180) * PI) * Math.cos((ele.i / 180) * PI));
  // console.log("X "+X);
  var Y =
    r *
    (Math.sin((ele.o / 180) * PI) * Math.cos((vpo / 180) * PI) +
      Math.cos((ele.o / 180) * PI) * Math.sin((vpo / 180) * PI) * Math.cos((ele.i / 180) * PI));
  // console.log("Y "+Y);
  var Z = r * (Math.sin((vpo / 180) * PI) * Math.sin((ele.i / 180) * PI));
  // console.log("Z "+Z);

  return { x: X, y: Y, z: Z };
}

function calculateL1Position(planet, sun) {
  let perf = performance.now();
  const G = 6.6743e-11; // Gravitational constant in m^3 kg^-1 s^-2
  const massSun = sun.MassKg; // Mass of the Sun in kg
  const massPlanet = planet.params.mass; // Mass of the planet in kg

  // Get the positions of the Sun and planet
  const sunCoords = sun.position;
  const planetCoords = planet.position;

  // Calculate the distance between the Sun and the planet
  const dx = planetCoords.x - sunCoords.x;
  const dy = planetCoords.y - sunCoords.y;
  const dz = planetCoords.z - sunCoords.z;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Calculate the L1 point using an iterative numerical method
  let L1Distance = r; // Initial guess for L1 distance from the planet
  const epsilon = 1e-6; // Convergence threshold
  let diff;

  do {
    const forceSun = (G * massSun) / Math.pow(r - L1Distance, 2);
    const forcePlanet = (G * massPlanet) / Math.pow(L1Distance, 2);
    const totalForce = forceSun - forcePlanet;

    // Update the L1 distance based on the balance of forces
    diff = totalForce * (L1Distance / (forceSun + forcePlanet));
    L1Distance += diff;
  } while (Math.abs(diff) > epsilon);

  // Calculate the coordinates of L1 point relative to the Sun
  const L1Ratio = L1Distance / r;
  const L1Coords = {
    x: sunCoords.x + dx * L1Ratio,
    y: sunCoords.y + dy * L1Ratio,
    z: sunCoords.z + dz * L1Ratio,
  };

  let perf2 = performance.now();

  console.log(perf2 - perf);

  return L1Coords;
}

function insideSunArea(PlanetA, PlanetB) {
  var ClosestDistanceToSunKm =
    (Math.abs(PlanetB.x * PlanetA.y - PlanetB.y * PlanetA.x) /
      Math.sqrt(Math.pow(PlanetB.y - PlanetA.y, 2) + Math.pow(PlanetB.x - PlanetA.x, 2))) *
    149500000;
  if (ClosestDistanceToSunKm < 70000000) {
    if (distanceKm(PlanetA, PlanetB) > distanceKm(PlanetA, { x: 0, y: 0, z: 0 })) {
      return true;
    }
  }
  return false;
}

export function distance3D(planetA, planetB) {
  //Astronomical Unit (AU): Approximately 149,597,870.7 kilometers.
  return Math.sqrt(Math.pow(planetA.x - planetB.x, 2) + Math.pow(planetA.y - planetB.y, 2) + Math.pow(planetA.z - planetB.z, 2));
}

export const scaleFactor = 2000000;

export function auTo3D(au) {
  return (au * 149597871) / scaleFactor;
}

export function _3DToAu(_3d) {
  return (_3d / 149597871) * scaleFactor;
}

export function auToKm(au) {
  return au * 149597871;
}
