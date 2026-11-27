import HomePage from "./pages/HomePage.jsx";
import CustomerSessionProvider from "./features/account/components/CustomerSessionProvider.jsx";

export default function App() {
  return (
    <CustomerSessionProvider>
      <HomePage />
    </CustomerSessionProvider>
  );
}
