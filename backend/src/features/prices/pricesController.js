import { PriceAdministrationError } from "./pricesError.js";
import { StaffAuthError } from "../staff/staffAuthError.js";

export function createPricesController(service) {
  const handle = (operation) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.status(200).json({ success: true, data: await operation(req) });
    } catch (error) {
      if (
        error instanceof PriceAdministrationError ||
        error instanceof StaffAuthError
      ) {
        return res
          .status(error.status)
          .json({ success: false, code: error.code, error: error.message });
      }
      if (
        ["23505", "23514", "40P01", "55P03", "40001", "22003"].includes(
          error?.code,
        )
      ) {
        return res.status(409).json({
          success: false,
          code: "PRICE_CONFLICT",
          error: "Price update conflicted. Reload and review before retrying",
        });
      }
      console.error("Price operation failed");
      res.status(500).json({
        success: false,
        code: "PRICE_OPERATION_FAILED",
        error:
          "Price operation could not be confirmed. Reload current settings",
      });
    }
  };
  return {
    listPrices: handle(() => service.listPrices()),
    listStaffPrices: handle((req) => service.listStaffPrices(req)),
    updatePrice: handle((req) => service.setPrice(req.body, req)),
  };
}
