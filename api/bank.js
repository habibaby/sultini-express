// /api/bank.js
//
// Combines what used to be three separate endpoints — list-banks,
// verify-bank-account, create-transfer-recipient — into one, purely to
// stay under Vercel's 12-serverless-function limit on the free Hobby
// plan. Deploys were failing once the project crossed that count.
//
// Usage:
//   GET  /api/bank?action=list                                    → list of banks
//   POST /api/bank  { action: 'verify', accountNumber, bankCode }  → resolve account name
//   POST /api/bank  { action: 'create-recipient', recipientType, id, accountNumber, bankCode } → verify + save + create Paystack recipient

export default async function handler(req, res) {
  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  // ---------- GET /api/bank?action=list ----------
  if (req.method === 'GET') {
    if (req.query.action !== 'list') {
      return res.status(400).json({ error: 'Unknown action for GET /api/bank' });
    }
    try {
      const banksRes = await fetch('https://api.paystack.co/bank?country=nigeria&currency=NGN', {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      });
      const banksData = await banksRes.json();
      if (!banksRes.ok || !banksData.status) {
        console.error('Paystack /bank error:', banksRes.status, banksData);
        return res.status(400).json({ error: `Paystack said: "${banksData.message || 'unknown error'}" (HTTP ${banksRes.status})` });
      }
      const banks = banksData.data.map(b => ({ name: b.name, code: b.code })).sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json({ success: true, banks });
    } catch (err) {
      console.error('bank list request failed:', err);
      return res.status(500).json({ error: `Request to Paystack failed: ${err.message}` });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ error: 'Server is missing PAYSTACK_SECRET_KEY — check Vercel Environment Variables for Production.' });
  }

  const { action } = req.body || {};

  // ---------- POST /api/bank { action: 'verify' } ----------
  if (action === 'verify') {
    const { accountNumber, bankCode } = req.body;
    if (!accountNumber || !bankCode) return res.status(400).json({ error: 'Missing account number or bank' });
    try {
      const resolveRes = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
      );
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok || !resolveData.status) {
        return res.status(400).json({ error: resolveData.message || 'Could not verify this account. Double check the account number and bank.' });
      }
      return res.status(200).json({ success: true, accountName: resolveData.data.account_name, accountNumber: resolveData.data.account_number });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong verifying the account' });
    }
  }

  // ---------- POST /api/bank { action: 'create-recipient' } ----------
  if (action === 'create-recipient') {
    const { recipientType, id, accountNumber, bankCode } = req.body;
    if (!recipientType || !id || !accountNumber || !bankCode) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['vendor', 'rider'].includes(recipientType)) {
      return res.status(400).json({ error: 'recipientType must be vendor or rider' });
    }
    try {
      const resolveRes = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
      );
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok || !resolveData.status) {
        return res.status(400).json({ error: 'Could not verify this account before saving it' });
      }
      const verifiedName = resolveData.data.account_name;

      const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        body: JSON.stringify({ type: 'nuban', name: verifiedName, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' }),
      });
      const recipientData = await recipientRes.json();
      if (!recipientRes.ok || !recipientData.status) {
        return res.status(400).json({ error: recipientData.message || 'Could not create transfer recipient' });
      }
      const recipientCode = recipientData.data.recipient_code;

      const table = recipientType === 'vendor' ? 'vendors' : 'riders';
      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          bank_code: bankCode, account_number: accountNumber, account_name: verifiedName,
          paystack_recipient_code: recipientCode, account_verified: true,
        }),
      });
      if (!updateRes.ok) throw new Error(JSON.stringify(await updateRes.json()));

      return res.status(200).json({ success: true, accountName: verifiedName, recipientCode });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong saving payout details' });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
