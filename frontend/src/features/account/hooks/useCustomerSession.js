import { useContext, useSyncExternalStore } from "react";
import { CustomerSessionContext } from "../CustomerSessionContext.js";

export function useCustomerSession() {
  const model = useContext(CustomerSessionContext);
  if (!model)
    throw new Error(
      "useCustomerSession must be used within CustomerSessionProvider.",
    );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  return { ...state, model };
}
