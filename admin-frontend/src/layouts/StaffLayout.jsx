import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useSession } from "../features/session/hooks/useSession.js";
import Icon from "../shared/components/Icon.jsx";

export default function StaffLayout() {
  const { model, session } = useSession(),
    { user } = session,
    location = useLocation();
  const isAdmin = user?.role === "administrator";
  const [city, setCity] = useState(null),
    [cityError, setCityError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (user.role !== "cashier") return;
    const controller = new AbortController();
    model
      .request("/cities", { signal: controller.signal })
      .then((rows) => {
        if (!Array.isArray(rows)) throw Error();
        const found = rows.find((row) => row.id === user.cityId);
        if (!found || typeof found.name !== "string") throw Error();
        if (!controller.signal.aborted) setCity(found.name);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setCityError(true);
      });
    return () => controller.abort();
  }, [model, user, attempt]);
  useEffect(() => {
    document.getElementById("page-title")?.focus();
  }, [location.pathname]);
  return (
    <div className="workspace staff-private">
      <aside className="sidebar">
        <NavLink
          className="wordmark"
          to="/screenings"
          aria-label="RIO staff home"
        >
          RIO <span>staff</span>
        </NavLink>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Staff navigation">
          <NavLink to="/screenings">
            <Icon name="calendar" />
            Screenings
          </NavLink>
          {isAdmin && <NavLink to="/prices">Prices</NavLink>}
        </nav>
        <div className="scope">
          <p className="nav-label">Your access</p>
          <strong>
            {user.role === "administrator" ? "Administrator" : "Cashier"}
          </strong>
          <p>
            {user.role === "administrator"
              ? "All cities"
              : (city ?? (cityError ? "Assigned city" : "Loading city…"))}
          </p>
          {cityError && (
            <button
              className="text-button"
              onClick={() => {
                setCityError(false);
                setAttempt((n) => n + 1);
              }}
            >
              Retry city name
            </button>
          )}
        </div>
      </aside>
      <div className="workspace-content">
        <header className="workspace-header">
          <span className="access-tag">Staff access</span>
          <button
            className="secondary sign-out"
            onClick={() => model.signOut()}
          >
            <Icon name="logout" />
            Sign out
          </button>
        </header>
        <main id="main" className="workspace-main">
          <Outlet />
        </main>
        <footer>RIO cinema · Staff workspace</footer>
      </div>
    </div>
  );
}
