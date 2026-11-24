"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawn}=require("node:child_process"),sqlite=require("sqlite3"),{DateTime}=require("luxon");
const {config}=require("./fixtures/publications");
async function server(t,configured=true) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"oc-publication-api-")),filename=path.join(dir,"fixture.db"),port=45000+Math.floor(Math.random()*1000),base="http://127.0.0.1:"+port;
 // Inject fixture-only publication metadata into a disposable child process,
 // without editing the bundled catalog or adding a production configuration bypass.
 const program=configured?`const filename=require.resolve('./lib/publications');const lib=require(filename);const c=lib.buildPublicationCatalog(JSON.parse(process.env.FIXTURE_PUBLICATIONS));require.cache[filename].exports={...lib,eventSource:c.eventSource,publicationDirectory:c.directory};require('./server');`:`require('./server')`;
 const child=spawn(process.execPath,["-e",program],{cwd:path.resolve(__dirname,".."),env:{PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,NODE_ENV:"test",DB_PATH:filename,PORT:String(port),PUBLIC_SITE_URL:"https://global.example.test",FIXTURE_PUBLICATIONS:JSON.stringify(config())},stdio:"ignore"});
 t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<90;i++){try{if((await fetch(base+"/health")).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const db=new sqlite.Database(filename);t.after(()=>db.close());
 const sql=(query,p=[])=>new Promise((r,j)=>db.all(query,p,(e,rows)=>e?j(e):r(rows)));
 const get=async query=>{const res=await fetch(base+query);return {status:res.status,headers:res.headers,data:await res.json()};};
 return {base,sql,get};
}
test("approved bundled directory is public and contains only the approved metadata",async t=>{
 const f=await server(t,false);for(const url of ["/publications","/publications/"]){const res=await f.get(url);assert.equal(res.status,200);assert.deepEqual(res.data.data.map(p=>p.id),["enumclaw-events","plateau-events"]);assert.equal(res.data.meta.total,2);assert.ok(!/eventRoute|approvedHosts|canonicalCityPublications|credential|installationId/.test(JSON.stringify(res.data)));}
 const directory=(await f.get("/publications")).data;
 assert.deepEqual(directory.areas.map(a=>[a.city,a.publicationId,a.calendarUrl]),[
  ["Enumclaw","enumclaw-events",null],["Buckley","plateau-events",null],
  ["Carbonado","plateau-events",null],["South Prairie","plateau-events",null],["Wilkeson","plateau-events",null]
 ]);
 assert.ok(directory.areas.every(a=>/^city-[a-f0-9]{24}$/.test(a.id)));
 const future=new Date(Date.now()+86400000).toISOString(),end=new Date(Date.now()+90000000).toISOString();
 for(const [i,city]of ["Enumclaw","Buckley","Carbonado","South Prairie","Wilkeson","Seattle"].entries()) {
  await f.sql("INSERT INTO events(id,city,slug,title,startDateTime,endDateTime) VALUES (?,?,?,?,?,?)",[i+1,city,"approved-event-"+(i+1),"Fixture",future,end]);
  const list=await f.get("/events?city="+encodeURIComponent(city));const event=list.data.data[0];
  const publication=city==="Enumclaw"?"enumclaw-events":city==="Seattle"?null:"plateau-events";
  assert.equal(event.sourcePublicationId,publication);
  assert.equal(event.sourceEventUrl,publication?"https://"+(publication==="enumclaw-events"?"enumclawevents.org":"plateauevents.org")+"/events/"+event.slug:null);
 }
 assert.equal((await fetch(f.base+"/admin/dashboard-summary",{headers:{Accept:"application/json"}})).status,401);
});
test("approved fixture publications and event destinations preserve existing feeds, pagination and SEO",async t=>{
 const f=await server(t),directory=await f.get("/publications");assert.equal(directory.status,200);assert.equal(directory.data.data.length,2);assert.equal(directory.headers.get("cache-control"),"public, max-age=60");
 const cachedStatus=await new Promise((resolve,reject)=>{require("node:http").get(f.base+"/publications",{headers:{"If-None-Match":directory.headers.get("etag")}},res=>{res.resume();resolve(res.statusCode);}).on("error",reject);});assert.equal(cachedStatus,304);
 assert.ok(!/credential|installationId|secret|eventRoute|account|canonicalCityPublications/.test(JSON.stringify(directory.data)));
 const day=DateTime.now().setZone("America/Los_Angeles").startOf("day");
 const iso=(d,h)=>day.plus({days:d,hours:h}).toISO({suppressMilliseconds:true});
 const add=(id,city,slug,state,start,end,rule=null,extra={})=>f.sql("INSERT INTO events(id,city,slug,title,organizer,location,startDateTime,endDateTime,lifecycleState,hasRecurrence,recurrenceRule,archived,goingCount,interestedCount,ticketUrl) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[id,city,slug,"Fixture "+id,"Fixture organizer","Town Hall",start,end,state,rule?1:0,rule?JSON.stringify(rule):null,extra.archived||0,11,22,"https://tickets.example.test/"]);
 await add(1,"Enumclaw","cancelled","cancelled",iso(1,12),iso(1,14));
 await add(2,"Enumclaw","ordinary","scheduled",iso(2,12),iso(2,14));
 const items=[1,3,5].map(d=>({date:iso(d,10).slice(0,10),start:iso(d,10),end:iso(d,11)}));
 await add(3,"Enumclaw","series","scheduled",items[0].start,items[0].end,{type:"custom",items});
 await add(4,"Enumclaw","cancelled-series"," CANCELLED ",iso(1,10),iso(1,11),{type:"custom",items});
 await add(5,"Enumclaw","ongoing","scheduled",new Date(Date.now()-3600000).toISOString(),new Date(Date.now()+3600000).toISOString());
 await add(6,"Enumclaw","archived","scheduled",iso(1,9),iso(1,10),null,{archived:1});
 await add(7,"Buckley","regional","scheduled",iso(2,12),iso(2,14));
 await add(8,"Seattle","unmapped","scheduled",iso(2,12),iso(2,14));
 const query="/events?city=Enumclaw&sort=soonest&limit=2";
 const original=await f.get(query);assert.equal(original.status,200);assert.ok(original.data.meta.total>5);
 const filtered=await f.get(query+"&excludeCancelled=1");assert.equal(filtered.status,200);assert.equal(filtered.data.meta.total,5);
 assert.equal(filtered.data.data[0].id,5);assert.equal(filtered.data.data.length,2);assert.equal(filtered.data.meta.nextOffset,2);
 const all=[];let offset=0;
 do{const res=await f.get(query+"&excludeCancelled=1&offset="+offset);all.push(...res.data.data);offset=res.data.meta.nextOffset;}while(offset!==null);
 assert.equal(all.length,5);assert.equal(all.filter(e=>e.id===3).length,3);assert.ok(all.every(e=>![1,4,6].includes(e.id)));
 assert.ok(all.every(e=>e.sourcePublicationId==="enumclaw-events"&&e.sourceEventUrl==="https://enumclaw.example.test/events/"+e.slug));
 assert.deepEqual((await f.get(query+"&excludeCancelled=0")).data,original.data); // independent cache keys; default unchanged
 assert.equal((await f.get("/events?city=Enumclaw&expand=0&excludeCancelled=1")).data.meta.total,3);
 for(const bad of ["true","2","1&excludeCancelled=0"])assert.equal((await f.get("/events?excludeCancelled="+bad)).status,400);
 const detail=await f.get("/events/2");assert.equal(detail.data.data.sourceEventUrl,"https://enumclaw.example.test/events/ordinary");assert.equal(detail.data.data.canonicalUrl,"https://global.example.test/events/ordinary");assert.equal(detail.data.data.ticketUrl,"https://tickets.example.test/");
 assert.equal((await f.get("/events/slug/ordinary")).data.data.sourceEventUrl,detail.data.data.sourceEventUrl);
 assert.equal((await f.get("/events?city=Buckley")).data.data[0].sourcePublicationId,"plateau-events");
 assert.equal((await f.get("/events?city=Seattle")).data.data[0].sourceEventUrl,null);
 assert.equal((await f.get("/events?status=archived&excludeCancelled=1")).status,403);
 assert.deepEqual((await f.sql("SELECT goingCount,interestedCount,lifecycleState FROM events WHERE id=1"))[0],{goingCount:11,interestedCount:22,lifecycleState:"cancelled"});
});
