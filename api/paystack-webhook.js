// /api/paystack-webhook.js
//
// Paystack calls this URL directly (not the browser) whenever something
// happens on a transaction or transfer — most importantly, whether a
// payout actually succeeded or failed. This is the ONLY place a ledger
// entry should ever become 'paid' for real. Everything before this point
// is just "we attempted it."
//
// Set this URL in Paystack Dashboard > Settings > API Keys & Webhooks:
//   https://sultini.com/api/paystack-webhook
//
// IMPORTANT: this endpoint must receive the raw, unparsed request body —
// Paystack's signature is computed over the exact raw bytes, so if Vercel
// parses it to JSON first, signature verification will always fail.

import crypto from 'crypto';

export const config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  const rawBody = await getRawBody(req);

  // ---- Verify this really came from Paystack, not an impostor ----
  const signature = req.headers['x-paystack-signature'];
  const expectedSignature = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('Webhook signature mismatch — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody);

  // ---- Log every event for audit purposes, before doing anything else ----
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_events`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify([{
      provider: 'paystack',
      event_type: event.event,
      reference: event.data && event.data.reference,
      payload: event,
    }]),
  });

  // ---- React to transfer outcomes ----
  if (event.event === 'transfer.success') {
    await fetch(
      `${SUPABASE_URL}/rest/v1/ledger_entries?transfer_reference=eq.${event.data.reference}&status=eq.processing`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString() }),
      }
    );
  }

  if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
    await fetch(
      `${SUPABASE_URL}/rest/v1/ledger_entries?transfer_reference=eq.${event.data.reference}&status=eq.processing`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'transfer_failed',
          failure_reason: event.data.failure_reason || event.event,
        }),
      }
    );
  }

  // Always 200 quickly — Paystack retries aggressively if we don't
  return res.status(200).json({ received: true });
}
