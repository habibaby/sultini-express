// /api/refund-order.js
//
// Issues a real refund through Paystack for a given order, and
// reverses the vendor's ledger entry so they don't still get paid
// for an order that was refunded. Runs server-side since it needs
// the Paystack secret key.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ error: 'Missing orderId' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };

  try {
    // 1. Look up the order's payment reference
    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=payment_reference,payment_status,total`, { headers: sbHeaders });
    const orders = await orderRes.json();
    const order = orders && orders[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.payment_reference) return res.status(400).json({ error: 'This order has no online payment to refund (was it cash on delivery?)' });
    if (order.payment_status === 'refunded') return res.status(400).json({ error: 'This order was already refunded' });

    // 2. Actually issue the refund with Paystack
    const refundRes = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      body: JSON.stringify({ transaction: order.payment_reference }),
    });
    const refundData = await refundRes.json();
    if (!refundRes.ok || !refundData.status) {
      return res.status(400).json({ error: refundData.message || 'Paystack refund failed' });
    }

    // 3. Mark the order refunded
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ payment_status: 'refunded', status: 'cancelled' }),
    });

    // 4. Reverse the vendor's ledger entry for this order so they
    //    don't get paid for a refunded order (only if not already paid out)
    await fetch(`${SUPABASE_URL}/rest/v1/ledger_entries?order_id=eq.${orderId}&status=neq.paid`, {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'reversed' }),
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong issuing the refund' });
  }
}
