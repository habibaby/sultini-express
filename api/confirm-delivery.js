// /api/confirm-delivery.js
//
// Verifies a rider-entered delivery confirmation code SERVER-SIDE. The
// real code is never sent to the rider's browser at all — riders only
// ever send what the customer told them, and this endpoint checks it
// against the database directly, returning only success or failure.
// This is the actual security boundary; client-side comparison against
// a code already present in the page is not secure, since anyone can
// read a page's own HTML/JS via dev tools.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  const { orderId, enteredCode } = req.body || {};
  if (!orderId || !enteredCode) {
    return res.status(400).json({ error: 'Missing orderId or enteredCode' });
  }

  try {
    const orderRes = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=delivery_confirmation_code,status,fulfilment`,
      { headers: sbHeaders }
    );
    const orders = await orderRes.json();
    const order = orders && orders[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.fulfilment !== 'delivery') return res.status(400).json({ error: 'This order is not a delivery order' });

    const realCode = String(order.delivery_confirmation_code || '').trim().toUpperCase();
    const submitted = String(enteredCode || '').trim().toUpperCase();
    if (!realCode || submitted !== realCode) {
      return res.status(400).json({ error: 'That code doesn\'t match — please double-check with the customer before confirming delivery.' });
    }

    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'delivered' }),
    });
    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('Failed to update order status:', errText);
      return res.status(500).json({ error: 'Code was correct, but updating the order failed. Please try again.' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong confirming delivery' });
  }
}
