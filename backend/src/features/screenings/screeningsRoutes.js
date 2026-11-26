import { createSeatsRepository } from "../seats/seatsRepository.js";
import { createStaffScreeningsRepository } from "./staffScreeningsRepository.js";
import { createStaffScreeningsService } from "./staffScreeningsService.js";
import { createCinemasRepository } from "../cinemas/cinemasRepository.js";
import { createStaffScreeningsController } from "./staffScreeningsController.js";
import { createScreeningsRepository } from "./screeningsRepository.js";
import { createScreeningsService } from "./screeningsService.js";
import { createScreeningsController } from "./screeningsController.js";

export function registerScreeningRoutes(app, pool, staffAuth) {
  const repository = createScreeningsRepository(pool);
  const service = createScreeningsService(repository);
  const controller = createScreeningsController(service);
  app.get("/api/screenings", controller.listScreenings);
  const staffService = createStaffScreeningsService(
    createStaffScreeningsRepository(pool),
    createCinemasRepository(pool),
    createSeatsRepository(pool),
  );
  const staffController = createStaffScreeningsController(staffService);
  app.get(
    "/api/staff/screenings/:screeningId",
    ...staffAuth.requireSession,
    staffController.detail,
  );
  app.get(
    "/api/staff/screenings",
    ...staffAuth.requireSession,
    staffController.list,
  );
}
