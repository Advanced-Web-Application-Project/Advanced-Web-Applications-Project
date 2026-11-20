import { DatabaseIdError } from "../../utils/databaseId.js";

export function createFilmsController(service) {
  function handle(read, failure) {
    return async (req, res) => {
      try {
        const data = await read(req);
        if (data === undefined)
          return res
            .status(404)
            .json({ success: false, error: "Film not found" });
        res.status(200).json({ success: true, data });
      } catch (error) {
        if (error instanceof DatabaseIdError)
          return res.status(400).json({ success: false, error: error.message });
        console.error("Film read failed");
        res.status(500).json({ success: false, error: failure });
      }
    };
  }
  return {
    listFilms: handle(
      () => service.listFilms(),
      "There was a inside error while fetching films",
    ),
    getFilm: handle(
      (req) => service.getFilm(req.params.id),
      " There was an inside error while fetching film",
    ),
  };
}
