import { createPricesRepository } from "./pricesRepository.js";
import { createPricesService } from "./pricesService.js";
import { createPricesController } from "./pricesController.js";

export function registerPriceRoutes(app, pool, staffAuth = null) {
  const controller = createPricesController(
    createPricesService(createPricesRepository(pool)),
  );
  const requireStaffSession = staffAuth?.requireSession
    ? Array.isArray(staffAuth.requireSession)
      ? staffAuth.requireSession
      : [staffAuth.requireSession]
    : [];

  app.get("/api/prices", controller.listPrices);
  app.put("/api/prices", ...requireStaffSession, controller.updatePrice);
}