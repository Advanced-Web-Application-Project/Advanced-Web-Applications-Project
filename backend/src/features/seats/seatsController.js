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
    listSeats: handle(service.listSeats),
    getAvailability: handle(service.getAvailability),
  };
}
