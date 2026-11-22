"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),sqlite=require("sqlite3");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{EventEmitter}=require("node:events");
const {ensureWebsiteCredentialSchema,resolveSigningCredential}=require("../lib/website-credentials");
const {ensureOccurrenceEngagementSchema}=require("../lib/occurrence-engagement");
const {createConnectionService,ensureWebsiteAuthorizationSchema,challenge}=require("../lib/website-authorization");
const {publicAddress,fetchInstallationProof}=require("../lib/website-verification");
const random=()=>crypto.randomBytes(32).toString("base64url");
const cities=["Enumclaw","Buckley","Wilkeson","Carbonado","South Prairie"];
async function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"oc-authorize-")),filename=path.join(dir,"fixture.db");
 const db=new sqlite.Database(filename);
 t.after(()=>new Promise(resolve=>db.close(()=>{fs.rmSync(dir,{recursive:true,force:true});resolve();})));
 const run=(sql,params=[])=>new Promise((r,j)=>db.run(sql,params,function(e){e?j(e):r({changes:this.changes,lastID:this.lastID});}));
 const all=(sql,params=[])=>new Promise((r,j)=>db.all(sql,params,(e,rows)=>e?j(e):r(rows)));
 const get=async(sql,p)=>(await all(sql,p))[0];let tail=Promise.resolve();
 const transaction=fn=>{const work=async()=>{await run("BEGIN IMMEDIATE");try{const result=await fn({run,all,get});await run("COMMIT");return result;}catch(e){await run("ROLLBACK");throw e;}};const r=tail.then(work,work);tail=r.catch(()=>{});return r;};
 await ensureWebsiteCredentialSchema(run);await ensureWebsiteAuthorizationSchema(run);await ensureOccurrenceEngagementSchema(run);
 await run("CREATE TABLE users(id INTEGER PRIMARY KEY,username,email,passwordHash,role,city,permissionsJson,bootstrapIdentity)");
 await run(`INSERT INTO users(id,username,role,city,permissionsJson,bootstrapIdentity) VALUES
 (1,'Administrator','admin','Enumclaw',NULL,NULL),
 (2,'Scoped Developer','developer','Enumclaw','{"cityAccess":["Enumclaw"]}',NULL),
 (3,'Organizer','organizer','Enumclaw',NULL,NULL),
 (4,'Other Developer','developer','Buckley','{"cityAccess":["Buckley"]}',NULL),
 (5,'Bootstrap','developer','Enumclaw','{"cityAccess":["Enumclaw"]}','fixture-bootstrap')`);
 const policy={supportedCities:cities,getUserAllowedCities:user=>user.role==="admin"?cities:(JSON.parse(user.permissionsJson||"{}").cityAccess||[user.city])};
 const env={WEBSITE_CONNECTIONS_ENABLED:"true",DASHBOARD_ORIGIN:"https://admin.example.test",WEBSITE_CREDENTIAL_ENCRYPTION_KEYS:JSON.stringify({v1:crypto.randomBytes(32).toString("hex")}),WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY:"v1"};
 let clock=Date.now(),proofs=new Map(),badProof=false;
 const verify=async(site,id)=>{const p=proofs.get(id);return badProof?{...p,challenge:random()}:p;};
 const build=()=>createConnectionService({transaction,accountPolicy:policy,env,now:()=>clock,verify});
 let service=build();
 const start=async(overrides={})=>{
  const verifier=random(),body={installationId:crypto.randomUUID(),siteUrl:"https://website.example.test/wp/",homeUrl:"https://website.example.test/",redirectUri:"https://website.example.test/wp/wp-admin/admin-post.php?action=oc_connection_callback",requesterLabel:"Fixture WordPress admin",cities:["Enumclaw"],state:random(),codeChallenge:challenge(verifier),codeChallengeMethod:"S256",...overrides};
  const result=await service.start(body);
  proofs.set(result.requestId,{requestId:result.requestId,installationId:body.installationId,siteUrl:body.siteUrl,homeUrl:body.homeUrl,redirectUri:body.redirectUri,challenge:result.verificationChallenge});
  return {body,result,verifier};
 };
 const prepare=(s,userId=1,sessionToken="session-fixture")=>service.prepareConsent({requestId:s.result.requestId,userId,sessionToken});
 const approve=async(s,userId=1,selected=s.body.cities)=>{
  const view=await prepare(s,userId);
  const url=await service.consent({requestId:s.result.requestId,userId,sessionToken:"session-fixture",csrf:view.csrf,cities:selected});
  return {requestId:s.result.requestId,installationId:s.body.installationId,redirectUri:s.body.redirectUri,state:s.body.state,codeVerifier:s.verifier,code:new URL(url).searchParams.get("code")};
 };
 const sign=(credential,body,endpoint="/connections/activate")=>{
  const timestamp=String(Math.floor(clock/1000)),nonce=crypto.randomBytes(24).toString("base64url");
  const signature=crypto.createHmac("sha256",credential.secret).update(["POST",endpoint,timestamp,nonce,crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")].join("\n")).digest("hex");
  return {body,method:"POST",path:endpoint,headers:{"X-OC-Key-Id":credential.id,"X-OC-Timestamp":timestamp,"X-OC-Nonce":nonce,"X-OC-Signature":signature}};
 };
 return {run,get,all,transaction,env,policy,verify,filename,start,prepare,approve,sign,get service(){return service;},restart:()=>{service=build();},advance:ms=>{clock+=ms;},badProof:value=>{badProof=value;}};
}

test("administrator and scoped developers approve only authorized cities, including bootstrap",async t=>{
 const f=await fixture(t);
 const multi=await f.start({cities:["Enumclaw","Buckley"]});
 assert.deepEqual((await f.prepare(multi,2)).allowedCities,["Enumclaw"]);
 const v=await f.prepare(multi,2);
 await assert.rejects(f.service.consent({requestId:multi.result.requestId,userId:2,sessionToken:"session-fixture",csrf:v.csrf,cities:["Buckley"]}),{status:403});
 const one=await f.start();await f.approve(one,2);
 const bootstrap=await f.start({cities:["Enumclaw","Buckley"]});
 assert.deepEqual((await f.prepare(bootstrap,5)).allowedCities,["Enumclaw"]);
 const outside=await f.start({cities:["Buckley"]});await assert.rejects(f.prepare(outside,2),{status:403});
 await assert.rejects(f.prepare(one,3),{status:403});
 const authorized=await f.start({cities:["Enumclaw","Buckley"]});const grant=await f.approve(authorized,1);
 const provisioned=await f.service.redeem(grant);assert.deepEqual(provisioned.credentials.map(c=>c.city),["Enumclaw","Buckley"]);
 for(const c of provisioned.credentials)assert.match(c.id,/^ocm_/);
 await assert.rejects(f.start({cities:["Plateau Regional"]}),{status:400});
});

test("exact callback, S256, state, consent CSRF and session bindings fail closed",async t=>{
 const f=await fixture(t);
 for(const overrides of [{redirectUri:"https://attacker.test/callback"},{siteUrl:"http://website.example.test/"},{homeUrl:"https://different.test/"},{codeChallengeMethod:"plain"},{siteUrl:"https://user:secret@website.example.test/"}]) await assert.rejects(f.start(overrides));
 const s=await f.start(),view=await f.prepare(s);
 for(const extra of [{csrf:random()},{sessionToken:"different-session"},{userId:2}])await assert.rejects(f.service.consent({requestId:s.result.requestId,userId:1,sessionToken:"session-fixture",csrf:view.csrf,cities:["Enumclaw"],...extra}),{status:403});
 const grant=await f.approve(s);
 for(const extra of [{state:random()},{codeVerifier:random()},{redirectUri:s.body.redirectUri+"&extra=1"},{installationId:crypto.randomUUID()}])await assert.rejects(f.service.redeem({...grant,...extra}),{status:400});
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_signing_credentials")).n,0);
 assert.ok((await f.service.redeem(grant)).credentials.length);
});

test("website proof is transaction-bound and required before consent",async t=>{
 const f=await fixture(t),s=await f.start();f.badProof(true);
 await assert.rejects(f.prepare(s),{status:400,code:"installation_not_verified"});
 assert.equal((await f.get("SELECT verifiedAt FROM website_connection_attempts WHERE id=?",[s.result.requestId])).verifiedAt,null);
 f.badProof(false);assert.ok((await f.prepare(s)).csrf);
});

test("short expiry, one-time redemption and concurrent exchanges cannot duplicate credentials",async t=>{
 const f=await fixture(t),s=await f.start(),grant=await f.approve(s);
 const result=await Promise.allSettled([f.service.redeem(grant),f.service.redeem(grant)]);
 assert.equal(result.filter(r=>r.status==="fulfilled").length,1);
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_signing_credentials")).n,1);
 const expired=await f.start(),expiredGrant=await f.approve(expired);f.advance(120001);await assert.rejects(f.service.redeem(expiredGrant),{status:400});
 const pending=await f.start();f.advance(600001);await assert.rejects(f.prepare(pending),{status:400});
});

test("interrupted issuance rolls back; lost responses require fresh authorization",async t=>{
 const f=await fixture(t),s=await f.start({cities:["Enumclaw","Buckley"]}),grant=await f.approve(s);
 await f.run("CREATE TRIGGER fail_second BEFORE INSERT ON website_signing_credentials WHEN NEW.city='Buckley' BEGIN SELECT RAISE(ABORT,'fixture-secret-error'); END");
 await assert.rejects(f.service.redeem(grant),error=>error.status===503&&!error.message.includes("fixture-secret"));
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_signing_credentials")).n,0);
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_installations")).n,0);
 await f.run("DROP TRIGGER fail_second");const first=await f.service.redeem(grant);
 await assert.rejects(f.service.redeem(grant),{status:400});
 const retry=await f.start(),next=await f.service.redeem(await f.approve(retry));
 assert.notEqual(first.credentials[0].id,next.credentials[0].id);
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_signing_credentials WHERE status='active'")).n,0);
});

test("signed possession activates credentials and supports authenticated checks, replacement and revocation",async t=>{
 const f=await fixture(t),s=await f.start(),p=await f.service.redeem(await f.approve(s)),c=p.credentials[0];
 const body={credentialId:c.id,activationChallenge:c.activationChallenge};
 const lookup=()=>f.transaction(tx=>resolveSigningCredential(tx,c.id,f.env,Date.now(),f.service.credentialAuthority));
 assert.equal(await lookup(),null);
 const bad=f.sign(c,body);bad.headers["X-OC-Signature"]="0".repeat(64);await assert.rejects(f.service.activate(bad),{status:401});
 const req=f.sign(c,body);assert.equal((await f.service.activate(req)).status,"active");
 await assert.rejects(f.service.activate(req),{status:409});assert.ok(await lookup());
 const check=f.sign(c,{installationId:p.installationId},"/connections/check");assert.equal((await f.service.check(check)).city,"Enumclaw");
 await assert.rejects(f.service.check(check),{status:409});
 const replacement=await f.start({replaceInstallationId:p.installationId}),p2=await f.service.redeem(await f.approve(replacement));
 assert.equal(p2.installationId,p.installationId);
 assert.equal((await f.get("SELECT replacesCredentialId FROM website_signing_credentials WHERE id=?",[p2.credentials[0].id])).replacesCredentialId,c.id);
 assert.ok(await lookup());
 await f.service.manage({userId:1,action:"revokeCredential",installationId:p.installationId,credentialId:c.id});
 assert.equal(await lookup(),null);
 await assert.rejects(f.service.activate(f.sign(c,body)),{status:401});
});

test("permission loss blocks redemption, activation and active credentials without changing engagement",async t=>{
 const f=await fixture(t),s=await f.start(),grant=await f.approve(s,2);
 await f.run("UPDATE users SET permissionsJson='{"+'"cityAccess":["Buckley"]'+"}' WHERE id=2");
 await assert.rejects(f.service.redeem(grant),{status:403});
 await f.run("UPDATE users SET permissionsJson='{"+'"cityAccess":["Enumclaw"]'+"}' WHERE id=2");
 const p=await f.service.redeem(grant),c=p.credentials[0];
 await f.run("UPDATE users SET role='organizer' WHERE id=2");
 await assert.rejects(f.service.activate(f.sign(c,{credentialId:c.id,activationChallenge:c.activationChallenge})),{status:403});
 await f.run("UPDATE users SET role='developer' WHERE id=2");await f.service.activate(f.sign(c,{credentialId:c.id,activationChallenge:c.activationChallenge}));
 await f.run("INSERT INTO occurrence_engagement VALUES (99,'2030-01-01T00:00:00.000Z','historical','going','now')");
 await f.run("DELETE FROM users WHERE id=2");
 assert.equal(await f.transaction(tx=>resolveSigningCredential(tx,c.id,f.env,Date.now(),f.service.credentialAuthority)),null);
 assert.equal((await f.get("SELECT COUNT(*) n FROM occurrence_engagement")).n,1);
});

test("connection management, status, audit redaction, expiry, missing keys and persistent restart",async t=>{
 const f=await fixture(t),s=await f.start(),grant=await f.approve(s,2);f.restart();const p=await f.service.redeem(grant),c=p.credentials[0];
 const status=await f.service.manage({userId:2,action:"status",installationId:p.installationId});
 assert.ok(!JSON.stringify(status).includes(c.secret));
 await assert.rejects(f.service.manage({userId:4,action:"status",installationId:p.installationId}),{status:403});
 await assert.rejects(f.service.manage({userId:3,action:"list"}),{status:403});
 const audit=await f.service.manage({userId:1,action:"audit",installationId:p.installationId});
 const storage=await f.all("SELECT * FROM website_connection_attempts");
 assert.ok(!JSON.stringify([...audit.events,...storage]).includes(c.secret));
 f.advance(600001);await assert.rejects(f.service.activate(f.sign(c,{credentialId:c.id,activationChallenge:c.activationChallenge})),{status:400});
 delete f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS;await assert.rejects(f.start(),{status:503});
 await f.service.manage({userId:1,action:"revokeInstallation",installationId:p.installationId});
});

test("login continuation is bounded, opaque and cannot choose an external redirect",async t=>{
 const f=await fixture(t),s=await f.start(),cookie=await f.service.setResume({requestId:s.result.requestId});
 assert.equal(await f.service.resume(cookie),"/connections/authorize?request="+s.result.requestId);
 assert.equal(await f.service.resume(cookie+"forged"),null);
 assert.equal(await f.service.resume("https://evil.test"),null);
 f.restart();assert.ok(await f.service.resume(cookie));f.advance(600001);assert.equal(await f.service.resume(cookie),null);
});

test("verification rejects unsafe addresses and pins validated DNS; redirects and oversized bodies fail",async()=>{
 for(const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","100.64.1.1","192.168.1.1","172.16.0.1","0.0.0.0","::1","::ffff:127.0.0.1","fe80::1","fc00::1","2001:db8::1"])assert.equal(publicAddress(ip),false,ip);
 assert.ok(publicAddress("93.184.216.34"));
 await assert.rejects(fetchInstallationProof("https://site.test/","fixture",{lookup:async()=>[{address:"127.0.0.1",family:4}],request:()=>assert.fail("must not fetch private IP")}));
 let captured;
 const request=(status=200,body='{"ok":true}')=>(url,options,callback)=>{
  captured={url,options};const req=new EventEmitter();req.destroy=()=>req.emit("close");req.end=()=>queueMicrotask(()=>{
   const res=new EventEmitter();res.statusCode=status;res.headers={"content-type":"application/json"};res.destroy=()=>{};callback(res);
   res.emit("data",Buffer.from(body));res.emit("end");req.emit("close");
  });return req;
 };
 const lookup=async()=>[{address:"93.184.216.34",family:4}];
 assert.deepEqual(await fetchInstallationProof("https://site.test/wp/","pending",{lookup,request:request()}),{ok:true});
 assert.equal(captured.url.pathname,"/wp/wp-json/opencircle/v1/connection-proof");assert.equal(captured.options.rejectUnauthorized,true);assert.equal(captured.options.agent,false);
 captured.options.lookup("rebinding.test",{},(_e,address)=>assert.equal(address,"93.184.216.34"));
 await assert.rejects(fetchInstallationProof("https://site.test/","pending",{lookup,request:request(302)}));
 await assert.rejects(fetchInstallationProof("https://site.test/","pending",{lookup,request:request(200,"x".repeat(9000))}));
});

test("consent HTTP document preserves native Origin and exact callback redirect without exposing secrets",async t=>{
 const f=await fixture(t),s=await f.start();
 const express=require("express"),{createConnectionRouter}=require("../routes/website-connections");
 const connection=createConnectionRouter({transaction:f.transaction,accountPolicy:f.policy,env:{...f.env,NODE_ENV:"test"},verify:f.verify,sessionStore:{restore:async value=>value==="fixture-session"?{userId:1,user:"Fixture administrator"}:null}});
 const app=express();app.use(express.json());app.use(express.urlencoded({extended:true}));app.use("/connections",connection.router);
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
 const base="http://127.0.0.1:"+server.address().port,headers={Cookie:"oc_auth=fixture-session",Accept:"text/html"};
 const response=await fetch(base+"/connections/authorize?request="+s.result.requestId,{headers});
 assert.equal(response.status,200);assert.equal(response.headers.get("referrer-policy"),"same-origin");
 assert.ok(response.headers.get("content-security-policy").includes("form-action 'self' https://website.example.test"));
 assert.equal(response.headers.get("access-control-allow-origin"),null);
 const html=await response.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 assert.ok(html.includes('name="cities"'));assert.ok(!html.includes(s.verifier));assert.ok(!html.includes(s.result.verificationChallenge));
 const form=new URLSearchParams({requestId:s.result.requestId,csrf,cities:"Enumclaw"});
 assert.equal((await fetch(base+"/connections/consent",{method:"POST",headers:{...headers,Origin:"null"},body:form,redirect:"manual"})).status,403);
 const consent=await fetch(base+"/connections/consent",{method:"POST",headers:{...headers,Origin:f.env.DASHBOARD_ORIGIN},body:form,redirect:"manual"});
 assert.equal(consent.status,303);assert.equal(consent.headers.get("referrer-policy"),"no-referrer");
 const callback=new URL(consent.headers.get("location"));assert.equal(callback.origin,"https://website.example.test");assert.equal(callback.pathname,"/wp/wp-admin/admin-post.php");
 assert.ok(callback.searchParams.has("code"));assert.equal(callback.searchParams.get("state"),s.body.state);
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_signing_credentials")).n,0);
});

test("cancellation consumes consent without creating a connection or credentials",async t=>{
 const f=await fixture(t),s=await f.start(),view=await f.prepare(s);
 const callback=new URL(await f.service.consent({requestId:s.result.requestId,userId:1,sessionToken:"session-fixture",csrf:view.csrf,cities:[],cancel:true}));
 assert.equal(callback.searchParams.get("error"),"access_denied");assert.equal(callback.searchParams.get("state"),s.body.state);assert.equal(callback.searchParams.has("code"),false);
 await assert.rejects(f.prepare(s),{status:400});
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_installations")).n,0);
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_signing_credentials")).n,0);
});
