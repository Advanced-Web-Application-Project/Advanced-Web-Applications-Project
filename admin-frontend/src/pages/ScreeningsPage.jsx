import StaffScreeningList from "../features/screenings/components/StaffScreeningList.jsx";
export default function ScreeningsPage() {
  return (
    <>
      <p className="eyebrow">Your workspace</p>
      <h1 id="page-title" tabIndex={-1}>
        Screenings
      </h1>
      <p className="intro">Find screenings and check current availability.</p>
      <StaffScreeningList />
    </>
  );
}
