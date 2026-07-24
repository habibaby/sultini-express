# Sultini Express — Website Code

This folder is the real, working customer-ordering site. It's connected
live to your Supabase database — no more mock/fake data.

## What's in here
- `index.html` — the whole customer app (browse, cart, checkout)
- `supabase-config.js` — connects the site to your Supabase database

## Putting this on GitHub (no coding needed)

1. Go to **github.com** and log in (create a free account if you don't
   have one).
2. Click the **+** in the top-right corner → **New repository**.
3. Name it `sultini-express` and click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. Drag every file from this folder into the upload box.
6. Scroll down and click **Commit changes**.

That's it — your code is now on GitHub.

## Making it live with Vercel (no coding needed)

1. Go to **vercel.com** and sign up using your GitHub account (this
   lets Vercel see your repositories).
2. Click **Add New → Project**.
3. Find `sultini-express` in the list and click **Import**.
4. Vercel will detect it's a static site — you don't need to change
   any settings. Click **Deploy**.
5. In a minute or two, Vercel gives you a live link
   (like `sultini-express.vercel.app`) where the site is running for
   real, for anyone to visit.
6. Later, when you're ready to use `sultini.com`, Vercel has a
   **Domains** tab in your project settings where you can connect it.

## Important — before you show this to real customers

This version lets people click through the whole ordering flow, but
placing an order doesn't yet save it to the database or take a real
Paystack payment. That's the next piece we build together. Don't
launch this to real customers until that's connected — right now
an "order" just shows a confirmation screen without actually
charging anyone or notifying a vendor.
