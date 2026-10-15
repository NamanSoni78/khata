#!/bin/bash
# E2E API test for Khata v2 — gmail signup → OTP → MPIN → unlock → chat → dashboard → user AI config → admin
set -e
cd /home/z/my-project
BASE=http://localhost:3000
JAR=/tmp/khata-cookies.txt
DASH=/tmp/khata-dash-cookies.txt
ADMIN=/tmp/khata-admin-cookies.txt
rm -f $JAR $DASH $ADMIN
# unique per-run email so reruns never collide
export EMAIL="rahule2e$(date +%s)@gmail.com"

pass() { echo "✓ $1"; }
fail() { echo "✗ $1"; exit 1; }

echo "=== 1. Signup (gmail validation) ==="
R=$(curl -s -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"some.thing@gmail.com","password":"password123","agreed":true}')
echo "$R" | grep -q "plain Gmail" && pass "dotted gmail rejected" || fail "dotted gmail: $R"

R=$(curl -s -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"some+thing@gmail.com","password":"password123","agreed":true}')
echo "$R" | grep -q "plain Gmail" && pass "+tag gmail rejected" || fail "+tag gmail: $R"

R=$(curl -s -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"rahul@yahoo.com","password":"password123","agreed":true}')
echo "$R" | grep -q "gmail.com" && pass "non-gmail rejected" || fail "yahoo: $R"

R=$(curl -s -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"agreed\":false}")
echo "$R" | grep -q "agree" && pass "terms agreement required" || fail "agreed: $R"

R=$(curl -s -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"agreed\":true}")
DEV_CODE=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('devCode',''))")
[ -n "$DEV_CODE" ] && pass "signup OK, dev OTP $DEV_CODE" || fail "signup: $R"

echo "=== 2. OTP verification (wrong then right) ==="
R=$(curl -s -X POST $BASE/api/auth/verify-otp -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"000000\"}")
echo "$R" | grep -q "isn't right" && pass "wrong OTP rejected" || fail "wrong otp: $R"

R=$(curl -s -c $JAR -X POST $BASE/api/auth/verify-otp -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$DEV_CODE\"}")
echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('requiresMpinSetup') is True; print('✓ OTP verified, session created, MPIN setup required')" || fail "verify: $R"

echo "=== 3. Duplicate signup rejected ==="
R=$(curl -s -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"agreed\":true}")
echo "$R" | grep -q "already exists" && pass "duplicate signup blocked" || fail "dup: $R"

echo "=== 4. MPIN setup (4 + 6 digit) ==="
R=$(curl -s -b $JAR -X POST "$BASE/api/auth/mpin?action=setup" -H 'Content-Type: application/json' \
  -d '{"appMpin":"1234","dashboardMpin":"654321"}')
echo "$R" | grep -q '"ok":true' && pass "MPINs saved + categories seeded" || fail "mpin setup: $R"

echo "=== 5. me endpoint ==="
R=$(curl -s -b $JAR $BASE/api/auth/me)
echo "$R" | python3 -c "
import json,sys,os; d=json.load(sys.stdin)
assert d['authenticated'] and d['email']==os.environ['EMAIL']
assert d['hasAppMpin'] and d['hasDashboardMpin']
assert d['sttEngine'] in ('native','openai-compatible')
print('✓ me: authed, mpins present, stt engine =', d['sttEngine'])" || fail "me: $R"

echo "=== 6. Chat without LLM key (client-safe error) ==="
R=$(curl -s -b $JAR -X POST "$BASE/api/chat?action=daily" -H 'Content-Type: application/json' \
  -d '{"message":"aaj 20 rs rapido ke kharch hue"}')
echo "$R" | grep -qE "isn't set up yet|temporarily unavailable" && pass "chat client-safe error (no key OR unreachable)" || fail "chat: $R"

echo "=== 7. Logout + MPIN unlock flow (returning user) ==="
curl -s -c $JAR -b $JAR -X POST $BASE/api/auth/logout > /dev/null
R=$(curl -s -X POST "$BASE/api/auth/mpin?action=unlock" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"mpin\":\"9999\"}")
echo "$R" | grep -q "tries left" && pass "wrong MPIN rejected w/ attempts left" || fail "wrong mpin: $R"

R=$(curl -s -c $JAR -X POST "$BASE/api/auth/mpin?action=unlock" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"mpin\":\"1234\"}")
echo "$R" | grep -q '"ok":true' && pass "4-digit MPIN unlock creates session" || fail "unlock: $R"

echo "=== 8. Forgot-MPIN reset (gmail + password) ==="
R=$(curl -s -X POST "$BASE/api/auth/mpin?action=reset" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"appMpin\":\"4321\",\"dashboardMpin\":\"111222\"}")
echo "$R" | grep -q '"ok":true' && pass "MPIN reset via gmail+password works" || fail "mpin reset: $R"

echo "=== 9. Dashboard login (6-digit MPIN) ==="
R=$(curl -s -X POST "$BASE/api/dashboard/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"dashboardMpin\":\"000000\"}")
echo "$R" | grep -q "tries left" && pass "wrong dashboard MPIN rejected" || fail "dash wrong: $R"

R=$(curl -s -c $DASH -X POST "$BASE/api/dashboard/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"dashboardMpin\":\"111222\"}")
echo "$R" | grep -q '"ok":true' && pass "dashboard 6-digit MPIN login works" || fail "dash login: $R"

echo "=== 10. User AI config (own keys) ==="
R=$(curl -s -b $DASH $BASE/api/user/ai-config)
echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'daily' in d and 'instructions' in d; print('✓ GET ai-config OK')" || fail "ai-config get: $R"

R=$(curl -s -b $DASH -X PUT $BASE/api/user/ai-config -H 'Content-Type: application/json' \
  -d '{"key":"ai.daily","value":{"baseUrl":"https://api.groq.com/openai/v1","apiKey":"gsk_test123","model":"llama-3.3-70b-versatile"}}')
echo "$R" | grep -q '"ok":true' && pass "user LLM override saved" || fail "ai-config put: $R"

R=$(curl -s -b $DASH -X PUT $BASE/api/user/ai-config -H 'Content-Type: application/json' \
  -d '{"key":"ai.instructions","value":{"daily":"Call me bro, reply in Hinglish"}}')
echo "$R" | grep -q '"ok":true' && pass "custom instructions saved" || fail "instructions: $R"

R=$(curl -s -b $DASH $BASE/api/user/ai-config)
echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['daily']['apiKey']=='••••••••'; assert d['instructions']['daily'].startswith('Call me'); print('✓ API key masked in GET, instructions stored')" || fail "mask: $R"

R=$(curl -s -b $DASH -X DELETE "$BASE/api/user/ai-config?key=ai.daily")
echo "$R" | grep -q '"ok":true' && pass "reset to defaults works" || fail "delete: $R"

echo "=== 11. Forgot password flow ==="
R=$(curl -s -X POST $BASE/api/auth/forgot-password -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\"}")
CODE=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('devCode',''))")
[ -n "$CODE" ] && pass "forgot-password OTP sent (dev $CODE)" || fail "forgot: $R"

R=$(curl -s -X POST $BASE/api/auth/reset-password -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\",\"newPassword\":\"newpassword456\"}")
echo "$R" | grep -q '"ok":true' && pass "password reset works" || fail "reset: $R"

R=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"newpassword456\"}")
echo "$R" | grep -q '"ok":true' && pass "login with new password works" || fail "relogin: $R"

echo "=== 12. Admin panel ==="
R=$(curl -s -c $ADMIN -X POST $BASE/api/admin/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"khata-admin-2024"}')
echo "$R" | grep -q '"ok":true' && pass "admin login" || fail "admin: $R"

R=$(curl -s -b $ADMIN $BASE/api/admin/users)
echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); u=d['users'][0]; assert u['email']=='$EMAIL'; print('✓ admin users list shows gmail')" || fail "users: $R"

R=$(curl -s -b $ADMIN $BASE/api/admin/db-status)
echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['database']['remote'] is False; assert d['env']['hasResend'] is False; print('✓ db-status: local sqlite, resend detected as unset')" || fail "status: $R"

echo "=== 13. Legal pages render ==="
curl -s $BASE/terms | grep -q "Terms of Service" && pass "/terms renders" || fail "terms"
curl -s $BASE/privacy | grep -q "Privacy Policy" && pass "/privacy renders" || fail "privacy"
curl -s $BASE/ | grep -q "Sign in" && pass "landing renders" || fail "landing"
curl -s $BASE/sitemap.xml | grep -q "terms" && pass "sitemap includes legal pages" || fail "sitemap"

echo ""
echo "ALL API TESTS PASSED ✅"
