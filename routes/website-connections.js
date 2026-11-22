"use strict";
const express=require("express");
const crypto=require("node:crypto");
const {esc}=require("../lib/html");
const {createConnectionService}=require("../lib/website-authorization");
const {configureManagedCredentialAuthority}=require("../lib/website-credentials");
const {createRateLimiter}=require("../lib/public-rate-limit");
const CONNECTION_PAGE_STYLE = `
      :root{--panel:#fff;--panel2:#f6f8fb;--text:#0f172a;--muted:#52647b;--line:#dce2e8;--brand:#00bd8c;--radius:16px;--ctrl-h:44px}*{box-sizing:border-box}body{margin:0;background:#edf3f7;color:var(--text);font-family:system-ui,sans-serif}.main{max-width:720px;margin:32px auto;padding:16px}.card{padding:24px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}h1{font-size:28px}.sub{color:var(--muted);line-height:1.5}a,p{overflow-wrap:anywhere}.city{display:block;padding:10px 0}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:var(--ctrl-h);padding:0 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);font:inherit;cursor:pointer}.btn-primary{background:var(--brand);font-weight:650}input{margin-right:8px}@media(prefers-color-scheme:dark){:root{--panel:#101827;--panel2:#1b2638;--text:#e5edf7;--muted:#b6c4d5;--line:#334155}body{background:#101827}}

.card li{overflow-wrap:anywhere}`;
function cookie(req,name) {
  const item=String(req.headers.cookie||"").split(";").map(s=>s.trim()).find(s=>s.startsWith(name+"="));
  return item?item.slice(name.length+1):"";
}
function createConnectionRouter({transaction,accountPolicy,sessionStore,env=process.env,verify,now}) {
  const router=express.Router(),service=createConnectionService({transaction,accountPolicy,env,verify,now});
  configureManagedCredentialAuthority(service.credentialAuthority);
  const limiter=createRateLimiter({windowMs:60000,max:120,maxKeys:4096});
  router.use((req,res,next)=>{
    res.removeHeader("Access-Control-Allow-Origin");res.removeHeader("Access-Control-Allow-Credentials");
    res.set({"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'"});
    if(env.NODE_ENV!=="test" && !req.secure)return res.status(400).json({error:"https_required"});
    if(env.WEBSITE_CONNECTIONS_ENABLED!=="true") return res.status(503).json({error:"connections_disabled"});
    if(!limiter.consume(req.socket.remoteAddress||"unknown")) { res.set("Retry-After","60");return res.status(429).json({error:"try_later"}); }
    next();
  });
  const route=fn=>async(req,res)=>{try{await fn(req,res);}catch(error){const status=Number.isInteger(error.status)?error.status:503;if(status===429)res.set("Retry-After","60");const code=error.code&&/^[a-z_]+$/.test(error.code)?error.code:"connection_unavailable";
    if(["/authorize","/consent","/disconnect"].includes(req.path) && String(req.headers.accept||"").includes("text/html")) {
      return res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCircle Connection</title><link rel="stylesheet" href="/assets/admin-ui.css"></head><body><main style="max-width:640px;margin:32px auto;padding:24px;font-family:system-ui,sans-serif"><h1>Connection needs attention</h1><p role="alert">${code==="not_authorized"?"Your account cannot authorize this connection.":code==="expired_connection"?"This connection request expired. Return to WordPress and connect again.":"We could not complete this connection. Return to WordPress and try again."}</p><a href="/admin">Return to dashboard</a></main></body></html>`);
    }
    res.status(status).json({error:code});}};
  const signedIn=async(req,res)=>{
    const session=await sessionStore.restore(cookie(req,"oc_auth"));
    if(!session) {res.status(401).json({error:"sign_in_required"});return null;}return session;
  };
  const sameOrigin=req=>req.headers.origin===service.issuer();
  router.post("/start",route(async(req,res)=>{
    if(req.headers.origin) return res.status(403).json({error:"server_exchange_required"});
    if(!req.is("application/json"))return res.status(415).json({error:"invalid_request"});
    res.json(await service.start(req.body));
  }));
  router.get("/authorize",route(async(req,res)=>{
    const session=await sessionStore.restore(cookie(req,"oc_auth"));
    if(!session) {
      const value=await service.setResume({requestId:req.query.request});
      res.cookie("oc_connect_resume",value,{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:600000});
      return res.redirect("/login");
    }
    const view=await service.prepareConsent({requestId:req.query.request,userId:session.userId,sessionToken:cookie(req,"oc_auth")});
    // no-referrer makes native form POSTs send Origin:null in Chrome.
    // Same-origin preserves Origin for CSRF validation, without sending referrers
    // to the external WordPress callback. The redirect response remains no-referrer.
    res.set("Referrer-Policy","same-origin");
    // Chrome also applies form-action to the 303 destination. Only the verified
    // installation's origin is permitted; the server still matches its exact URI.
    res.set("Content-Security-Policy",res.get("Content-Security-Policy").replace("form-action 'self'", "form-action 'self' " + new URL(view.siteUrl).origin));
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize OpenCircle Connection</title><link rel="stylesheet" href="/assets/admin-ui.css"><style>${CONNECTION_PAGE_STYLE}</style></head><body><main class="main"><section class="card" aria-labelledby="heading"><h1 id="heading">Authorize Connection</h1>
      <p>Signed in as <strong>${esc(session.user)}</strong>.</p><p><strong>Verified installation:</strong> ${esc(view.siteUrl)}</p><p class="sub">Website: ${esc(view.homeUrl)}<br>Requesting administrator label: ${esc(view.requesterLabel)} (provided by the website).</p>
      <p>This connection lets the website submit and read Going and Interested responses for events in the communities you approve. It does not grant event editing or account access.</p>
      <p class="sub">Requested communities: ${view.requestedCities.map(esc).join(", ")}. Only communities you may authorize are selectable.</p>
      <form method="post" action="/connections/consent"><input type="hidden" name="requestId" value="${esc(req.query.request)}"><input type="hidden" name="csrf" value="${esc(view.csrf)}"><fieldset><legend>Communities to authorize</legend>${view.allowedCities.map(city=>`<label class="city"><input type="checkbox" name="cities" value="${esc(city)}" checked>${esc(city)}</label>`).join("")}</fieldset><div class="actions"><button class="btn btn-primary" type="submit">Authorize Connection</button><button class="btn" type="submit" name="cancel" value="1">Cancel</button></div></form></section></main></body></html>`);
  }));
  router.post("/consent",route(async(req,res)=>{
    const session=await signedIn(req,res);if(!session)return;
    if(!sameOrigin(req))return res.status(403).json({error:"invalid_consent"});
    const cities=Array.isArray(req.body.cities)?req.body.cities:typeof req.body.cities==="string"?[req.body.cities]:[];
    const redirect=await service.consent({...req.body,cities,cancel:req.body.cancel==="1",userId:session.userId,sessionToken:cookie(req,"oc_auth")});
    res.clearCookie("oc_connect_resume",{path:"/",secure:true,httpOnly:true,sameSite:"lax"});res.redirect(303,redirect);
  }));
  router.post("/redeem",route(async(req,res)=>{
    if(req.headers.origin)return res.status(403).json({error:"server_exchange_required"});
    if(!req.is("application/json"))return res.status(415).json({error:"invalid_request"});
    res.json(await service.redeem(req.body));
  }));
  router.post("/activate",route(async(req,res)=>{
    if(req.headers.origin)return res.status(403).json({error:"server_exchange_required"});
    if(!req.is("application/json"))return res.status(415).json({error:"invalid_request"});
    const headers={};for(const name of ["X-OC-Key-Id","X-OC-Timestamp","X-OC-Nonce","X-OC-Signature"])headers[name]=req.get(name);
    res.json(await service.activate({body:req.body,headers,method:req.method,path:req.originalUrl}));
  }));
  router.post("/check",route(async(req,res)=>{
    if(req.headers.origin)return res.status(403).json({error:"server_exchange_required"});
    if(!req.is("application/json"))return res.status(415).json({error:"invalid_request"});
    const headers={};for(const name of ["X-OC-Key-Id","X-OC-Timestamp","X-OC-Nonce","X-OC-Signature"])headers[name]=req.get(name);
    res.json(await service.check({body:req.body,headers,method:req.method,path:req.originalUrl}));
  }));
  const signingHeaders=req=>{
    const headers={};for(const name of ["X-OC-Key-Id","X-OC-Timestamp","X-OC-Nonce","X-OC-Signature"])headers[name]=req.get(name);
    return headers;
  };
  router.post("/disconnect/start",route(async(req,res)=>{
    if(req.headers.origin)return res.status(403).json({error:"server_exchange_required"});
    if(!req.is("application/json"))return res.status(415).json({error:"invalid_request"});
    res.json(await service.disconnection.start({body:req.body,headers:signingHeaders(req),method:req.method,path:req.originalUrl}));
  }));
  router.get("/disconnect",route(async(req,res)=>{
    const session=await sessionStore.restore(cookie(req,"oc_auth"));
    if(!session) {
      const value=await service.disconnection.setResume({requestId:req.query.request});
      res.cookie("oc_connect_resume",value,{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:600000});
      return res.redirect("/login");
    }
    const view=await service.disconnection.prepare({requestId:req.query.request,userId:session.userId,sessionToken:cookie(req,"oc_auth")});
    const explanations={installation:"This website will lose access through all of its managed API credentials.",city:"Only the listed community will be disconnected. Other communities remain connected.",credential:"Only the listed signing credential will be revoked. Other credentials remain available.",rotation:"The old signing credential will be revoked. Its verified replacement will remain active."};
    const labels={installation:"Disconnect Website",city:"Disconnect Community",credential:"Revoke Credential",rotation:"Retire Old Credential"};
    res.set("Referrer-Policy","same-origin");
    res.set("Content-Security-Policy",res.get("Content-Security-Policy").replace("form-action 'self'", "form-action 'self' " + new URL(view.siteUrl).origin));
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disconnect OpenCircle Website</title><link rel="stylesheet" href="/assets/admin-ui.css"><style>${CONNECTION_PAGE_STYLE}</style></head><body><main class="main"><section class="card" aria-labelledby="disconnectHeading"><h1 id="disconnectHeading">Disconnect OpenCircle Website</h1><p>Signed in as <strong>${esc(session.user)}</strong>.</p><p><strong>Verified website:</strong> ${esc(view.siteUrl)}</p><h2>Communities affected</h2><ul>${view.cities.map(city=>`<li>${esc(city)}</li>`).join("")}</ul><p>${esc(explanations[view.operation])}</p><p class="sub">Events, analytics, visitor identities, and historical Going and Interested responses will be kept. Manually configured credentials are not changed.</p>${view.operation==="credential"||view.operation==="rotation"?`<p class="sub">Credential: ${esc(view.credentialIds[0])}${view.replacementCredentialId?`<br>Replacement kept active: ${esc(view.replacementCredentialId)}`:""}</p>`:""}<form method="post" action="/connections/disconnect"><input type="hidden" name="requestId" value="${esc(req.query.request)}"><input type="hidden" name="csrf" value="${esc(view.csrf)}"><div class="actions"><button class="btn btn-danger" type="submit">${esc(labels[view.operation])}</button><button class="btn" type="submit" name="cancel" value="1">Cancel</button></div></form></section></main></body></html>`);
  }));
  router.post("/disconnect",route(async(req,res)=>{
    const session=await signedIn(req,res);if(!session)return;
    if(!sameOrigin(req))return res.status(403).json({error:"invalid_consent"});
    const redirect=await service.disconnection.confirm({requestId:req.body.requestId,userId:session.userId,sessionToken:cookie(req,"oc_auth"),csrf:req.body.csrf,cancel:req.body.cancel==="1"});
    res.clearCookie("oc_connect_resume",{path:"/",httpOnly:true,secure:true,sameSite:"lax"});res.redirect(303,redirect);
  }));
  for(const action of ["result","recover"])router.post("/disconnect/"+action,route(async(req,res)=>{
    if(req.headers.origin)return res.status(403).json({error:"server_exchange_required"});
    if(!req.is("application/json"))return res.status(415).json({error:"invalid_request"});
    res.json(await service.disconnection[action](req.body));
  }));
  // Session-bound management. Mutations have a separate per-session CSRF token.
  const csrf=sessionToken=>crypto.createHmac("sha256",sessionToken).update("opencircle-connection-management-v1").digest("hex");
  router.get("/manage",route(async(req,res)=>{
    const session=await signedIn(req,res);if(!session)return;
    if(!["status","list","audit","pending"].includes(req.query.action))return res.status(405).json({error:"method_not_allowed"});
    const data=await service.manage({...req.query,userId:session.userId});
    res.json({...data,csrf:csrf(cookie(req,"oc_auth"))});
  }));
  router.post("/manage",route(async(req,res)=>{
    const session=await signedIn(req,res);if(!session)return;
    const expected=csrf(cookie(req,"oc_auth"));
    if(!sameOrigin(req)||typeof req.body.csrf!=="string"||req.body.csrf.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(req.body.csrf),Buffer.from(expected)))return res.status(403).json({error:"invalid_consent"});
    res.json(await service.manage({...req.body,userId:session.userId}));
  }));
  return {router,service};
}
module.exports={createConnectionRouter};
