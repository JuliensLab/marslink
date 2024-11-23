// simNetworkWorker.js

// importScripts("simNetwork.js"); // Import the SimNetwork class

// const simNetwork = new SimNetwork();

self.onmessage = function (e) {
  console.log(e);
  //   const { planets, satellites, maxDistanceAU, maxLinksPerSatellite } = e.data;

  // Perform the network computation
  //   const links = simNetwork.getNetworkData(planets, satellites, maxDistanceAU, maxLinksPerSatellite);
  const links = [];

  // Post the result back to the main thread
  self.postMessage({ links });
};
