import { useEffect, useState } from "react";
import { CustomerSessionContext } from "../CustomerSessionContext.js";
import { createCustomerSessionModel } from "../services/customerSessionModel.js";

export default function CustomerSessionProvider({ children, model: provided }) {
  const [model] = useState(() => provided ?? createCustomerSessionModel());
  useEffect(() => {
    model.check();
    const refresh = () => {
      if (
        document.visibilityState === "visible" &&
        model.getSnapshot().status === "authenticated"
      )
        model.check();
    };
    const visibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      model.stop();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [model]);
  return (
    <CustomerSessionContext.Provider value={model}>
      {children}
    </CustomerSessionContext.Provider>
  );
}
