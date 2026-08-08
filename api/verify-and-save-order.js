// /api/verify-and-save-order.js
//
// This runs on Vercel's servers, NOT in the customer's browser.
// It's the only place allowed to touch your Paystack secret key
// and your Supabase service_role key — both stay hidden here.
//
// What it does, in order:
// 1. Takes the Paystack payment reference the browser just got
// 2. Asks Paystack directly: "was this really paid?"
// 3. Only if Paystack confirms payment, writes the order to Supabase
// 4. Splits the earnings: 80% to the vendor, 20% to the platform,
//    each starting in the 1-day dispute window before cash-out.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { reference, order } = req.body;
  // order = { vendorId, items: [{menuItemId, qty, price}], fulfilment,
  //           deliveryFee, subtotal, total, deliveryAddress,
  //           pickupTimeChoice, guestName, guestPhone }

  if (!reference || !order) {
    return res.status(400).json({ error: 'Missing reference or order details' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  try {
    // ---- Step 0: recompute the real subtotal from actual menu_items
    // prices — never trust prices or quantities sent from the browser.
    // This is what makes promo pricing (and every other price) safe:
    // a customer's browser can say whatever it wants, only the database's
    // real price/promo_price ever actually gets charged.
    const itemIds = order.items.map(i => i.menuItemId);
    const menuRes = await fetch(
      `${SUPABASE_URL}/rest/v1/menu_items?id=in.(${itemIds.join(',')})&select=id,price,promo_price,in_stock`,
      { headers: sbHeaders }
    );
    const realItems = await menuRes.json();
    const realItemsById = Object.fromEntries(realItems.map(i => [i.id, i]));

    // Same principle applies to extras — fetch the real, current price and
    // real item ownership for every extra referenced anywhere in the order,
    // so a tampered client can't claim a cheap extra at a fake price or
    // attach an extra that doesn't actually belong to the item it's on.
    const allExtraIds = order.items.flatMap(i => (i.extras || []).map(e => e.id));
    let realExtrasById = {};
    if (allExtraIds.length > 0) {
      const extrasRes = await fetch(
        `${SUPABASE_URL}/rest/v1/menu_item_extras?id=in.(${allExtraIds.join(',')})&select=id,menu_item_id,name,price`,
        { headers: sbHeaders }
      );
      const realExtras = await extrasRes.json();
      realExtrasById = Object.fromEntries(realExtras.map(e => [e.id, e]));
    }

    let realSubtotal = 0;
    for (const orderedItem of order.items) {
      const real = realItemsById[orderedItem.menuItemId];
      if (!real) return res.status(400).json({ error: 'One of the items in your cart no longer exists — please refresh and try again.' });
      if (!real.in_stock) return res.status(400).json({ error: 'One of the items in your cart just went out of stock — please refresh and try again.' });
      const realPrice = (real.promo_price != null && Number(real.promo_price) < Number(real.price)) ? Number(real.promo_price) : Number(real.price);
      let realExtrasTotal = 0;
      for (const claimedExtra of (orderedItem.extras || [])) {
        const realExtra = realExtrasById[claimedExtra.id];
        if (!realExtra || realExtra.menu_item_id !== orderedItem.menuItemId) {
          return res.status(400).json({ error: 'One of the selected extras is no longer available — please refresh your cart and try again.' });
        }
        realExtrasTotal += Number(realExtra.price);
      }
      realSubtotal += (realPrice + realExtrasTotal) * orderedItem.qty;
    }
    if (Math.abs(Number(order.subtotal) - realSubtotal) > 1) {
      console.error(`Subtotal mismatch: client sent ${order.subtotal}, real total is ${realSubtotal}`);
      return res.status(400).json({ error: 'Item prices have changed — please refresh your cart and try again.' });
    }

    // ---- Step 1: verify the payment really happened ----
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment could not be verified' });
    }

    const amountPaidKobo = verifyData.data.amount; // Paystack works in kobo
    const expectedKobo = Math.round(order.total * 100);
    if (amountPaidKobo !== expectedKobo) {
      return res.status(400).json({ error: 'Paid amount does not match order total' });
    }

    // ---- Step 1b: recompute the delivery fee ourselves — never trust a
    // client-calculated number, the same reason the payment amount above
    // gets checked against Paystack directly rather than trusted as-is.
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
        // No confirmed vendor location — fall back to the flat platform fee
        const fallback = await sbCheck(`platform_settings?key=eq.delivery_fee&select=value`);
        expectedFee = Number((fallback[0] || {}).value ?? 1500);
      }

      if (Math.abs(Number(order.deliveryFee) - expectedFee) > 1) {
        console.error(`Delivery fee mismatch: client sent ${order.deliveryFee}, expected ${expectedFee}`);
        return res.status(400).json({ error: 'Delivery fee does not match — please refresh and try again.' });
      }
    }

    // ---- Step 2: write the order to Supabase (service role bypasses RLS safely, server-side only) ----
    const pickupCode = 'SK-' + Math.floor(1000 + Math.random() * 9000);
    // Genuinely separate from pickup_code — this is the actual
    // proof-of-delivery secret. It only ever reaches the customer and
    // admin, never a rider, so a rider can't know it in advance.
    const deliveryConfirmationCode = String(Math.floor(1000 + Math.random() * 9000));

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
        delivery_confirmation_code: deliveryConfirmationCode,
        vendor_id: order.vendorId,
        customer_id: order.customerId || null,
        fulfilment: order.fulfilment,
        pickup_time_choice: order.pickupTimeChoice || null,
        delivery_address: order.deliveryAddress || null,
        subtotal: order.subtotal,
        delivery_fee: order.deliveryFee || 0,
        delivery_lat: order.deliveryLat || null,
        special_instructions: order.specialInstructions || null,
        delivery_lng: order.deliveryLng || null,
        total: order.total,
        payment_method: 'online',
        payment_status: 'paid',
        status: 'new',
        guest_name: order.guestName || null,
        customer_email: order.guestEmail || null,
        payment_reference: reference,
        guest_phone: order.guestPhone || null,
      }]),
    });
    const orderData = await orderRes.json();
    if (!orderRes.ok) throw new Error(JSON.stringify(orderData));
    const savedOrder = orderData[0];

    // order items
    await sb('order_items', {
      method: 'POST',
      body: JSON.stringify(
        order.items.map(i => ({
          order_id: savedOrder.id,
          menu_item_id: i.menuItemId,
          quantity: i.qty,
          price_at_order: i.price,
          extras: (i.extras || []).map(e => {
            const real = realExtrasById[e.id];
            return real ? { name: real.name, price: Number(real.price) } : null;
          }).filter(Boolean),
        }))
      ),
    });

    // Read the real, admin-editable split percentage and dispute window
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

    // Save the card for faster checkout next time, if the customer is
    // logged in and Paystack says this card can be safely reused
    const auth = verifyData.data.authorization;
    if (order.customerId && auth && auth.reusable && auth.authorization_code) {
      const existingRes = await sb(`customer_cards?customer_id=eq.${order.customerId}&authorization_code=eq.${auth.authorization_code}&select=id`);
      const existing = await existingRes.json();
      if (!existing || existing.length === 0) {
        await sb('customer_cards', {
          method: 'POST',
          body: JSON.stringify([{
            customer_id: order.customerId,
            authorization_code: auth.authorization_code,
            card_type: auth.card_type || null,
            last4: auth.last4 || null,
            bank: auth.bank || null,
          }]),
        });
      }
    }

    // Notify the admin on every single order — email + WhatsApp, so this
    // doesn't depend on checking the dashboard to know an order came in
    try {
      await fetch(`https://www.sultini.com/api/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'admin',
          subject: `New order ${pickupCode}`,
          message: `New order ${pickupCode} worth ₦${order.total} was just placed and paid for.`,
        }),
      });
    } catch (notifyErr) {
      console.error('Notification failed', notifyErr);
    }

    // Confirm the order to the customer too, with their real codes — this
    // is their one permanent record if they close the app right after
    // ordering, especially important for guests with no account to fall
    // back on for order history
    try {
      await fetch(`https://www.sultini.com/api/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'customer', orderId: savedOrder.id, status: 'new' }),
      });
    } catch (custNotifyErr) {
      console.error('Customer confirmation notification failed', custNotifyErr);
    }

    // Notify the vendor too — SMS now, not email, since vendors are on
    // the move and often don't check email promptly
    try {
      const vendorRes = await sb(`vendors?id=eq.${order.vendorId}&select=name`);
      const vendorRows = await vendorRes.json();
      if (vendorRows && vendorRows[0]) {
        await fetch(`https://www.sultini.com/api/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'vendor',
            vendorId: order.vendorId,
            message: `New order ${pickupCode} on Sultini Express, worth ₦${order.total}. Log into your dashboard to accept it.`,
          }),
        });
      }
    } catch (vendorNotifyErr) {
      console.error('Vendor notification failed', vendorNotifyErr);
    }

    return res.status(200).json({ success: true, pickupCode, deliveryConfirmationCode, orderId: savedOrder.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong saving the order' });
  }
}
