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

async function connected(f,selected=["Enumclaw"],owner=1) {
 const initial=await f.start({cities:selected});const provision=await f.service.redeem(await f.approve(initial,owner));
 for(const c of provision.credentials)await f.service.activate(f.sign(c,{credentialId:c.id,activationChallenge:c.activationChallenge}));
 return {initial,provision,credential:provision.credentials[0]};
}
async function begin(f,c,extra={}) {
 const verifier=random();
 const body={installationId:c.provision.installationId,clientInstallationId:c.initial.body.installationId,redirectUri:c.initial.body.redirectUri,state:random(),codeChallenge:challenge(verifier),codeChallengeMethod:"S256",operation:"installation",...extra};
 const response=await f.service.disconnection.start(f.sign(c.credential,body,"/connections/disconnect/start"));
 return {body,response,verifier};
}
async function confirm(f,pending,userId=1,cancel=false) {
 const view=await f.service.disconnection.prepare({requestId:pending.response.requestId,userId,sessionToken:"disconnect-session"});
 const url=await f.service.disconnection.confirm({requestId:pending.response.requestId,userId,sessionToken:"disconnect-session",csrf:view.csrf,cancel});
 return {...resultBody(pending),completionCode:new URL(url).searchParams.get("completion_code")};
}
function resultBody(p) {
 return {requestId:p.response.requestId,installationId:p.body.installationId,clientInstallationId:p.body.clientInstallationId,redirectUri:p.body.redirectUri,state:p.body.state,codeVerifier:p.verifier,requestProof:p.response.requestProof};
}
const active=(f,c)=>f.transaction(tx=>resolveSigningCredential(tx,c.id,f.env,Date.now(),f.service.credentialAuthority));

test("signed initiation cannot revoke; administrator confirmation disconnects only managed credentials",async t=>{
 const f=await fixture(t),c=await connected(f,["Enumclaw","Buckley"]);
 await f.run("INSERT INTO occurrence_engagement VALUES (99,'2030-01-01T00:00:00.000Z','historical-identity','going','fixture')");
 const history=await f.all("SELECT * FROM occurrence_engagement");
 const p=await begin(f,c);assert.ok(await active(f,c.credential));
 const view=await f.service.disconnection.prepare({requestId:p.response.requestId,userId:1,sessionToken:"disconnect-session"});
 assert.deepEqual(view.cities,["Buckley","Enumclaw"]);assert.ok(!JSON.stringify(view).includes(p.response.requestProof));
 const receipt=await confirm(f,p),result=await f.service.disconnection.result(receipt);
 assert.equal(result.status,"revoked");assert.equal(result.operation,"installation");
 for(const cred of c.provision.credentials)assert.equal(await active(f,cred),null);
 assert.equal((await f.get("SELECT status FROM website_installations WHERE id=?",[c.provision.installationId])).status,"revoked");
 assert.deepEqual(await f.all("SELECT * FROM occurrence_engagement"),history);
 f.env.OCCURRENCE_ENGAGEMENT_CREDENTIALS=JSON.stringify({manual:{city:"Enumclaw",secret:"fixture manual secret".repeat(3)}});
 assert.ok(await f.transaction(tx=>resolveSigningCredential(tx,"manual",f.env)));
 await assert.rejects(f.service.disconnection.result(receipt),{status:409,code:"completion_used"});
});

test("developer ownership and current city scope are required; organizers and other developers denied",async t=>{
 const f=await fixture(t),c=await connected(f,["Enumclaw"],2),p=await begin(f,c);
 for(const userId of [3,4,5])await assert.rejects(f.service.disconnection.prepare({requestId:p.response.requestId,userId,sessionToken:"x"}),{status:403});
 const receipt=await confirm(f,p,2);assert.equal((await f.service.disconnection.result(receipt)).status,"revoked");
 const other=await connected(f,["Enumclaw","Buckley"]),attempt=await begin(f,other);
 await assert.rejects(f.service.disconnection.prepare({requestId:attempt.response.requestId,userId:2,sessionToken:"x"}),{status:403});
});

test("scope, callback, signatures, session and CSRF are bound to the exact transaction",async t=>{
 const f=await fixture(t),c=await connected(f),p=await begin(f,c);
 const invalid=f.sign(c.credential,{...p.body,installationId:crypto.randomUUID()},"/connections/disconnect/start");
 await assert.rejects(f.service.disconnection.start(invalid),{status:401});
 await assert.rejects(f.service.disconnection.start(f.sign(c.credential,{...p.body,redirectUri:"https://evil.test/callback"},"/connections/disconnect/start")),{status:400,code:"callback_mismatch"});
 await assert.rejects(f.service.disconnection.start(f.sign(c.credential,{...p.body,clientInstallationId:crypto.randomUUID()},"/connections/disconnect/start")),{status:400});
 const replay=f.sign(c.credential,p.body,"/connections/disconnect/start");await f.service.disconnection.start(replay);await assert.rejects(f.service.disconnection.start(replay),{status:409});
 const view=await f.service.disconnection.prepare({requestId:p.response.requestId,userId:1,sessionToken:"disconnect-session"});
 for(const extra of [{csrf:random()},{sessionToken:"other-session"},{userId:2}])await assert.rejects(f.service.disconnection.confirm({requestId:p.response.requestId,userId:1,sessionToken:"disconnect-session",csrf:view.csrf,...extra}),{status:403});
 assert.ok(await active(f,c.credential));
});

test("concurrent confirmation has one winner and transactional failure rolls revocation back",async t=>{
 const f=await fixture(t),c=await connected(f),p=await begin(f,c);
 const view=await f.service.disconnection.prepare({requestId:p.response.requestId,userId:1,sessionToken:"disconnect-session"});
 await f.run("CREATE TRIGGER fail_disconnect BEFORE INSERT ON website_connection_audit WHEN NEW.action='disconnection.confirmed' BEGIN SELECT RAISE(ABORT,'fixture secret diagnostic'); END");
 const input={requestId:p.response.requestId,userId:1,sessionToken:"disconnect-session",csrf:view.csrf};
 await assert.rejects(f.service.disconnection.confirm(input),e=>e.status===503&&!e.message.includes("secret"));
 assert.ok(await active(f,c.credential));assert.equal((await f.get("SELECT status FROM website_disconnection_attempts WHERE id=?",[p.response.requestId])).status,"pending");
 await f.run("DROP TRIGGER fail_disconnect");
 const answers=await Promise.allSettled([f.service.disconnection.confirm(input),f.service.disconnection.confirm(input)]);
 assert.equal(answers.filter(a=>a.status==="fulfilled").length,1);
 assert.equal((await f.get("SELECT COUNT(*) n FROM website_connection_audit WHERE action='disconnection.confirmed'")).n,1);
});

test("single-city, single-credential and rotation actions preserve unrelated active replacements",async t=>{
 const f=await fixture(t),c=await connected(f,["Enumclaw","Buckley"]);
 const city=await begin(f,c,{operation:"city",city:"Enumclaw"});await confirm(f,city);
 assert.equal(await active(f,c.provision.credentials.find(x=>x.city==="Enumclaw")),null);
 assert.ok(await active(f,c.provision.credentials.find(x=>x.city==="Buckley")));
 const one=await connected(f),replacementStart=await f.start({replaceInstallationId:one.provision.installationId,installationId:one.initial.body.installationId});
 const replacement=await f.service.redeem(await f.approve(replacementStart));const next=replacement.credentials[0];
 const recent={...one,initial:replacementStart};
 await assert.rejects(begin(f,recent,{operation:"rotation",credentialId:one.credential.id,replacementCredentialId:next.id}),{status:409,code:"replacement_not_active"});
 await f.service.activate(f.sign(next,{credentialId:next.id,activationChallenge:next.activationChallenge}));
 const rotation=await begin(f,recent,{operation:"rotation",credentialId:one.credential.id,replacementCredentialId:next.id});
 await confirm(f,rotation);assert.equal(await active(f,one.credential),null);assert.ok(await active(f,next));
 const single=await begin(f,{...recent,credential:next},{operation:"credential",credentialId:next.id});await confirm(f,single);
 assert.equal(await active(f,next),null);
});

test("cancel, code expiry and bounded recovery verify committed results without signing keys",async t=>{
 const f=await fixture(t),c=await connected(f),p=await begin(f,c);
 const cancelled=await confirm(f,p,1,true),result=await f.service.disconnection.result(cancelled);
 assert.equal(result.status,"cancelled");assert.deepEqual(result.revokedCredentialIds,[]);assert.ok(await active(f,c.credential));
 const fresh=await begin(f,c);await confirm(f,fresh);f.restart();
 const body=resultBody(fresh);f.advance(120001);
 await assert.rejects(f.service.disconnection.result({...body,completionCode:random()}),{status:400});
 delete f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS;
 const recovered=await f.service.disconnection.recover(body);assert.equal(recovered.status,"revoked");assert.equal(recovered.recovered,true);
 await assert.rejects(f.service.disconnection.recover(body),{status:409,code:"recovery_used"});
});

test("completion cannot be forged, replayed or redeemed for another installation",async t=>{
 const f=await fixture(t),c=await connected(f),other=await connected(f),p=await begin(f,c),receipt=await confirm(f,p);
 for(const extra of [{completionCode:random()},{requestProof:random()},{codeVerifier:random()},{installationId:other.provision.installationId},{redirectUri:"https://evil.test/"},{state:random()},{clientInstallationId:crypto.randomUUID()}])await assert.rejects(f.service.disconnection.result({...receipt,...extra}),{status:400});
 const answers=await Promise.allSettled([f.service.disconnection.result(receipt),f.service.disconnection.result(receipt)]);
 assert.equal(answers.filter(a=>a.status==="fulfilled").length,1);
 assert.ok(await active(f,other.credential));
 // A lost successful server exchange has one extra authenticated delivery,
 // not another revocation and not another usable completion code.
 assert.equal((await f.service.disconnection.recover(resultBody(p))).status,"revoked");
 await assert.rejects(f.service.disconnection.result(receipt),{status:409});
 await assert.rejects(f.service.disconnection.recover(resultBody(p)),{status:409});
 const stored=await f.all("SELECT * FROM website_disconnection_attempts");const audit=await f.all("SELECT * FROM website_connection_audit");
 for(const value of [c.credential.secret,p.response.requestProof,p.verifier,receipt.completionCode])assert.ok(!JSON.stringify([...stored,...audit]).includes(value));
});

test("expired transactions, changed permissions and login continuation fail closed",async t=>{
 const f=await fixture(t),c=await connected(f,["Enumclaw"],2),p=await begin(f,c);
 const resume=await f.service.disconnection.setResume({requestId:p.response.requestId});
 assert.equal(await f.service.resume(resume),"/connections/disconnect?request="+p.response.requestId);
 assert.equal(await f.service.resume(resume+"forged"),null);
 const view=await f.service.disconnection.prepare({requestId:p.response.requestId,userId:2,sessionToken:"disconnect-session"});
 await f.run("UPDATE users SET role='organizer' WHERE id=2");
 await assert.rejects(f.service.disconnection.confirm({requestId:p.response.requestId,userId:2,sessionToken:"disconnect-session",csrf:view.csrf}),{status:403});
 f.advance(600001);assert.equal(await f.service.resume(resume),null);
 await assert.rejects(f.service.disconnection.prepare({requestId:p.response.requestId,userId:1,sessionToken:"x"}),{status:400});
});

test("API-hosted confirmation uses real expiring sessions, CSRF and server-only result exchange",async t=>{
 const f=await fixture(t),c=await connected(f),p=await begin(f,c);
 await f.run("CREATE TABLE auth_sessions(tokenHash TEXT PRIMARY KEY,user TEXT,role TEXT,city TEXT,exp INTEGER,createdAt TEXT,userId INTEGER,principalType TEXT)");
 await f.run("UPDATE users SET passwordHash='fixture-password-hash' WHERE id=1");
 const {createSessionStore}=require("../lib/auth-sessions");
 const store=createSessionStore({get:f.get,filename:f.filename,bootstrapUser:"fixture-bootstrap",ttlMs:3600000});
 const session=await store.createAccountSession({id:1,passwordHash:"fixture-password-hash"});
 const express=require("express"),{createConnectionRouter}=require("../routes/website-connections");
 const {router,service}=createConnectionRouter({transaction:f.transaction,accountPolicy:f.policy,sessionStore:store,env:{...f.env,NODE_ENV:"test"}});
 const app=express();app.use(express.json());app.use(express.urlencoded({extended:true}));app.use("/connections",router);
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
 const base="http://127.0.0.1:"+server.address().port,url="/connections/disconnect?request="+p.response.requestId;
 const anonymous=await fetch(base+url,{redirect:"manual"});assert.equal(anonymous.status,302);assert.equal(anonymous.headers.get("location"),"/login");
 const resume=anonymous.headers.get("set-cookie").split(";")[0].slice("oc_connect_resume=".length);
 assert.equal(await service.resume(resume),url);
 const headers={Cookie:"oc_auth="+session,Accept:"text/html"};
 const page=await fetch(base+url,{headers}),html=await page.text();assert.equal(page.status,200);assert.equal(page.headers.get("referrer-policy"),"same-origin");
 assert.ok(html.includes("Disconnect OpenCircle Website"));for(const secret of [c.credential.secret,p.response.requestProof,p.verifier])assert.ok(!html.includes(secret));
 let csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 const post=(token,extra={})=>fetch(base+"/connections/disconnect",{method:"POST",redirect:"manual",headers:{Cookie:"oc_auth="+token,Origin:f.env.DASHBOARD_ORIGIN,...extra},body:new URLSearchParams({requestId:p.response.requestId,csrf})});
 assert.equal((await post(session,{Origin:"null"})).status,403);assert.ok(await active(f,c.credential));
 await f.run("UPDATE auth_sessions SET exp=0");assert.equal((await post(session)).status,401);
 assert.equal((await fetch(base+url,{headers,redirect:"manual"})).headers.get("location"),"/login");
 const fresh=await store.createAccountSession({id:1,passwordHash:"fixture-password-hash"});
 const newPage=await (await fetch(base+url,{headers:{Cookie:"oc_auth="+fresh}})).text();csrf=newPage.match(/name="csrf" value="([^"]+)"/)[1];
 const confirmed=await post(fresh);assert.equal(confirmed.status,303);assert.equal(confirmed.headers.get("referrer-policy"),"no-referrer");
 const callback=new URL(confirmed.headers.get("location"));assert.equal(callback.origin,"https://website.example.test");assert.equal(callback.pathname,"/wp/wp-admin/admin-post.php");
 const body={...resultBody(p),completionCode:callback.searchParams.get("completion_code")};
 const redeem=origin=>fetch(base+"/connections/disconnect/result",{method:"POST",headers:{"Content-Type":"application/json",...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
 assert.equal((await redeem("https://website.example.test")).status,403);
 const receipt=await redeem();assert.equal(receipt.status,200);assert.equal((await receipt.json()).status,"revoked");assert.equal((await redeem()).status,409);
 assert.equal(await active(f,c.credential),null);
});

test("rotation rechecks the replacement at confirmation and recovery cannot precede a decision",async t=>{
 const f=await fixture(t),c=await connected(f);
 const nextStart=await f.start({replaceInstallationId:c.provision.installationId,installationId:c.initial.body.installationId});
 const issued=await f.service.redeem(await f.approve(nextStart)),replacement=issued.credentials[0];
 await f.service.activate(f.sign(replacement,{credentialId:replacement.id,activationChallenge:replacement.activationChallenge}));
 const p=await begin(f,c,{operation:"rotation",credentialId:c.credential.id,replacementCredentialId:replacement.id});
 await assert.rejects(f.service.disconnection.recover(resultBody(p)),{status:400});
 const view=await f.service.disconnection.prepare({requestId:p.response.requestId,userId:1,sessionToken:"disconnect-session"});
 await f.service.manage({userId:1,action:"revokeCredential",installationId:c.provision.installationId,credentialId:replacement.id});
 await assert.rejects(f.service.disconnection.confirm({requestId:p.response.requestId,userId:1,sessionToken:"disconnect-session",csrf:view.csrf}),{status:409});
 assert.ok(await active(f,c.credential));
});
