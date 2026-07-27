// /api/create-rider-account.js
//
// Creates a real login account for a rider, entirely server-side.
// This matters because doing it directly in the browser would log
// the ADMIN out and log them in as the new rider by accident —
// Supabase's client-side signup always switches to the new session.
// Running it here, with the service_role key, avoids that entirely.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password, full_name, phone, vehicle, bank_name, account_number, added_by } = req.body;
  if (!email || !password || !full_name || !phone) {
    return res.status(400).json({ error: 'Missing required rider details' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const adminHeaders = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };

  try {
    // 1. Create the actual login account
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name } }),
    });
    const createData = await createRes.json();
    if (!createRes.ok) {
      return res.status(400).json({ error: createData.msg || createData.error_description || 'Could not create rider account' });
    }
    const userId = createData.id;

    // 2. The signup trigger already made a 'customer' profile — fix the role to 'rider'
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ role: 'rider' }),
    });

    // 3. Create the rider record itself, linked to this new account
    const riderRes = await fetch(`${SUPABASE_URL}/rest/v1/riders`, {
      method: 'POST',
      headers: { ...adminHeaders, Prefer: 'return=representation' },
      body: JSON.stringify([{
        full_name, phone, vehicle: vehicle || null,
        bank_name: bank_name || null, account_number: account_number || null,
        user_id: userId, added_by: added_by || null,
      }]),
    });
    const riderData = await riderRes.json();
    if (!riderRes.ok) throw new Error(JSON.stringify(riderData));

    return res.status(200).json({ success: true, rider: riderData[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong creating the rider account' });
  }
}
