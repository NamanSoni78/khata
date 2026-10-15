#!/bin/bash
# UI walkthrough: recording pill, keypad keyboard input, dashboard export — all in one server lifetime.
set -e
cd /home/z/my-project

# fresh-ish state: keep dev.db (seeded), start server
DATABASE_URL="file:/home/z/my-project/dev.db" ADMIN_USERNAME=admin ADMIN_PASSWORD=khata-admin-2024 EMAIL_DEV_MODE=true \
  nohup bun run start > /tmp/khata-ui.log 2>&1 &
SRV=$!
trap "kill -9 $SRV 2>/dev/null; pkill -9 -f 'next-server' 2>/dev/null" EXIT
for i in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:3000/ && break
  sleep 1
done
echo "server up"

# ---- create test user via API (dev OTP) ----
EMAIL="uitest$(date +%s)@gmail.com"
R=$(curl -s -X POST http://localhost:3000/api/auth/signup -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"agreed\":true}")
CODE=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('devCode',''))")
[ -n "$CODE" ] || { echo "no devCode: $R"; exit 1; }
curl -s -c /tmp/ui-jar.txt -X POST http://localhost:3000/api/auth/verify-otp -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" -o /dev/null
curl -s -b /tmp/ui-jar.txt -X POST 'http://localhost:3000/api/auth/mpin?action=setup' -H 'Content-Type: application/json' \
  -d '{"appMpin":"1234","dashboardMpin":"123456"}' -o /dev/null
echo "user created: $EMAIL (mpin 1234 / 123456)"

# ---- seed a couple of chat messages via mock LLM? skip — visual only ----

# ---- browser: landing → unlock with KEYBOARD ----
agent-browser open http://localhost:3000/ > /dev/null
sleep 2
# remembered email? none — land on landing. Type email + password → sign in → lands on unlock? No:
# login creates session and goes straight to chat (or mpin exists → unlock after lock).
# Simulate the returning-user flow: logout via API isn't needed — use the unlock screen directly:
# Actually login = session + chat. To test UNLOCK, we clear the session cookie via logout endpoint.
curl -s -b /tmp/ui-jar.txt -X POST http://localhost:3000/api/auth/logout -o /dev/null
agent-browser open http://localhost:3000/ > /dev/null
sleep 2
agent-browser screenshot /tmp/v6-unlock-landing.png > /dev/null

# The unlock screen shows when localStorage has the remembered email — set it via JS:
agent-browser eval "localStorage.setItem('khata-remembered-email', '$EMAIL'); localStorage.setItem('khata-remembered-name', 'ui'); 'ok'"
agent-browser open http://localhost:3000/ > /dev/null
sleep 2
agent-browser screenshot /tmp/v6-unlock.png > /dev/null
echo "--- unlock screen captured; typing PIN via KEYBOARD ---"
agent-browser key 1 > /dev/null; sleep 0.3
agent-browser key 2 > /dev/null; sleep 0.3
agent-browser key 3 > /dev/null; sleep 0.3
agent-browser key 4 > /dev/null; sleep 3
agent-browser screenshot /tmp/v6-after-keyboard-pin.png > /dev/null
agent-browser snapshot 2>&1 | head -15

echo "--- console errors? ---"
agent-browser console 2>&1 | rg -i 'error' | head -5 || echo "(no console errors)"

# ---- chat screen: recording pill visual (can't grant mic in headless, but pill UI check via class) ----
agent-browser screenshot /tmp/v6-chat.png > /dev/null

# ---- dashboard: 6-digit keypad + export chat history button ----
agent-browser open http://localhost:3000/dashboard > /dev/null
sleep 2
agent-browser screenshot /tmp/v6-dash-login.png > /dev/null
agent-browser key 1 > /dev/null; sleep 0.2; agent-browser key 2 > /dev/null; sleep 0.2
agent-browser key 3 > /dev/null; sleep 0.2; agent-browser key 4 > /dev/null; sleep 0.2
agent-browser key 5 > /dev/null; sleep 0.2; agent-browser key 6 > /dev/null; sleep 3
agent-browser screenshot /tmp/v6-dash.png > /dev/null
echo "--- dashboard snapshot (export chat section) ---"
agent-browser snapshot 2>&1 | rg -i 'export chat|Analysis agent|chat transcript' | head -5

echo "--- console errors on dashboard? ---"
agent-browser console 2>&1 | rg -i 'error' | head -5 || echo "(no console errors)"

echo "DONE"
