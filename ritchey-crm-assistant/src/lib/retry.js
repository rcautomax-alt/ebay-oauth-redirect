export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors that retrying won't fix (you need to log back in first).
export class SessionError extends Error {}

export async function withRetry(fn, { tries = 3, baseMs = 700, maxMs = Infinity, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (err instanceof SessionError || i === tries - 1) break;
      onRetry?.(err, i + 1);
      await sleep(Math.min(baseMs * 2 ** i, maxMs));
    }
  }
  throw lastErr;
}
