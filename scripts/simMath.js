// simMath.js — small numeric helpers shared across the sim.
//
// minOf/maxOf replace `Math.min(...arr)` / `Math.max(...arr)`: spreading a large
// array into call arguments overflows the stack past ~65k elements ("Maximum call
// stack size exceeded"). In-ring capacity arrays scale with satellite count and can
// blow past that, so always reduce instead of spreading.

export function minOf(arr) {
  let m = Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
  return m;
}

export function maxOf(arr) {
  let m = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}
