// /api/list-banks.js
//
// Returns Paystack's current list of Nigerian banks (name + code), so
// vendor and rider onboarding can use a proper dropdown instead of a
// free-text "type your bank name" field. Free text is how "Access Bank"
// vs "access bank plc" vs a typo becomes impossible to match to a real
// bank_code later — this removes that whole class of mistake.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

  // Fail loudly and specifically if the key is just missing — this is the
  // single most common cause of "could not load banks" and previously gave
  // no clue that this was the problem.
  if (!PAYSTACK_SECRET_KEY) {
    console.error('PAYSTACK_SECRET_KEY is not set in this environment');
    return res.status(500).json({ error: 'Server is missing PAYSTACK_SECRET_KEY — check Vercel Environment Variables for Production.' });
  }

  try {
    const banksRes = await fetch('https://api.paystack.co/bank?country=nigeria&currency=NGN', {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    const banksData = await banksRes.json();

    if (!banksRes.ok || !banksData.status) {
      // Pass Paystack's own message through instead of a generic one —
      // this is what actually tells us "Invalid key", "Unauthorized", etc.
      console.error('Paystack /bank error:', banksRes.status, banksData);
      return res.status(400).json({
        error: `Paystack said: "${banksData.message || 'unknown error'}" (HTTP ${banksRes.status})`,
      });
    }

    const banks = banksData.data
      .map(b => ({ name: b.name, code: b.code }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({ success: true, banks });
  } catch (err) {
    console.error('list-banks request failed:', err);
    return res.status(500).json({ error: `Request to Paystack failed: ${err.message}` });
  }
}
