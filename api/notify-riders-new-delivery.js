// /api/notify-riders-new-delivery.js
//
// Emails every active rider when an order becomes ready for delivery
// and has no rider assigned yet — so riders know to check the app
// and claim it, instead of it silently sitting unassigned.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pickupCode } = req.body;
  if (!pickupCode) {
    return res.status(400).json({ error: 'Missing pickupCode' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const ridersRes = await fetch(`${SUPABASE_URL}/rest/v1/riders?active=eq.true&select=email`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const riders = await ridersRes.json();
    const emails = (riders || []).map(r => r.email).filter(Boolean);

    if (emails.length === 0) {
      return res.status(200).json({ skipped: true, reason: 'No active riders with an email on file' });
    }

    // Send individually so riders never see each other's email addresses
    await Promise.all(emails.map(email =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: 'Sultini Express <notifications@sultini.com>',
          to: [email],
          subject: 'New delivery available',
          text: `A new delivery (order ${pickupCode}) is ready and needs a rider. Log into your Sultini rider dashboard to accept it.`,
        }),
      }).catch(e => console.error('Failed to notify', email, e))
    ));

    return res.status(200).json({ success: true, notified: emails.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not notify riders' });
  }
}
