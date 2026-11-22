"use strict";
const crypto = require("node:crypto");
const { ensureWebsiteDisconnectionSchema, createDisconnectionService } = require("./website-disconnection");
const { createWebsiteCredentialRegistry, canonicalSiteUrl, resolvePendingCredential, resolveSigningCredential, validateEncryptionConfiguration, RegistryError } = require("./website-credentials");
const { fetchInstallationProof } = require("./website-verification");
const token = () => crypto.randomBytes(32).toString("base64url");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const tokenValid = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value,"base64url").toString("base64url") === value;
const challenge = verifier => crypto.createHash("sha256").update(verifier).digest("base64url");
class ConnectionError extends Error { constructor(status, code) { super(code); this.status=status; this.code=code; } }
const fail = (status, code) => { throw new ConnectionError(status,code); };
async function ensureWebsiteAuthorizationSchema(run) {
  await ensureWebsiteDisconnectionSchema(run);
  await run(`CREATE TABLE IF NOT EXISTS website_connection_attempts (
    id TEXT PRIMARY KEY, clientInstallationId TEXT NOT NULL, siteUrl TEXT NOT NULL, homeUrl TEXT NOT NULL,
    replaceInstallationId TEXT, redirectUri TEXT NOT NULL, requesterLabel TEXT NOT NULL, requestedCities TEXT NOT NULL,
    state TEXT NOT NULL, pkceChallenge TEXT NOT NULL, proofHash TEXT NOT NULL,
    createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, status TEXT NOT NULL,
    verifiedAt INTEGER, consentUserId INTEGER, consentSessionHash TEXT, csrfHash TEXT, resumeHash TEXT,
    approvedByUserId INTEGER, approvedCities TEXT, codeHash TEXT UNIQUE, codeExpiresAt INTEGER,
    installationId TEXT, activationProofs TEXT, activationExpiresAt INTEGER
  )`);
  await run("CREATE INDEX IF NOT EXISTS idx_website_attempt_expiry ON website_connection_attempts(expiresAt)");
}
function createConnectionService({ transaction, accountPolicy, env=process.env, now=Date.now, verify=fetchInstallationProof }) {
  function issuer() {
    try {
      const value=env.DASHBOARD_ORIGIN;
      const url=new URL(value);
      if (url.protocol!=="https:" || url.origin!==value || url.username || url.password) fail(503,"configuration_unavailable");
      return url.origin;
    } catch { fail(503,"configuration_unavailable"); }
  }
  function configured(needsKey=true) {
    if (env.WEBSITE_CONNECTIONS_ENABLED!=="true") fail(503,"connections_disabled");
    issuer();
    try { if(needsKey) validateEncryptionConfiguration(env); } catch { fail(503,"configuration_unavailable"); }
  }
  async function permissions(tx,userId) {
    const user=await tx.get("SELECT id,role,city,permissionsJson FROM users WHERE id=?",[userId]);
    if (!user || !["admin","developer","area_manager"].includes(user.role)) fail(403,"not_authorized");
    return { user,cities: accountPolicy.getUserAllowedCities(user).filter(city=>accountPolicy.supportedCities.includes(city)) };
  }
  async function authorize({tx,actorUserId,city,installationId}) {
    try {
      const p=await permissions(tx,actorUserId);
      if (city && !p.cities.includes(city)) return false;
      if (installationId) {
        const row=await tx.get("SELECT createdByUserId FROM website_installations WHERE id=?",[installationId]);
        if (!row || p.user.role!=="admin" && row.createdByUserId!==actorUserId) return false;
      }
      return true;
    } catch { return false; }
  }
  const credentialAuthority=async ({tx,actorUserId,city})=> {
    try { return (await permissions(tx,actorUserId)).cities.includes(city); } catch { return false; }
  };
  const registry=tx=>createWebsiteCredentialRegistry({transaction: fn=>fn(tx),authorize,env,now});
  const attempt=async(tx,id) => {
    if (!tokenValid(id)) fail(400,"invalid_request");
    const row=await tx.get("SELECT * FROM website_connection_attempts WHERE id=?",[id]);
    if (!row || row.expiresAt<=now() || !["pending","approved"].includes(row.status)) fail(400,"expired_connection");
    return row;
  };
  const scope=async(tx,row,cities) => {
    const p=await permissions(tx,row.approvedByUserId);
    if (!cities.every(city=>p.cities.includes(city))) fail(403,"not_authorized");
  };
  const safe=(fn,needsKey=true)=>async input=>{
    configured(needsKey);
    try { return await fn(input || {}); }
    catch(error) {
      if(error instanceof ConnectionError) throw error;
      if(error instanceof RegistryError) {
        const codes={FORBIDDEN:[403,"not_authorized"],NOT_FOUND:[404,"not_found"],INVALID:[400,"invalid_request"],CONFLICT:[409,"conflict"]};
        const mapped=codes[error.code];if(mapped)fail(...mapped);
      }
      fail(503,"connection_unavailable");
    }
  };
  const disconnection=createDisconnectionService({transaction,registry,authorize,credentialAuthority,issuer,safe,fail,now,env});
  return {
    issuer, authorize, disconnection,
    // Used for ongoing credential scope checks, not connection management ownership.
    credentialAuthority,
    start: safe(async body=>{
      const siteUrl=canonicalSiteUrl(body.siteUrl),homeUrl=canonicalSiteUrl(body.homeUrl);
      const site=new URL(siteUrl),home=new URL(homeUrl);
      if(site.origin!==home.origin || site.port || home.port || site.pathname.includes("%") || home.pathname.includes("%")) fail(400,"invalid_request");
      const redirectUri=siteUrl+"wp-admin/admin-post.php?action=oc_connection_callback";
      if(body.replaceInstallationId!==undefined && !/^[a-f0-9-]{36}$/i.test(body.replaceInstallationId)) fail(400,"invalid_request");
      if(body.redirectUri!==redirectUri || !/^[a-f0-9-]{36}$/i.test(body.installationId || "") || !tokenValid(body.state) ||
        body.codeChallengeMethod!=="S256" || !tokenValid(body.codeChallenge) ||
        !Array.isArray(body.cities) || !body.cities.length || body.cities.length>accountPolicy.supportedCities.length ||
        new Set(body.cities).size!==body.cities.length || !body.cities.every(city=>accountPolicy.supportedCities.includes(city))) fail(400,"invalid_request");
      const id=token(), proof=token();
      await transaction(async tx=>{
        // Expired, never-provisioned attempts carry no credentials and can be pruned.
        await tx.run("DELETE FROM website_connection_attempts WHERE expiresAt<? AND status IN ('pending','approved','cancelled')",[now()]);
        const size=await tx.get("SELECT COUNT(*) AS n FROM website_connection_attempts WHERE status IN ('pending','approved')");
        if(size.n>=1000) fail(429,"try_later");
        await tx.run(`INSERT INTO website_connection_attempts(id,clientInstallationId,siteUrl,homeUrl,replaceInstallationId,redirectUri,requesterLabel,requestedCities,state,pkceChallenge,proofHash,createdAt,expiresAt,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,[id,body.installationId,siteUrl,homeUrl,body.replaceInstallationId||null,redirectUri,
          typeof body.requesterLabel==="string"?body.requesterLabel.replace(/[\x00-\x1f\x7f]/g,"").slice(0,100):"WordPress administrator",
          JSON.stringify(body.cities),body.state,body.codeChallenge,hash(proof),now(),now()+600000]);
      });
      return { requestId:id,verificationChallenge:proof,expiresIn:600,authorizationUrl:issuer()+"/connections/authorize?request="+id };
    }),
    prepareConsent: safe(async ({requestId,userId,sessionToken})=>{
      const initial=await transaction(async tx=>{
        const row=await attempt(tx,requestId),p=await permissions(tx,userId);
        if(row.replaceInstallationId && !await authorize({tx,actorUserId:userId,installationId:row.replaceInstallationId})) fail(403,"not_authorized");
        if(row.status!=="pending") fail(400,"expired_connection");
        return {row,allowedCities:JSON.parse(row.requestedCities).filter(city=>p.cities.includes(city))};
      });
      if(!initial.allowedCities.length) fail(403,"not_authorized");
      // Fixed HTTPS route, pinned DNS and bounded response. No DB lock during I/O.
      const proof=await verify(initial.row.siteUrl,requestId);
      if (!proof || proof.requestId!==requestId || proof.installationId!==initial.row.clientInstallationId ||
        proof.siteUrl!==initial.row.siteUrl || proof.homeUrl!==initial.row.homeUrl || proof.redirectUri!==initial.row.redirectUri ||
        !tokenValid(proof.challenge) || hash(proof.challenge)!==initial.row.proofHash) fail(400,"installation_not_verified");
      const csrf=token();
      await transaction(async tx=>{
        const row=await attempt(tx,requestId); await permissions(tx,userId);
        if(row.status!=="pending") fail(400,"expired_connection");
        await tx.run("UPDATE website_connection_attempts SET verifiedAt=?,consentUserId=?,consentSessionHash=?,csrfHash=? WHERE id=?",[now(),userId,hash(sessionToken),hash(csrf),requestId]);
      });
      return { siteUrl:initial.row.siteUrl,homeUrl:initial.row.homeUrl,requesterLabel:initial.row.requesterLabel,
        requestedCities:JSON.parse(initial.row.requestedCities),allowedCities:initial.allowedCities,csrf };
    }),
    setResume: safe(({requestId})=>transaction(async tx=>{
      const row=await attempt(tx,requestId);
      if(row.status!=="pending") fail(400,"expired_connection");
      const value=token(); await tx.run("UPDATE website_connection_attempts SET resumeHash=? WHERE id=?",[hash(value),requestId]);
      return requestId+"."+value;
    })),
    resume: async cookie=>{
      try {
        configured(false);
        if(String(cookie||"").startsWith("disconnect."))return disconnection.resume(cookie);
        const [id,value]=String(cookie||"").split(".");
        if(!tokenValid(value)) return null;
        return await transaction(async tx=>{
          const row=await attempt(tx,id);
          return row.status==="pending" && row.resumeHash===hash(value)?"/connections/authorize?request="+id:null;
        });
      } catch { return null; }
    },
    consent: safe(({requestId,userId,sessionToken,csrf,cities,cancel})=>transaction(async tx=>{
      const row=await attempt(tx,requestId);
      if(row.status!=="pending" || !row.verifiedAt || row.consentUserId!==userId || row.consentSessionHash!==hash(sessionToken) || !tokenValid(csrf) || row.csrfHash!==hash(csrf)) fail(403,"invalid_consent");
      const p=await permissions(tx,userId);
      if(row.replaceInstallationId && !await authorize({tx,actorUserId:userId,installationId:row.replaceInstallationId})) fail(403,"not_authorized");
      const url=new URL(row.redirectUri);url.searchParams.set("state",row.state);url.searchParams.set("iss",issuer());
      if(cancel) { await tx.run("UPDATE website_connection_attempts SET status='cancelled',csrfHash=NULL,resumeHash=NULL WHERE id=?",[requestId]);url.searchParams.set("error","access_denied");return url.href; }
      if(!Array.isArray(cities)||!cities.length||new Set(cities).size!==cities.length||!cities.every(city=>JSON.parse(row.requestedCities).includes(city)&&p.cities.includes(city))) fail(403,"not_authorized");
      const code=token();
      await tx.run("UPDATE website_connection_attempts SET status='approved',approvedByUserId=?,approvedCities=?,codeHash=?,codeExpiresAt=?,csrfHash=NULL,resumeHash=NULL WHERE id=?",[userId,JSON.stringify(cities),hash(code),now()+120000,requestId]);
      url.searchParams.set("code",code); return url.href;
    })),
    redeem: safe(body=>transaction(async tx=>{
      if(!tokenValid(body.code)||!tokenValid(body.state)||typeof body.codeVerifier!=="string"||!/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier)) fail(400,"invalid_grant");
      const row=await attempt(tx,body.requestId);
      if(row.status!=="approved"||row.codeExpiresAt<=now()||row.codeHash!==hash(body.code)||row.state!==body.state||row.redirectUri!==body.redirectUri||row.clientInstallationId!==body.installationId||row.pkceChallenge!==challenge(body.codeVerifier)) fail(400,"invalid_grant");
      const cities=JSON.parse(row.approvedCities);await scope(tx,row,cities);
      const r=registry(tx),actorUserId=row.approvedByUserId;
      let connection;
      if(row.replaceInstallationId) {
        if(!await authorize({tx,actorUserId,installationId:row.replaceInstallationId})) fail(403,"not_authorized");
        connection=await tx.get("SELECT id,siteUrl,status FROM website_installations WHERE id=?",[row.replaceInstallationId]);
        if(!connection || connection.siteUrl!==row.siteUrl || connection.status==="revoked") fail(400,"invalid_grant");
      } else connection=await r.registerInstallation({actorUserId,siteUrl:row.siteUrl});
      const credentials=[],proofs={};
      for(const city of cities) {
        await r.grantCity({actorUserId,installationId:connection.id,city});
        const predecessor=await tx.get("SELECT id FROM website_signing_credentials WHERE installationId=? AND city=? AND status='active' AND (expiresAt IS NULL OR expiresAt>?) ORDER BY createdAt DESC LIMIT 1",[connection.id,city,now()]);
        const c=await r.issueCredential({actorUserId,installationId:connection.id,city,replacesCredentialId:predecessor?.id||null});
        const activationChallenge=token();proofs[c.id]=hash(activationChallenge);credentials.push({...c,activationChallenge});
      }
      await tx.run("UPDATE website_connection_attempts SET status='redeemed',codeHash=NULL,installationId=?,activationProofs=?,activationExpiresAt=? WHERE id=?",[connection.id,JSON.stringify(proofs),now()+600000,row.id]);
      return { installationId:connection.id,siteUrl:connection.siteUrl,credentials,activationExpiresIn:600 };
    })),
    activate: safe(({body,headers,method,path})=>transaction(async tx=>{
      if(!body||Object.keys(body).some(k=>!["credentialId","activationChallenge"].includes(k))||!tokenValid(body.activationChallenge)||body.credentialId!==headers["X-OC-Key-Id"]) fail(400,"invalid_request");
      const row=await tx.get(`SELECT a.* FROM website_connection_attempts a
        JOIN website_signing_credentials c ON c.installationId=a.installationId
        JOIN json_each(a.activationProofs) p ON p.key=c.id
        WHERE c.id=? AND a.status='redeemed' LIMIT 1`,[body.credentialId]);
      if(!row || row.activationExpiresAt<=now() || JSON.parse(row.activationProofs)[body.credentialId]!==hash(body.activationChallenge)) fail(400,"activation_expired");
      await scope(tx,row,JSON.parse(row.approvedCities));
      const c=await resolvePendingCredential(tx,body.credentialId,env,now());
      if(!c) fail(401,"invalid_signature");
      const timestamp=headers["X-OC-Timestamp"],nonce=headers["X-OC-Nonce"],signature=headers["X-OC-Signature"];
      if(!/^\d{10}$/.test(timestamp||"")||Math.abs(now()-Number(timestamp)*1000)>300000||!/^[A-Za-z0-9_-]{22,64}$/.test(nonce||"")||!/^[a-f0-9]{64}$/.test(signature||"")) fail(401,"invalid_signature");
      const expected=crypto.createHmac("sha256",c.secret).update([method,path,timestamp,nonce,hash(JSON.stringify(body))].join("\n")).digest("hex");
      if(!crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signature,"hex"))) fail(401,"invalid_signature");
      await tx.run("DELETE FROM occurrence_engagement_nonces WHERE expiresAt<?",[now()]);
      const claimed=await tx.run("INSERT OR IGNORE INTO occurrence_engagement_nonces VALUES (?,?,?)",[body.credentialId,nonce,now()+600000]);
      if(!claimed.changes) fail(409,"request_used");
      await registry(tx).activateCredential({actorUserId:row.approvedByUserId,credentialId:body.credentialId});
      return {ok:true,credentialId:body.credentialId,status:"active"};
    })),
    check: safe(({body,headers,method,path})=>transaction(async tx=>{
      if(!body||Object.keys(body).some(k=>k!=="installationId")) fail(400,"invalid_request");
      const c=await resolveSigningCredential(tx,headers["X-OC-Key-Id"],env,now(),credentialAuthority);
      const row=await tx.get("SELECT installationId FROM website_signing_credentials WHERE id=?",[headers["X-OC-Key-Id"]]);
      if(!c || row?.installationId!==body.installationId) fail(401,"invalid_signature");
      const timestamp=headers["X-OC-Timestamp"],nonce=headers["X-OC-Nonce"],signature=headers["X-OC-Signature"];
      if(!/^\d{10}$/.test(timestamp||"")||Math.abs(now()-Number(timestamp)*1000)>300000||!/^[A-Za-z0-9_-]{22,64}$/.test(nonce||"")||!/^[a-f0-9]{64}$/.test(signature||"")) fail(401,"invalid_signature");
      const expected=crypto.createHmac("sha256",c.secret).update([method,path,timestamp,nonce,hash(JSON.stringify(body))].join("\n")).digest("hex");
      if(!crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signature,"hex"))) fail(401,"invalid_signature");
      await tx.run("DELETE FROM occurrence_engagement_nonces WHERE expiresAt<?",[now()]);
      const claim=await tx.run("INSERT OR IGNORE INTO occurrence_engagement_nonces VALUES (?,?,?)",[headers["X-OC-Key-Id"],nonce,now()+600000]);
      if(!claim.changes) fail(409,"request_used");
      return {ok:true,installationId:row.installationId,city:c.city,status:"active"};
    })),
    manage: safe(({userId,action,installationId,credentialId,city})=>transaction(async tx=>{
      const r=registry(tx),input={actorUserId:userId,installationId,credentialId,city};
      if(!["status","revokeCredential","revokeInstallation","revokeCity","audit","list","pending"].includes(action)) fail(400,"invalid_request");
      if(action==="pending") {
        const p=await permissions(tx,userId);
        const rows=await tx.all("SELECT id,siteUrl,requestedCities,status,expiresAt FROM website_connection_attempts WHERE (consentUserId=? OR approvedByUserId=?) AND status IN ('pending','approved') AND expiresAt>? ORDER BY createdAt DESC LIMIT 100",[userId,userId,now()]);
        return {pending:rows.filter(row=>JSON.parse(row.requestedCities).every(city=>p.cities.includes(city)))};
      }
      if(action==="list") {
        const p=await permissions(tx,userId);
        const rows=await tx.all("SELECT id,siteUrl,status FROM website_installations WHERE (?='admin' OR createdByUserId=?) ORDER BY createdAt DESC LIMIT 100",[p.user.role,userId]);
        const visible=[];
        for(const row of rows) { try { await r.getStatus({actorUserId:userId,installationId:row.id});visible.push(row); } catch {} }
        return {connections:visible};
      }
      await r.getStatus({actorUserId:userId,installationId});
      if(action==="status") return r.getStatus(input);
      if(action==="audit") return {events:await tx.all("SELECT action,credentialId,city,actorUserId,createdAt FROM website_connection_audit WHERE installationId=? ORDER BY id DESC LIMIT 100",[installationId])};
      if(credentialId) { const c=await tx.get("SELECT installationId FROM website_signing_credentials WHERE id=?",[credentialId]);if(c?.installationId!==installationId) fail(404,"not_found"); }
      await r[action](input);return {ok:true};
    }),false),
  };
}
module.exports = { ensureWebsiteAuthorizationSchema, createConnectionService, ConnectionError, hash, challenge, tokenValid };
