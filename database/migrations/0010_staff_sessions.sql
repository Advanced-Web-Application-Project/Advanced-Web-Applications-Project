-- Dedicated server-owned session storage; no runtime table creation.
CREATE TABLE public.staff_sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamptz NOT NULL
);
CREATE INDEX staff_sessions_expire_idx ON public.staff_sessions(expire);

-- Keys are domain-separated HMACs, never raw email/IP values.
CREATE TABLE public.staff_login_attempts (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);
CREATE INDEX staff_login_attempts_window_idx ON public.staff_login_attempts(window_start);

CREATE TABLE public.staff_auth_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('login', 'logout')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
