import { ApiError, apiRequest } from "../../../shared/services/apiClient.js";
import { createCustomerSessionService } from "./customerSessionService.js";

export function createCustomerSessionModel({ request = apiRequest } = {}) {
  let state = { status: "checking", session: null },
    revision = 0,
    pending = null;
  const listeners = new Set();
  const emit = (value) => {
    state = value;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    revision++;
    pending?.abort();
    pending = null;
  };
  const service = createCustomerSessionService(request);
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: cancel,
    async check() {
      cancel();
      const currentRevision = revision,
        controller = new AbortController();
      pending = controller;
      emit({ status: "checking", session: null });
      try {
        const session = await service.current(controller.signal);
        if (currentRevision === revision)
          emit({ status: "authenticated", session });
      } catch (error) {
        if (currentRevision !== revision || controller.signal.aborted) return;
        if (error.status === 401) emit({ status: "anonymous", session: null });
        else
          emit({
            status: error.status === 503 ? "unavailable" : "error",
            session: null,
            error,
          });
      } finally {
        if (currentRevision === revision) pending = null;
      }
    },
    async signIn(email, password) {
      cancel();
      const currentRevision = revision,
        controller = new AbortController();
      pending = controller;
      try {
        const session = await service.login(email, password, controller.signal);
        if (currentRevision !== revision)
          throw new DOMException("Cancelled", "AbortError");
        emit({ status: "authenticated", session });
      } finally {
        if (currentRevision === revision) pending = null;
      }
    },
    async register(email, password) {
      cancel();
      const currentRevision = revision,
        controller = new AbortController();
      pending = controller;
      try {
        const session = await service.register(
          email,
          password,
          controller.signal,
        );
        if (currentRevision !== revision)
          throw new DOMException("Cancelled", "AbortError");
        emit({ status: "authenticated", session });
      } finally {
        if (currentRevision === revision) pending = null;
      }
    },
    async signOut() {
      if (state.status !== "authenticated")
        throw new ApiError("Customer sign-in is required.", 401);
      const token = state.session.csrfToken,
        session = state.session;
      cancel();
      const currentRevision = revision,
        controller = new AbortController();
      pending = controller;
      emit({ status: "signingOut", session });
      try {
        await service.logout(token, controller.signal);
        if (currentRevision === revision)
          emit({ status: "anonymous", session: null });
      } catch (error) {
        if (currentRevision === revision && !controller.signal.aborted) {
          if (error.status === 401)
            emit({ status: "anonymous", session: null });
          else {
            emit({ status: "authenticated", session, error });
            throw error;
          }
        }
      } finally {
        if (currentRevision === revision) pending = null;
      }
    },
  };
}
