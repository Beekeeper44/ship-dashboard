// GET /api/shipments?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Runs the saved Metabase question and returns rows shaped for the dashboard.
// Card 38974 -> https://arena-club.metabaseapp.com/question/38974

import { getResolvedServices, getEmployeeNames } from './_store.js';

const CARD_ID = process.env.METABASE_CARD_ID || '38974';

// Accept either name, and tolerate a bare host with no scheme or a trailing slash.
function metabaseBase() {
  let base = process.env.METABASE_HOST || process.env.METABASE_URL || '';
  base = base.trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const BASE = metabaseBase();
  if (!BASE || !process.env.METABASE_API_KEY) {
    return res.status(500).json({
      error: 'missing_env',
      detail: 'Set METABASE_HOST (or METABASE_URL) and METABASE_API_KEY in Vercel project settings, then redeploy.',
    });
  }

  const { start, end } = req.query;

  // Template-tag parameters. Names must match the {{variables}} in the SQL.
  // Omit one entirely and its [[ ]] block drops out, which is how the query
  // falls back to CURRENT_DATE().
  const parameters = [];
  if (start) {
    parameters.push({
      type: 'date/single',
      target: ['variable', ['template-tag', 'start_date']],
      value: start,
    });
  }
  if (end) {
    parameters.push({
      type: 'date/single',
      target: ['variable', ['template-tag', 'end_date']],
      value: end,
    });
  }

  let raw;
  try {
    const r = await fetch(
      `${BASE}/api/card/${CARD_ID}/query/json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.METABASE_API_KEY,
        },
        body: JSON.stringify({ parameters }),
      }
    );
    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: 'metabase_failed', status: r.status, detail: detail.slice(0, 500) });
    }
    raw = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'metabase_unreachable', detail: String(err) });
  }

  if (!Array.isArray(raw)) {
    return res.status(502).json({ error: 'unexpected_shape', detail: JSON.stringify(raw).slice(0, 400) });
  }

  // Snowflake returns UPPERCASE column names. Tolerate either case.
  const pick = (row, ...names) => {
    for (const n of names) {
      if (row[n] !== undefined) return row[n];
      const up = n.toUpperCase();
      if (row[up] !== undefined) return row[up];
      const lo = n.toLowerCase();
      if (row[lo] !== undefined) return row[lo];
    }
    return undefined;
  };

  const rows = raw.map((r) => {
    const who = pick(r, 'SHIPPED_BY') ?? '';
    const label = pick(r, 'LABEL_IMAGE', 'LABEL_URL') || '';
    return {
      who,
      order: String(pick(r, 'ORDER_NUMBER') ?? ''),
      cards: Number(pick(r, 'CARDS_SHIPPED') ?? 0),
      trk: pick(r, 'TRACKING_NUMBER') || '',
      ts: pick(r, 'COMPLETED_AT') || '',
      orderUrl: pick(r, 'ORDER_URL') || '',
      trackUrl: pick(r, 'TRACKING_URL') || '',
      label,
      gap: typeof who === 'string' && who.startsWith('Unmapped user'),
    };
  });

  // Merge in service levels already read off labels, and any employee names
  // that don't resolve in public.users
  let resolved = {};
  let names = {};
  try {
    [resolved, names] = await Promise.all([
      getResolvedServices(rows.map((r) => r.order)),
      getEmployeeNames(),
    ]);
  } catch {
    // Neon not configured yet — carry on without it
  }

  for (const r of rows) {
    const m = /^Unmapped user (.+)$/.exec(r.who);
    if (m && names[m[1]]) {
      r.who = names[m[1]];
      r.gap = false;
    }
  }

  for (const r of rows) {
    const hit = resolved[r.order];
    if (hit) {
      r.carrier = hit.service;
      r.read = 'label';
    } else {
      r.carrier = carrierFromTracking(r.trk);
      r.read = r.carrier === 'FedEx — unverified' ? 'pending' : '';
    }
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json(rows);
}

// Carrier from the tracking number alone.
// Deliberately does NOT split FedEx Ground from Express — verified on real
// labels that both use the same 12-digit 87x format, so the number cannot
// tell them apart. That split comes from reading the label, or better, from
// Arta persisting service_level onto the order.
export function carrierFromTracking(trk) {
  const t = (trk || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!t) return 'No tracking';
  if (t.startsWith('1Z')) return 'UPS';
  if (t.startsWith('JJD0')) return 'DHL';
  if (t.startsWith('963')) return 'FedEx Ground';
  if (/^9[2-5]/.test(t) && t.length >= 20 && t.length <= 26) return 'USPS';
  if (t.startsWith('420')) return 'USPS';
  if (/^8[0-9]/.test(t) && t.length === 12) return 'FedEx — unverified';
  if (/^(10|11|12|13|33)/.test(t)) return 'FedEx Express';
  return 'Unknown — check';
}
