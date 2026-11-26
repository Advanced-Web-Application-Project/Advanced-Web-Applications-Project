import { randomBytes, timingSafeEqual } from "node:crypto";
import { StaffAuthError, sendStaffError } from "./staffAuthError.js";

const call = (object, method) =>
  new Promise((resolve, reject) =>
    object[method]((error) => (error ? reject(error) : resolve())),
  );

export function createStaffAuthController(service, config, clearCookie) {
  function writeOrigin(req) {
    if (req.get("Origin") !== config.origin)
      throw new StaffAuthError(
        403,
        "STAFF_ORIGIN_DENIED",
        "A configured staff origin is required.",
      );
  }
  function identity(req) {
    return {
      user: {
        id: req.staffActor.userId,
        role: req.staffActor.role,
        cityId: req.staffActor.cityId,
      },
      expiresAt: new Date(req.session.staff.expiresAt).toISOString(),
      csrfToken: req.session.csrfToken,
    };
  }
  return {
    async login(req, res) {
      try {
        writeOrigin(req);
        if (!req.is("application/json") || req.get("X-RIO-Staff") !== "1")
          throw new StaffAuthError(
            403,
            "STAFF_LOGIN_REQUEST_DENIED",
            "Use the staff JSON sign-in request.",
          );
        const data = await service.login(req.body, req.ip);
        await call(req.session, "regenerate");
        req.session.staff = data;
        req.session.csrfToken = randomBytes(32).toString("base64url");
        req.session.cookie.expires = new Date(data.expiresAt);
        req.session.cookie.originalMaxAge = Math.max(
          0,
          data.expiresAt - Date.now(),
        );
        try {
          req.staffActor = await service.current(data);
          await call(req.session, "save");
          await service.recordEvent(data.userId, "login");
        } catch (error) {
          await call(req.session, "destroy").catch(() => {});
          clearCookie(res);
          throw error;
        }
        res.status(200).json({ success: true, data: identity(req) });
      } catch (error) {
        if (error instanceof StaffAuthError && error.status === 429)
          res.set("Retry-After", error.code === "LOGIN_BUSY" ? "5" : "900");
        sendStaffError(res, error);
      }
    },
    current(req, res) {
      res.status(200).json({ success: true, data: identity(req) });
    },
    async logout(req, res) {
      try {
        assertStaffCsrf(req, config);
        const userId = req.staffActor.userId;
        await call(req.session, "destroy");
        clearCookie(res);
        await service.recordEvent(userId, "logout");
        res.status(200).json({ success: true, data: { signedOut: true } });
      } catch (error) {
        sendStaffError(res, error);
      }
    },
  };
}

export function assertStaffCsrf(req, config) {
  if (req.get("Origin") !== config.origin)
    throw new StaffAuthError(
      403,
      "STAFF_ORIGIN_DENIED",
      "A configured staff origin is required.",
    );
  const token = req.get("X-CSRF-Token"),
    expected = req.session?.csrfToken;
  if (
    typeof token !== "string" ||
    typeof expected !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !/^[A-Za-z0-9_-]{43}$/.test(expected) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  )
    throw new StaffAuthError(
      403,
      "CSRF_DENIED",
      "Refresh the staff session and retry this action.",
    );
}
