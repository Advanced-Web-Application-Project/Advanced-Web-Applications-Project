import { useCallback } from "react";
import { Link, useLocation, useParams } from "react-router";
import { safeReturnPath } from "../../../routes/returnPath.js";
import { formatScreeningTime } from "../services/screeningList.js";
import { validateScreeningDetail } from "../services/occupancyLayout.js";
import { useScreeningRead } from "../hooks/useScreeningRead.js";
import OccupancyMap from "./OccupancyMap.jsx";
export default function StaffScreeningDetail() {
  const { screeningId } = useParams(),
    location = useLocation();
  const validate = useCallback(
    (data) => validateScreeningDetail(data, Number(screeningId)),
    [screeningId],
  );
  const { data, error, loading, refresh } = useScreeningRead(
    `/staff/screenings/${encodeURIComponent(screeningId)}`,
    validate,
    ".occupancy-map",
  );
  return (
    <section aria-label="Screening occupancy">
      <div className="list-toolbar">
        <Link
          className="button-link"
          to={safeReturnPath("/screenings" + location.search)}
        >
          Back to screenings
        </Link>
        <button className="secondary" onClick={refresh} disabled={loading}>
          Refresh
        </button>
      </div>
      {loading ? (
        <p role="status">Loading screening…</p>
      ) : error ? (
        <div role="alert" className="panel">
          <p>
            {error.status === 404
              ? "Screening was not found or is not available to your account."
              : error.status === 403
                ? "You don’t have access to this screening."
                : error.status === 400
                  ? "This screening address is invalid."
                  : "Couldn’t load screening occupancy. Please try again."}
          </p>
          <button onClick={refresh}>Try again</button>
        </div>
      ) : (
        <>
          <section
            className="panel screening-detail-summary"
            aria-label="Screening information"
          >
            <h2>{data.screening.film_title}</h2>
            <p>
              <time dateTime={data.screening.screening_time}>
                {formatScreeningTime(data.screening.screening_time)}
              </time>{" "}
              · {data.screening.city_name} · Screen {data.screening.screen_id}
            </p>
            <p>
              Seated: {data.availability.seated.available ?? "Unknown"} /{" "}
              {data.availability.seated.total} available · Wheelchair:{" "}
              {data.availability.wheelchair.available ?? "Unknown"} /{" "}
              {data.availability.wheelchair.total} available
            </p>
            <p role="status" className="hint">
              Updated {formatScreeningTime(data.availability.as_of)} · Helsinki
              time
            </p>
          </section>
          {data.availability.inventory_complete ? (
            <OccupancyMap places={data.places} />
          ) : (
            <p role="alert" className="error">
              Inventory is incomplete. The occupancy map and availability cannot
              be confirmed.
            </p>
          )}
        </>
      )}
    </section>
  );
}
