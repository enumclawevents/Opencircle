"use strict";
const crypto = require("node:crypto");
const { resolveSigningCredential } = require("./website-credentials");
const token = () => crypto.randomBytes(32).toString("base64url");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const validToken = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value,"base64url").toString("base64url") === value;
const pkce = verifier => crypto.createHash("sha256").update(verifier).digest("base64url");
async function ensureWebsiteDisconnectionSchema(run) {
  await run(`CREATE TABLE IF NOT EXISTS website_disconnection_attempts (
    id TEXT PRIMARY KEY, installationId TEXT NOT NULL, clientInstallationId TEXT NOT NULL,
    redirectUri TEXT NOT NULL, siteUrl TEXT NOT NULL, operation TEXT NOT NULL,
    city TEXT, credentialId TEXT, replacementCredentialId TEXT,
    state TEXT NOT NULL, pkceChallenge TEXT NOT NULL, requestProofHash TEXT NOT NULL,
    createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, status TEXT NOT NULL,
    consentUserId INTEGER, consentSessionHash TEXT, csrfHash TEXT, resumeHash TEXT,
    confirmedByUserId INTEGER, completedAt INTEGER, completionCodeHash TEXT UNIQUE,
    completionExpiresAt INTEGER, recoveryExpiresAt INTEGER, claimedAt INTEGER, recoveryUsedAt INTEGER,
    resultJson TEXT
  )`);
  await run("CREATE INDEX IF NOT EXISTS idx_website_disconnect_expiry ON website_disconnection_attempts(expiresAt)");
}
// This service uses the existing registry and permission helpers supplied by
// Phase B. A site signature can initiate a request, never approve revocation.
function createDisconnectionService({transaction,registry,authorize,credentialAuthority,issuer,safe,fail,now=Date.now,env=process.env}) {
  const operationNames = ["installation","city","credential","rotation"];
  async function request(tx,id,pending=false) {
    if(!validToken(id))fail(400,"invalid_request");
    const row=await tx.get("SELECT * FROM website_disconnection_attempts WHERE id=?",[id]);
    if(!row)fail(400,"invalid_request");
    if(pending&&(row.status!=="pending"||row.expiresAt<=now()))fail(400,"disconnect_expired");
    return row;
  }
  async function targets(tx,row,userId=null) {
    const connection=await tx.get("SELECT id,siteUrl,status FROM website_installations WHERE id=?",[row.installationId]);
    if(!connection || connection.siteUrl!==row.siteUrl)fail(404,"not_found");
    const grants=await tx.all("SELECT city,revokedAt FROM website_authorized_cities WHERE installationId=? ORDER BY city",[row.installationId]);
    let cities;
    if(row.operation==="installation") cities=grants.map(g=>g.city);
    else if(row.operation==="city") {
      if(!grants.some(g=>g.city===row.city))fail(400,"invalid_request");
      cities=[row.city];
    } else {
      const old=await tx.get("SELECT id,city FROM website_signing_credentials WHERE id=? AND installationId=?",[row.credentialId,row.installationId]);
      if(!old)fail(400,"invalid_request");
      cities=[old.city];
      if(row.operation==="rotation") {
        const replacement=await tx.get(`SELECT id FROM website_signing_credentials
          WHERE id=? AND installationId=? AND city=? AND status='active'
            AND activatedAt IS NOT NULL AND replacesCredentialId=?
            AND (expiresAt IS NULL OR expiresAt>?)`,[row.replacementCredentialId,row.installationId,old.city,old.id,now()]);
        if(!replacement || connection.status!=="active" || !grants.some(g=>g.city===old.city && !g.revokedAt))fail(409,"replacement_not_active");
      }
    }
    if(userId!==null) {
      if(!await authorize({tx,actorUserId:userId,installationId:row.installationId}))fail(403,"not_authorized");
      for(const city of cities)if(!await authorize({tx,actorUserId:userId,installationId:row.installationId,city}))fail(403,"not_authorized");
    }
    const credentialIds = row.operation==="installation" || row.operation==="city"
      ? (await tx.all(`SELECT id FROM website_signing_credentials WHERE installationId=? ${row.operation==="city"?"AND city=?":""} ORDER BY id`,row.operation==="city"?[row.installationId,row.city]:[row.installationId])).map(c=>c.id)
      : [row.credentialId];
    return {connection,cities,credentialIds};
  }
  async function verifyStart(tx,body,headers,method,path) {
    const id=headers["X-OC-Key-Id"];
    if(typeof id!=="string"||!id.startsWith("ocm_"))fail(401,"invalid_signature");
    const credential=await resolveSigningCredential(tx,id,env,now(),credentialAuthority);
    const row=await tx.get("SELECT installationId FROM website_signing_credentials WHERE id=?",[id]);
    if(!credential||row?.installationId!==body.installationId)fail(401,"invalid_signature");
    const timestamp=headers["X-OC-Timestamp"],nonce=headers["X-OC-Nonce"],signature=headers["X-OC-Signature"];
    if(!/^\d{10}$/.test(timestamp||"")||Math.abs(now()-Number(timestamp)*1000)>300000||!/^[A-Za-z0-9_-]{22,64}$/.test(nonce||"")||!/^[a-f0-9]{64}$/.test(signature||""))fail(401,"invalid_signature");
    const expected=crypto.createHmac("sha256",credential.secret).update([method,path,timestamp,nonce,hash(JSON.stringify(body))].join("\n")).digest("hex");
    if(!crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signature,"hex")))fail(401,"invalid_signature");
    await tx.run("DELETE FROM occurrence_engagement_nonces WHERE expiresAt<?",[now()]);
    const claim=await tx.run("INSERT OR IGNORE INTO occurrence_engagement_nonces VALUES (?,?,?)",[id,nonce,now()+600000]);
    if(!claim.changes)fail(409,"request_used");
    return id;
  }
  async function validateResult(tx,body) {
    if(!body || Object.keys(body).some(k=>!["requestId","installationId","clientInstallationId","redirectUri","state","codeVerifier","requestProof","completionCode"].includes(k)))fail(400,"invalid_result");
    const row=await request(tx,body.requestId);
    if(!["confirmed","cancelled"].includes(row.status)||row.installationId!==body.installationId||row.clientInstallationId!==body.clientInstallationId||row.redirectUri!==body.redirectUri||row.state!==body.state||
      !validToken(body.requestProof)||row.requestProofHash!==hash(body.requestProof)||typeof body.codeVerifier!=="string"||!/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier)||row.pkceChallenge!==pkce(body.codeVerifier))fail(400,"invalid_result");
    return row;
  }
  return {
    start: safe(({body,headers,method,path})=>transaction(async tx=>{
      if(!body||Object.keys(body).some(k=>!["installationId","clientInstallationId","redirectUri","state","codeChallenge","codeChallengeMethod","operation","city","credentialId","replacementCredentialId"].includes(k))||
        !operationNames.includes(body.operation)||!validToken(body.state)||!validToken(body.codeChallenge)||body.codeChallengeMethod!=="S256")fail(400,"invalid_request");
      const initiatingCredentialId=await verifyStart(tx,body,headers,method,path);
      // The callback and client identity must come from the existing, verified
      // provisioning record, not a newly supplied URL or installation assertion.
      const registration=await tx.get(`SELECT a.clientInstallationId,a.redirectUri,a.siteUrl FROM website_connection_attempts a
        JOIN json_each(a.activationProofs) p ON p.key=?
        WHERE a.installationId=? AND a.status='redeemed' AND a.verifiedAt IS NOT NULL LIMIT 1`,[initiatingCredentialId,body.installationId]);
      if(!registration||registration.clientInstallationId!==body.clientInstallationId||registration.redirectUri!==body.redirectUri)fail(400,"callback_mismatch");
      if(body.operation==="installation"&&(body.city!==undefined||body.credentialId!==undefined||body.replacementCredentialId!==undefined)||
        body.operation==="city"&&(typeof body.city!=="string"||body.credentialId!==undefined||body.replacementCredentialId!==undefined)||
        ["credential","rotation"].includes(body.operation)&&(typeof body.credentialId!=="string"||body.city!==undefined)||
        body.operation==="credential"&&body.replacementCredentialId!==undefined||
        body.operation==="rotation"&&typeof body.replacementCredentialId!=="string")fail(400,"invalid_request");
      const id=token(),proof=token();
      const row={...body,siteUrl:registration.siteUrl};await targets(tx,row);
      await tx.run("DELETE FROM website_disconnection_attempts WHERE expiresAt<? AND status='pending'",[now()]);
      if((await tx.get("SELECT COUNT(*) AS n FROM website_disconnection_attempts WHERE status='pending'")).n>=1000)fail(429,"try_later");
      await tx.run(`INSERT INTO website_disconnection_attempts(id,installationId,clientInstallationId,redirectUri,siteUrl,operation,city,credentialId,replacementCredentialId,state,pkceChallenge,requestProofHash,createdAt,expiresAt,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,[id,body.installationId,registration.clientInstallationId,registration.redirectUri,registration.siteUrl,body.operation,body.city||null,body.credentialId||null,body.replacementCredentialId||null,body.state,body.codeChallenge,hash(proof),now(),now()+600000]);
      return {requestId:id,requestProof:proof,expiresIn:600,confirmationUrl:issuer()+"/connections/disconnect?request="+id};
    })),
    prepare: safe(({requestId,userId,sessionToken})=>transaction(async tx=>{
      const row=await request(tx,requestId,true),affected=await targets(tx,row,userId),csrf=token();
      await tx.run("UPDATE website_disconnection_attempts SET consentUserId=?,consentSessionHash=?,csrfHash=? WHERE id=?",[userId,hash(sessionToken),hash(csrf),requestId]);
      return {siteUrl:row.siteUrl,operation:row.operation,cities:affected.cities,credentialIds:affected.credentialIds,replacementCredentialId:row.replacementCredentialId,csrf};
    }),false),
    setResume: safe(({requestId})=>transaction(async tx=>{
      await request(tx,requestId,true);const value=token();await tx.run("UPDATE website_disconnection_attempts SET resumeHash=? WHERE id=?",[hash(value),requestId]);
      return "disconnect."+requestId+"."+value;
    }),false),
    resume: async cookie=>{
      try {
        const [purpose,id,value]=String(cookie||"").split(".");if(purpose!=="disconnect"||!validToken(value))return null;
        return await transaction(async tx=>{const row=await request(tx,id,true);return row.resumeHash===hash(value)?"/connections/disconnect?request="+id:null;});
      }catch{return null;}
    },
    confirm: safe(({requestId,userId,sessionToken,csrf,cancel=false})=>transaction(async tx=>{
      const row=await request(tx,requestId,true);
      if(row.consentUserId!==userId||row.consentSessionHash!==hash(sessionToken)||!validToken(csrf)||row.csrfHash!==hash(csrf))fail(403,"invalid_consent");
      const affected=await targets(tx,row,userId),r=registry(tx),input={actorUserId:userId,installationId:row.installationId,city:row.city,credentialId:row.credentialId};
      if(!cancel) {
        if(row.operation==="installation") {if(affected.connection.status!=="revoked")await r.revokeInstallation(input);}
        else if(row.operation==="city")await r.revokeCity(input);
        else await r.revokeCredential(input);
      }
      const result={ok:true,requestId:row.id,installationId:row.installationId,operation:row.operation,
        status:cancel?"cancelled":"revoked",affectedCities:affected.cities,
        revokedCredentialIds:cancel?[]:affected.credentialIds,replacementCredentialId:row.replacementCredentialId||null,completedAt:new Date(now()).toISOString()};
      const code=token();
      await tx.run(`UPDATE website_disconnection_attempts SET status=?,confirmedByUserId=?,completedAt=?,completionCodeHash=?,completionExpiresAt=?,recoveryExpiresAt=?,resultJson=?,csrfHash=NULL,resumeHash=NULL WHERE id=?`,
        [cancel?"cancelled":"confirmed",userId,now(),hash(code),now()+120000,now()+600000,JSON.stringify(result),row.id]);
      await tx.run("INSERT INTO website_connection_audit(installationId,credentialId,city,actorUserId,action,createdAt) VALUES (?,?,?,?,?,?)",[row.installationId,row.credentialId,row.city,userId,cancel?"disconnection.cancelled":"disconnection.confirmed",result.completedAt]);
      const url=new URL(row.redirectUri);url.searchParams.set("state",row.state);url.searchParams.set("iss",issuer());url.searchParams.set("completion_code",code);
      return url.href;
    }),false),
    result: safe(body=>transaction(async tx=>{
      const row=await validateResult(tx,body);
      if(row.claimedAt!==null)fail(409,"completion_used");
      if(row.completionExpiresAt<=now())fail(400,"completion_expired");
      if(!validToken(body.completionCode)||row.completionCodeHash!==hash(body.completionCode))fail(400,"invalid_result");
      await tx.run("UPDATE website_disconnection_attempts SET claimedAt=?,completionCodeHash=NULL WHERE id=?",[now(),row.id]);
      return JSON.parse(row.resultJson);
    }),false),
    // A bounded delivery recovery, not a second completion or revocation. It
    // authenticates the initiating PHP server even after its signing key is gone.
    recover: safe(body=>transaction(async tx=>{
      const row=await validateResult(tx,body);
      if(row.recoveryUsedAt!==null)fail(409,"recovery_used");
      if(row.recoveryExpiresAt<=now())fail(400,"completion_expired");
      await tx.run("UPDATE website_disconnection_attempts SET claimedAt=COALESCE(claimedAt,?),recoveryUsedAt=?,completionCodeHash=NULL WHERE id=?",[now(),now(),row.id]);
      return {...JSON.parse(row.resultJson),recovered:true};
    }),false),
  };
}
module.exports={ensureWebsiteDisconnectionSchema,createDisconnectionService};
