// simSolarSystem.js

import { helioCoords } from "./simOrbits.js";

export class SimSolarSystem {
  constructor() {}

  getSolarSystemData() {
    return this.solarSystemData;
  }

  updatePlanetsPositions(simDaysSinceStart) {
    for (const [name, object] of Object.entries(this.solarSystemData.planets))
      this.solarSystemData.planets[name].position = helioCoords(object, simDaysSinceStart);
    return this.solarSystemData.planets;
  }

  solarSystemData = {
    background: { diameterKm: 6000000000, shape: "sphere", texturePath: "img/textures/8k_stars.jpg" },
    sun: {
      diameterKm: 1392700,
      massKg: 1.9885e30,
      rotationHours: { y: 27 },
      shape: "sphere",
      texturePath: "img/textures/2k_sun.jpg",
    },
    planets: [
      //{"name":"Sun","i":0,"o":0,"p":0,"a":0,"n":0,"e":0,"l":0,"diameterKm":1391000,"orbitdays":1,"Dele":2450680.5,"color":[255,255,0]},
      // i = inclination in degrees
      // a = semi major axis (distance between sun and planet) in AU
      // e = eccentricity dimensionless
      // o = Longitude of the Ascending Node in degrees
      // p = Argument of Perihelion in degrees
      // n = Mean Motion in degrees per day
      // l = Mean Longitude in degrees
      {
        name: "Mercury",
        i: 7.00507,
        o: 48.3339,
        p: 77.4539999999999,
        a: 0.3870978,
        n: 4.092353,
        e: 0.2056324,
        l: 314.42369,
        diameterKm: 4878,
        massKg: 0.33e24,
        orbitdays: 88,
        rotationHours: { y: 1407.6 },
        Dele: 2450680.5,
        color: [100, 100, 120],
        shape: "sphere",
        texturePath: "img/textures/2k_mercury.jpg",
      },
      {
        name: "Venus",
        i: 3.39472,
        o: 76.6889,
        p: 131.761,
        a: 0.7233238,
        n: 1.602158,
        e: 0.0067933,
        l: 236.94045,
        diameterKm: 12104,
        massKg: 4.87e24,
        orbitdays: 224.7,
        rotationHours: { y: -5832.5 },
        Dele: 2450680.5,
        color: [180, 110, 80],
        shape: "sphere",
        texturePath: "img/textures/2k_venus_surface.jpg",
      },
      {
        name: "Earth",
        i: 0.00041,
        o: 349.2,
        p: 102.8517,
        a: 1.00002,
        n: 0.9855796,
        e: 0.0166967,
        l: 328.40353,
        diameterKm: 12756,
        massKg: 5.97e24,
        orbitdays: 365.25,
        rotationHours: { y: 23.9 },
        Dele: 2450680.5,
        color: [50, 80, 220],
        shape: "sphere",
        texturePath: "img/textures/2k_earth_daymap.jpg",
      },
      {
        name: "Mars",
        i: 1.84992,
        o: 49.5664,
        p: 336.0882,
        a: 1.5236365,
        n: 0.5240613,
        e: 0.0934231,
        l: 262.42784,
        diameterKm: 6794,
        massKg: 0.642e24,
        orbitdays: 687,
        rotationHours: { y: 24.6 },
        Dele: 2450680.5,
        color: [200, 20, 20],
        shape: "sphere",
        texturePath: "img/textures/2k_mars.jpg",
      },
      {
        name: "Jupiter",
        i: 1.30463,
        o: 100.4713,
        p: 15.6978,
        a: 5.202597,
        n: 0.08309618,
        e: 0.0484646,
        l: 322.55983,
        diameterKm: 142984,
        massKg: 1898e24,
        orbitdays: 4332,
        rotationHours: { y: 9.9 },
        Dele: 2450680.5,
        color: [159, 120, 71],
        shape: "sphere",
        texturePath: "img/textures/2k_jupiter.jpg",
      },
      {
        name: "Saturn",
        i: 2.48524,
        o: 113.6358,
        p: 88.863,
        a: 9.57189999999999,
        n: 0.03328656,
        e: 0.0531651,
        l: 20.95759,
        diameterKm: 120536,
        massKg: 568e24,
        orbitdays: 10760,
        rotationHours: { y: 10.7 },
        Dele: 2450680.5,
        color: [226, 195, 151],
        shape: "sphere",
        texturePath: "img/textures/2k_saturn.jpg",
      },
      {
        name: "Uranus",
        i: 0.77343,
        o: 74.0954,
        p: 175.6807,
        a: 19.30181,
        n: 0.01162295,
        e: 0.0428959,
        l: 303.18967,
        diameterKm: 51118,
        massKg: 86.8e24,
        orbitdays: 30700,
        rotationHours: { y: -17.2 },
        Dele: 2450680.5,
        color: [68, 210, 207],
        shape: "sphere",
        texturePath: "img/textures/2k_uranus.jpg",
      },
      {
        name: "Neptune",
        i: 1.7681,
        o: 131.7925,
        p: 7.206,
        a: 30.26664,
        n: 0.005919282,
        e: 0.0102981,
        l: 299.8641,
        diameterKm: 49532,
        massKg: 102e24,
        orbitdays: 60200,
        rotationHours: { y: 16.1 },
        Dele: 2450680.5,
        color: [69, 109, 247],
        shape: "sphere",
        texturePath: "img/textures/2k_neptune.jpg",
      },
      {
        name: "Pluto",
        i: 17.12137,
        o: 110.3833,
        p: 224.8025,
        a: 39.5804,
        n: 0.003958072,
        e: 0.2501272,
        l: 235.7656,
        diameterKm: 2370,
        massKg: 0.013e24,
        orbitdays: 90600,
        rotationHours: { y: -153.3 },
        Dele: 2450680.5,
        color: [128, 103, 81],
        shape: "sphere",
        texturePath: "img/textures/1k_pluto.jpg",
      },
      {
        name: "Tesla",
        i: 1.084119,
        o: 317.308,
        p: 137,
        a: 1.32792307,
        n: 0.644087245,
        e: 0.257443509,
        l: 145.15,
        diameterKm: 5000,
        massKg: 2000,
        orbitdays: 558,
        rotationHours: { x: 0, y: 0.029, z: 0.011 },
        Dele: 2458168.5,
        color: [255, 0, 0],
        shape: "car",
        texturePath: "img/textures/1k_roadster.jpg",
      },
    ],
  };
}
