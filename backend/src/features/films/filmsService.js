import { parseDatabaseId } from "../../utils/databaseId.js";

export function createFilmsService(repository) {
  return {
    listFilms: () => repository.findFilms(),
    getFilm: (id) => repository.findFilm(parseDatabaseId(id)),
  };
}
