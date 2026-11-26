import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router";
import { useSession } from "../features/session/hooks/useSession.js";
import SignInForm from "../features/session/components/SignInForm.jsx";
import StatusPanel from "../shared/components/StatusPanel.jsx";
import StaffLayout from "../layouts/StaffLayout.jsx";
import ScreeningsPage from "../pages/ScreeningsPage.jsx";
import NotFoundPage from "../pages/NotFoundPage.jsx";
import PricesPage from "../pages/PricesPage.jsx";
import { safeReturnPath } from "./returnPath.js";

export default function StaffRoutes() {
  const { status, model } = useSession(),
    location = useLocation(),
    [params] = useSearchParams();
  if (status === "checking" || status === "signingOut")
    return (
      <StatusPanel
        title={
          status === "signingOut" ? "Signing out…" : "Checking your session…"
        }
        busy
      >
        <p>Please wait.</p>
      </StatusPanel>
    );
  if (["error", "forbidden", "unavailable"].includes(status))
    return (
      <StatusPanel
        title={
          status === "forbidden"
            ? "Staff access denied"
            : status === "unavailable"
              ? "Staff sign-in isn’t available"
              : "Couldn’t check your session"
        }
        action={() => model.check()}
      >
        {status === "forbidden" ? (
          <p>Use the approved staff website, or contact your administrator.</p>
        ) : status === "unavailable" ? (
          <p>
            Staff access hasn’t been enabled yet. Contact the person who manages
            RIO.
          </p>
        ) : (
          <p>We couldn’t verify your session. Please try again.</p>
        )}
      </StatusPanel>
    );
  if (status === "signOutError")
    return (
      <StatusPanel
        title="Sign-out not confirmed"
        action={() => model.signOut()}
        label="Retry sign-out"
      >
        <p>
          Your workspace has been cleared. We couldn’t confirm that the server
          signed you out.
        </p>
        <button className="secondary" onClick={() => model.check()}>
          Check session
        </button>
      </StatusPanel>
    );
  if (status !== "authenticated")
    return location.pathname === "/sign-in" ? (
      <SignInForm />
    ) : (
      <Navigate
        to={
          "/sign-in?returnTo=" +
          encodeURIComponent(safeReturnPath(location.pathname))
        }
        replace
      />
    );
  if (location.pathname === "/sign-in")
    return <Navigate to={safeReturnPath(params.get("returnTo"))} replace />;
  return (
    <Routes>
      <Route element={<StaffLayout />}>
        <Route index element={<Navigate to="/screenings" replace />} />
        <Route path="screenings" element={<ScreeningsPage />} />
        <Route path="prices" element={<PricesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
