import { registerBookingRoutes } from "./src/features/bookings/bookingsRoutes.js";
import { registerCinemaRoutes } from "./src/features/cinemas/cinemasRoutes.js";
import { registerFilmRoutes } from "./src/features/films/filmsRoutes.js";
import { registerSeatRoutes } from "./src/features/seats/seatsRoutes.js";
import { registerPriceRoutes } from "./src/features/prices/pricesRoutes.js";
import { registerScreeningRoutes } from "./src/features/screenings/screeningsRoutes.js";

export default function registerApiRoutes(app, pool, { staffAuth }) {
  registerCinemaRoutes(app, pool);
  registerFilmRoutes(app, pool);
  registerScreeningRoutes(app, pool, staffAuth);
  registerSeatRoutes(app, pool);
  registerPriceRoutes(app, pool, staffAuth);
  registerBookingRoutes(app, pool, staffAuth);

  // Pricing administration remains separate; checkout quotes own charged prices.
}
