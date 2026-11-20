import {
  parseDatabaseId,
  parseOptionalDatabaseId,
} from "../../utils/databaseId.js";

export function createCinemasService(repository) {
  return {
    listCities: () => repository.findCities(),
    getCity: (id) => repository.findCity(parseDatabaseId(id)),
    listScreens: (query) =>
      repository.findScreens(parseOptionalDatabaseId(query, "cityId")),
    getScreen: (id) => repository.findScreen(parseDatabaseId(id)),
  };
}
