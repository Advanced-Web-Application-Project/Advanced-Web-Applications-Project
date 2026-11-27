function readHttpOrigin(value, name = "FRONTEND_URL") {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
}

export function readEnvironment(environment = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  try {
    const url = new URL(databaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "DATABASE_URL must be a PostgreSQL connection URL with a database name",
    );
  }

  if (!environment.FRONTEND_URL) {
    throw new Error("FRONTEND_URL is required");
  }
  const portValue = environment.PORT ?? "3000";
  const port = Number(portValue);
  if (
    !/^\d+$/.test(String(portValue)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    databaseUrl,
    frontendUrl: readHttpOrigin(environment.FRONTEND_URL),
    staff: readStaffEnvironment(environment),
    customer: readCustomerEnvironment(environment),
    port,
  };
}

export function readCustomerEnvironment(environment = process.env) {
  const secret = environment.CUSTOMER_SESSION_SECRET;
  if (!secret) return null;
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
    Buffer.from(secret, "base64url").toString("base64url") !== secret
  )
    throw new Error(
      "CUSTOMER_SESSION_SECRET must be a private random 32-byte canonical base64url value",
    );
  const origin = readHttpOrigin(environment.FRONTEND_URL);
  const url = new URL(origin);
  const secureCookies = url.protocol === "https:";
  if (
    !secureCookies &&
    (environment.NODE_ENV === "production" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "HTTP customer origins are allowed only for loopback development; production requires HTTPS",
    );
  const proxy =
    environment.CUSTOMER_TRUST_PROXY_HOPS ??
    environment.STAFF_TRUST_PROXY_HOPS ??
    "0";
  if (!["0", "1"].includes(String(proxy)))
    throw new Error(
      "CUSTOMER_TRUST_PROXY_HOPS must be 0 or 1; configure the verified deployment proxy boundary",
    );
  return {
    origin,
    secret,
    secureCookies,
    trustProxyHops: Number(proxy),
  };
}

export function readStaffEnvironment(environment = process.env) {
  if (!environment.STAFF_FRONTEND_URL && !environment.STAFF_SESSION_SECRET)
    return null;
  const origin = readHttpOrigin(
    environment.STAFF_FRONTEND_URL,
    "STAFF_FRONTEND_URL",
  );
  const secret = environment.STAFF_SESSION_SECRET;
  if (
    typeof secret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
    Buffer.from(secret, "base64url").toString("base64url") !== secret
  )
    throw new Error(
      "STAFF_SESSION_SECRET must be a private random 32-byte canonical base64url value",
    );
  if (origin === readHttpOrigin(environment.FRONTEND_URL))
    throw new Error("Staff and customer frontend origins must be distinct");
  const url = new URL(origin),
    secureCookies = url.protocol === "https:";
  if (
    !secureCookies &&
    (environment.NODE_ENV === "production" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "HTTP staff origins are allowed only for loopback development; production requires HTTPS",
    );
  const proxy = environment.STAFF_TRUST_PROXY_HOPS ?? "0";
  if (!["0", "1"].includes(String(proxy)))
    throw new Error(
      "STAFF_TRUST_PROXY_HOPS must be 0 or 1; configure the verified deployment proxy boundary",
    );
  return { origin, secret, secureCookies, trustProxyHops: Number(proxy) };
}
