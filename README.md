# Sultini Express — Complete Website Code

This is the FULL, current, correct set of files for your site — all
in one place so nothing is missing or out of sync.

## What's in here
- `index.html` — the marketing homepage
- `order.html` — the ordering app (browse, cart, checkout, payment, login)
- `vendor.html` — vendor registration and dashboard
- `admin.html` — admin dashboard
- `supabase-config.js` — connects every page to your Supabase database
- `api/verify-and-save-order.js` — the secure server-side function that
  verifies Paystack payments and saves orders
- `README.md` — this file

## How to update GitHub with this (clean slate approach)

To make sure everything matches exactly, the safest move is to remove
what's there now and upload this complete set fresh, rather than
editing files one at a time.

1. Go to your `sultini-express` repository on GitHub
2. For each file currently in the repo (`index.html`, `order.html`,
   `admin.html`, `vendor.html`, `supabase-config.js`,
   `api/verify-and-save-order.js`, `README.md`):
   - Click the file
   - Click the **...** menu (or trash icon) -> **Delete file** -> **Commit changes**
3. Once the repo is empty, click **Add file -> Upload files**
4. Drag in every file from this folder **at once**, including the
   `api` folder with `verify-and-save-order.js` inside it (GitHub
   preserves folder structure when you drag a folder in, or you can
   type `api/verify-and-save-order.js` as the filename if uploading
   it individually)
5. Scroll down, click **Commit changes**

Vercel will detect the changes and redeploy automatically -- usually
within a minute or two.

## Important -- your secret keys are NOT in these files

`supabase-config.js` only contains your public/anon key, which is
safe to be public. Your Paystack secret key and Supabase
service_role key live only in Vercel's Environment Variables -- they
were not touched by this update, so you don't need to re-enter them.

## If something still doesn't work after this

Open the page that's broken, press F12 (or right-click -> Inspect),
click the "Console" tab, and try the broken action again. Any red
error text that appears there is the actual cause -- screenshot it
and send it over.
