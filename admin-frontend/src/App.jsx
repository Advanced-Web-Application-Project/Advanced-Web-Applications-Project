import SessionProvider from "./features/session/components/SessionProvider.jsx";
import StaffRoutes from "./routes/StaffRoutes.jsx";
export default function App({ model }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SessionProvider model={model}>
        <StaffRoutes />
      </SessionProvider>
    </>
  );
}
