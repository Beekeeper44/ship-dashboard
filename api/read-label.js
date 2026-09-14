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

Reply with ONLY a JSON object, no other text:
{"service":"<one of the values above, or UNREADABLE>","confidence":"high|medium|low","evidence":"<a few words naming what you saw>"}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { order, labelUrl } = req.body || {};
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

  // Arta serves PDFs by default; ask for the PNG, which vision handles.
  const url = labelUrl.replace('format=pdf_4_x_6', 'format=png');

  let b64, mediaType;
  try {
    const img = await fetch(url);
    if (!img.ok) {
      return res.status(502).json({ error: 'label_fetch_failed', status: img.status });
    }
    mediaType = (img.headers.get('content-type') || 'image/png').split(';')[0];
    if (mediaType === 'application/pdf') {
      return res.status(415).json({
        error: 'pdf_not_supported',
        hint: 'Request the label with format=png — the query exposes this as LABEL_IMAGE.',
      });
    }
    b64 = Buffer.from(await img.arrayBuffer()).toString('base64');
  } catch (err) {
    return res.status(502).json({ error: 'label_unreachable', detail: String(err) });
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

  if (parsed.service && parsed.service !== 'UNREADABLE') {
    try {
      await saveResolvedService(order, { ...parsed, labelUrl: url });
    } catch {
      // cache write failed — still return the answer
    }
  }

  return res.status(200).json(parsed);
}
