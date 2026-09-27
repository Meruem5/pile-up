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
2. **Migrations.** In the same editor, run each file in `supabase/migrations/` in order (currently just `002_people_and_ownership.sql`). They're safe to run again. Run a new migration *before* merging the app change that needs it.
3. **Household.** In the same editor, run your private seed script. It creates the household, adds both member emails, and loads the starter numbers. It is not in this repo; keep it that way.
4. **Auth URLs.** Authentication → URL Configuration:
   - **Site URL:** your custom domain, e.g. `https://runway.example.com`
   - **Redirect URLs:** add the same URL, plus `https://meruem5.github.io/pile-up/` if you'll also use that address.
5. **GitHub Pages.** Repo → Settings → Pages → *Deploy from a branch* → `main` / `(root)`. Under *Custom domain*, enter your domain (this commits a `CNAME` file). Then tick *Enforce HTTPS*.
6. **DNS**, at your registrar:
   - **Subdomain** (e.g. `runway.example.com`): a `CNAME` record pointing to `meruem5.github.io`.
   - **Apex domain** (`example.com`): `A` records pointing to `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`.
7. **Email templates.** Authentication → Emails: paste `supabase/email-template.html` into both *Magic Link* and *Confirm signup* (a first-ever sign-in uses Confirm signup). Set the subject to "Your Runway sign-in link". Keep the `{{ .TokenHash }}` link as it is.
8. **After both of you have signed in once** (optional hardening): Authentication → Sign In / Providers → turn off *Allow new users to sign up*. Strangers then can't even create empty accounts.

## Notes

- **Sign-in links work on any device, once, for about an hour.** The email links to `https://planarian.dev/?token_hash=…`, and `app.js` verifies the token on arrival, then removes it from the address bar. If you use Supabase's default email templates instead, links only work in the browser that requested them.
- **Supabase's built-in email sender is heavily rate-limited.** If links stop arriving, wait, or configure custom SMTP under Authentication → Emails.
- **Money model.** Everything is in US dollars. Each person sets their own monthly savings capacity; only they can change it. Every goal is **Shared** or belongs to one person, and is **Active**, **Paused** or **Done** (paused and done goals ask for $0/mo). Shared goals split by the household rule (50/50 or by savings capacity) unless a goal sets its own, including a custom percentage. "Who pays what" shows each person's share, their own goals, and what's left over, with the other split rule's figure in brackets for comparison.
- **Edits save per field and appear live for the other person.** An incoming change waits while you're typing in a field, so it can't overwrite your input. Unsaved changes are kept on the page and retried, and closing the tab asks first.
- **Overdue goals** (target date in the past) are flagged. Their full remaining amount counts as due now, and they're left off the balance projection, since today's balance already reflects them.
- **Adding colors:** don't reorder `COLOR_ORDER` in `app.js` without re-running the CVD palette validator. The order is what keeps adjacent colors distinguishable. The allowed list is also enforced in `schema.sql`.
