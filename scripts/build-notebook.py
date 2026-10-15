#!/usr/bin/env python3
"""Builds KHATA_DB_SETUP.ipynb — the Colab notebook that pushes the Khata
schema + seed to the user's Turso database."""
import json

cells = []

def md(src):
    cells.append({"cell_type": "markdown", "metadata": {}, "source": src.splitlines(keepends=True)})

def code(src):
    cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": src.splitlines(keepends=True)})

md("""# 🗄️ Khata — Turso Database Setup

This notebook sets up your **Turso** database for Khata in one go:
schema (all tables) + default admin configuration (agents, flags, glossary).

### What you need
1. **`khata-production.zip`** — uploaded to this notebook (📁 folder icon on the left → Upload).
2. A **Turso** account (free): [https://turso.tech](https://turso.tech)
   - Create a database (any region close to India, e.g. `aws-ap-southeast-1`)
   - Copy its **Database URL** (`libsql://your-db.turso.io`)
   - Create a **token**: `turso db tokens create <db-name>` (or the "Generate token" button)

Then just run the cells top to bottom. ✌️""")

code("""# 1. Unzip the project (upload khata-production.zip via the Files panel first)
import os

if not os.path.exists('/content/khata-production.zip'):
    raise FileNotFoundError('Upload khata-production.zip first: left panel → Files → Upload')

!mkdir -p /content/khata
!unzip -oq /content/khata-production.zip -d /content/khata
!ls /content/khata | head -20
print('\\n✓ Project extracted.')""")

code("""# 2. Install Bun (fast JS runtime — the project's scripts run on it)
!npm install -g bun -s
import os
os.environ['PATH'] = '/root/.bun/bin:' + os.environ['PATH']
print('Bun version:')
!bun --version""")

code("""# 3. Install dependencies (~1-2 min; runs `prisma generate` automatically)
%cd /content/khata
!bun install 2>&1 | tail -3""")

code("""# 4. Generate the Prisma client explicitly (belt & suspenders)
%cd /content/khata
!bunx prisma generate 2>&1 | tail -2""")

md("""## 5. Your Turso credentials 👇

Paste your **Database URL** and **Auth Token** below, then run the cell.
*(The values stay in this notebook session only — nothing is sent anywhere except Turso.)*""")

code("""# @markdown ---
TURSO_DATABASE_URL = "libsql://your-db-name-your-user.turso.io"  # @param {type:"string"}
TURSO_AUTH_TOKEN = "eyJ..."  # @param {type:"string"}
# @markdown ---

import os
os.environ['TURSO_DATABASE_URL'] = TURSO_DATABASE_URL
os.environ['TURSO_AUTH_TOKEN'] = TURSO_AUTH_TOKEN

assert TURSO_DATABASE_URL.startswith('libsql://'), 'Paste your libsql://… database URL above ☝️'
assert len(TURSO_AUTH_TOKEN) > 20, 'Paste your Turso auth token above ☝️'
print('Credentials set ✓ (', TURSO_DATABASE_URL, ')')""")

code("""# 6. Create the schema + seed the defaults on Turso 🚀
%cd /content/khata
!bun run scripts/turso-setup.ts""")

code('''# 7. (Optional) quick verification - table list + row counts
%cd /content/khata
verify = """
import { createClient } from "@libsql/client";
const c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const r = await c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
console.log("Tables (" + r.rows.length + "):");
for (const row of r.rows) console.log("  -", row.name);
await c.close();
"""
with open("/tmp/verify.ts", "w") as f:
    f.write(verify)
!bun run /tmp/verify.ts''')

md("""## 8. Almost done — connect it to Vercel

Copy these into **Vercel → Khata project → Settings → Environment Variables**
(Production + Preview):

| Variable | Value |
|---|---|
| `DATABASE_URL` | your `libsql://…` URL |
| `DATABASE_AUTH_TOKEN` | your token |

…alongside the other env vars from the README (`ADMIN_USERNAME`, `ADMIN_PASSWORD`,
`RESEND_API_KEY`, VAPID keys, QStash…). Then **Deploy** 🎉""")

nb = {
    "nbformat": 4,
    "nbformat_minor": 0,
    "metadata": {
        "colab": {"provenance": [], "name": "KHATA_DB_SETUP"},
        "kernelspec": {"name": "python3", "display_name": "Python 3"},
        "language_info": {"name": "python"},
    },
    "cells": cells,
}

with open("/home/z/my-project/KHATA_DB_SETUP.ipynb", "w") as f:
    json.dump(nb, f, indent=1)
print("notebook written:", len(cells), "cells")
