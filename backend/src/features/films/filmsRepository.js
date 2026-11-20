export function createFilmsRepository(pool) {
  return {
    async findFilms() {
      return (
        await pool.query(
          "SELECT id, title, metadata_api_id, description, artwork_url FROM films ORDER BY id",
        )
      ).rows;
    },
    async findFilm(id) {
      return (
        await pool.query(
          "SELECT id, title, metadata_api_id, description, artwork_url FROM films WHERE id = $1",
          [id],
        )
      ).rows[0];
    },
  };
}
