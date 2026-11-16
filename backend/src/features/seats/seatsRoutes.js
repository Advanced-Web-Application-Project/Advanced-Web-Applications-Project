import { createSeatsRepository } from "./seatsRepository.js";
import { createSeatsService } from "./seatsService.js";
import { createSeatsController } from "./seatsController.js";

export function registerSeatRoutes(app, pool) {
  const controller = createSeatsController(
    createSeatsService(createSeatsRepository(pool)),
  );
  app.get("/api/seats", controller.listSeats);
  app.get("/api/seats/availability", controller.getAvailability);
}
