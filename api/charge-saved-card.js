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

    // ---- Step 1b: recompute the delivery fee ourselves — same check as
    // the regular checkout path, so this payment method can't be used to
    // bypass real distance-based pricing.
    if (order.fulfilment === 'delivery') {
      const sbCheck = (path) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      }).then(r => r.json());

      const vendors = await sbCheck(`vendors?id=eq.${order.vendorId}&select=lat,lng`);
      const vendor = vendors && vendors[0];
      let expectedFee;

      if (vendor && vendor.lat != null && vendor.lng != null && order.deliveryLat != null && order.deliveryLng != null) {
        const settings = await sbCheck(`platform_settings?key=in.(delivery_base_fee,delivery_per_km_rate,delivery_min_fee,delivery_max_fee)&select=key,value`);
        const get = (key, fallback) => Number((settings.find(s => s.key === key) || {}).value ?? fallback);
        const R = 6371;
        const dLat = (order.deliveryLat - vendor.lat) * Math.PI / 180;
        const dLng = (order.deliveryLng - vendor.lng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(vendor.lat * Math.PI / 180) * Math.cos(order.deliveryLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        expectedFee = Math.round(get('delivery_base_fee', 800) + distanceKm * get('delivery_per_km_rate', 120));
        expectedFee = Math.max(get('delivery_min_fee', 1000), Math.min(get('delivery_max_fee', 3500), expectedFee));
      } else {
        const fallback = await sbCheck(`platform_settings?key=eq.delivery_fee&select=value`);
        expectedFee = Number((fallback[0] || {}).value ?? 1500);
      }

      if (Math.abs(Number(order.deliveryFee) - expectedFee) > 1) {
        console.error(`Delivery fee mismatch (saved card): client sent ${order.deliveryFee}, expected ${expectedFee}`);
        return res.status(400).json({ error: 'Delivery fee does not match — please refresh and try again.' });
      }
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
        delivery_lat: order.deliveryLat || null,
        delivery_lng: order.deliveryLng || null,
        total: order.total,
        payment_method: 'online',
        payment_status: 'paid',
        status: 'new',
        guest_name: order.guestName || null,
        customer_email: order.guestEmail || null,
        payment_reference: chargeData.data.reference,
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
          from: 'Sultini Express <notifications@sultini.com>',
          to: ['sultiniexpress@yahoo.com'],
          subject: `Sultini Express: New order ${pickupCode}`,
          text: `A new order (${pickupCode}) worth ₦${order.total} was just placed (paid with a saved card).`,
        }),
      });
    } catch (notifyErr) {
      console.error('Notification failed', notifyErr);
    }

    try {
      const vendorRes = await sb(`vendors?id=eq.${order.vendorId}&select=email,name`);
      const vendorRows = await vendorRes.json();
      const vendorEmail = vendorRows && vendorRows[0] && vendorRows[0].email;
      if (vendorEmail) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          body: JSON.stringify({
            from: 'Sultini Express <notifications@sultini.com>',
            to: [vendorEmail],
            subject: `New order: ${pickupCode}`,
            text: `You have a new order (${pickupCode}) worth ₦${order.total}. Log into your vendor dashboard to accept it.`,
          }),
        });
      }
    } catch (vendorNotifyErr) {
      console.error('Vendor notification failed', vendorNotifyErr);
    }

    return res.status(200).json({ success: true, pickupCode, orderId: savedOrder.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong charging the card or saving the order' });
  }
}
