import {
  DatabaseIdError,
  parseOptionalDatabaseId,
} from "../../utils/databaseId.js";

export { DatabaseIdError as ScreeningFilterError };

export function createScreeningsService(repository) {
  return {
    async listScreenings(query) {
      const filters = {};
      for (const name of ["cityId", "screenId", "filmId"]) {
        const value = parseOptionalDatabaseId(query, name);
        if (value !== undefined) filters[name] = value;
      }
      return repository.findScreenings(filters);
    },
  };
}
