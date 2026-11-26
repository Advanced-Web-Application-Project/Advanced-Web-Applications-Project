import { useScreeningRead } from "../hooks/useScreeningRead.js";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useSession } from "../../session/hooks/useSession.js";
import {
  formatScreeningTime,
  screeningListQuery,
  validateScreeningList,
} from "../services/screeningList.js";

function Filters({ data, session, apply }) {
  const { filters, cities, screens } = data;
  const [city, setCity] = useState(String(filters.cityId ?? ""));
  return (
    <form
      className="screening-filters panel"
      aria-label="Screening filters"
      onSubmit={(event) => {
        event.preventDefault();
        apply(
          screeningListQuery(
            new FormData(event.currentTarget),
            session.user.role,
            session.user.cityId,
          ),
        );
      }}
    >
      <div className="selection-field">
        <label htmlFor="city-filter">City</label>
        <select
          id="city-filter"
          name="cityId"
          value={city}
          disabled={session.user.role === "cashier"}
          onChange={(event) => {
            setCity(event.target.value);
            event.currentTarget.form.elements.screenId.value = "";
          }}
        >
          {session.user.role === "administrator" && (
            <option value="">All cities</option>
          )}
          {cities.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="selection-field">
        <label htmlFor="from-filter">From</label>
        <input
          id="from-filter"
          type="date"
          name="dateFrom"
          required
          defaultValue={filters.dateFrom}
        />
      </div>
      <div className="selection-field">
        <label htmlFor="to-filter">Through</label>
        <input
          id="to-filter"
          type="date"
          name="dateTo"
          required
          defaultValue={filters.dateTo}
        />
      </div>
      <div className="selection-field">
        <label htmlFor="screen-filter">Screen</label>
        <select
          id="screen-filter"
          name="screenId"
          defaultValue={filters.screenId ?? ""}
        >
          <option value="">All screens</option>
          {screens
            .filter((item) => !city || item.city_id === Number(city))
            .map((item) => (
              <option key={item.id} value={item.id}>
                Screen {item.id} ·{" "}
                {cities.find((c) => c.id === item.city_id)?.name} ·{" "}
                {item.capacity} seats
              </option>
            ))}
        </select>
      </div>
      <button type="submit">Apply filters</button>
      <p className="hint">Helsinki dates and times. Choose up to 31 days.</p>
    </form>
  );
}
function Places({ value }) {
  return (
    <span>
      {value.available === null ? "Unavailable" : value.available}{" "}
      <span className="hint">/ {value.total} available</span>
    </span>
  );
}
export default function StaffScreeningList() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const { data, error, loading, refresh } = useScreeningRead(
    `/staff/screenings${query ? `?${query}` : ""}`,
    validateScreeningList,
    ".screening-filters",
  );
  const returnQuery = data
    ? new URLSearchParams(
        Object.entries(data.filters)
          .filter(([, value]) => value !== null)
          .map(([key, value]) => [key, String(value)]),
      ).toString()
    : "";
  return (
    <section aria-label="Staff screenings" className="screening-list">
      <div className="list-toolbar">
        <p className="hint">
          Availability is a snapshot. Viewing this list does not reserve places.
        </p>
        <button className="secondary" onClick={refresh} disabled={loading}>
          Refresh
        </button>
      </div>
      {loading ? (
        <p role="status">Loading screenings…</p>
      ) : error ? (
        <div className="panel" role="alert">
          <p>
            {error.status === 403
              ? "You don’t have access to these screening filters."
              : error.status === 400 || error.status === 404
                ? "Check the city, screen and date range in your filters."
                : "Couldn’t load screenings. Please try again."}
          </p>
          <button onClick={refresh}>Try again</button>{" "}
          <button className="secondary" onClick={() => setParams({})}>
            Reset filters
          </button>
        </div>
      ) : (
        <>
          <Filters
            key={query}
            data={data}
            session={session}
            apply={setParams}
          />
          <p className="hint" role="status">
            Updated {formatScreeningTime(data.as_of)} · {data.screenings.length}{" "}
            {data.screenings.length === 1 ? "screening" : "screenings"}
          </p>
          {data.truncated && (
            <p role="status" className="notice">
              Showing the first 500 screenings. Narrow your filters to see the
              remaining screenings.
            </p>
          )}
          {!data.screenings.length ? (
            <p className="panel" role="status">
              No screenings match these filters.
            </p>
          ) : (
            <ul className="screening-cards" aria-label="Screening results">
              {data.screenings.map((row) => (
                <li className="panel screening-card" key={row.id}>
                  <div>
                    <h2>{row.film_title}</h2>
                    <p>
                      <time dateTime={row.screening_time}>
                        {formatScreeningTime(row.screening_time)}
                      </time>
                    </p>
                    <p className="hint">
                      {row.city_name} · Screen {row.screen_id}
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>Seated</dt>
                      <dd>
                        <Places value={row.availability.seated} />
                      </dd>
                    </div>
                    <div>
                      <dt>Wheelchair</dt>
                      <dd>
                        <Places value={row.availability.wheelchair} />
                      </dd>
                    </div>
                  </dl>
                  <Link
                    className="button-link occupancy-link"
                    to={`/screenings/${row.id}${returnQuery ? `?${returnQuery}` : ""}`}
                    aria-label={`View occupancy for ${row.film_title}, screen ${row.screen_id}, ${formatScreeningTime(row.screening_time)}`}
                  >
                    View occupancy
                  </Link>
                  {!row.availability.inventory_complete && (
                    <p role="status" className="error">
                      Inventory is incomplete. Availability cannot be confirmed.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
