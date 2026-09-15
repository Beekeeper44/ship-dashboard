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

// The card's native template tags plus its SQL. Metabase requires each
// parameter to carry the tag's UUID `id`, not just its name, so the card
// definition has to be read first. Cached for the life of the lambda.
let CARD_CACHE = null;

async function getCard(base) {
  if (CARD_CACHE) return CARD_CACHE;
  const r = await fetch(`${base}/api/card/${CARD_ID}`, { headers: headers() });
  if (!r.ok) throw new Error(`card_fetch ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const card = await r.json();
  const native = card?.dataset_query?.native || {};
  const raw = native['template-tags'] || {};
  CARD_CACHE = {
    queryType: card?.dataset_query?.type || null,   // 'native' | 'query' (GUI)
    mbql: card?.dataset_query?.query || null,
    resultMetadata: Array.isArray(card?.result_metadata) ? card.result_metadata : [],
    sql: native.query || '',
    tags: Object.fromEntries(
      Object.entries(raw).map(([name, t]) => [name, {
        id: t.id,
        type: t.type,                       // text | number | date | dimension
        widgetType: t['widget-type'] || null, // set on field filters
        required: !!t.required,
        default: t.default ?? null,
      }])
    ),
  };
  return CARD_CACHE;
}

// A GUI (query-builder) card has no template tags, so there is nothing to fill
// in. It can still be filtered the way a dashboard filter does it: by targeting
// one of its own columns. Find the completed-at column and its field ref.
const DATE_COLUMN = process.env.METABASE_DATE_COLUMN || 'COMPLETED_AT';

function dateFieldRef(card) {
  const cols = card.resultMetadata.filter(
    (c) => /date|time/i.test(String(c.base_type || c.effective_type || ''))
  );
  const wanted = String(DATE_COLUMN).toLowerCase();
  const hit =
    cols.find((c) => String(c.name || '').toLowerCase() === wanted) ||
    cols.find((c) => /completed/i.test(String(c.name || ''))) ||
    cols[0];
  if (!hit) return null;
  const ref = hit.field_ref || (hit.id ? ['field', hit.id, null] : null);
  return ref ? { name: hit.name, ref } : null;
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
const isDateTag = (t) =>
  t.type === 'date' || (t.type === 'dimension' && String(t.widgetType || '').startsWith('date'));

function resolveDateTags(tags) {
  const dates = Object.entries(tags).filter(([, t]) => isDateTag(t));
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

  const { start, end, debug, probe, fresh } = req.query;

  let card;
  try {
    card = await getCard(BASE);
  } catch (err) {
    return res.status(502).json({ error: 'card_definition_failed', detail: String(err) });
  }
  const tags = card.tags;

  const today = new Date().toLocaleDateString('en-CA');
  const { startName, endName } = resolveDateTags(tags);
  const parameters = [];

  for (const [name, tag] of Object.entries(tags)) {
    // A date field filter is a *dimension*, not a variable. Sending it as a
    // variable is silently ignored by Metabase — the query runs with the filter
    // unset and you get the card's own default window back, which is exactly
    // what "the range picker does nothing" looks like.
    if (isDateTag(tag) && tag.type === 'dimension') {
      if (name !== startName && name !== endName) continue;
      if (name === endName && startName) continue;      // one dimension covers both ends
      const from = start || today;
      const to = end || today;
      parameters.push({
        id: tag.id,
        type: 'date/all-options',
        target: ['dimension', ['template-tag', name]],
        value: from === to ? from : `${from}~${to}`,
      });
      continue;
    }

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

  // No date variables on the card at all — filter its column directly, which is
  // what a dashboard date filter does under the hood.
  let columnFilter = null;
  if (!startName && !endName) {
    const f = dateFieldRef(card);
    if (f && (start || end)) {
      const from = start || end;
      const to = end || start;
      columnFilter = f.name;
      parameters.push({
        id: 'ship-dashboard-range',
        type: 'date/range',
        target: ['dimension', f.ref],
        value: from === to ? `${from}~${to}` : `${from}~${to}`,
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
      queryType: card.queryType,
      columnFilter,
      dateColumn: dateFieldRef(card),
      // A GUI card carries its own filter clause; if that clause pins the
      // window (e.g. Completed At = Today) nothing sent from here can widen it.
      mbqlFilter: card.mbql ? (card.mbql.filter || null) : null,
      // If the SQL pins the window itself — CURRENT_DATE, GETDATE(),
      // DATEADD(day,-1,...) outside a {{tag}} — no parameter can move it.
      sqlDatePins: (card.sql.match(/\b(CURRENT_DATE|CURRENT_TIMESTAMP|GETDATE\(\)|SYSDATE|NOW\(\)|TODAY\(\))\b/gi) || []),
      sqlHasDateTags: /\{\{\s*(start|end|from|to)[a-z_]*\s*\}\}/i.test(card.sql),
      sql: card.sql.slice(0, 4000),
    });
  }

  // /api/shipments?probe=1&start=…&end=… runs the card twice — once with the
  // parameters, once with none — and reports the date span that came back.
  // If both spans are identical, the parameters are not moving the query and
  // the window is pinned inside the SQL.
  if (probe) {
    const run = async (params) => {
      const r = await fetch(`${BASE}/api/card/${CARD_ID}/query/json`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ parameters: params }),
      });
      if (!r.ok) return { ok: false, status: r.status, detail: (await r.text()).slice(0, 300) };
      const rows = await r.json();
      if (!Array.isArray(rows)) return { ok: false, detail: 'unexpected_shape' };
      const stamps = rows
        .map((x) => x.COMPLETED_AT || x.completed_at || x.Completed_At)
        .filter(Boolean)
        .map(String)
        .sort();
      return {
        ok: true,
        rows: rows.length,
        earliest: stamps[0] || null,
        latest: stamps[stamps.length - 1] || null,
      };
    };
    const [withParams, withoutParams] = await Promise.all([run(parameters), run([])]);
    return res.status(200).json({
      requested: { start: start || null, end: end || null },
      sentParameters: parameters,
      withParams,
      withoutParams,
      verdict: (() => {
        if (!withParams.ok || !withoutParams.ok) return 'a run failed — see detail';
        if (!parameters.length) return 'nothing was sent — the card exposes no date variable to fill';
        const same = withParams.earliest === withoutParams.earliest
          && withParams.latest === withoutParams.latest;
        return same
          ? 'parameters had no effect — the window is set inside the card, not by the request'
          : 'parameters changed the span — the range is reaching the card';
      })(),
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
