import express from "express";
import cors from "cors";
import registerApiRoutes from "../api.js";
import { registerStaffAuthRoutes } from "./features/staff/staffAuthRoutes.js";
import { registerCustomerAuthRoutes } from "./features/customer/customerAuthRoutes.js";

export function createApp({
  pool,
  frontendUrl,
  staff = null,
  customer = null,
}) {
  const app = express();
  if (
    staff &&
    customer &&
    staff.trustProxyHops !== customer.trustProxyHops
  )
    throw new Error("Staff and customer auth must use the same trusted proxy boundary");
  if (staff?.trustProxyHops || customer?.trustProxyHops)
    app.set(
      "trust proxy",
      staff?.trustProxyHops ?? customer?.trustProxyHops ?? 0,
    );
  const origins = new Set([frontendUrl, staff?.origin].filter(Boolean));
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(null, origins.has(origin) ? origin : false),
      credentials: true,
      exposedHeaders: ["Retry-After"],
    }),
  );
  app.use("/api/staff", express.json({ limit: "4kb" }));
  app.use("/api/customer", express.json({ limit: "4kb" }));
  app.use(express.json());
  const staffAuth = registerStaffAuthRoutes(app, pool, staff);
  const customerAuth = registerCustomerAuthRoutes(app, pool, customer);
  app.locals.closeAuth = async () => {
    await Promise.all([staffAuth.close(), customerAuth.close()]);
  };
  registerApiRoutes(app, pool, { staffAuth });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (
      req.path === "/api/customer" ||
      req.path.startsWith("/api/customer/") ||
      req.path === "/api/staff" ||
      req.path.startsWith("/api/staff/")
    )
      res.set("Cache-Control", "no-store");
    const status =
      error.type === "entity.parse.failed"
        ? 400
        : error.type === "entity.too.large"
          ? 413
          : 500;
    res.status(status).json({
      success: false,
      error:
        status === 400
          ? "Invalid JSON request body"
          : status === 413
            ? "Request body too large"
            : "Internal server error",
    });
  });
  return app;
}
