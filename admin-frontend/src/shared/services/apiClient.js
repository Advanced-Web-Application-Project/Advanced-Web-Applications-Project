export class ApiError extends Error {
  constructor(message, status = 0, code = "", retryAfter = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
export function validateApiBase(value) {
  if (value === "/api") return value;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.replace(/\/$/, "") !== "/api"
    )
      throw Error();
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw Error();
    return url.href.replace(/\/$/, "");
  } catch {
    throw new ApiError(
      "The staff service address is not configured correctly.",
      0,
      "CONFIGURATION",
    );
  }
}
export function createApiClient(
  base,
  {
    onUnauthorized = () => {},
    getCsrfToken = () => null,
    fetchImpl = (...args) => fetch(...args),
    timeoutMs = 15000,
  } = {},
) {
  const root = validateApiBase(base);
  return async function request(
    path,
    {
      method = "GET",
      body,
      signal,
      ignoreUnauthorized = false,
      csrf = true,
      csrfToken,
    } = {},
  ) {
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//")
    )
      throw new ApiError("Invalid staff request.");
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const token = csrfToken ?? getCsrfToken();
      const response = await fetchImpl(root + path, {
        method,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(path === "/staff/login" ? { "X-RIO-Staff": "1" } : {}),
          ...(csrf && method !== "GET" && token
            ? { "X-CSRF-Token": token }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (error.name === "AbortError") throw error;
        if (response.status === 401 && !ignoreUnauthorized) onUnauthorized();
        throw new ApiError(
          "The staff service returned an unexpected response.",
          response.status,
          "INVALID_RESPONSE",
        );
      }
      if (!response.ok || data?.success !== true) {
        if (response.status === 401 && !ignoreUnauthorized) onUnauthorized();
        const raw = Number(response.headers.get("Retry-After"));
        throw new ApiError(
          "The staff request could not be completed.",
          response.status,
          typeof data?.code === "string" ? data.code : "",
          response.status === 429
            ? Number.isFinite(raw) && raw > 0
              ? Math.min(900, Math.ceil(raw))
              : 60
            : 0,
        );
      }
      if (!Object.hasOwn(data, "data"))
        throw new ApiError(
          "The staff service returned an unexpected response.",
          response.status,
          "INVALID_RESPONSE",
        );
      return data.data;
    } catch (error) {
      if (timedOut)
        throw new ApiError(
          "The staff service did not respond in time.",
          0,
          "TIMEOUT",
        );
      if (
        error instanceof ApiError ||
        signal?.aborted ||
        error.name === "AbortError"
      )
        throw error;
      throw new ApiError("Could not reach the staff service.", 0, "NETWORK");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
}
