-- Customer sessions and throttling are isolated from the staff session namespace.
CREATE TABLE public.customer_sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamptz NOT NULL
);
CREATE INDEX customer_sessions_expire_idx ON public.customer_sessions(expire);

CREATE TABLE public.customer_login_attempts (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);
CREATE INDEX customer_login_attempts_window_idx
  ON public.customer_login_attempts(window_start);
