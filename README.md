# Ship Dashboard

Orders shipped by employee, carrier and day. Reads Arena Club's Metabase
question **38974** and renders it as a browsable dashboard.

<https://arena-club.metabaseapp.com/question/38974>

---

## Deploy

```bash
npm i -g vercel        # once
cd ship-dashboard
vercel                 # first deploy, creates the project
vercel --prod          # promote to production
```

Then set the environment variables in **Vercel → your project → Settings →
Environment Variables** (values in `.env.example`):

| Variable | Required | What it's for |
|---|---|---|
| `METABASE_URL` | yes | `https://arena-club.metabaseapp.com` |
| `METABASE_API_KEY` | yes | Metabase → Settings → Authentication → API keys |
| `METABASE_CARD_ID` | no | defaults to `38974` |
| `ANTHROPIC_API_KEY` | for service split | reads Ground vs Express off the label |
| `DATABASE_URL` | recommended | Neon Postgres, caches each label read |

Redeploy after adding them. Without the Metabase vars the page still loads —
it falls back to built-in sample rows so you can see the layout.

## Local

```bash
npm install
cp .env.example .env.local   # fill in real values
vercel dev                   # http://localhost:3000
```

---

## What's here

```
public/index.html      the whole dashboard — UI, styles, logic, logos inlined
public/logos/          carrier + Arena Club logos as separate files
api/shipments.js       runs Metabase 38974, maps columns, returns JSON
api/read-label.js      sends a label image to Claude, returns its service level
api/_store.js          Neon queries — label cache + employee name overrides
schema.sql             Neon tables, run once
```

The dashboard is one self-contained HTML file on purpose — no build step, no
framework. Edit `public/index.html` directly and redeploy.

## The label-reading step, and why it exists

FedEx tracking numbers do not encode the service. Verified against real Arena
labels:

| Tracking | Actual service |
|---|---|
| `8770 8207 6236` | FedEx **Ground** |
| `8771 0390 1782` | FedEx **Express** |

Same prefix, same length. No rule over the tracking number can separate them,
and the warehouse has no service column — `orders.shipping_method` is empty on
all 74,813 rows since August, and `service_level` exists only on
`category_orders`, empty on 1.29M rows.

So those shipments show as **FedEx — unverified** until the label is read. The
marker box on the label is the answer:

| Marker | Service |
|---|---|
| boxed **E** | FedEx Express |
| boxed **G** | FedEx Ground |
| boxed **H** | FedEx Home Delivery |
| USPS banner | USPS Priority Mail |

`api/read-label.js` fetches the label PNG and asks Claude which marker it shows,
then caches the answer. Roughly a cent per label, once per shipment.

**The better fix is upstream.** Arta returns `carrier` and `service_level` in
the shipment response, and we already store `orders.return_shipment_id`. If
engineering persists those two fields at label creation, delete
`api/read-label.js` and `api/_store.js`, read the column in the SQL instead, and
nothing else in the UI changes.

## Neon setup

Create a Neon project, copy the connection string into `DATABASE_URL`, then run:

```bash
psql "$DATABASE_URL" -f schema.sql
```

or paste `schema.sql` into the Neon SQL editor. It creates:

| Table | What it holds |
|---|---|
| `shipment_service` | service level read off each label, so it's read once |
| `employee_names` | names for user_ids missing from `public.users` (Jimi Kim is seeded) |
| `shipment_log` | optional daily snapshot, only if you want history outside Metabase |

Skip Neon entirely and the app still runs — it just re-reads labels each time
and shows unmapped user ids as-is.

### Adding a missing employee name

```sql
INSERT INTO employee_names (user_id, full_name)
VALUES ('<uuid from the dashboard>', 'Their Name');
```

Takes effect on the next refresh. No redeploy, no SQL question edit.

## Column mapping

`api/shipments.js` expects these from card 38974 (case-insensitive):

`SHIPPED_BY` · `ORDER_NUMBER` · `CARDS_SHIPPED` · `TRACKING_NUMBER` ·
`COMPLETED_AT` · `ORDER_URL` · `TRACKING_URL` · `LABEL_IMAGE` (or `LABEL_URL`)

If the question aliases anything differently, fix the `pick()` calls in that
file rather than renaming columns in the SQL — other Metabase cards may depend
on them.

## One caveat about card counts

`ship_card` events arrive in bursts — a 122-card order and a 1-card order are
both a single batch. `CARDS_SHIPPED` measures what came through the queue, not
how hard someone worked. Confirm with the Oregon team how the scan fires before
anyone reads the team numbers as throughput.
