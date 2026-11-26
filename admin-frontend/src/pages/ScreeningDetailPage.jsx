import StaffScreeningDetail from "../features/screenings/components/StaffScreeningDetail.jsx";
export default function ScreeningDetailPage() {
  return (
    <>
      <p className="eyebrow">Your workspace</p>
      <h1 id="page-title" tabIndex={-1}>
        Screening details
      </h1>
      <StaffScreeningDetail />
    </>
  );
}
