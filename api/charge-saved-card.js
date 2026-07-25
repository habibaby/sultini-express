// /api/charge-saved-card.js
//
// Charges a customer's previously-saved card using Paystack's
// "charge authorization" feature — no popup needed. Runs server-side
// so the Paystack secret key and Supabase service_role key stay hidden.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { authorizationCode, email, order } = req.body;
  if (!authorizationCode || !email || !order) {
    return res.status(400).json({ error: 'Missing authorization code, email, or order details' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // ---- Step 1: actually charge the saved card ----
    const chargeRes = await fetch('https://api.paystack.co/transaction/charge_authorization', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      },
      body: JSON.stringify({
        authorization_code: authorizationCode,
        email,
        amount: Math.round(order.total * 100),
        currency: 'NGN',
      }),
    });
    const chargeData = await chargeRes.json();

    if (!chargeData.status || chargeData.data.status !== 'success') {
      return res.status(400).json({ error: chargeData.data?.gateway_response || 'Card charge failed' });
    }

    // ---- Step 2: write the order to Supabase, same as a normal payment ----
    const pickupCode = 'SK-' + Math.floor(1000 + Math.random() * 9000);

    const sb = (path, opts = {}) =>
      fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=representation',
          ...(opts.headers || {}),
        },
      });

    const orderRes = await sb('orders', {
      method: 'POST',
      body: JSON.stringify([{
        pickup_code: pickupCode,
        vendor_id: order.vendorId,
        customer_id: order.customerId || null,
        fulfilment: order.fulfilment,
        pickup_time_choice: order.pickupTimeChoice || null,
        delivery_address: order.deliveryAddress || null,
        subtotal: order.subtotal,
        delivery_fee: order.deliveryFee || 0,
        total: order.total,
        payment_method: 'online',
        payment_status: 'paid',
        status: 'new',
        guest_name: order.guestName || null,
        guest_phone: order.guestPhone || null,
      }]),
    });
    const orderData = await orderRes.json();
    if (!orderRes.ok) throw new Error(JSON.stringify(orderData));
    const savedOrder = orderData[0];

    await sb('order_items', {
      method: 'POST',
      body: JSON.stringify(
        order.items.map(i => ({
          order_id: savedOrder.id,
          menu_item_id: i.menuItemId,
          quantity: i.qty,
          price_at_order: i.price,
        }))
      ),
    });

    const settingsRes = await sb('platform_settings?select=key,value');
    const settingsRows = await settingsRes.json();
    const settingsMap = {};
    (settingsRows || []).forEach(s => { settingsMap[s.key] = s.value; });
    const vendorPct = Number(settingsMap.vendor_share_pct || 80) / 100;
    const disputeHours = Number(settingsMap.dispute_window_hours || 24);

    const availableAt = new Date(Date.now() + disputeHours * 60 * 60 * 1000).toISOString();
    const vendorShare = +(order.subtotal * vendorPct).toFixed(2);
    await sb('ledger_entries', {
      method: 'POST',
      body: JSON.stringify([{
        order_id: savedOrder.id,
        recipient_type: 'vendor',
        vendor_id: order.vendorId,
        amount: vendorShare,
        status: 'in_dispute_window',
        available_at: availableAt,
      }]),
    });

    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: 'Sultini Express <onboarding@resend.dev>',
          to: ['sultiniexpress@yahoo.com'],
          subject: `Sultini Express: New order ${pickupCode}`,
          text: `A new order (${pickupCode}) worth ₦${order.total} was just placed (paid with a saved card).`,
        }),
      });
    } catch (notifyErr) {
      console.error('Notification failed', notifyErr);
    }

    return res.status(200).json({ success: true, pickupCode, orderId: savedOrder.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong charging the card or saving the order' });
  }
}
