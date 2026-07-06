import { chromium } from "playwright-core";
const BASE="http://localhost:5173";
const b=await chromium.launch({headless:true,executablePath:"/home/yash/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",args:["--no-sandbox"]});
const ctx=await b.newContext();
const pg=await ctx.newPage();
const r=await pg.request.post(`${BASE}/api/v1/auth/login`,{data:{email:"audit@nexus.local",password:"LocalDev12345!"}});
const body=await r.json();
console.log("seed token len:", (body.accessToken||"").length);
await pg.addInitScript(t=>{localStorage.setItem("nexus_token",t.accessToken);localStorage.setItem("nexus_user",JSON.stringify(t.user??{}));},body);
const bad=[];
pg.on("response",x=>{const s=x.status(); if((s===401||s===404)&&x.url().includes("/api")) bad.push(`${s} ${x.url().replace(BASE,"")}`);});
await pg.goto(`${BASE}/memory`,{waitUntil:"networkidle",timeout:20000}).catch(()=>{});
await pg.waitForTimeout(1500);
// check token actually in localStorage + what authFetch would send
const tok=await pg.evaluate(()=>localStorage.getItem("nexus_token"));
console.log("in-browser nexus_token len:", (tok||"").length);
console.log("=== 401/404 api calls ==="); [...new Set(bad)].forEach(u=>console.log("  ",u));
await b.close();
