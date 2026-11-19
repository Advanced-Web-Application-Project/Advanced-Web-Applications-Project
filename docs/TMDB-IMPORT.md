# TMDB Film Import

Imports an explicit list of TMDB movie IDs into the local PostgreSQL `films` table
via a backend-only CLI command. Customer browsing (`GET /api/films`, `GET /api/films/:id`)
continues reading retained local PostgreSQL rows with no runtime dependency on TMDB.

## Prerequisites & Setup

1. Ensure the local isolated PostgreSQL database is running and migrations (including
   the append-only `films_tmdb_metadata_api_id_uidx` migration) have been applied.
2. Add your TMDB API Read Access Token (v4 Bearer token) to `backend/.env` (never commit `.env`):

   ```dotenv
   RIO_DATABASE_MODE=isolated-development
   DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/rio_dev
   TMDB_API_READ_ACCESS_TOKEN=<your-tmdb-read-access-token>