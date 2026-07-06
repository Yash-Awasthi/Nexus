#!/usr/bin/env bash
API=http://localhost:3000
login(){ T=$(curl -s -m 10 -X POST $API/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"audit@nexus.local","password":"LocalDev12345!"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))'); }
login
: > /tmp/getsweep-out.txt
while IFS= read -r line; do
  [ -z "$line" ] && continue
  pre=${line%% *}; p=${line#* }
  code=$(curl -s -o /tmp/g.txt -w '%{http_code}' -m 12 "$API$pre$p" -H "Authorization: Bearer $T" 2>/dev/null || echo TIMEOUT)
  [ "$code" = "401" ] && { login; code=$(curl -s -o /tmp/g.txt -w '%{http_code}' -m 12 "$API$pre$p" -H "Authorization: Bearer $T" 2>/dev/null || echo TIMEOUT); }
  echo "$code  $pre$p" >> /tmp/getsweep-out.txt
  [ "$code" = "500" ] && echo "     .500. $(head -c 300 /tmp/g.txt | tr '\n' ' ')" >> /tmp/getsweep-out.txt
done < /tmp/getsweep.txt
echo "DONE $(grep -cE '^[0-9T]' /tmp/getsweep-out.txt)" >> /tmp/getsweep-out.txt
cp /tmp/getsweep-out.txt /home/yash/Desktop/PROJECTS/Nexus/track/getsweep-results.txt
