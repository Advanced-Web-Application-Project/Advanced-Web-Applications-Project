import { createCinemasRepository } from "./cinemasRepository.js";
import { createCinemasService } from "./cinemasService.js";
import { createCinemasController } from "./cinemasController.js";

export function registerCinemaRoutes(app, pool) {
  const controller = createCinemasController(
    createCinemasService(createCinemasRepository(pool)),
  );
  app.get("/api/cities", controller.listCities);
  app.get("/api/cities/:id", controller.getCity);
  app.get("/api/screens", controller.listScreens);
  app.get("/api/screens/:id", controller.getScreen);
}
