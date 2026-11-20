-- Preserve existing identities, contacts, credentials and referenced history.
LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE invalid_ids text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO invalid_ids FROM public.users
  WHERE NOT ((role = 'cashier' AND permitted_city_id IS NOT NULL)
          OR (role IN ('administrator', 'customer') AND permitted_city_id IS NULL));
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Staff identity preflight: invalid role/city user IDs: %. Review manually; no accounts were reassigned.', invalid_ids;
  END IF;
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO invalid_ids FROM public.users
  WHERE length(lower(btrim(email))) > 254
     OR lower(btrim(email)) !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$';
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Staff identity preflight: invalid email user IDs: %. Review manually; no addresses were rewritten.', invalid_ids;
  END IF;
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO invalid_ids
  FROM public.users WHERE lower(btrim(email)) IN (
    SELECT lower(btrim(email)) FROM public.users GROUP BY lower(btrim(email)) HAVING count(*) > 1
  );
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Staff identity preflight: duplicate normalized login user IDs: %. Review manually; no accounts were merged.', invalid_ids;
  END IF;
END $$;

ALTER TABLE public.users
  ADD COLUMN login_email text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  ADD COLUMN is_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN session_version integer NOT NULL DEFAULT 1,
  ADD COLUMN provisioned_at timestamptz,
  ADD COLUMN credentials_changed_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD CONSTRAINT users_role_city_check CHECK (
    (role = 'cashier' AND permitted_city_id IS NOT NULL)
    OR (role IN ('administrator', 'customer') AND permitted_city_id IS NULL)
  ),
  ADD CONSTRAINT users_login_email_check CHECK (
    length(login_email) <= 254 AND login_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ),
  ADD CONSTRAINT users_session_version_check CHECK (session_version > 0),
  ADD CONSTRAINT users_enabled_time_check CHECK (
    (is_enabled AND disabled_at IS NULL) OR (NOT is_enabled AND disabled_at IS NOT NULL)
  );
CREATE UNIQUE INDEX users_login_email_uidx ON public.users(login_email);

-- #35 must compare this version and current enabled state on every session use.
CREATE FUNCTION public.guard_staff_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.password_hash, NEW.role, NEW.permitted_city_id, NEW.email, NEW.is_enabled)
       IS DISTINCT FROM ROW(OLD.password_hash, OLD.role, OLD.permitted_city_id, OLD.email, OLD.is_enabled) THEN
    NEW.session_version := OLD.session_version + 1;
  ELSIF NEW.session_version < OLD.session_version THEN
    RAISE EXCEPTION 'Session version cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    NEW.credentials_changed_at := clock_timestamp();
  ELSE
    NEW.credentials_changed_at := OLD.credentials_changed_at;
  END IF;
  IF NEW.is_enabled THEN
    NEW.disabled_at := NULL;
  ELSIF OLD.is_enabled THEN
    NEW.disabled_at := clock_timestamp();
  ELSE
    NEW.disabled_at := OLD.disabled_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_staff_identity BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.guard_staff_identity();
