import { SeatSelectionRequestError } from "./seatSelectionValidation.js";
import { SeatRequestError } from "./seatsService.js";

export function createSeatsController(service) {
  function handle(read) {
    return async (req, res) => {
      try {
        res.status(200).json({ success: true, data: await read(req.query) });
      } catch (error) {
        if (error instanceof SeatRequestError)
          return res.status(400).json({ success: false, error: error.message });
        console.error("There was an error fetching the seats");
        res.status(500).json({
          success: false,
          error: "There was a inside error while fetching the Seat data",
        });
      }
    };
  }
  return {
    async validateSelection(req, res) {
      res.set("Cache-Control", "no-store");
      try {
        res.status(200).json({
          success: true,
          data: await service.validateSelection(req.body),
        });
      } catch (error) {
        if (
          error instanceof SeatSelectionRequestError ||
          error instanceof SeatRequestError
        )
          return res.status(400).json({
            success: false,
            code:
              error instanceof SeatSelectionRequestError
                ? "INVALID_SELECTION_REQUEST"
                : "INVALID_SCREENING",
            error: error.message,
          });
        console.error("Seat selection validation failed");
        res.status(500).json({
          success: false,
          code: "VALIDATION_FAILED",
          error: "Seat selection could not be checked. Please retry.",
        });
      }
    },
    listSeats: handle(service.listSeats),
    getAvailability: handle(service.getAvailability),
  };
}
