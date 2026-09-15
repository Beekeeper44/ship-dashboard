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
import { SQL as OWN_SQL } from './_query.js';

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
    databaseId: card?.database_id ?? card?.dataset_query?.database ?? null,
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

/* --------------------------------------------------------- by-name vars ---- */

// The question page accepts ?start_date=…&end_date=…, so the native variables
// exist — this API key just can't read the card's query definition, which is
// why /api/card/38974 reports no template tags. Their names are all that's
// needed: a parameter targets a variable by name, and the tag's UUID `id` is
// only required for dashboard parameters.
const DATE_VARS = (process.env.METABASE_DATE_VARS || 'start_date,end_date')
  .split(',').map((x) => x.trim()).filter(Boolean);

function namedParameters(start, end, withIds, type = 'date/single') {
  const [startVar, endVar] = DATE_VARS;
  const one = (name, value, id) => {
    const p = { type, target: ['variable', ['template-tag', name]], value };
    if (withIds) p.id = id;
    return p;
  };
  const out = [];
  if (startVar && start) out.push(one(startVar, start, 'ship-start'));
  if (endVar && end) out.push(one(endVar, end, 'ship-end'));
  return out;
}

// The card's SQL reads TO_DATE(TO_VARCHAR({{start_date}})), so the variable may
// be declared Text rather than Date — and a parameter whose type doesn't match
// the tag is rejected, leaving the query to fall back on its CURRENT_DATE()
// default. Some Metabase versions also want an `id` on every parameter while
// others reject one they don't recognise. Rather than guess, walk the
// combinations and keep the first that comes back inside the window asked for.
//
// A run that returns rows from outside the window is a run whose parameters
// were ignored, so it doesn't count as a success.
const BYNAME_TYPES = ['date/single', 'category', 'date/all-options'];

async function runByName(base, start, end) {
  if (!DATE_VARS.length) return { ok: false, url: 'by-name', detail: 'no date variable names configured' };
  const dayOf = (r) => normalizeStamp(r.COMPLETED_AT ?? r.completed_at).slice(0, 10);
  let fallback = null;

  for (const type of BYNAME_TYPES) {
    for (const withIds of [false, true]) {
      const parameters = namedParameters(start, end, withIds, type);
      const out = await runQuery(base, { route: null, parameters });
      const variant = { type, withIds };
      if (!out.ok) {
        fallback = fallback || { ...out, sent: parameters, variant };
        continue;
      }
      const applied = out.rows.length === 0 ||
        out.rows.every((r) => { const d = dayOf(r); return !d || (d >= start && d <= end); });
      if (applied) return { ...out, sent: parameters, variant };
      fallback = { ...out, sent: parameters, variant };   // ran, but ignored the dates
    }
  }
  return fallback;
}

/* ----------------------------------------------------------- own query ---- */

// When api/_query.js holds the dashboard's SQL, run it directly. This is the
// only route that depends on nothing — not the card's variables, not a
// dashboard's filters, not what the API key can introspect.
const DB_ID = process.env.METABASE_DB_ID || '397';          // Snowflake APP_PROD
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

function ownSql(start, end) {
  if (!OWN_SQL || !OWN_SQL.trim()) return null;
  if (!isDate(start) || !isDate(end)) return null;
  return OWN_SQL
    .replace(/\{\{\s*start_date\s*\}\}/gi, `'${start}'`)
    .replace(/\{\{\s*end_date\s*\}\}/gi, `'${end}'`);
}

async function runOwnSql(base, start, end, databaseId) {
  const query = ownSql(start, end);
  if (!query) return { ok: false, url: 'own-sql', detail: 'no SQL in api/_query.js' };
  const url = `${base}/api/dataset/json`;
  const body = new URLSearchParams({
    query: JSON.stringify({ type: 'native', database: Number(databaseId || DB_ID), native: { query } }),
    format_rows: 'false',
  });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-api-key': process.env.METABASE_API_KEY },
    body,
  });
  if (!r.ok) return { ok: false, status: r.status, url, detail: (await r.text()).slice(0, 400) };
  const rows = await r.json();
  if (!Array.isArray(rows)) return { ok: false, url, detail: JSON.stringify(rows).slice(0, 400) };
  return { ok: true, url, rows };
}

/* --------------------------------------------------------------- ad-hoc ---- */

// The most dependable route, and the one that needs no discovery at all: run a
// new query whose source IS the saved question, with a date filter on top.
//
//   { "source-table": "card__38974",
//     "filter": ["between", ["field","COMPLETED_AT",…], "2026-09-08", "2026-09-11"] }
//
// Works whether 38974 is native or query-builder, with or without variables,
// on a dashboard or not. The one thing it cannot do is widen a window the
// question itself pins — nesting can only narrow.
const DATE_COLUMN = process.env.METABASE_DATE_COLUMN || 'COMPLETED_AT';

function dateColumn(card) {
  const cols = card.resultMetadata || [];
  const wanted = String(DATE_COLUMN).toLowerCase();
  const hit =
    cols.find((c) => String(c.name || '').toLowerCase() === wanted) ||
    cols.find((c) => /completed/i.test(String(c.name || '')) &&
                     /date|time/i.test(String(c.base_type || c.effective_type || ''))) ||
    cols.find((c) => /date|time/i.test(String(c.base_type || c.effective_type || '')));
  if (!hit) return { name: DATE_COLUMN, baseType: 'type/DateTime' };
  return { name: hit.name, baseType: hit.base_type || hit.effective_type || 'type/DateTime' };
}

function adhocQuery(card, start, end) {
  const col = dateColumn(card);
  return {
    type: 'query',
    database: card.databaseId,
    query: {
      'source-table': `card__${CARD_ID}`,
      filter: ['between', ['field', col.name, { 'base-type': col.baseType }], start, end],
    },
  };
}

async function runAdhoc(base, card, start, end) {
  if (!card.databaseId) return { ok: false, url: 'adhoc', detail: 'no database id on the card' };
  const url = `${base}/api/dataset/json`;
  const body = new URLSearchParams({
    query: JSON.stringify(adhocQuery(card, start, end)),
    format_rows: 'false',
  });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-api-key': process.env.METABASE_API_KEY },
    body,
  });
  if (!r.ok) return { ok: false, status: r.status, url, detail: (await r.text()).slice(0, 400) };
  const rows = await r.json();
  if (!Array.isArray(rows)) return { ok: false, url, detail: JSON.stringify(rows).slice(0, 400) };
  return { ok: true, url, rows };
}

/* ------------------------------------------------------------- execute ---- */

async function runQuery(base, { route, parameters }) {
  const url = route
    ? `${base}/api/dashboard/${route.dashboardId}/dashcard/${route.dashcardId}/card/${CARD_ID}/query/json`
    : `${base}/api/card/${CARD_ID}/query/json`;

  // format_rows:false keeps timestamps as ISO instead of "Sep 11, 2026, 5:13 PM".
  // Export endpoints format by default, and a formatted date is unparseable to
  // every date comparison downstream.
  const r = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ parameters, format_rows: false }),
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

// A timestamp can arrive as ISO, as "September 11, 2026, 5:13 PM", or as
// "2026-09-11 17:13:00" depending on the route and the export settings.
// Normalise once, here, so every comparison downstream — the window check, the
// clamp, and the browser's own date filtering — works on the same shape.
export function normalizeStamp(v) {
  if (v === null || v === undefined) return '';
  const raw = String(v).trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;          // already ISO
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const stampsOf = (rows) =>
  rows.map((x) => normalizeStamp(x.COMPLETED_AT ?? x.completed_at ?? x.Completed_At)).filter(Boolean).sort();

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

  // /api/shipments?cards=1&dashboard=<id> lists every card on a dashboard with
  // its question id, so the card the dashboard actually renders can be told
  // apart from whatever METABASE_CARD_ID currently points at.
  if (req.query.cards) {
    const dashId = req.query.dashboard || process.env.METABASE_DASHBOARD_ID;
    if (!dashId) {
      return res.status(400).json({
        error: 'need_dashboard_id',
        detail: 'Call /api/shipments?cards=1&dashboard=<id>, taking <id> from the dashboard URL.',
      });
    }
    const r = await fetch(`${BASE}/api/dashboard/${dashId}`, { headers: headers() });
    if (!r.ok) {
      return res.status(502).json({ error: 'dashboard_fetch_failed', status: r.status, detail: (await r.text()).slice(0, 300) });
    }
    const dash = await r.json();
    const dashcards = dash.dashcards || dash.ordered_cards || [];
    return res.status(200).json({
      dashboard: { id: dashId, name: dash.name },
      parameters: (dash.parameters || []).map((p) => ({ id: p.id, name: p.name, slug: p.slug, type: p.type })),
      cards: dashcards.map((dc) => ({
        dashcardId: dc.id,
        cardId: dc.card_id,
        name: dc.card?.name || null,
        isCurrentCard: String(dc.card_id) === String(CARD_ID),
        parameterMappings: (dc.parameter_mappings || []).map((m) => ({ parameter_id: m.parameter_id, target: m.target })),
      })),
      currentlyQuerying: CARD_ID,
    });
  }

  if (debug) {
    return res.status(200).json({
      card: CARD_ID,
      cardName: card.name,
      ownSqlConfigured: !!(OWN_SQL && OWN_SQL.trim()),
      // Empty tags with a working ?start_date= on the question page means the
      // key can run the card but not read its definition. Names are enough.
      tagsReadable: Object.keys(tags).length > 0,
      dateVariableNames: DATE_VARS,
      byNameParameterVariants: BYNAME_TYPES.map((t) => namedParameters(start || today, end || today, false, t)),
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
    const [byName, withParams, withoutParams, adhoc, own] = await Promise.all([
      runByName(BASE, start || today, end || today),
      runQuery(BASE, { route: useDashboard ? route : null, parameters }),
      runQuery(BASE, { route: null, parameters: [] }),
      runAdhoc(BASE, card, start || today, end || today),
      runOwnSql(BASE, start || today, end || today, card.databaseId),
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
    const c = span(adhoc);
    const n = span(byName);
    const o = span(own);
    return res.status(200).json({
      via: useDashboard ? 'dashboard' : 'card',
      requested: { start: start || null, end: end || null },
      sentParameters: parameters,
      ownSql: o,
      byName: n,
      byNameVariant: byName.variant || null,
      byNameSent: byName.sent || null,
      withParams: a,
      withoutParams: b,
      adhoc: c,
      adhocQuery: adhocQuery(card, start || today, end || today),
      verdict: (() => {
        if (o.ok && o.rows > 0)
          return 'the embedded SQL returns the window directly — that is the route the app uses first';
        if (n.ok && n.rows > 0 && n.latest && n.latest.slice(0, 10) <= (end || today))
          return 'the named variables honour the range — that is the route the app now uses';
        if (c.ok && c.rows > 0 && c.latest && c.latest.slice(0, 10) <= (end || today))
          return 'the nested ad-hoc query honours the range — that is the route the app now uses';
        if (c.ok && c.rows === 0)
          return 'the nested ad-hoc query returned nothing for that window — the question itself only exposes today';
        if (!a.ok || !b.ok) return 'a run failed — see detail';
        if (!parameters.length) return 'nothing was sent — no date variable on the card and no dashboard filter found';
        return (a.earliest === b.earliest && a.latest === b.latest)
          ? 'parameters had no effect — the window is set inside the question itself'
          : 'parameters changed the span — the range is reaching the query';
      })(),
    });
  }

  // Try the routes in order of reliability and stop at the first one that comes
  // back inside the window that was asked for. A route that answers with rows
  // from outside the range is a route that ignored the range.
  const from = start || today;
  const to = end || today;
  const wantsRange = !!(start || end);
  const dayOf = (r) => normalizeStamp(r.COMPLETED_AT ?? r.completed_at).slice(0, 10);
  const inWindow = (rows) =>
    rows.length > 0 && rows.every((r) => { const d = dayOf(r); return !d || (d >= from && d <= to); });

  const attempts = [];
  if (OWN_SQL && OWN_SQL.trim()) attempts.push({ name: 'own-sql', run: () => runOwnSql(BASE, from, to, card.databaseId) });
  if (!hasCardDates) attempts.push({ name: 'by-name', run: () => runByName(BASE, from, to) });
  if (wantsRange) attempts.push({ name: 'adhoc', run: () => runAdhoc(BASE, card, from, to) });
  if (useDashboard) attempts.push({ name: 'dashboard', run: () => runQuery(BASE, { route, parameters }) });
  attempts.push({ name: 'card', run: () => runQuery(BASE, { route: null, parameters: useDashboard ? [] : parameters }) });

  let result = null;
  let via = null;
  let honoured = !wantsRange;
  const tried = [];
  for (const a of attempts) {
    const out = await a.run();
    const ok = out.ok && (!wantsRange || inWindow(out.rows) || out.rows.length === 0);
    tried.push({
      route: a.name,
      ok: out.ok,
      rows: out.ok ? out.rows.length : null,
      honouredRange: out.ok ? ok : null,
      detail: out.ok ? null : (out.detail || out.status),
    });
    if (!out.ok) continue;
    result = out; via = a.name;
    if (ok) { honoured = true; break; }               // stop at the first route that respected the window
  }

  if (!result) {
    return res.status(502).json({ error: 'metabase_failed', tried, sentParameters: parameters });
  }

  // Every route ran but none respected the window. Say so instead of serving an
  // empty table — a silent zero reads as "no shipments that week", which is a
  // different and much more misleading thing.
  if (!honoured) {
    return res.status(502).json({
      error: 'range_ignored',
      detail: `Every route returned rows outside ${from}..${to}. The window was not applied.`,
      requested: { start: from, end: to },
      tried,
      sentParameters: parameters,
    });
  }

  // Whatever route answered, never show rows from outside the requested window.
  // Better an honest empty day than today's rows labelled as last Tuesday.
  const raw = wantsRange
    ? result.rows.filter((r) => { const d = dayOf(r); return !d || (d >= from && d <= to); })
    : result.rows;

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
      ts: normalizeStamp(pick(r, 'COMPLETED_AT')),
      orderUrl: pick(r, 'ORDER_URL') || '',
      trackUrl: pick(r, 'TRACKING_URL') || '',
      label,
      // The PNG variant is what renders and what OCR reads; the original (often
      // a PDF) is the fallback and what "open the label" points at. The client
      // looks for both, and without labelPdf a row with no PNG had nothing to
      // fall back to.
      labelPdf: pick(r, 'LABEL_URL') || '',
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
  res.setHeader('X-Query-Route', via);
  if (result.variant) res.setHeader('X-Param-Variant', JSON.stringify(result.variant));
  res.setHeader('X-Routes-Tried', JSON.stringify(tried));
  res.setHeader('X-Window', `${from}..${to}`);
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
