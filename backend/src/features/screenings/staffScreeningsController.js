import { sendStaffError } from "../staff/staffAuthError.js";
export function createStaffScreeningsController(service) {
  return {
    async detail(req, res) {
      try {
        res.json({
          success: true,
          data: await service.detail(req.params.screeningId, req.staffActor),
        });
      } catch (error) {
        sendStaffError(res, error);
      }
    },
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
