import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { createCustomerAuthController } from "./customerAuthController.js";
import { createCustomerAuthRepository } from "./customerAuthRepository.js";
import {
  createCustomerAuthService,
  CUSTOMER_SESSION_MS,
} from "./customerAuthService.js";
import {
  CustomerAuthError,
  sendCustomerError,
} from "./customerAuthError.js";

const noStore = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};
const call = (object, method) =>
  new Promise((resolve, reject) =>
    object[method]((error) => (error ? reject(error) : resolve())),
  );

export function registerCustomerAuthRoutes(app, pool, config) {
  if (!config) {
    app.use("/api/customer", noStore, (_req, res) =>
      sendCustomerError(
        res,
        new CustomerAuthError(
          503,
          "CUSTOMER_AUTH_UNAVAILABLE",
          "Customer authentication is not configured.",
        ),
      ),
    );
    return { close: async () => {} };
  }
  const PgStore = connectPgSimple(session);
  const store = new PgStore({
    pool,
    schemaName: "public",
    tableName: "customer_sessions",
    createTableIfMissing: false,
    disableTouch: true,
    pruneSessionInterval: 15 * 60,
    errorLog: () => console.error("Customer session store failed"),
  });
  const cookieName = config.secureCookies
    ? "__Host-rio.customer"
    : "rio.customer";
  const cookie = {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: config.secureCookies ? "none" : "lax",
    path: "/",
    maxAge: CUSTOMER_SESSION_MS,
  };
  const middleware = session({
    name: cookieName,
    secret: config.secret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie,
  });
  const cookies = (req, res, next) =>
    middleware(req, res, (error) =>
      error ? sendCustomerError(res, error) : next(),
    );
  const service = createCustomerAuthService(
    createCustomerAuthRepository(pool),
    config,
  );
  function origin(req, res, next) {
    let requestOrigin = req.get("Origin");
    if (requestOrigin === undefined && req.get("Referer")) {
      try {
        const ref = new URL(req.get("Referer"));
        if (!ref.username && !ref.password) requestOrigin = ref.origin;
      } catch {
        requestOrigin = undefined;
      }
    }
    if (requestOrigin !== config.origin)
      return sendCustomerError(
        res,
        new CustomerAuthError(
          403,
          "CUSTOMER_ORIGIN_DENIED",
          "This origin is not permitted for customer requests.",
        ),
      );
    if (
      (config.secureCookies && !req.secure) ||
      (!config.secureCookies &&
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        ))
    )
      return sendCustomerError(
        res,
        new CustomerAuthError(
          403,
          "CUSTOMER_HTTPS_REQUIRED",
          "Customer requests require HTTPS.",
        ),
      );
    next();
  }
  const clearCookie = (res) =>
    res.clearCookie(cookieName, {
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      path: cookie.path,
    });
  async function authenticate(req, res, next) {
    try {
      req.customerUser = await service.current(req.session?.customer);
      next();
    } catch (error) {
      if (
        error instanceof CustomerAuthError &&
        error.status === 401 &&
        req.session?.customer
      ) {
        try {
          await call(req.session, "destroy");
          clearCookie(res);
        } catch (failure) {
          return sendCustomerError(res, failure);
        }
      }
      sendCustomerError(res, error);
    }
  }
  const controller = createCustomerAuthController(
    service,
    config,
    clearCookie,
  );
  app.use("/api/customer", noStore, origin, cookies);
  app.post("/api/customer/login", controller.login);
  app.post("/api/customer/register", controller.register);
  app.get("/api/customer/session", authenticate, controller.current);
  app.post("/api/customer/logout", authenticate, controller.logout);
  return { close: () => store.close() };
}
