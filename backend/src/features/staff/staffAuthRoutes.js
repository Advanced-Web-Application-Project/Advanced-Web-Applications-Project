import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { createStaffAuthController } from "./staffAuthController.js";
import { createStaffAuthRepository } from "./staffAuthRepository.js";
import {
  createStaffAuthService,
  STAFF_SESSION_MS,
} from "./staffAuthService.js";
import { StaffAuthError, sendStaffError } from "./staffAuthError.js";

const noStore = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};
const call = (object, method) =>
  new Promise((resolve, reject) =>
    object[method]((error) => (error ? reject(error) : resolve())),
  );

export function registerStaffAuthRoutes(app, pool, config) {
  if (!config) {
    app.use("/api/staff", noStore, (_req, res) =>
      sendStaffError(
        res,
        new StaffAuthError(
          503,
          "STAFF_UNAVAILABLE",
          "Staff authentication is not configured.",
        ),
      ),
    );
    return {
      requireSession: [
        noStore,
        (_req, res) =>
          sendStaffError(
            res,
            new StaffAuthError(
              401,
              "STAFF_AUTH_REQUIRED",
              "Staff sign-in is required.",
            ),
          ),
      ],
      close: async () => {},
    };
  }
  const PgStore = connectPgSimple(session);
  const store = new PgStore({
    pool,
    schemaName: "public",
    tableName: "staff_sessions",
    createTableIfMissing: false,
    disableTouch: true,
    pruneSessionInterval: 15 * 60,
    errorLog: () => console.error("Staff session store failed"),
  });
  const cookieName = config.secureCookies ? "__Host-rio.staff" : "rio.staff";
  const cookie = {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: config.secureCookies ? "none" : "lax",
    path: "/",
    maxAge: STAFF_SESSION_MS,
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
      error ? sendStaffError(res, error) : next(),
    );
  const service = createStaffAuthService(
    createStaffAuthRepository(pool),
    config,
  );
  function origin(req, res, next) {
    let requestOrigin = req.get("Origin");
    if (requestOrigin === undefined && req.get("Referer")) {
      try {
        const ref = new URL(req.get("Referer"));
        if (!ref.username && !ref.password) requestOrigin = ref.origin;
      } catch {
        /* Deny malformed referrers. */
      }
    }
    if (requestOrigin !== config.origin)
      return sendStaffError(
        res,
        new StaffAuthError(
          403,
          "STAFF_ORIGIN_DENIED",
          "This origin is not permitted for staff requests.",
        ),
      );
    if (
      (config.secureCookies && !req.secure) ||
      (!config.secureCookies &&
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        ))
    )
      return sendStaffError(
        res,
        new StaffAuthError(
          403,
          "STAFF_HTTPS_REQUIRED",
          "Staff requests require HTTPS.",
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
      req.staffActor = await service.current(req.session?.staff);
      next();
    } catch (error) {
      if (
        error instanceof StaffAuthError &&
        error.status === 401 &&
        req.session?.staff
      ) {
        try {
          await call(req.session, "destroy");
          clearCookie(res);
        } catch (failure) {
          return sendStaffError(res, failure);
        }
      }
      sendStaffError(res, error);
    }
  }
  const controller = createStaffAuthController(service, config, clearCookie);
  app.use("/api/staff", noStore, origin, cookies);
  app.post("/api/staff/login", controller.login);
  app.get("/api/staff/session", authenticate, controller.current);
  app.post("/api/staff/logout", authenticate, controller.logout);
  return {
    requireSession: [noStore, origin, cookies, authenticate],
    close: () => store.close(),
  };
}
