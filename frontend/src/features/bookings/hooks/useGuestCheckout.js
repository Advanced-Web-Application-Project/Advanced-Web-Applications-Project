import { useEffect, useReducer, useRef, useState } from "react";
import {
  getQuote,
  createHold,
  releaseHold,
  createPrivateKey,
  definitiveFailure,
} from "../services/checkoutService.js";

export function useGuestCheckout(context, onBack) {
  const [items, setItems] = useState(() =>
    context.selected.map((p) => ({ seatId: p.id, category: "adult" })),
  );
  const [email, setEmail] = useState("");
  const [quoteState, saveQuote] = useReducer((_, value) => value, null);
  const [quoteAttempt, retryQuote] = useReducer((n) => n + 1, 0);
  const [state, setState] = useState({
    phase: "review",
    attempt: null,
    hold: null,
    error: "",
  });
  const [clock, setClock] = useState(() => performance.now());
  const working = useRef(false);
  const signature = JSON.stringify({
    screeningId: context.screening.id,
    items,
  });
  const quoteKey = `${signature}:${quoteAttempt}`;
  const quote = quoteState?.key === quoteKey ? quoteState : null;
  useEffect(() => {
    const controller = new AbortController();
    getQuote(context, JSON.parse(signature).items, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted)
          saveQuote({ key: quoteKey, data, receivedAt: performance.now() });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          saveQuote({ key: quoteKey, error: error.message });
      });
    return () => controller.abort();
  }, [context, signature, quoteKey]);
  useEffect(() => {
    if (!state.hold) return;
    const timer = setInterval(() => setClock(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [state.hold]);
  const busy = ["creating", "releasing"].includes(state.phase),
    locked = Boolean(state.attempt);
  const remaining = state.hold
    ? Math.min(
        300,
        Math.max(
          0,
          Math.ceil(
            (Date.parse(state.hold.expiresAt) -
              (Date.parse(state.attempt.quote.asOf) +
                clock -
                state.attempt.quoteReceivedAt)) /
              1000,
          ),
        ),
      )
    : 0;

  async function start(event) {
    event.preventDefault();
    if (working.current) return;
    if (
      !state.attempt &&
      (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254)
    ) {
      setState({ ...state, error: "Enter a valid email address." });
      return;
    }
    if (!state.attempt && !quote?.data) return;
    working.current = true;
    let attempt = state.attempt;
    try {
      attempt ??= {
        key: createPrivateKey(),
        body: {
          screeningId: context.screening.id,
          seatId: items,
          clientEmail: email.trim(),
          expectedQuote: quote.data.quoteFingerprint,
        },
        quote: quote.data,
        quoteReceivedAt: quote.receivedAt,
      };
      setState({ phase: "creating", attempt, hold: null, error: "" });
      const hold = await createHold(attempt);
      setClock(performance.now());
      setState({ phase: "held", attempt, hold, error: "" });
    } catch (error) {
      if (!attempt || definitiveFailure(error)) {
        setState({
          phase: "review",
          attempt: null,
          hold: null,
          error: error.message || "Checkout could not start. Please try again.",
        });
        retryQuote();
      } else
        setState({
          phase: "uncertain",
          attempt,
          hold: null,
          error:
            "We could not confirm whether checkout started. Retry to recover the same request, or cancel it before returning to seats.",
        });
    } finally {
      working.current = false;
    }
  }
  async function cancel() {
    if (working.current) return;
    working.current = true;
    setState({ ...state, phase: "releasing", error: "" });
    try {
      let hold = state.hold;
      if (!hold && state.attempt) {
        try {
          hold = await createHold(state.attempt);
        } catch (error) {
          if (!definitiveFailure(error)) throw error;
        }
      }
      if (hold) await releaseHold(hold);
      onBack();
    } catch {
      setState({
        ...state,
        error:
          "We could not confirm the release. Try returning to seats again; your checkout details are kept.",
      });
    } finally {
      working.current = false;
    }
  }
  return {
    items,
    email,
    setEmail,
    quote,
    state,
    busy,
    locked,
    remaining,
    start,
    cancel,
    retryQuote,
    setCategory(id, category) {
      if (locked) return;
      setItems(items.map((i) => (i.seatId === id ? { ...i, category } : i)));
      setState({ ...state, error: "" });
    },
  };
}
