import { useEffect, useReducer } from "react";
import { getAvailability } from "../services/availabilityService.js";
import { formatShowtime } from "../utils/selection.js";

function ShowtimeAvailability({ screen, screening }) {
  const [attempt, refresh] = useReducer((n) => n + 1, 0);
  const [state, update] = useReducer((_, next) => next, { attempt: -1 });
  const current = state.attempt === attempt ? state : { status: "loading" };
  useEffect(() => {
    const controller = new AbortController();
    getAvailability(screen, screening, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          update({ attempt, status: "ready", data });
      })
      .catch(() => {
        if (!controller.signal.aborted) update({ attempt, status: "error" });
      });
    return () => controller.abort();
  }, [screen, screening, attempt]);
  useEffect(() => {
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const available =
    current.status === "ready" && current.data.inventory_complete;
  const time = formatShowtime(screening.screening_time);
  return (
    <li data-screening-id={screening.id} data-screen-id={screen.id}>
      <strong>{time}</strong>
      <p role="status">
        {current.status === "loading"
          ? "Loading availability…"
          : available
            ? `${current.data.seated.available}/${current.data.seated.total} seated · ${current.data.wheelchair.available}/${current.data.wheelchair.total} wheelchair`
            : "Availability counts unavailable. Seat availability will be checked separately."}
      </p>
      {current.status !== "loading" && !available && (
        <button
          type="button"
          className="retry-button"
          onClick={refresh}
          aria-label={`Retry availability for ${time}`}
        >
          Retry availability
        </button>
      )}
    </li>
  );
}

export default function ScreeningAvailability(props) {
  return (
    <ShowtimeAvailability
      key={`${props.screen.id}:${props.screening.id}`}
      {...props}
    />
  );
}
