import { useCallback, useEffect, useState } from "react";
import { useSession } from "../../session/hooks/useSession.js";
export function useScreeningRead(path, validate, pauseSelector) {
  const { model } = useSession();
  const [attempt, setAttempt] = useState(0),
    [result, setResult] = useState(null);
  const key = `${path}:${attempt}`;
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    model
      .request(path, { signal: controller.signal })
      .then(validate)
      .then((data) => {
        if (current) setResult({ key, data });
      })
      .catch((error) => {
        if (current && error.name !== "AbortError") setResult({ key, error });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [model, path, key, validate]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        !document.activeElement?.closest(pauseSelector)
      )
        refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [refresh, pauseSelector]);
  const active = result?.key === key ? result : null;
  return {
    data: active?.data,
    error: active?.error,
    loading: !active,
    refresh,
  };
}
