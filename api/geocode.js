// /api/geocode.js
//
// Two jobs, combined into one file to stay under Vercel's function limit:
//   1. Turn a typed address into map coordinates (Google Geocoding API)
//   2. Calculate the real delivery fee from actual distance, server-side —
//      never trust a client-calculated fee, same reason payment amounts
//      are always recomputed server-side too.
//
// Straight-line distance (haversine), not Google's Distance Matrix — this
// is intentionally the cheaper, simpler choice. For a city Sokoto's size,
// straight-line distance is accurate enough to fix flat-fee overcharging,
// without the ongoing per-request cost of full route calculation.
//
// Usage:
//   POST { action: 'geocode', address }                          → { lat, lng }
//   POST { action: 'calculate-fee', vendorId, lat, lng }          → { fee, distanceKm }

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_MAPS_API_KEY — check Vercel Environment Variables for Production.' });
  }

  const { action } = req.body || {};
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  // ---------- Turn an address into coordinates ----------
  if (action === 'geocode') {
    const { address, city } = req.body;
    if (!address || !address.trim()) return res.status(400).json({ error: 'Missing address' });
    try {
      // Biased toward the relevant city so short/ambiguous addresses
      // resolve correctly — this used to be hardcoded to Sokoto, which
      // would have quietly mis-resolved every Kaduna address.
      const cityLabel = city ? city.charAt(0).toUpperCase() + city.slice(1) : 'Sokoto';
      const query = `${address}, ${cityLabel}, Nigeria`;
      const geoRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}`
      );
      const geoData = await geoRes.json();
      if (geoData.status !== 'OK' || !geoData.results.length) {
        return res.status(400).json({ error: `Could not locate that address (${geoData.status}). Try adding more detail — a nearby landmark helps.` });
      }
      const { lat, lng } = geoData.results[0].geometry.location;
      const formattedAddress = geoData.results[0].formatted_address;
      return res.status(200).json({ success: true, lat, lng, formattedAddress });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong looking up that address' });
    }
  }

  // ---------- Calculate the real delivery fee from actual distance ----------
  if (action === 'calculate-fee') {
    const { vendorId, lat, lng } = req.body;
    if (!vendorId || lat == null || lng == null) return res.status(400).json({ error: 'Missing vendorId or coordinates' });

    try {
      const vendorRes = await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${vendorId}&select=lat,lng,name`, { headers: sbHeaders });
      const vendors = await vendorRes.json();
      const vendor = vendors && vendors[0];
      if (!vendor || vendor.lat == null || vendor.lng == null) {
        return res.status(400).json({ error: 'This store hasn\'t confirmed its location yet — using the standard delivery fee instead.', fallback: true });
      }

      const settingsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/platform_settings?key=in.(delivery_base_fee,delivery_per_km_rate,delivery_min_fee,delivery_max_fee)&select=key,value`,
        { headers: sbHeaders }
      );
      const settings = await settingsRes.json();
      const get = (key, fallback) => Number((settings.find(s => s.key === key) || {}).value ?? fallback);
      const baseFee = get('delivery_base_fee', 800);
      const perKmRate = get('delivery_per_km_rate', 120);
      const minFee = get('delivery_min_fee', 1000);
      const maxFee = get('delivery_max_fee', 3500);

      const distanceKm = haversineKm(vendor.lat, vendor.lng, lat, lng);
      let fee = Math.round(baseFee + distanceKm * perKmRate);
      fee = Math.max(minFee, Math.min(maxFee, fee));

      return res.status(200).json({ success: true, fee, distanceKm: Math.round(distanceKm * 10) / 10 });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong calculating the delivery fee' });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
