import { chromium } from "playwright-core";
const BASE="http://localhost:5173";
const PAGES=["honesty","redteam","skills","connectors/sync","quality","moderation"];
const b=await chromium.launch({headless:true,executablePath:"/home/yash/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",args:["--no-sandbox"]});
const ctx=await b.newContext();
const pg=await ctx.newPage();
const r=await pg.request.post(`${BASE}/api/v1/auth/login`,{data:{email:"audit@nexus.local",password:"LocalDev12345!"}});
const body=await r.json();
await pg.addInitScript(t=>{localStorage.setItem("nexus_token",t.accessToken);localStorage.setItem("nexus_user",JSON.stringify(t.user??{}));},body);
for(const p of PAGES){
  const errs=[];
  const h=m=>{if(m.type()==="error"){const t=m.text();if(!/notifications\/count|Failed to load resource/.test(t))errs.push(t.replace(/\s+/g," ").slice(0,140));}};
  pg.on("console",h);
  // twice: first may trigger vite optimize, second is real
  await pg.goto(`${BASE}/${p}`,{waitUntil:"networkidle",timeout:25000}).catch(()=>{});
  await pg.waitForTimeout(1500);
  await pg.goto("about:blank");
  await pg.goto(`${BASE}/${p}`,{waitUntil:"networkidle",timeout:25000}).catch(()=>{});
  await pg.waitForTimeout(1500);
  const info=await pg.evaluate(()=>({len:(document.body?.innerText??"").trim().length,head:(document.body?.innerText??"").trim().slice(0,50).replace(/\s+/g," ")}));
  pg.off("console",h);
  const uniq=[...new Set(errs)];
  console.log(`/${p}  len=${info.len}  ${info.len<30?"BLANK":"rendered"}  err=${uniq[0]??"none"}`);
}
await b.close();
