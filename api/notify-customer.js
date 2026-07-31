// /api/notify-customer.js
//
// Emails the customer whenever their order's status changes —
// accepted, ready, out for delivery, delivered, etc. Called from
// wherever an order status gets updated (vendor, admin, or rider).

const STATUS_MESSAGES = {
  rejected: {
    subject: "Your order couldn't be accepted",
    text: (code) => `Unfortunately the store wasn't able to accept your order ${code}. If you paid online, please contact Sultini Express support about a refund.`,
  },
  preparing: {
    subject: 'Your order is being prepared',
    text: (code) => `Good news — your order ${code} has been accepted and is now being prepared.`,
  },
  ready: {
    subject: 'Your order is ready',
    text: (code) => `Your order ${code} is ready! If you chose pickup, you can collect it now with your pickup code.`,
  },
  out_for_delivery: {
    subject: 'A rider is on the way to pick up your order',
    text: (code) => `A Sultini rider has been assigned to your order ${code} and is heading to the store now.`,
  },
  picked_up: {
    subject: 'Your order is on its way to you',
    text: (code) => `Your rider has picked up order ${code} and is on the way to you now.`,
  },
  delivered: {
    subject: 'Your order has been delivered',
    text: (code) => `Order ${code} has been marked as delivered. Enjoy! If anything was wrong, you can report a problem from your account page.`,
  },
  completed: {
    subject: 'Thanks for picking up your order!',
    text: (code) => `Order ${code} has been confirmed picked up. Enjoy! If anything was wrong, you can report a problem from your account page.`,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { orderId, status } = req.body;
  if (!orderId || !status) {
    return res.status(400).json({ error: 'Missing orderId or status' });
  }

  const template = STATUS_MESSAGES[status];
  if (!template) {
    // Not every status needs a customer email (e.g. 'new') — that's fine, not an error
    return res.status(200).json({ skipped: true });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=pickup_code,customer_email`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const orders = await orderRes.json();
    const order = orders && orders[0];
    if (!order || !order.customer_email) {
      return res.status(200).json({ skipped: true, reason: 'No customer email on file' });
    }

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Sultini Express <notifications@sultini.com>',
        to: [order.customer_email],
        subject: `Sultini Express: ${template.subject}`,
        text: template.text(order.pickup_code),
      }),
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not send customer notification' });
  }
}
