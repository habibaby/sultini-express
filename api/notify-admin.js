// /api/notify-admin.js
//
// Sends a real email to the admin whenever something needs
// attention: a new vendor application, a cash-out request, etc.
// Runs server-side so the email-sending key stays hidden.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { subject, message } = req.body;
  if (!subject || !message) {
    return res.status(400).json({ error: 'Missing subject or message' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const ADMIN_EMAIL = 'sultiniexpress@yahoo.com';

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Sultini Express <onboarding@resend.dev>',
        to: [ADMIN_EMAIL],
        subject: `Sultini Express: ${subject}`,
        text: message,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend error:', errText);
      return res.status(500).json({ error: 'Email failed to send' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong sending the notification' });
  }
}
