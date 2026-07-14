# CMRO Duty Register — Setup Guide

A shared attendance register. Each staff member installs it on their own phone,
clocks in every morning, and all clock-ins land in one register that the admin
and supervisor can view, download, and print. It finalises automatically at
10:30 on working days.

This one-time setup is done by the **admin** and takes about 15 minutes.
Staff do **nothing** except open a link and tap **Install** once.

---

## What's in this folder

| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | the app itself |
| `config.js` | the only file you edit (2 lines) |
| `schema.sql` | run once to create the database |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | make it installable on phones |

---

## Step 1 — Create the free database (Supabase)

1. Go to **https://supabase.com** and sign up (free, no card needed).
2. Click **New project**. Give it a name (e.g. *CMRO Register*) and a database
   password. Pick the region closest to your office. Wait ~2 minutes.

## Step 2 — Create the tables

1. In your project, open **SQL Editor** → **New query**.
2. Open `schema.sql` from this folder, copy everything, paste it in, and click **Run**.
   This creates the tables and loads your 20-person roster (all with PIN **1234**).

## Step 3 — Connect the app

1. In Supabase open **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `config.js` and paste them in:

   ```js
   window.CMRO_CONFIG = {
     SUPABASE_URL: "https://xxxxxxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi....(long key)...."
   };
   ```

## Step 4 — Put it online (free)

The app must be served over HTTPS so phones can install it. Easiest free option:

**GitHub Pages**
1. Create a free account at **https://github.com** → **New repository** (Public).
2. Upload every file from this folder (drag-and-drop works).
3. Repo **Settings → Pages** → *Source: Deploy from branch* → **main / (root)** → Save.
4. After a minute you get a link like `https://yourname.github.io/cmro-register/`.

(Any static host works too — Netlify, Cloudflare Pages, an office web server.)

## Step 5 — Install on each phone

1. Open the link in **Chrome** on the phone.
2. Menu (⋮) → **Install app** (or **Add to Home screen**).
3. It now opens full-screen like a normal app.

## Step 6 — First login

- Admin: username **ashrafunnisa**, PIN **1234**
- Supervisor: username **jeevan**, PIN **1234**
- Staff example: username **naga**, PIN **1234**

Go to **People** to add/disable staff, and tell everyone to keep their PIN private.
Change the seeded PINs by re-adding users or updating them in Supabase → Table editor.

---

## How it works day to day

- **Staff** open the app each morning and tap **Clock in**. After **10:00** they're
  flagged *Late*; after **10:30** the register closes and anyone not marked is *Absent*.
- **Supervisor / Admin** open **Register** to see the live list, mark **Leave**,
  **Download** the report (CSV, same columns as your paper report), or **Print** it.
- **Admin** also has **People** (add / disable users) and **Settings**
  (section name, late time, report time, working days).

## Security — please read

This is a lightweight, internal-office setup. The app runs in the browser using
Supabase's public *anon* key, and PINs are checked inside the app. That means
anyone who has both the link and the key could, in principle, read or write data.
For a trusted internal register that's usually fine. To harden it later you can:
move login to Supabase Auth, add per-role Row Level Security policies, or put a
small server in front. Happy to set that up when you need it.

## Optional — finalise even when no one is online

Right now the day finalises automatically whenever an admin/supervisor has the
Register open past 10:30 (which is the normal case). If you want it to finalise
at 10:30 **regardless of anyone being online**, add a scheduled job in Supabase:
enable the **pg_cron** extension and schedule a daily `insert into day_status ...`
at 10:30 on weekdays. Ask and I'll give you the exact one-line schedule.
