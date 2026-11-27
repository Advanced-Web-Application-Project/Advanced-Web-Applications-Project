import { randomBytes, timingSafeEqual } from "node:crypto";
import { CustomerAuthError, sendCustomerError } from "./customerAuthError.js";

const call = (object, method) =>
  new Promise((resolve, reject) =>
    object[method]((error) => (error ? reject(error) : resolve())),
  );

export function createCustomerAuthController(service, config, clearCookie) {
  function writeOrigin(req) {
    if (req.get("Origin") !== config.origin)
      throw new CustomerAuthError(
        403,
        "CUSTOMER_ORIGIN_DENIED",
        "A configured customer origin is required.",
      );
  }
  function checkCsrf(req) {
    writeOrigin(req);
    const token = req.get("X-CSRF-Token"),
      expected = req.session?.csrfToken;
    if (
      typeof token !== "string" ||
      typeof expected !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !/^[A-Za-z0-9_-]{43}$/.test(expected) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      throw new CustomerAuthError(
        403,
        "CSRF_DENIED",
        "Refresh the customer session and retry this action.",
      );
  }
  function identity(req) {
    return {
      user: req.customerUser,
      expiresAt: new Date(req.session.customer.expiresAt).toISOString(),
      csrfToken: req.session.csrfToken,
    };
  }
  async function establishSession(req, res, data, status) {
    await call(req.session, "regenerate");
    req.session.customer = data;
    req.session.csrfToken = randomBytes(32).toString("base64url");
    req.session.cookie.expires = new Date(data.expiresAt);
    req.session.cookie.originalMaxAge = Math.max(
      0,
      data.expiresAt - Date.now(),
    );
    try {
      req.customerUser = await service.current(data);
      await call(req.session, "save");
    } catch (error) {
      await call(req.session, "destroy").catch(() => {});
      clearCookie(res);
      throw error;
    }
    res.status(status).json({ success: true, data: identity(req) });
  }
  function checkLoginRequest(req) {
    writeOrigin(req);
    if (!req.is("application/json") || req.get("X-RIO-Customer") !== "1")
      throw new CustomerAuthError(
        403,
        "CUSTOMER_LOGIN_REQUEST_DENIED",
        "Use the customer JSON account request.",
      );
  }
  function sendAuthError(res, error) {
    if (error instanceof CustomerAuthError && error.status === 429)
      res.set("Retry-After", error.code === "LOGIN_BUSY" ? "5" : "900");
    sendCustomerError(res, error);
  }
  return {
    async login(req, res) {
      try {
        checkLoginRequest(req);
        const data = await service.login(req.body, req.ip);
        await establishSession(req, res, data, 200);
      } catch (error) {
        sendAuthError(res, error);
      }
    },
    async register(req, res) {
      try {
        checkLoginRequest(req);
        const data = await service.register(req.body, req.ip);
        await establishSession(req, res, data, 201);
      } catch (error) {
        sendAuthError(res, error);
      }
    },
    current(req, res) {
      res.status(200).json({ success: true, data: identity(req) });
    },
    async logout(req, res) {
      try {
        checkCsrf(req);
        await call(req.session, "destroy");
        clearCookie(res);
        res.status(200).json({ success: true, data: { signedOut: true } });
      } catch (error) {
        sendCustomerError(res, error);
      }
    },
  };
}
