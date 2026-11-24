import { sendStaffError } from "../staff/staffAuthError.js";
export function createStaffScreeningsController(service) {
  return {
    async list(req, res) {
      try {
        res.json({
          success: true,
          data: await service.list(req.query, req.staffActor),
        });
      } catch (error) {
        sendStaffError(res, error);
      }
    },
  };
}
