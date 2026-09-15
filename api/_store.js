// Cache of service levels already read off labels.
//
// A label never changes, so read it once and keep the answer. Without this
// you'd pay for a vision call on every page load.
//
// The tables are created automatically on first use (see ensureSchema below),
// so a new Neon database needs nothing but DATABASE_URL. schema.sql holds the
// full reference version, including the optional snapshot table.
//
// If DATABASE_URL isn't set the dashboard still works — it just re-reads
// labels on demand instead of remembering them.

import { neon } from '@neondatabase/serverless';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

// Create the tables on first use. schema.sql is still the reference copy — this
// is the same DDL, run automatically so a fresh Neon database doesn't fail with
// `relation "shipment_service" does not exist` on the first label read.
// Every statement is IF NOT EXISTS, so it's safe on every cold start.
let READY = null;

function ensureSchema() {
  if (!sql) return Promise.resolve();
  if (READY) return READY;
  READY = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS shipment_service (
        order_number text PRIMARY KEY,
        service      text NOT NULL,
        confidence   text,
        evidence     text,
        label_url    text,
        resolved_at  timestamptz NOT NULL DEFAULT now()
      )`;
    await sql`
      CREATE INDEX IF NOT EXISTS shipment_service_service_idx
        ON shipment_service (service)`;
    await sql`
      CREATE TABLE IF NOT EXISTS employee_names (
        user_id   text PRIMARY KEY,
        full_name text NOT NULL,
        note      text,
        added_at  timestamptz NOT NULL DEFAULT now()
      )`;
    await sql`
      INSERT INTO employee_names (user_id, full_name, note)
      VALUES ('15c43202-3b17-4a8c-9316-a601328c92ee', 'Jimi Kim', 'not in public.users')
      ON CONFLICT (user_id) DO NOTHING`;
  })().catch((err) => {
    READY = null;               // let the next request try again
    throw err;
  });
  return READY;
}

export async function getResolvedServices(orderNumbers) {
  if (!sql || !orderNumbers || !orderNumbers.length) return {};
  await ensureSchema();
  const rows = await sql`
    SELECT order_number, service, confidence, evidence
    FROM shipment_service
    WHERE order_number = ANY(${orderNumbers})
  `;
  return Object.fromEntries(rows.map((r) => [r.order_number, r]));
}

export async function saveResolvedService(order, { service, confidence, evidence, labelUrl }) {
  if (!sql) return;
  await ensureSchema();
  await sql`
    INSERT INTO shipment_service (order_number, service, confidence, evidence, label_url)
    VALUES (${order}, ${service}, ${confidence ?? null}, ${evidence ?? null}, ${labelUrl ?? null})
    ON CONFLICT (order_number) DO UPDATE
      SET service     = EXCLUDED.service,
          confidence  = EXCLUDED.confidence,
          evidence    = EXCLUDED.evidence,
          label_url   = EXCLUDED.label_url,
          resolved_at = now()
  `;
}

// Names for user_ids that don't resolve in public.users.
// Add rows to employee_names rather than hardcoding them in the SQL question.
export async function getEmployeeNames() {
  if (!sql) return {};
  await ensureSchema();
  const rows = await sql`SELECT user_id, full_name FROM employee_names`;
  return Object.fromEntries(rows.map((r) => [r.user_id, r.full_name]));
}
