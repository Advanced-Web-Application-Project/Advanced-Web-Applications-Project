import { useEffect, useState } from "react";
import { SessionContext } from "../SessionContext.js";
import { createSessionModel } from "../services/sessionModel.js";

export default function SessionProvider({ children, model: provided }) {
  const [model] = useState(() => provided ?? createSessionModel());
  useEffect(() => {
    let suspended = false;
    const hide = () => {
      document.documentElement.classList.add("staff-suspended");
      suspended = true;
      if (model.getSnapshot().status === "authenticated") model.pause();
    };
    const resume = () => {
      if (suspended) {
        suspended = false;
        model.check();
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") hide();
      else resume();
    };
    const pageShow = () => {
      hide();
      suspended = false;
      model.check();
    };
    const channel =
      typeof window.BroadcastChannel === "function"
        ? new window.BroadcastChannel("rio-staff-session")
        : null;
    if (channel)
      channel.onmessage = () => {
        hide();
        if (document.visibilityState !== "hidden") {
          suspended = false;
          model.check();
        }
      };
    const notify = model.onSessionChange(() =>
      channel?.postMessage({ type: "session-changed" }),
    );
    const sync = model.subscribe(() => {
      if (model.getSnapshot().status === "authenticated") {
        if (document.visibilityState === "hidden" || suspended) {
          suspended = true;
          model.pause();
        } else document.documentElement.classList.remove("staff-suspended");
      }
    });
    const timer = setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        model.getSnapshot().status === "authenticated"
      ) {
        hide();
        suspended = false;
        model.check();
      }
    }, 60000);
    window.addEventListener("blur", hide);
    window.addEventListener("focus", resume);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", pageShow);
    document.addEventListener("visibilitychange", visibility);
    model.check();
    return () => {
      model.stop();
      notify();
      sync();
      channel?.close();
      clearInterval(timer);
      window.removeEventListener("blur", hide);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", pageShow);
      document.removeEventListener("visibilitychange", visibility);
      document.documentElement.classList.remove("staff-suspended");
    };
  }, [model]);
  return (
    <SessionContext.Provider value={model}>{children}</SessionContext.Provider>
  );
}
