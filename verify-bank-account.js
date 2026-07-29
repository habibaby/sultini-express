// /api/verify-bank-account.js
//
// Before we ever save a vendor or rider's bank details, we ask Paystack
// to resolve the account number against the bank and tell us the real
// account name on file. The vendor/rider then has to confirm that name
// matches who they are — this is what stops a mistyped account number
// or digit-swap from silently sending someone else's money out.
//
// This does NOT move any money. It only looks up whose account it is.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accountNumber, bankCode } = req.body;
  if (!accountNumber || !bankCode) {
    return res.status(400).json({ error: 'Missing account number or bank' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

  try {
    const resolveRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const resolveData = await resolveRes.json();

    if (!resolveRes.ok || !resolveData.status) {
      return res.status(400).json({
        error: resolveData.message || 'Could not verify this account. Double check the account number and bank.',
      });
    }

    return res.status(200).json({
      success: true,
      accountName: resolveData.data.account_name,
      accountNumber: resolveData.data.account_number,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong verifying the account' });
  }
}
