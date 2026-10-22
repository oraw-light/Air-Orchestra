export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}
