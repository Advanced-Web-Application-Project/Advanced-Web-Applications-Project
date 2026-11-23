import { useContext, useSyncExternalStore } from "react";
import { SessionContext } from "../SessionContext.js";
export function useSession() {
  const model = useContext(SessionContext);
  if (!model) throw new Error("Session provider is required");
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  return { ...state, model };
}
