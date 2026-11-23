import express from "express";
import cors from "cors";
import registerApiRoutes from "../api.js";
import { registerStaffAuthRoutes } from "./features/staff/staffAuthRoutes.js";

export function createApp({ pool, frontendUrl, staff = null }) {
  const app = express();
  if (staff?.trustProxyHops) app.set("trust proxy", staff.trustProxyHops);
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
  app.use(express.json());
  const staffAuth = registerStaffAuthRoutes(app, pool, staff);
  app.locals.closeStaffAuth = staffAuth.close;
  registerApiRoutes(app, pool, { staffAuth });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
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
