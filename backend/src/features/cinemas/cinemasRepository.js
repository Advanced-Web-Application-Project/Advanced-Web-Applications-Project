export function createCinemasRepository(pool) {
  return {
    async findCities() {
      return (await pool.query("SELECT id, name FROM cities ORDER BY id")).rows;
    },
    async findCity(id) {
      return (
        await pool.query("SELECT id, name FROM cities WHERE id = $1", [id])
      ).rows[0];
    },
    async findScreens(cityId) {
      return (
        await pool.query(
          `SELECT screens.id, screens.capacity, screens.wheelchair_capacity,
                screens.city_id, cities.name AS city_name
         FROM screens JOIN cities ON screens.city_id = cities.id
         ${cityId === undefined ? "" : "WHERE screens.city_id = $1"}
         ORDER BY screens.id ASC`,
          cityId === undefined ? [] : [cityId],
        )
      ).rows;
    },
    async findScreen(id) {
      return (
        await pool.query(
          `SELECT screens.id, screens.capacity, screens.wheelchair_capacity,
                screens.city_id, cities.name AS city_name
         FROM screens JOIN cities ON screens.city_id = cities.id
         WHERE screens.id = $1`,
          [id],
        )
      ).rows[0];
    },
  };
}
