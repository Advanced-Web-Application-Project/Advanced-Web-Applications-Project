import { registerBookingRoutes } from "./src/features/bookings/bookingsRoutes.js";
import { registerCinemaRoutes } from "./src/features/cinemas/cinemasRoutes.js";
import { registerFilmRoutes } from "./src/features/films/filmsRoutes.js";
import { registerSeatRoutes } from "./src/features/seats/seatsRoutes.js";
import { registerScreeningRoutes } from "./src/features/screenings/screeningsRoutes.js";

export default function registerApiRoutes(app, pool, { staffAuth }) {
  registerCinemaRoutes(app, pool);
  registerFilmRoutes(app, pool);
  registerScreeningRoutes(app, pool, staffAuth);
  registerSeatRoutes(app, pool);
  registerBookingRoutes(app, pool, staffAuth);

  // Pricing administration remains separate; checkout quotes own charged prices.
  app.get("/api/prices", async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM prices");
      res.status(200).json({ success: true, data: result.rows });
    } catch {
      console.error("There was an inside error while fetching prices");
      res.status(500).json({
        success: false,
        error: "There was an inside error while fetching prices",
      });
    }
  });
}
