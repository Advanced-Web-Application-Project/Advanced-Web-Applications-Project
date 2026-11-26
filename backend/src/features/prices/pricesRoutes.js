import { createPricesRepository } from "./pricesRepository.js";
import { createPricesService } from "./pricesService.js";
import { createPricesController } from "./pricesController.js";

export function registerPriceRoutes(app, pool, staffAuth) {
  const controller = createPricesController(
    createPricesService(createPricesRepository(pool)),
  );
  const requireSession = staffAuth.requireSession;
  app.get("/api/prices", controller.listPrices);
  app.get("/api/staff/prices", ...requireSession, controller.listStaffPrices);
  app.put(
    "/api/prices",
    ...requireSession,
    staffAuth.requireCsrf,
    controller.updatePrice,
  );
}
