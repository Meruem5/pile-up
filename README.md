# Runway

A shared financial-timeline and funding-plan calculator for two people. It's a static page (`index.html` + `app.js`) served by GitHub Pages, with data in Supabase.

## How access works

The Supabase publishable key in `app.js` is public by design. **Row-level security is the only thing protecting the data**, so all of it lives in `supabase/schema.sql`:

- You sign in with an email magic link.
- Every table has RLS on, and every policy checks the signed-in user's verified email against `household_members`.
- Anyone can request a link and get a Supabase account. Without a `household_members` row, that account can read and write nothing.
- Households and members can only be created from the Supabase SQL editor. The app can't create them.

Nothing personal belongs in this repo, because it's public: no member emails and no goal data. Those go straight into the database.

## Setup

1. **Schema.** Supabase → SQL Editor → paste `supabase/schema.sql` → Run. You can safely run it again.
2. **Household.** In the same editor, run your private seed script. It creates the household, adds both member emails, and loads the starter numbers. It is not in this repo; keep it that way.
3. **Auth URLs.** Authentication → URL Configuration:
   - **Site URL:** your custom domain, e.g. `https://runway.example.com`
   - **Redirect URLs:** add the same URL, plus `https://meruem5.github.io/pile-up/` if you'll also use that address.
4. **GitHub Pages.** Repo → Settings → Pages → *Deploy from a branch* → `main` / `(root)`. Under *Custom domain*, enter your domain (this commits a `CNAME` file). Then tick *Enforce HTTPS*.
5. **DNS**, at your registrar:
   - **Subdomain** (e.g. `runway.example.com`): a `CNAME` record pointing to `meruem5.github.io`.
   - **Apex domain** (`example.com`): `A` records pointing to `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`.
6. **After both of you have signed in once** (optional hardening): Authentication → Sign In / Providers → turn off *Allow new users to sign up*. Strangers then can't even create empty accounts.

## Notes

- **Open the sign-in link in the same browser you requested it from.** Magic links use PKCE, which binds the link to that browser; a link opened on another device won't sign you in there.
- **Supabase's built-in email sender is heavily rate-limited.** If links stop arriving, wait, or configure custom SMTP under Authentication → Emails.
- **Edits save per field and appear live for the other person.** An incoming change waits while you're typing in a field, so it can't overwrite your input. Unsaved changes are kept on the page and retried, and closing the tab asks first.
- **Overdue goals** (target date in the past) are flagged. Their full remaining amount counts as due now, and they're left off the balance projection, since today's balance already reflects them.
- **Adding colors:** don't reorder `COLOR_ORDER` in `app.js` without re-running the CVD palette validator. The order is what keeps adjacent colors distinguishable. The allowed list is also enforced in `schema.sql`.
