// GET /api/shipments?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Runs the saved Metabase question and returns rows shaped for the dashboard.
// Card 38974 -> https://arena-club.metabaseapp.com/question/38974
//
// Card 38974 is a query-builder question: it has no {{start_date}} / {{end_date}}
// template tags, so there is nothing on the card itself to fill in. Its Start
// Date / End Date boxes are *dashboard* filters, and dashboard filters only
// apply on the dashboard's own query route:
//
//   POST /api/dashboard/:dash/dashcard/:dashcard/card/:card/query/json
//
// So that is the route this file uses whenever the card exposes no date
// variables of its own. Everything needed to build it — dashboard id, dashcard
// id, the two parameter ids and their column mappings — is discovered from the
// Metabase API and cached. Set METABASE_DASHBOARD_ID to skip the discovery.

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

/* ---------------------------------------------------------------- card ---- */

// The card's template tags, its SQL and its result columns. Metabase requires
// each parameter to carry the tag's UUID `id`, not just its name, so the card
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
    name: card?.name || '',
    queryType: card?.dataset_query?.type || null,     // 'native' | 'query' (GUI)
    mbql: card?.dataset_query?.query || null,
    resultMetadata: Array.isArray(card?.result_metadata) ? card.result_metadata : [],
    dashboardId: card?.dashboard_id || null,
    sql: native.query || '',
    tags: Object.fromEntries(
      Object.entries(raw).map(([name, t]) => [name, {
        id: t.id,
        type: t.type,                                 // text | number | date | dimension
        widgetType: t['widget-type'] || null,         // set on field filters
        required: !!t.required,
        default: t.default ?? null,
      }])
    ),
  };
  return CARD_CACHE;
}

const isDateTag = (t) =>
  t.type === 'date' || (t.type === 'dimension' && String(t.widgetType || '').startsWith('date'));

// The card's variables are not guaranteed to be called start_date / end_date.
// Match on shape instead, falling back to positional order when there are
// exactly two date tags.
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

function paramType(tagType) {
  if (tagType === 'date') return 'date/single';
  if (tagType === 'number') return 'number/=';
  return 'category';
}

/* ----------------------------------------------------------- dashboard ---- */

// dashboard id + dashcard id + the two date parameters, with the column each
// one is mapped to. Null when the card doesn't live on a dashboard we can see.
let ROUTE_CACHE;

async function getDashboardRoute(base, card) {
  if (ROUTE_CACHE !== undefined) return ROUTE_CACHE;
  ROUTE_CACHE = null;
  try {
    let dashId = process.env.METABASE_DASHBOARD_ID || card.dashboardId || null;

    if (!dashId) {
      // Metabase lists the dashboards a card appears on. Older versions 404
      // here, in which case METABASE_DASHBOARD_ID has to be set by hand.
      const r = await fetch(`${base}/api/card/${CARD_ID}/dashboards`, { headers: headers() });
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list) && list.length) dashId = list[0].id ?? list[0].dashboard_id;
      }
    }
    if (!dashId) return ROUTE_CACHE;

    const d = await fetch(`${base}/api/dashboard/${dashId}`, { headers: headers() });
    if (!d.ok) return ROUTE_CACHE;
    const dash = await d.json();

    const dashcards = dash.dashcards || dash.ordered_cards || [];
    const dc = dashcards.find((c) => String(c.card_id) === String(CARD_ID));
    if (!dc) return ROUTE_CACHE;

    const params = dash.parameters || [];
    const label = (p) => String(p.slug || p.name || '').toLowerCase();
    const dateish = params.filter((p) => /date|time/i.test(String(p.type || '')) || /date/.test(label(p)));
    const startP = dateish.find((p) => /start|from|begin|since/.test(label(p)));
    const endP = dateish.find((p) => /end|until|thru|through/.test(label(p)));

    const targetFor = (id) =>
      (dc.parameter_mappings || []).find((m) => m.parameter_id === id)?.target || null;

    ROUTE_CACHE = {
      dashboardId: dashId,
      dashboardName: dash.name || '',
      dashcardId: dc.id,
      start: startP ? { id: startP.id, type: startP.type, slug: startP.slug, target: targetFor(startP.id) } : null,
      end: endP ? { id: endP.id, type: endP.type, slug: endP.slug, target: targetFor(endP.id) } : null,
      allParameters: params.map((p) => ({ id: p.id, slug: p.slug, type: p.type })),
    };
  } catch {
    ROUTE_CACHE = null;
  }
  return ROUTE_CACHE;
}

function dashboardParameters(route, start, end) {
  const out = [];
  const add = (p, value) => {
    if (!p || !value) return;
    const one = { id: p.id, type: p.type || 'date/single', value };
    if (p.target) one.target = p.target;
    out.push(one);
  };
  add(route.start, start || end);
  add(route.end, end || start);
  return out;
}

/* ------------------------------------------------------------- execute ---- */

async function runQuery(base, { route, parameters }) {
  const url = route
    ? `${base}/api/dashboard/${route.dashboardId}/dashcard/${route.dashcardId}/card/${CARD_ID}/query/json`
    : `${base}/api/card/${CARD_ID}/query/json`;

  const r = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ parameters }),
  });
  if (!r.ok) {
    return { ok: false, status: r.status, url, detail: (await r.text()).slice(0, 600) };
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) {
    return { ok: false, url, detail: JSON.stringify(rows).slice(0, 400) };
  }
  return { ok: true, url, rows };
}

const stampsOf = (rows) =>
  rows.map((x) => x.COMPLETED_AT || x.completed_at || x.Completed_At).filter(Boolean).map(String).sort();

/* ------------------------------------------------------------- handler ---- */

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

  // --- route A: the card has its own date variables, fill them in
  const cardParameters = [];
  for (const [name, tag] of Object.entries(tags)) {
    if (isDateTag(tag) && tag.type === 'dimension') {
      if (name !== startName && name !== endName) continue;
      if (name === endName && startName) continue;        // one dimension covers both ends
      const from = start || today;
      const to = end || today;
      cardParameters.push({
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
      cardParameters.push({
        id: tag.id,
        type: paramType(tag.type),
        target: ['variable', ['template-tag', name]],
        value,
      });
    }
  }

  // --- route B: no date variables on the card, so go through the dashboard,
  //     which is where the Start Date / End Date filters actually live
  const hasCardDates = !!(startName || endName);
  const route = hasCardDates ? null : await getDashboardRoute(BASE, card);
  const useDashboard = !!(route && (route.start || route.end));
  const parameters = useDashboard
    ? dashboardParameters(route, start || today, end || today)
    : cardParameters;

  const unfilled = hasCardDates
    ? Object.keys(tags).filter((n) => !cardParameters.some((p) => p.target?.[1]?.[1] === n))
    : [];

  if (debug) {
    return res.status(200).json({
      card: CARD_ID,
      cardName: card.name,
      queryType: card.queryType,
      via: useDashboard ? 'dashboard' : 'card',
      tags,
      matched: { start: startName, end: endName },
      requested: { start: start || null, end: end || null },
      sentParameters: parameters,
      unfilled,
      dashboardRoute: route,
      // A GUI card carries its own filter clause; if that clause pins the
      // window (e.g. Completed At = Today) nothing sent from here can widen it.
      mbqlFilter: card.mbql ? (card.mbql.filter || null) : null,
      sqlDatePins: (card.sql.match(/\b(CURRENT_DATE|CURRENT_TIMESTAMP|GETDATE\(\)|SYSDATE|NOW\(\)|TODAY\(\))\b/gi) || []),
      sql: card.sql.slice(0, 4000),
    });
  }

  // /api/shipments?probe=1&start=…&end=… runs the query twice — once with the
  // parameters, once with none — and reports the date span each returned.
  if (probe) {
    const [withParams, withoutParams] = await Promise.all([
      runQuery(BASE, { route: useDashboard ? route : null, parameters }),
      runQuery(BASE, { route: null, parameters: [] }),
    ]);
    const span = (r) => r.ok
      ? {
          ok: true,
          rows: r.rows.length,
          earliest: stampsOf(r.rows)[0] || null,
          latest: stampsOf(r.rows).slice(-1)[0] || null,
          url: r.url,
        }
      : r;
    const a = span(withParams);
    const b = span(withoutParams);
    return res.status(200).json({
      via: useDashboard ? 'dashboard' : 'card',
      requested: { start: start || null, end: end || null },
      sentParameters: parameters,
      withParams: a,
      withoutParams: b,
      verdict: (() => {
        if (!a.ok || !b.ok) return 'a run failed — see detail';
        if (!parameters.length) return 'nothing was sent — no date variable on the card and no dashboard filter found';
        return (a.earliest === b.earliest && a.latest === b.latest)
          ? 'parameters had no effect — the window is set inside the question itself'
          : 'parameters changed the span — the range is reaching the query';
      })(),
    });
  }

  const result = await runQuery(BASE, { route: useDashboard ? route : null, parameters });
  if (!result.ok) {
    return res.status(502).json({
      error: 'metabase_failed',
      status: result.status || null,
      via: useDashboard ? 'dashboard' : 'card',
      url: result.url,
      sentParameters: parameters,
      detail: result.detail,
    });
  }
  const raw = result.rows;

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
  res.setHeader('X-Query-Route', useDashboard ? `dashboard/${route.dashboardId}` : `card/${CARD_ID}`);
  res.setHeader('X-Sent-Params', JSON.stringify(parameters.map((p) => [p.slug || p.id, p.value])));
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
