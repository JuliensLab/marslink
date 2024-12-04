// class LaunchSchedule {
//   constructor(solarSystem, date) {
//     this.solarSystem = solarSystem;
//     this.nextClosestApproachDate = closestApproachDate(date)
//   }

//   closestApproachDate(date) {
//     // calculates the date of the closest approach from this date to the future
//     // calculate position of Earth and Mars over the next 2 years and figure out the closest approach
//     this.solarSystem
//     return; // return the date of the closest approach
//   }

//   deltaVRequired(date, closestApproachDate){
//     const peakDeltaV = 1;
//     const daysDiff = Math.abs(closestApproachDate - date)
//     const pct = 30-daysDiff
//     if (pct < 0) return Infinity
//     return peakDeltaV  * pct
//   }

//   launchSchedule(date, launchCountPerWindow){
//     const closestApproachDate = this.closestApproach(date)
//     const peakLaunchDate = closestApproachDate - 6 months
//     // departure rate distribution:
//     // 100% of max at peakLaunchDate
//     // 80% of max at peakLaunchDate +/- 10 days
//     // 60% of max at peakLaunchDate +/- 20 days
//     // 40% of max at peakLaunchDate +/- 30 days
//     // 20% of max at peakLaunchDate +/- 40 days
//     // 0% of max at peakLaunchDate +/- 50 days
//     // Total launches is launchCountPerWindow
//     const launchSchedule = [{dateDeparture: date, dateArrival: date, orbit:{
//         // i = inclination in degrees
//         // a = semi major axis (distance between sun and planet) in AU
//         // e = eccentricity dimensionless
//         // o = Longitude of the Ascending Node in degrees (RAAN)
//         // p = Argument of Perihelion in degrees
//         // n = Mean Motion in degrees per day
//         // l = Mean Longitude in degrees
//         }}, ...]
//     return launchSchedule
//   }
// }
