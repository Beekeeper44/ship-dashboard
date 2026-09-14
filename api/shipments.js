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

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': process.env.METABASE_API_KEY,
  };
}

// name -> { id, type, required } for the card's native template tags.
// Metabase requires each parameter to carry the tag's UUID `id`, not just its
// name, so read the card definition first. Cached for the life of the lambda.
let TAG_CACHE = null;

async function getTemplateTags(base) {
  if (TAG_CACHE) return TAG_CACHE;
  const r = await fetch(`${base}/api/card/${CARD_ID}`, { headers: headers() });
  if (!r.ok) throw new Error(`card_fetch ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const card = await r.json();
  const tags = card?.dataset_query?.native?.['template-tags'] || {};
  TAG_CACHE = Object.fromEntries(
    Object.entries(tags).map(([name, t]) => [name, { id: t.id, type: t.type, required: !!t.required }])
  );
  return TAG_CACHE;
}

function paramType(tagType) {
  if (tagType === 'date') return 'date/single';
  if (tagType === 'number') return 'number/=';
  return 'category';
}

// The card's variables are not guaranteed to be called start_date / end_date.
// Match on shape instead: a date-typed tag whose name looks like a start or an
// end. Falls back to positional order when there are exactly two date tags.
// A tag we fail to match is a silent zero-row bug, so this also reports what
// it matched via ?debug=1 and the X-Sent-Params header.
function resolveDateTags(tags) {
  const dates = Object.entries(tags).filter(([, t]) => t.type === 'date');
  let startName = null;
  let endName = null;

  for (const [name] of dates) {
    const n = name.toLowerCase();
    if (!startName && /(^|_)(start|from|begin|since|after)/.test(n)) startName = name;
    else if (!endName && /(^|_)(end|to|thru|through|until|before)/.test(n)) endName = name;
  }
  if (!startName && !endName && dates.length === 2) {
    startName = dates[0][0];
    endName = dates[1][0];
  }
  return { startName, endName };
}

// Required tags that aren't dates still need a value or Metabase refuses to
// run. Never send 0 for a max — `cards_shipped <= 0` matches nothing, which
// looks exactly like "the query returned no rows".
function fallbackValue(name, tag) {
  const n = name.toLowerCase();
  if (tag.type === 'number') return /max/.test(n) ? 1000000 : 0;
  return '';
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

  const { start, end, debug, fresh } = req.query;

  let tags;
  try {
    tags = await getTemplateTags(BASE);
  } catch (err) {
    return res.status(502).json({ error: 'card_definition_failed', detail: String(err) });
  }

  const today = new Date().toLocaleDateString('en-CA');
  const { startName, endName } = resolveDateTags(tags);
  const parameters = [];

  for (const [name, tag] of Object.entries(tags)) {
    let value;
    if (name === startName) value = start || (tag.required ? today : undefined);
    else if (name === endName) value = end || (tag.required ? today : undefined);
    else if (tag.required) value = fallbackValue(name, tag);

    if (value !== undefined && value !== null && value !== '') {
      parameters.push({
        id: tag.id,
        type: paramType(tag.type),
        target: ['variable', ['template-tag', name]],
        value,
      });
    }
  }

  // Anything the card declares that we are not filling. If a date tag shows up
  // here, that is the reason a range picked in the UI has no effect: Metabase
  // falls back to the tag's own default and you get its rows, not yours.
  const unfilled = Object.keys(tags).filter(
    (n) => !parameters.some((p) => p.target[1][1] === n)
  );

  // /api/shipments?debug=1 shows the card's variables, which ones were matched
  // to the date range, and exactly what would be sent.
  if (debug) {
    return res.status(200).json({
      card: CARD_ID,
      tags,
      matched: { start: startName, end: endName },
      requested: { start: start || null, end: end || null },
      sentParameters: parameters,
      unfilled,
    });
  }

  let raw;
  try {
    const r = await fetch(
      `${BASE}/api/card/${CARD_ID}/query/json`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ parameters }),
      }
    );
    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({
        error: 'metabase_failed',
        status: r.status,
        sentParameters: parameters,
        detail: detail.slice(0, 600),
      });
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

  res.setHeader('Cache-Control', fresh
    ? 'no-store, no-cache, must-revalidate'
    : 's-maxage=60, stale-while-revalidate=120');
  res.setHeader('X-Cache-Store', process.env.DATABASE_URL ? 'neon' : 'none');
  res.setHeader('X-Sent-Params', JSON.stringify(parameters.map((p) => [p.target[1][1], p.value])));
  res.setHeader('X-Unfilled-Tags', unfilled.join(',') || 'none');
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
