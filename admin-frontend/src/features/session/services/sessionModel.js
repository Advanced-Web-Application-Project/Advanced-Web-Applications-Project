import {
  ApiError,
  createApiClient,
} from "../../../shared/services/apiClient.js";
import { createSessionService } from "./sessionService.js";

export function createSessionModel({
  baseUrl = import.meta.env?.VITE_API_BASE_URL || "/api",
  fetchImpl,
  timeoutMs,
} = {}) {
  let state = { status: "checking", session: null, notice: "" },
    epoch = 0,
    pending = null,
    logoutToken = null,
    hadSession = false;
  const listeners = new Set(),
    changes = new Set(),
    requests = new Set();
  const emit = (value) => {
    state = value;
    for (const listener of listeners) listener();
  };
  function cancel() {
    epoch++;
    pending?.abort();
    pending = null;
    for (const controller of requests) controller.abort();
    requests.clear();
  }
  function publish(status, session = null, notice = "") {
    if (status === "authenticated") hadSession = true;
    else if (status === "anonymous") hadSession = false;
    emit({ status, session, notice });
  }
  function invalidate() {
    cancel();
    logoutToken = null;
    publish(
      "anonymous",
      null,
      "Your session ended. Sign in again, then review your action before retrying it.",
    );
    for (const listener of changes) listener();
  }
  let client;
  try {
    client = createApiClient(baseUrl, {
      fetchImpl,
      timeoutMs,
      getCsrfToken: () => state.session?.csrfToken,
      onUnauthorized: invalidate,
    });
  } catch (error) {
    client = async () => {
      throw error;
    };
  }
  const service = createSessionService(client);
  const notify = () => {
    for (const listener of changes) listener();
  };
  const model = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSessionChange: (listener) => {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    pause() {
      cancel();
      logoutToken = null;
      if (state.status === "authenticated") publish("checking");
    },
    stop() {
      cancel();
    },
    async check() {
      cancel();
      logoutToken = null;
      const revision = epoch,
        controller = new AbortController();
      pending = controller;
      publish("checking");
      try {
        const session = await service.current(controller.signal);
        if (revision === epoch) publish("authenticated", session);
      } catch (error) {
        if (revision !== epoch || controller.signal.aborted) return;
        if (error.status === 401)
          publish(
            "anonymous",
            null,
            hadSession ? "Your session ended. Sign in again." : "",
          );
        else if (error.status === 503 && error.code === "STAFF_UNAVAILABLE")
          publish("unavailable");
        else publish(error.status === 403 ? "forbidden" : "error");
      } finally {
        if (revision === epoch) pending = null;
      }
    },
    async signIn(email, password) {
      cancel();
      const revision = epoch,
        controller = new AbortController();
      pending = controller;
      try {
        const session = await service.login(email, password, controller.signal);
        if (revision !== epoch)
          throw new DOMException("Cancelled", "AbortError");
        logoutToken = null;
        publish("authenticated", session);
        notify();
      } finally {
        if (revision === epoch) pending = null;
      }
    },
    async signOut() {
      const token = logoutToken ?? state.session?.csrfToken;
      cancel();
      logoutToken = token;
      const revision = epoch,
        controller = new AbortController();
      pending = controller;
      publish("signingOut");
      notify();
      try {
        await service.logout(token, controller.signal);
        if (revision === epoch) {
          logoutToken = null;
          publish("anonymous", null, "You have signed out.");
        }
      } catch (error) {
        if (revision !== epoch || controller.signal.aborted) return;
        if (error.status === 401) {
          logoutToken = null;
          publish("anonymous", null, "You have signed out.");
        } else publish("signOutError");
      } finally {
        if (revision === epoch) pending = null;
      }
    },
    async request(path, options = {}) {
      if (state.status !== "authenticated")
        throw new ApiError(
          "Staff sign-in is required.",
          401,
          "STAFF_AUTH_REQUIRED",
        );
      const revision = epoch,
        controller = new AbortController(),
        abort = () => controller.abort();
      requests.add(controller);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      try {
        const result = await client(path, {
          ...options,
          signal: controller.signal,
        });
        if (revision !== epoch)
          throw new DOMException("Cancelled", "AbortError");
        return result;
      } finally {
        requests.delete(controller);
        options.signal?.removeEventListener("abort", abort);
      }
    },
  };
  return model;
}
