import { useEffect, useReducer, useRef } from "react";
import { getSeatLayout, validateSelection } from "../services/seatService.js";
import { isUnavailable } from "../utils/seatLayout.js";

const initialState = {
  layout: null,
  loadState: "loading",
  attempt: 0,
  selected: [],
  revision: 0,
  validation: { status: "idle" },
  notice: "Loading seat availability…",
};
function reducer(state, action) {
  switch (action.type) {
    case "refresh":
      return {
        ...state,
        attempt: state.attempt + 1,
        loadState: state.layout ? "refreshing" : "loading",
        revision: state.revision + 1,
        validation: { status: "idle" },
        notice: "Updating seat availability…",
      };
    case "loaded": {
      const available = new Set(
        action.layout.places.filter((p) => !isUnavailable(p)).map((p) => p.id),
      );
      const selected = state.selected.filter((id) => available.has(id));
      const removed = state.selected.length - selected.length;
      return {
        ...state,
        layout: action.layout,
        loadState: "ready",
        selected,
        revision: state.revision + 1,
        validation: { status: "idle" },
        notice: removed
          ? `${removed} selected ${removed === 1 ? "place is" : "places are"} now unavailable and removed. Review your selection.`
          : "Seat availability updated.",
      };
    }
    case "loadFailed":
      return {
        ...state,
        loadState: "error",
        revision: state.revision + 1,
        validation: { status: "idle" },
        notice: "We couldn’t load seat availability. Try again.",
      };
    case "toggle": {
      const place = state.layout?.places.find((p) => p.id === action.id);
      if (state.loadState !== "ready" || !place || isUnavailable(place))
        return state;
      const removing = state.selected.includes(place.id),
        selected = removing
          ? state.selected.filter((id) => id !== place.id)
          : [...state.selected, place.id];
      return {
        ...state,
        selected,
        revision: state.revision + 1,
        validation: { status: "idle" },
        notice: `${place.is_wheelchair ? "Wheelchair space" : "Seat"} ${place.display_label} ${removing ? "removed" : "selected"}. ${selected.length} ${selected.length === 1 ? "place" : "places"} selected.`,
      };
    }
    case "edit":
      return {
        ...state,
        validation: { status: "idle" },
        notice: "Review your places, then check the selection again.",
      };
    case "checking":
      return {
        ...state,
        validation: { status: "checking" },
        notice: "Checking the complete selection…",
      };
    case "checked":
      return action.revision !== state.revision
        ? state
        : {
            ...state,
            validation: { status: "checked", result: action.result },
            notice: action.result.valid
              ? "Selection checked. These places are not reserved."
              : "This selection needs a change. Read the feedback below.",
          };
    case "checkFailed":
      return action.revision !== state.revision
        ? state
        : {
            ...state,
            validation: { status: "error" },
            notice: "We couldn’t check your selection. Try again.",
          };
    default:
      return state;
  }
}

export function useSeatSelection({
  screenId,
  screeningId,
  capacity,
  onValidatedSelection,
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const pendingCheck = useRef(null);
  const version = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    getSeatLayout(screenId, screeningId, capacity, {
      signal: controller.signal,
    })
      .then((layout) => {
        if (controller.signal.aborted) return;
        version.current++;
        pendingCheck.current?.abort();
        dispatch({ type: "loaded", layout });
      })
      .catch(() => {
        if (!controller.signal.aborted) dispatch({ type: "loadFailed" });
      });
    return () => controller.abort();
  }, [screenId, screeningId, capacity, state.attempt]);
  useEffect(
    () => () => {
      version.current++;
      pendingCheck.current?.abort();
    },
    [],
  );
  // Background/focus updates remove newly unavailable selections and invalidate previews.
  useEffect(() => {
    function refresh() {
      version.current++;
      pendingCheck.current?.abort();
      onValidatedSelection?.(null);
      dispatch({ type: "refresh" });
    }
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [onValidatedSelection]);
  function invalidate() {
    version.current++;
    pendingCheck.current?.abort();
    onValidatedSelection?.(null);
  }
  return {
    ...state,
    edit() {
      invalidate();
      dispatch({ type: "edit" });
    },
    toggle(id) {
      invalidate();
      dispatch({ type: "toggle", id });
    },
    refresh() {
      invalidate();
      dispatch({ type: "refresh" });
    },
    async check() {
      if (
        state.loadState !== "ready" ||
        !state.selected.length ||
        state.validation.status === "checking"
      )
        return;
      invalidate();
      const controller = new AbortController();
      pendingCheck.current = controller;
      const current = version.current,
        revision = state.revision;
      const request = { screenId, screeningId, seatIds: [...state.selected] };
      dispatch({ type: "checking" });
      try {
        const result = await validateSelection(request, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || version.current !== current) return;
        dispatch({ type: "checked", revision, result });
        if (result.valid)
          onValidatedSelection?.({ ...request, asOf: result.as_of });
      } catch {
        if (!controller.signal.aborted && version.current === current)
          dispatch({ type: "checkFailed", revision });
      }
    },
  };
}
