import "dotenv/config";
import { FilmImportValidationError } from "../src/features/films/filmImportError.js";
import { loadTmdbImportConfig } from "../src/config/tmdbImportConfig.js";
import { createDatabasePool } from "../src/config/database.js";
import {
  createTmdbClient,
  TmdbUpstreamError,
} from "../src/features/films/tmdbClient.js";
import { createFilmImportRepository } from "../src/features/films/filmImportRepository.js";
import { importTmdbFilms } from "../src/features/films/filmImportService.js";
import { migrateDatabase } from "./database/migrate.js";
import { seedBrowsing } from "./database/seed-browsing.js";
import { seedInventory } from "./database/seed-inventory.js";
import {
  planPresentation,
  seedPresentationScreenings,
} from "./database/seed-presentation.js";
import {
  DatabaseCommandError,
  reportDatabaseError,
} from "./database/connection.js";
import {
  PRESENTATION_MOVIES,
  PRESENTATION_START_DATE,
} from "../../database/seeds/presentation.js";

let pool;
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--start-date"))
    throw new DatabaseCommandError(
      "Usage: npm run db:seed:presentation -- --start-date YYYY-MM-DD",
    );
  const startDate = args[1] ?? PRESENTATION_START_DATE;
  planPresentation(startDate);
  const config = loadTmdbImportConfig();
  const mode = process.env.RIO_DATABASE_MODE;
  const target = { databaseUrl: config.databaseUrl, mode };
  await migrateDatabase(target);
  await seedBrowsing({ ...target, includeDemoScreenings: false });
  await seedInventory(target);
  pool = createDatabasePool(config);
  const imported = await importTmdbFilms({
    rawIds: PRESENTATION_MOVIES.map((f) => f.tmdbId),
    tmdbClient: createTmdbClient(config.tmdb),
    filmImportRepository: createFilmImportRepository(pool, {
      database: config.dbName,
    }),
  });
  const result = await seedPresentationScreenings({ ...target, startDate });
  console.log(
    JSON.stringify(
      {
        database: config.dbName,
        startDate,
        timezone: result.timezone,
        movies: imported.films.map((f) => ({
          id: f.localId,
          title: f.title,
          providerId: f.metadataApiId,
        })),
        screenings: result.screenings.length,
        created: result.createdScreenings,
        retained: result.retainedScreenings,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (
    error instanceof FilmImportValidationError ||
    error instanceof TmdbUpstreamError
  ) {
    console.error(`Presentation import failed: ${error.message}`);
    process.exitCode = 1;
  } else reportDatabaseError(error);
} finally {
  await pool?.end();
}
