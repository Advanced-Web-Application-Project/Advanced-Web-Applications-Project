import { DatabaseIdError } from "../../utils/databaseId.js";

export function createCinemasController(service) {
  function handle(read, failure, notFound) {
    return async (req, res) => {
      try {
        const data = await read(req);
        if (
          data === undefined ||
          (notFound && Array.isArray(data) && !data.length)
        ) {
          return res.status(404).json({ success: false, error: notFound });
        }
        res.status(200).json({ success: true, data });
      } catch (error) {
        if (error instanceof DatabaseIdError)
          return res.status(400).json({ success: false, error: error.message });
        console.error("Cinema read failed");
        res.status(500).json({ success: false, error: failure });
      }
    };
  }
  return {
    listCities: handle(
      () => service.listCities(),
      "There was an inside error while fetching cities",
      "No cities found",
    ),
    getCity: handle(
      (req) => service.getCity(req.params.id),
      "There was an inside error while fetching cities",
      "City not found",
    ),
    listScreens: handle(
      (req) => service.listScreens(req.query),
      "There was an internal error while fetching screens",
    ),
    getScreen: handle(
      (req) => service.getScreen(req.params.id),
      "There was an inside error while fetching screen",
      "Screen not found",
    ),
  };
}
