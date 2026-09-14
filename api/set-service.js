// POST /api/set-service   { order, service, tracking }
//
// Records a service level chosen by a person looking at the label.
// No Anthropic key needed — this is the manual path.
//
// The marker box on a FedEx label is unambiguous once you see it:
//   boxed E = Express, boxed G = Ground, boxed H = Home Delivery.
// A human reading it is more reliable than anything we could infer, and each
// label only has to be read once because the answer is cached here.

import { saveResolvedService, getResolvedServices } from './_store.js';

const ALLOWED = new Set([
  'FedEx Express',
  'FedEx Ground',
  'FedEx Home',
  'USPS',
  'DHL',
  'UPS',
  'Unknown — check',
]);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // quick check that the cache is wired up
    return res.status(200).json({
      cache: process.env.DATABASE_URL ? 'Neon connected' : 'MISSING DATABASE_URL — choices will not persist',
      allowed: [...ALLOWED],
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { order, service, tracking } = req.body || {};

  if (!order || !service) {
    return res.status(400).json({ error: 'missing_params', detail: 'order and service are required' });
  }
  if (!ALLOWED.has(service)) {
    return res.status(400).json({ error: 'bad_service', detail: service, allowed: [...ALLOWED] });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({
      error: 'no_cache',
      detail: 'Set DATABASE_URL (Neon) in Vercel so choices persist, then redeploy.',
    });
  }

  try {
    await saveResolvedService(order, {
      service,
      confidence: 'high',
      evidence: 'set by hand from the label',
      labelUrl: null,
    });
  } catch (err) {
    return res.status(502).json({ error: 'save_failed', detail: String(err) });
  }

  return res.status(200).json({ order, service, saved: true, tracking: tracking || null });
}

// GET /api/set-service?orders=a,b,c — what's already recorded
export async function lookup(orders) {
  return getResolvedServices(orders);
}
