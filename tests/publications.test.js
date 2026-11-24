"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {buildPublicationCatalog}=require("../lib/publications");
const {config}=require("./fixtures/publications");

test("publication identity, regional coverage and public projection are independent of cities",()=>{
 const catalog=buildPublicationCatalog(config()),directory=catalog.directory();
 assert.equal(directory.meta.total,2);assert.equal(directory.meta.schemaVersion,1);
 assert.equal(directory.data[1].id,"plateau-events");assert.equal(directory.data[1].cities.length,4);
 assert.deepEqual(Object.keys(directory.data[0]).sort(),["id","name","websiteUrl","calendarUrl","cities"].sort());
 assert.equal(catalog.eventSource({city:" buckley ",slug:"wine-walk",id:42}).sourceEventUrl,"https://plateau.example.test/events/wine-walk");
 for(const city of ["Carbonado","South Prairie","Wilkeson"])assert.equal(catalog.eventSource({city,id:42}).sourcePublicationId,"plateau-events");
 assert.deepEqual(catalog.eventSource({city:"Plateau Regional",slug:"event"}),{sourcePublicationId:null,sourceEventUrl:null});
 const unchanged=catalog.directory().meta.revision;directory.data[0].cities.push("Seattle");
 assert.deepEqual(catalog.directory().data[0].cities,["Enumclaw"]);assert.equal(catalog.directory().meta.revision,unchanged);
});
test("opt-in and enabled flags exclude publications and fail closed for source links",()=>{
 for(const field of ["enabled","nearbyCommunities"]) {
  const c=config();c.publications[1][field]=false;const catalog=buildPublicationCatalog(c);
  assert.deepEqual(catalog.directory().data.map(p=>p.id),["enumclaw-events"]);
  assert.deepEqual(catalog.eventSource({city:"Buckley",slug:"event"}),{sourcePublicationId:null,sourceEventUrl:null});
 }
});
test("invalid, ambiguous, duplicate or unapproved configuration is rejected",()=>{
 const invalid=[
 c=>{c.publications.push(c.publications[0]);},c=>{c.approvedHosts.push(c.approvedHosts[0]);},
 c=>{c.publications[0].cities.push("enumclaw");},c=>{c.canonicalCityPublications.push({city:"enumclaw",publicationId:"plateau-events"});},
 c=>{c.canonicalCityPublications[0].publicationId="missing";},c=>{c.canonicalCityPublications[0].city="Seattle";},
 c=>{c.publications[0].websiteUrl="http://enumclaw.example.test/";},
 c=>{c.publications[0].websiteUrl="https://unapproved.example.test/";},
 c=>{c.publications[0].calendarUrl="https://plateau.example.test/events/";},
 c=>{c.publications[0].websiteUrl="https://user:secret@enumclaw.example.test/";},
 c=>{c.publications[0].calendarUrl+="?redirect=evil";},c=>{c.publications[0].eventRoute.pathPrefix="//evil.test/";},
 c=>{c.publications[0].eventRoute.pathPrefix="/events/../";},c=>{c.publications[0].eventRoute.pathPrefix="/events/%2e/";},
 c=>{c.publications[0].eventRoute.identifier="ticketUrl";},c=>{c.publications[0].enabled="true";},
 c=>{c.publications[0].credentialId="must-not-appear";},c=>{c.schemaVersion=2;},
 ];
 for(const change of invalid){const c=config();change(c);assert.throws(()=>buildPublicationCatalog(c),/Invalid publication catalog/);}
});
test("source URLs preserve slug encoding, reject route traversal, and never use tickets or request hosts",()=>{
 const catalog=buildPublicationCatalog(config());
 for(const slug of ["Wine-Walk-2026","a/b?c#d","Café & Music","%2F","//evil.test"])assert.equal(catalog.eventSource({city:"Enumclaw",id:42,slug,ticketUrl:"https://evil.test/",sourceEventUrl:"https://evil.test/"}).sourceEventUrl,"https://enumclaw.example.test/events/"+encodeURIComponent(slug));
 for(const slug of [".","..","\ud800"])assert.equal(catalog.eventSource({city:"Enumclaw",slug}).sourceEventUrl,null);
 assert.equal(catalog.eventSource({city:"Enumclaw",id:42}).sourceEventUrl,"https://enumclaw.example.test/events/42");
 const c=config();c.canonicalCityPublications=[];assert.equal(buildPublicationCatalog(c).eventSource({city:"Enumclaw",slug:"known"}).sourceEventUrl,null);
});

test("approved bundled catalog routes all five cities with slug-first and ID fallback URLs",()=>{
 const bundled=require("../data/publications.json"),catalog=buildPublicationCatalog(bundled);
 assert.deepEqual(bundled.approvedHosts,["enumclawevents.org","plateauevents.org"]);
 assert.deepEqual(catalog.directory().data.map(p=>p.id),["enumclaw-events","plateau-events"]);
 for(const city of ["Enumclaw","Buckley","Carbonado","South Prairie","Wilkeson"]){
  const id=city==="Enumclaw"?"enumclaw-events":"plateau-events";
  const host=city==="Enumclaw"?"enumclawevents.org":"plateauevents.org";
  assert.deepEqual(catalog.eventSource({city,id:42,slug:"stored-slug"}),{sourcePublicationId:id,sourceEventUrl:"https://"+host+"/events/stored-slug"});
  assert.equal(catalog.eventSource({city,id:42}).sourceEventUrl,"https://"+host+"/events/42");
 }
 assert.deepEqual(catalog.eventSource({city:"Seattle",id:42}),{sourcePublicationId:null,sourceEventUrl:null});
 for(const field of ["enabled","nearbyCommunities"]){
  const disabled=JSON.parse(JSON.stringify(bundled));disabled.publications[1][field]=false;
  const filtered=buildPublicationCatalog(disabled);
  assert.deepEqual(filtered.directory().data.map(p=>p.id),["enumclaw-events"]);
  assert.equal(filtered.eventSource({city:"Buckley",id:42}).sourceEventUrl,null);
 }
});

test("geographic areas preserve publication projection and stable city identities",()=>{
 const c=config(),catalog=buildPublicationCatalog(c),directory=catalog.directory();
 assert.equal(directory.areas.length,5);
 assert.deepEqual(directory.areas.map(a=>a.city),["Enumclaw","Buckley","Carbonado","South Prairie","Wilkeson"]);
 assert.equal(new Set(directory.areas.map(a=>a.id)).size,5);
 for(const a of directory.areas){
  assert.match(a.id,/^city-[a-f0-9]{24}$/);
  assert.deepEqual(Object.keys(a),["id","name","city","publicationId","calendarUrl"]);
  assert.equal(a.name,a.city);assert.equal(a.calendarUrl,null);
  assert.equal(a.publicationId,a.city==="Enumclaw"?"enumclaw-events":"plateau-events");
 }
 const buckley=directory.areas[1];
 c.canonicalCityPublications[1].name="Discover Buckley";
 c.canonicalCityPublications.reverse();
 const changed=buildPublicationCatalog(c).directory();
 assert.equal(changed.areas.find(a=>a.city==="Buckley").id,buckley.id);
 assert.equal(changed.areas.find(a=>a.city==="Buckley").name,"Discover Buckley");
 assert.deepEqual(changed.data,directory.data);
 directory.areas[0].city="private mutation";
 assert.equal(catalog.directory().areas[0].city,"Enumclaw");
 const missing=config();missing.canonicalCityPublications=[];
 assert.deepEqual(buildPublicationCatalog(missing).directory().areas,[]);
 const reassigned=config();reassigned.publications[0].cities.push("Buckley");
 reassigned.canonicalCityPublications[1].publicationId="enumclaw-events";
 const reassignedDirectory=buildPublicationCatalog(reassigned).directory();
 assert.notEqual(reassignedDirectory.meta.revision,catalog.directory().meta.revision);
 const reassignedArea=reassignedDirectory.areas[1];
 assert.equal(reassignedArea.id,buckley.id);assert.equal(reassignedArea.publicationId,"enumclaw-events");
});
test("area discovery excludes inactive and opted-out publications and disabled areas",()=>{
 for(const flag of ["enabled","nearbyCommunities"]){
  const c=config();c.publications[1][flag]=false;
  assert.deepEqual(buildPublicationCatalog(c).directory().areas.map(a=>a.city),["Enumclaw"]);
 }
 const c=config();c.canonicalCityPublications[1].enabled=false;
 const catalog=buildPublicationCatalog(c);
 assert.equal(catalog.directory().areas.length,4);
 assert.equal(catalog.directory().data.length,2);
 assert.equal(catalog.eventSource({city:"Buckley",id:42}).sourcePublicationId,"plateau-events");
 c.canonicalCityPublications[1].enabled="false";assert.throws(()=>buildPublicationCatalog(c));
});
test("explicit city calendars validate origin, calendar paths and a literal city query",()=>{
 for(const [index,url]of [[1,"https://plateau.example.test/events/buckley/"],[1,"https://plateau.example.test/events/?city=Buckley"],[3,"https://plateau.example.test/events/?city=South%20Prairie"]]){
  const c=config();c.canonicalCityPublications[index].calendarUrl=url;
  assert.equal(buildPublicationCatalog(c).directory().areas[index].calendarUrl,url);
 }
 const invalid=["http://plateau.example.test/events/","https://evil.test/events/","https://enumclaw.example.test/events/",
  "https://user:secret@plateau.example.test/events/","https://plateau.example.test:444/events/",
  "https://plateau.example.test/events/#fragment","https://plateau.example.test/events/../api/",
  "https://plateau.example.test/events/%2e%2e/api/","https://plateau.example.test/events/%252e%252e/",
  "https://plateau.example.test/api/events","https://plateau.example.test/wp-json/","https://plateau.example.test/events/api/",
  "https://plateau.example.test/events/?redirect=https%3A%2F%2Fevil.test",
  "https://plateau.example.test/events/?city=Buckley&city=Buckley","https://plateau.example.test/events/?city=Enumclaw",
  "https://plateau.example.test/events/?city=Buckley&rest_route=/events", "https://plateau.example.test/events/?city=Buckley%0a"];
 for(const url of invalid){const c=config();c.canonicalCityPublications[1].calendarUrl=url;assert.throws(()=>buildPublicationCatalog(c),url);}
});
test("directory revision covers geographic and participation configuration changes",()=>{
 const original=buildPublicationCatalog(config()).directory().meta.revision;
 for(const change of [c=>{c.canonicalCityPublications[1].name="Buckley area";},c=>{c.canonicalCityPublications[1].calendarUrl="https://plateau.example.test/events/buckley/";},c=>{c.canonicalCityPublications[1].enabled=false;},c=>{c.publications[1].nearbyCommunities=false;},c=>{c.canonicalCityPublications.pop();}]){
  const c=config();change(c);assert.notEqual(buildPublicationCatalog(c).directory().meta.revision,original);
 }
 assert.equal(buildPublicationCatalog(config()).directory().meta.revision,original);
});

test("empty approved catalogs retain the safe empty-directory contract",()=>{
 const directory=buildPublicationCatalog({schemaVersion:1,approvedHosts:[],publications:[],canonicalCityPublications:[]}).directory();
 assert.deepEqual(directory.data,[]);assert.deepEqual(directory.areas,[]);assert.equal(directory.meta.total,0);
});
