/**
 * Shared client-side utilities.
 */

/**
 * Format seconds as m:ss.
 * @param {number} s
 * @returns {string}
 */
export function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

/**
 * Clamp a value between min and max.
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Extract an error message from a failed fetch Response.
 * Falls back to `fallback` if the body is not JSON or has no .error field.
 * @param {Response} res
 * @param {string} fallback
 * @returns {Promise<string>}
 */
export async function parseErrorBody(res, fallback) {
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}
