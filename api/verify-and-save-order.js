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

  try {
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

    // ---- Step 2: write the order to Supabase (service role bypasses RLS safely, server-side only) ----
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

    // order items
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

    // ledger: vendor gets 80% of the item subtotal, held for 1 day
    const availableAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const vendorShare = +(order.subtotal * 0.8).toFixed(2);
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

    return res.status(200).json({ success: true, pickupCode, orderId: savedOrder.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong saving the order' });
  }
}
