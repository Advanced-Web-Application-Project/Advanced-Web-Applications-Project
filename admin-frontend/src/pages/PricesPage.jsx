import { Link } from "react-router";
import { useSession } from "../features/session/hooks/useSession.js";
import AdminPricesView from "../features/prices/components/AdminPricesView.jsx";

export default function PricesPage() {
  const { session } = useSession();
  const isAdmin = session?.user?.role === "administrator";

  if (!isAdmin) {
    return (
      <>
        <p className="eyebrow">RIO staff</p>
        <h1 id="page-title" tabIndex={-1}>
          Access denied
        </h1>
        <p>Only administrators can view or update global ticket prices.</p>
        <Link className="button-link" to="/screenings">
          Back to Screenings
        </Link>
      </>
    );
  }

  return (
    <>
      <p className="eyebrow">Administration</p>
      <h1 id="page-title" tabIndex={-1}>
        Prices
      </h1>
      <p className="intro">
        Manage the global adult ticket price and preview the derived child
        price.
      </p>
      <AdminPricesView />
    </>
  );
}
