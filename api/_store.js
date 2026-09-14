// Cache of service levels already read off labels.
//
// A label never changes, so read it once and keep the answer. Without this
// you'd pay for a vision call on every page load.
//
// Create the table once (Neon SQL editor, or `psql $DATABASE_URL`):
//
//   psql "$DATABASE_URL" -f schema.sql
//
// (or paste schema.sql into the Neon SQL editor)
//
// If DATABASE_URL isn't set the dashboard still works — it just re-reads
// labels on demand instead of remembering them.

import { neon } from '@neondatabase/serverless';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

export async function getResolvedServices(orderNumbers) {
  if (!sql || !orderNumbers || !orderNumbers.length) return {};
  const rows = await sql`
    SELECT order_number, service, confidence, evidence
    FROM shipment_service
    WHERE order_number = ANY(${orderNumbers})
  `;
  return Object.fromEntries(rows.map((r) => [r.order_number, r]));
}

export async function saveResolvedService(order, { service, confidence, evidence, labelUrl }) {
  if (!sql) return;
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
  const rows = await sql`SELECT user_id, full_name FROM employee_names`;
  return Object.fromEntries(rows.map((r) => [r.user_id, r.full_name]));
}
