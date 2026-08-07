const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class UpstreamHttpError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'UpstreamHttpError';
    this.status = status;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelay(response, attempt, baseDelayMs) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 2500);
  }
  return Math.min(baseDelayMs * (2 ** attempt), 2000);
}

export async function fetchWithPolicy(url, options = {}, policy = {}) {
  const {
    timeoutMs = 10000,
    retries = 2,
    baseDelayMs = 250,
  } = policy;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === retries) {
        return response;
      }
      lastError = new UpstreamHttpError(`Upstream HTTP ${response.status}`, response.status);
      await wait(retryDelay(response, attempt, baseDelayMs));
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await wait(Math.min(baseDelayMs * (2 ** attempt), 2000));
    }
  }

  throw lastError || new UpstreamHttpError('Upstream request failed');
}

export async function fetchJsonWithPolicy(url, options = {}, policy = {}) {
  const response = await fetchWithPolicy(url, options, policy);
  if (!response.ok) {
    throw new UpstreamHttpError(`Upstream HTTP ${response.status}`, response.status);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new UpstreamHttpError(`Invalid upstream JSON: ${error.message}`, response.status);
  }
}

export async function mapWithConcurrency(items, limit, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function setPublicCache(res, maxAge, staleWhileRevalidate) {
  res.setHeader('Cache-Control', `s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`);
}
