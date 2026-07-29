// /api/create-transfer-recipient.js
//
// Creates the Paystack "transfer recipient" that payouts actually get
// sent to. We re-resolve the account server-side (never trust a name
// the browser sends us — always re-check against Paystack directly)
// before creating the recipient, then save the recipient_code onto
// the vendor or rider row. Every future payout to them reuses this
// recipient_code — we never send raw account numbers at transfer time.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { recipientType, id, accountNumber, bankCode } = req.body;
  if (!recipientType || !id || !accountNumber || !bankCode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!['vendor', 'rider'].includes(recipientType)) {
    return res.status(400).json({ error: 'recipientType must be vendor or rider' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    // 1. Re-resolve the account server-side — never trust a client-supplied name
    const resolveRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const resolveData = await resolveRes.json();
    if (!resolveRes.ok || !resolveData.status) {
      return res.status(400).json({ error: 'Could not verify this account before saving it' });
    }
    const verifiedName = resolveData.data.account_name;

    // 2. Create the transfer recipient on Paystack
    const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      body: JSON.stringify({
        type: 'nuban',
        name: verifiedName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN',
      }),
    });
    const recipientData = await recipientRes.json();
    if (!recipientRes.ok || !recipientData.status) {
      return res.status(400).json({ error: recipientData.message || 'Could not create transfer recipient' });
    }
    const recipientCode = recipientData.data.recipient_code;

    // 3. Save onto the vendor or rider row
    const table = recipientType === 'vendor' ? 'vendors' : 'riders';
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        bank_code: bankCode,
        account_number: accountNumber,
        account_name: verifiedName,
        paystack_recipient_code: recipientCode,
        account_verified: true,
      }),
    });
    if (!updateRes.ok) {
      const err = await updateRes.json();
      throw new Error(JSON.stringify(err));
    }

    return res.status(200).json({ success: true, accountName: verifiedName, recipientCode });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong saving payout details' });
  }
}
