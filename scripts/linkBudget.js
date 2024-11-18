export function calculateDatarate(nominalRate, nominalDistance, targetDistance) {
  return (nominalRate * Math.pow(nominalDistance, 2)) / Math.pow(targetDistance, 2);
}
