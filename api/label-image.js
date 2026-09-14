// GET /api/label-image?url=<arta label url>
//
// Streams a shipping label through our own domain.
//
// Why: browser OCR needs pixel access, and drawing a cross-origin image onto a
// canvas taints it unless the source sends CORS headers. Arta doesn't, so we
// fetch server-side and re-serve it same-origin. Free — no third-party API.

const ALLOWED_HOSTS = new Set([
  'api.arta.io',
  'arta.io',
  's3.amazonaws.com',
  'arta-uploads-prd-documents.s3.amazonaws.com',
]);

function formatCandidates(labelUrl) {
  const base = labelUrl.replace(/\?format=.*$/, '');
  return [
    base + '?format=png_4_x_6',
    labelUrl.replace('format=pdf_4_x_6', 'format=png_4_x_6'),
    base + '?format=png',
    base,
    labelUrl,
  ].filter((u, i, a) => u && a.indexOf(u) === i);
}

export default async function handler(req, res) {
  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: 'missing_url' });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'bad_url' });
  }

  // Only proxy label hosts — don't turn this into an open relay.
  const host = target.hostname.replace(/^www\./, '');
  const ok = [...ALLOWED_HOSTS].some((h) => host === h || host.endsWith('.' + h));
  if (!ok) {
    return res.status(403).json({ error: 'host_not_allowed', host });
  }

  const tried = [];
  for (const cand of formatCandidates(raw)) {
    try {
      const r = await fetch(cand);
      const type = (r.headers.get('content-type') || '').split(';')[0];
      tried.push({ url: cand, status: r.status, type });
      if (!r.ok || !type.startsWith('image/')) continue;

      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send(buf);
    } catch (err) {
      tried.push({ url: cand, error: String(err) });
    }
  }

  return res.status(502).json({ error: 'no_image', tried });
}
