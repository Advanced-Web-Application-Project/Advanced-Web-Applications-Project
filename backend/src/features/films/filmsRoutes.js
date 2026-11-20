import { createFilmsRepository } from "./filmsRepository.js";
import { createFilmsService } from "./filmsService.js";
import { createFilmsController } from "./filmsController.js";

export function registerFilmRoutes(app, pool) {
  const controller = createFilmsController(
    createFilmsService(createFilmsRepository(pool)),
  );
  app.get("/api/films", controller.listFilms);
  app.get("/api/films/:id", controller.getFilm);
}
