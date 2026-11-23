import Icon from "../shared/components/Icon.jsx";
export default function ScreeningsPage() {
  return (
    <>
      <p className="eyebrow">Your workspace</p>
      <h1 id="page-title" tabIndex={-1}>
        Screenings
      </h1>
      <p className="intro">Welcome to your RIO staff workspace.</p>
      <section className="panel access-panel">
        <div className="panel-icon">
          <Icon name="calendar" />
        </div>
        <h2>You’re signed in</h2>
        <p>Screening lists and reservation tools are not available here yet.</p>
        <p className="hint">
          Your access is limited to the role and location assigned to your
          account.
        </p>
      </section>
    </>
  );
}
