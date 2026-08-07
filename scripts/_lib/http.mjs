function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getJsonWithRetry(url, options = {}) {
  const { attempts = 3, timeoutMs = 30000, allowErrorResponse = false } = options;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok && !allowErrorResponse) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
      return { response, payload: await response.json() };
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await wait(500 * (attempt + 1));
    }
  }
  throw lastError || new Error(`Request failed: ${url}`);
}
