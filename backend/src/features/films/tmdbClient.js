export class TmdbUpstreamError extends Error {
  constructor(message, { code, status = null, tmdbId = null } = {}) {
    super(message);
    this.name = "TmdbUpstreamError";
    this.code = code;
    this.status = status;
    this.tmdbId = tmdbId;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue, maxDelayMs) {
  if (!headerValue) return 500;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), maxDelayMs);
  }
  return 500;
}

export function createTmdbClient({
  accessToken,
  baseUrl = "https://api.themoviedb.org/3",
  language = "en-US",
  timeoutMs = 8000,
  maxRetries = 1,
  maxRetryDelayMs = 2000,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
}) {
  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    throw new TmdbUpstreamError("TMDB_API_READ_ACCESS_TOKEN is missing.", {
      code: "TMDB_MISSING_TOKEN",
    });
  }

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const safeMaxRetries = Math.floor(
    Math.min(Math.max(0, Number(maxRetries) || 0), 2),
  );

  async function requestJson(path, { query = {}, tmdbId = null } = {}) {
    const url = new URL(`${normalizedBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    while (true) {
      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          throw new TmdbUpstreamError(
            `TMDB request timed out after ${timeoutMs}ms (${path}).`,
            { code: "TMDB_TIMEOUT", tmdbId },
          );
        }
        throw new TmdbUpstreamError(
          `TMDB network request failed (${path}). Check connectivity.`,
          { code: "TMDB_NETWORK_ERROR", tmdbId },
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new TmdbUpstreamError(
          `TMDB authentication failed (HTTP ${response.status}). Check TMDB_API_READ_ACCESS_TOKEN.`,
          { code: "TMDB_AUTH_ERROR", status: response.status, tmdbId },
        );
      }

      if (response.status === 404) {
        throw new TmdbUpstreamError(
          tmdbId
            ? `TMDB movie ${tmdbId} was not found (HTTP 404).`
            : `TMDB resource not found at ${path} (HTTP 404).`,
          { code: "TMDB_NOT_FOUND", status: 404, tmdbId },
        );
      }

      if (response.status === 429) {
        if (attempt < safeMaxRetries) {
          const delayMs = parseRetryAfterMs(
            response.headers?.get?.("retry-after"),
            maxRetryDelayMs,
          );
          await response.body?.cancel();
          attempt += 1;
          await sleepImpl(delayMs);
          continue;
        }
        throw new TmdbUpstreamError(
          `TMDB rate limit exceeded (HTTP 429) for ${path}.`,
          { code: "TMDB_RATE_LIMITED", status: 429, tmdbId },
        );
      }

      if (response.status >= 500) {
        if (attempt < safeMaxRetries) {
          await response.body?.cancel();
          attempt += 1;
          await sleepImpl(Math.min(300, maxRetryDelayMs));
          continue;
        }
        throw new TmdbUpstreamError(
          `TMDB server error (HTTP ${response.status}) for ${path}.`,
          { code: "TMDB_SERVER_ERROR", status: response.status, tmdbId },
        );
      }

      if (!response.ok) {
        throw new TmdbUpstreamError(
          `TMDB returned unexpected HTTP ${response.status} for ${path}.`,
          { code: "TMDB_HTTP_ERROR", status: response.status, tmdbId },
        );
      }

      let payload;
      try {
        payload = await response.json();
      } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          throw new TmdbUpstreamError(
            `TMDB response timed out after ${timeoutMs}ms (${path}).`,
            { code: "TMDB_TIMEOUT", tmdbId },
          );
        }
        throw new TmdbUpstreamError(
          `TMDB returned malformed JSON for ${path}.`,
          { code: "TMDB_MALFORMED_RESPONSE", status: response.status, tmdbId },
        );
      }

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TmdbUpstreamError(
          `TMDB returned a non-object JSON payload for ${path}.`,
          { code: "TMDB_MALFORMED_RESPONSE", status: response.status, tmdbId },
        );
      }

      return payload;
    }
  }

  return {
    fetchConfiguration() {
      return requestJson("/configuration");
    },
    fetchMovieDetails(tmdbId) {
      return requestJson(`/movie/${tmdbId}`, {
        query: { language },
        tmdbId,
      });
    },
  };
}
