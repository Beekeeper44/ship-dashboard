-- Ship Dashboard — Neon schema
-- Run once in the Neon SQL editor, or: psql "$DATABASE_URL" -f schema.sql

-- ---------------------------------------------------------------
-- 1. Service level read off a shipping label
--
-- FedEx Ground and Express tracking numbers are identical in format
-- (12 digits, 87x), so the service can only be read from the label's
-- marker box. A label never changes, so read it once and keep it.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipment_service (
  order_number text PRIMARY KEY,
  service      text NOT NULL,          -- FedEx Express | FedEx Ground | FedEx Home | USPS | DHL | UPS
  confidence   text,                   -- high | medium | low
  evidence     text,                   -- what the model saw, for spot checks
  label_url    text,
  resolved_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shipment_service_service_idx
  ON shipment_service (service);

CREATE INDEX IF NOT EXISTS shipment_service_lowconf_idx
  ON shipment_service (confidence)
  WHERE confidence <> 'high';


-- ---------------------------------------------------------------
-- 2. Employee names missing from public.users
--
-- Some warehouse user_ids don't resolve, so the dashboard shows
-- "Unmapped user <uuid>". Add them here instead of hardcoding them
-- in the SQL question.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_names (
  user_id    text PRIMARY KEY,
  full_name  text NOT NULL,
  note       text,
  added_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO employee_names (user_id, full_name, note) VALUES
  ('15c43202-3b17-4a8c-9316-a601328c92ee', 'Jimi Kim', 'not in public.users')
ON CONFLICT (user_id) DO NOTHING;


-- ---------------------------------------------------------------
-- 3. Optional — daily snapshot
--
-- Metabase is the source of truth and is queried live, so this is
-- only worth creating if you want history that survives changes to
-- the question, or want to chart trends without hitting Snowflake.
-- Populate it from a nightly job.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipment_log (
  order_number    text PRIMARY KEY,
  shipped_by      text,
  shipped_by_id   text,
  cards_shipped   integer,
  tracking_number text,
  carrier         text,
  service         text,
  completed_at    timestamptz,
  order_url       text,
  tracking_url    text,
  label_url       text,
  captured_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shipment_log_completed_idx ON shipment_log (completed_at DESC);
CREATE INDEX IF NOT EXISTS shipment_log_employee_idx  ON shipment_log (shipped_by, completed_at DESC);
CREATE INDEX IF NOT EXISTS shipment_log_carrier_idx   ON shipment_log (carrier);


-- ---------------------------------------------------------------
-- Handy checks
-- ---------------------------------------------------------------

-- how many labels resolved, and to what
-- SELECT service, confidence, count(*) FROM shipment_service GROUP BY 1,2 ORDER BY 3 DESC;

-- anything the model wasn't sure about — worth eyeballing
-- SELECT order_number, service, confidence, evidence, label_url
--   FROM shipment_service WHERE confidence <> 'high' ORDER BY resolved_at DESC LIMIT 50;

-- names still unmapped, so you know what to add to employee_names
-- (run against the dashboard output, not here)

-- WHEN ARTA'S service_level LANDS ON THE ORDER:
--   the label reading becomes unnecessary. Keep this table as a record of
--   what was read, compare it against the real field for a week, then drop it.
-- SELECT s.order_number, s.service AS read_from_label, l.service AS from_arta
--   FROM shipment_service s JOIN shipment_log l USING (order_number)
--  WHERE s.service IS DISTINCT FROM l.service;
