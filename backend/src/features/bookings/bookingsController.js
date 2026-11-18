import { BookingError } from "./bookingsService.js";

export function createBookingsController(service) {
  function handle(action, status = 200) {
    return async (req, res) => {
      try {
        const data = await action(req);
        res.set("Cache-Control", "no-store");
        res.status(status).json({ success: true, data });
      } catch (error) {
        if (error instanceof BookingError)
          return res.status(error.status).json({
            success: false,
            code: error.code,
            error: error.message,
            ...(error.details ? { details: error.details } : {}),
          });
        if (["23505", "40P01", "55P03", "40001"].includes(error.code))
          return res.status(409).json({
            success: false,
            code: "ALLOCATION_CONFLICT",
            error:
              "Availability changed or the request conflicted. Refresh and retry.",
          });
        console.error("Booking request failed");
        res.status(500).json({
          success: false,
          code: "BOOKING_FAILED",
          error: "The booking request could not be completed. Please retry.",
        });
      }
    };
  }
  return {
    list: handle((req) => service.listBookings(req.query)),
    create: handle((req) => service.createHold(req.body), 201),
    release: handle((req) =>
      service.releaseHold(req.params.id, req.get("Authorization")),
    ),
  };
}
