import { createBookingsRepository } from "./bookingsRepository.js";
import { createBookingsService } from "./bookingsService.js";
import { createBookingsController } from "./bookingsController.js";

export function registerBookingRoutes(app, pool, staffAuth) {
  const controller = createBookingsController(
    createBookingsService(createBookingsRepository(pool)),
  );
  app.get("/api/bookings", ...staffAuth.requireSession, controller.list);
  app.post("/api/bookings/quote", controller.quote);
  app.post("/api/bookings", controller.create);
  app.delete("/api/bookings/:id", controller.release);
}
