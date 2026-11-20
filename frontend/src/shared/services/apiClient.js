export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function createApiClient(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  return async function apiRequest(
    path,
    { signal, method = "GET", body: requestBody, cache, headers = {} } = {},
  ) {
    const response = await fetch(`${base}/${path.replace(/^\/+/, "")}`, {
      method,
      headers: {
        ...headers,
        Accept: "application/json",
        ...(requestBody === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(requestBody === undefined
        ? {}
        : { body: JSON.stringify(requestBody) }),
      ...(cache === undefined ? {} : { cache }),
      signal,
    });
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new ApiError(
        "The cinema service returned an unexpected response.",
        response.status,
      );
    }
    if (!response.ok || body?.success !== true) {
      throw new ApiError(
        typeof body?.error === "string"
          ? body.error
          : "The cinema service could not complete the request.",
        response.status,
        typeof body?.code === "string" ? body.code : undefined,
      );
    }
    if (!Object.hasOwn(body, "data")) {
      throw new ApiError(
        "The cinema service returned an unexpected response.",
        response.status,
      );
    }
    return body.data;
  };
}

export const apiRequest = createApiClient(
  import.meta.env?.VITE_API_BASE_URL || "/api",
);

// Existing read services retain their public import.
export const apiGet = apiRequest;
