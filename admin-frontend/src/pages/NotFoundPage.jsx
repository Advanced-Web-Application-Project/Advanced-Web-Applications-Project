import { Link } from "react-router";
export default function NotFoundPage() {
  return (
    <>
      <p className="eyebrow">RIO staff</p>
      <h1 id="page-title" tabIndex={-1}>
        Page not found
      </h1>
      <p>This page is not available.</p>
      <Link className="button-link" to="/screenings">
        Back to Screenings
      </Link>
    </>
  );
}
