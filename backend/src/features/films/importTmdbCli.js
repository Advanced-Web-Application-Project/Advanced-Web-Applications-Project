import { FilmImportValidationError } from "./filmImportError.js";
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { createDatabasePool } from "../../config/database.js";
import { DatabaseCommandError } from "../../../scripts/database/connection.js";
import { TmdbUpstreamError } from "./tmdbClient.js";
import { loadTmdbImportConfig } from "../../config/tmdbImportConfig.js";
import { createTmdbClient } from "./tmdbClient.js";
import { createFilmImportRepository } from "./filmImportRepository.js";
import {
  importTmdbFilms,
  parseAndValidateTmdbIds,
} from "./filmImportService.js";

export function parseCliArgs(argv) {
  let rawIds = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ids" || arg.startsWith("--ids=")) {
      if (rawIds !== null)
        throw new FilmImportValidationError("Specify --ids only once.");
    }
    if (arg === "--ids") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new FilmImportValidationError(
          "Missing value for --ids. Usage: npm run db:import:tmdb -- --ids 550,603",
        );
      }
      rawIds = next;
      i += 1;
    } else if (arg.startsWith("--ids=")) {
      rawIds = arg.slice("--ids=".length);
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, rawIds: null };
    } else {
      throw new FilmImportValidationError(
        "Unknown argument. Usage: npm run db:import:tmdb -- --ids 550,603",
      );
    }
  }

  if (rawIds === null) {
    throw new FilmImportValidationError(
      "Missing required flag --ids. Usage: npm run db:import:tmdb -- --ids 550,603",
    );
  }

  return { help: false, rawIds };
}

async function main() {
  let pool = null;

  try {
    const { help, rawIds } = parseCliArgs(process.argv.slice(2));
    if (help) {
      console.log(
        "Usage: npm run db:import:tmdb -- --ids <comma-separated-tmdb-movie-ids>",
      );
      process.exitCode = 0;
      return;
    }

    // Validate CLI IDs and environment before any network call or DB connection.
    parseAndValidateTmdbIds(rawIds);
    const config = loadTmdbImportConfig(process.env);

    pool = createDatabasePool(config);
    const tmdbClient = createTmdbClient(config.tmdb);
    const filmImportRepository = createFilmImportRepository(pool, {
      database: config.dbName,
    });

    const summary = await importTmdbFilms({
      rawIds,
      tmdbClient,
      filmImportRepository,
    });

    console.log(
      `Imported ${summary.films.length} TMDB film(s) into ${config.dbName} ` +
        `(inserted: ${summary.insertedCount}, updated: ${summary.updatedCount}, language: ${summary.language}):`,
    );
    for (const film of summary.films) {
      console.log(
        `  - [${film.action}] local_id=${film.localId} provider_id=${film.metadataApiId} ` +
          `title="${film.title}" poster=${film.posterUrl ? "present" : "null"}`,
      );
    }
  } catch (err) {
    const message =
      err instanceof FilmImportValidationError ||
      err instanceof DatabaseCommandError ||
      err instanceof TmdbUpstreamError
        ? err.message
        : "Database operation failed. Check connectivity, permissions and migrations; connection details are omitted.";
    console.error(`TMDB import failed: ${message}`);
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.end().catch(() => {
        console.error(
          "TMDB import failed: database cleanup failed; connection details are omitted.",
        );
        process.exitCode = 1;
      });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
