// POST /api/read-label  { order, labelUrl }
//
// Fetches a shipping label image and asks Claude which service marker it shows.
// The answer is cached so each label is read exactly once.
//
// Why this exists: FedEx Ground and Express tracking numbers are identical in
// format (12 digits, 87x). Verified against real labels — 8770 8207 6236 is
// Ground, 8771 0390 1782 is Express. The only signal is the printed marker box.

import { getResolvedServices, saveResolvedService } from './_store.js';

const PROMPT = `This is a shipping label. Identify the carrier and service from its markers:

- A boxed capital "E" with the FedEx Express wordmark   -> "FedEx Express"
- A boxed capital "G" with the FedEx Ground wordmark    -> "FedEx Ground"
- A boxed capital "H" with FedEx Home Delivery          -> "FedEx Home"
- A "USPS PRIORITY MAIL" banner                         -> "USPS"
- A DHL logo                                            -> "DHL"
- A UPS logo                                            -> "UPS"

Supporting signals: FedEx Express labels usually print a service line such as
"2DAY", "PRIORITY OVERNIGHT" or "STANDARD OVERNIGHT". FedEx Ground and Home
Delivery labels carry a second long barcode number beginning 96.

Also read the tracking number printed next to "TRK#" (digits only, no spaces).
That lets us confirm the label belongs to the order we think it does.

Reply with ONLY a JSON object, no other text:
{"service":"<one of the values above, or UNREADABLE>","confidence":"high|medium|low","tracking":"<digits, or empty>","evidence":"<a few words naming what you saw>"}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { order, labelUrl, tracking } = req.body || {};
  if (!order || !labelUrl) {
    return res.status(400).json({ error: 'missing_params', detail: 'order and labelUrl are required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'missing_env', detail: 'Set ANTHROPIC_API_KEY.' });
  }

  // already read?
  try {
    const cached = await getResolvedServices([order]);
    if (cached[order]) return res.status(200).json({ ...cached[order], cached: true });
  } catch {
    // no cache configured — continue and just don't persist
  }

  // Arta serves PDFs by default. We don't know their exact PNG format string,
  // so try the likely ones and keep the first that returns an actual image.
  const base = labelUrl.replace(/\?format=.*$/, '');
  // png_4_x_6 verified working against Arta (2026-09-14); the rest are fallbacks.
  const candidates = [
    base + '?format=png_4_x_6',
    labelUrl.replace('format=pdf_4_x_6', 'format=png_4_x_6'),
    base + '?format=png',
    base,
    labelUrl,
  ].filter((u, i, a) => u && a.indexOf(u) === i);

  let b64, mediaType, url, tried = [];
  for (const cand of candidates) {
    try {
      const img = await fetch(cand);
      const ct = (img.headers.get('content-type') || '').split(';')[0];
      tried.push({ url: cand, status: img.status, type: ct });
      if (!img.ok) continue;
      if (!ct.startsWith('image/')) continue;   // PDFs and error pages skipped
      mediaType = ct;
      url = cand;
      b64 = Buffer.from(await img.arrayBuffer()).toString('base64');
      break;
    } catch (err) {
      tried.push({ url: cand, error: String(err) });
    }
  }

  if (!b64) {
    return res.status(502).json({
      error: 'no_image_format_worked',
      hint: 'None of the Arta format variants returned an image. Check tried[] for what each returned.',
      tried,
    });
  }

  let text;
  try {
    const ai = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    });
    const data = await ai.json();
    if (data.error) {
      return res.status(502).json({ error: 'anthropic_failed', detail: data.error });
    }
    text = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();
  } catch (err) {
    return res.status(502).json({ error: 'anthropic_unreachable', detail: String(err) });
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return res.status(500).json({ error: 'unparseable_response', raw: text.slice(0, 300) });
  }

  // Guard: if the label's printed tracking number doesn't match the order's,
  // the label URL points at a different shipment. Don't record the service.
  if (tracking && parsed.tracking) {
    const a = String(tracking).replace(/\D/g, '');
    const b = String(parsed.tracking).replace(/\D/g, '');
    if (a && b && a !== b) {
      return res.status(409).json({
        error: 'tracking_mismatch',
        detail: `Label shows ${b} but the order's tracking is ${a} — the label URL may point at the wrong shipment.`,
        service: parsed.service,
        labelTracking: b,
      });
    }
  }

  if (parsed.service && parsed.service !== 'UNREADABLE') {
    try {
      await saveResolvedService(order, { ...parsed, labelUrl: url });
    } catch {
      // cache write failed — still return the answer
    }
  }

  return res.status(200).json(parsed);
}
