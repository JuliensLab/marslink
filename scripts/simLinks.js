// simLinks.js

export class SimLinks {
  constructor() {}

  /**
   * Determines the links between satellites and planets based on their positions.
   * Connects satellites in the same ring to their immediate neighbors first,
   * then adds additional links while respecting port constraints.
   *
   * @param {Array} planets - Array of planet objects, each with properties { name, position: { x, y, z } }.
   * @param {Array} satellites - Array of satellite objects with properties { name, position: { x, y, z } }.
   * @param {number} [maxDistanceAU=0.3] - Maximum distance in AU for creating a link.
   * @param {number} [maxLinksPerSatellite=2] - Maximum number of links (laser ports) per satellite.
   * @returns {Array} links - Array of link objects { from: { x, y, z }, to: { x, y, z } }.
   */
  getLinksData(planets, satellites, maxDistanceAU = 0.3, maxLinksPerSatellite = 5) {
    const links = [];

    // Find Earth and Mars in the planets array
    const earthPlanet = planets.find((planet) => planet.name === "Earth");
    const marsPlanet = planets.find((planet) => planet.name === "Mars");

    // Ensure Earth and Mars positions are available
    const earthPosition = earthPlanet?.position;
    const marsPosition = marsPlanet?.position;

    if (!earthPosition || !marsPosition) {
      console.warn("Earth or Mars position is not available.");
      return links;
    }

    // Create a map to track the number of links per satellite
    const satelliteLinkCounts = new Map();
    satellites.forEach((satellite, index) => {
      satelliteLinkCounts.set(index, 0); // Initialize link count to 0
    });

    // Function to calculate distance between two points in 3D space
    function calculateDistance(a, b) {
      return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
    }

    // First, connect satellites in the same ring to their immediate neighbors
    const ringSatellites = new Map(); // Map of ringName -> array of satellite indices

    satellites.forEach((satellite, index) => {
      const [ringName, satIndexStr] = satellite.name.split("-");
      const satIndex = parseInt(satIndexStr);

      if (!ringSatellites.has(ringName)) {
        ringSatellites.set(ringName, []);
      }
      ringSatellites.get(ringName).push({ satellite, index, satIndex });
    });

    // For each ring, sort satellites by their satIndex to ensure correct order
    ringSatellites.forEach((satelliteList, ringName) => {
      satelliteList.sort((a, b) => a.satIndex - b.satIndex);
    });

    // Now, connect each satellite to the next one in the same ring if within distance threshold
    ringSatellites.forEach((satelliteList, ringName) => {
      for (let i = 0; i < satelliteList.length; i++) {
        const currentSat = satelliteList[i];
        const nextSat = satelliteList[(i + 1) % satelliteList.length]; // Wrap around to first satellite

        // Calculate distance between current and next satellite
        const distance = calculateDistance(currentSat.satellite.position, nextSat.satellite.position);

        // Check if within distance threshold and satellites have available ports
        if (
          distance <= maxDistanceAU &&
          satelliteLinkCounts.get(currentSat.index) < maxLinksPerSatellite &&
          satelliteLinkCounts.get(nextSat.index) < maxLinksPerSatellite
        ) {
          // Add the link
          links.push({
            from: currentSat.satellite.position,
            to: nextSat.satellite.position,
          });

          // Increment link counts
          satelliteLinkCounts.set(currentSat.index, satelliteLinkCounts.get(currentSat.index) + 1);
          satelliteLinkCounts.set(nextSat.index, satelliteLinkCounts.get(nextSat.index) + 1);
        }
      }
    });

    // Now, proceed to add other links while respecting port constraints

    // Collect all possible link options with distances
    const possibleLinks = [];

    // === Collect links between satellites and planets ===
    const planetPositions = [
      { name: "Earth", position: earthPosition },
      { name: "Mars", position: marsPosition },
    ];

    satellites.forEach((satellite, satIndex) => {
      const satPosition = satellite.position;

      planetPositions.forEach((planet) => {
        const distance = calculateDistance(satPosition, planet.position);

        if (distance <= maxDistanceAU) {
          possibleLinks.push({
            fromType: "satellite",
            fromIndex: satIndex,
            toType: "planet",
            toName: planet.name,
            distance: distance,
            fromPosition: satPosition,
            toPosition: planet.position,
          });
        }
      });
    });

    // === Collect links between satellites (excluding immediate neighbors already connected) ===
    for (let i = 0; i < satellites.length; i++) {
      const satA = satellites[i];
      const [ringA, indexA] = satA.name.split("-");

      for (let j = i + 1; j < satellites.length; j++) {
        const satB = satellites[j];
        const [ringB, indexB] = satB.name.split("-");

        // Skip if they are immediate neighbors in the same ring (already connected)
        if (ringA === ringB && Math.abs(parseInt(indexA) - parseInt(indexB)) === 1) {
          continue;
        }

        const distance = calculateDistance(satA.position, satB.position);

        if (distance <= maxDistanceAU) {
          possibleLinks.push({
            fromType: "satellite",
            fromIndex: i,
            toType: "satellite",
            toIndex: j,
            distance: distance,
            fromPosition: satA.position,
            toPosition: satB.position,
          });
        }
      }
    }

    // === Collect links between planets (Earth and Mars) if within maxDistanceAU ===
    const earthMarsDistance = calculateDistance(earthPosition, marsPosition);
    if (earthMarsDistance <= maxDistanceAU) {
      possibleLinks.push({
        fromType: "planet",
        fromName: "Earth",
        toType: "planet",
        toName: "Mars",
        distance: earthMarsDistance,
        fromPosition: earthPosition,
        toPosition: marsPosition,
      });
    }

    // === Sort all possible links by ascending distance ===
    possibleLinks.sort((a, b) => a.distance - b.distance);

    // === Assign links while respecting the maxLinksPerSatellite constraint ===

    // Track the number of links per planet if needed (e.g., Earth and Mars can have unlimited links)
    // For this example, we'll assume planets have unlimited ports

    for (const link of possibleLinks) {
      let fromCanLink = true;
      let toCanLink = true;

      // Check if 'from' satellite has available ports
      if (link.fromType === "satellite") {
        const fromLinkCount = satelliteLinkCounts.get(link.fromIndex);
        if (fromLinkCount >= maxLinksPerSatellite) {
          fromCanLink = false;
        }
      }

      // Check if 'to' satellite has available ports
      if (link.toType === "satellite") {
        const toLinkCount = satelliteLinkCounts.get(link.toIndex);
        if (toLinkCount >= maxLinksPerSatellite) {
          toCanLink = false;
        }
      }

      // If both ends can link, assign the link
      if (fromCanLink && toCanLink) {
        links.push({
          from: link.fromPosition,
          to: link.toPosition,
        });

        // Increment link counts
        if (link.fromType === "satellite") {
          satelliteLinkCounts.set(link.fromIndex, satelliteLinkCounts.get(link.fromIndex) + 1);
        }
        if (link.toType === "satellite") {
          satelliteLinkCounts.set(link.toIndex, satelliteLinkCounts.get(link.toIndex) + 1);
        }
      }
    }

    // Return the array of assigned links
    return links;
  }
}
