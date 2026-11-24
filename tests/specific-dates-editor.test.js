"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process"), sqlite = require("sqlite3");
const { hashPassword } = require("../lib/auth");
const chromePath = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("Specific Dates actual editor prefill, mutations, preview, validation and serialization", {
  skip: !fs.existsSync(chromePath) || typeof WebSocket === "undefined" ? "Requires Chrome and Node 20 --experimental-websocket (or Node 22+)" : false,
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-specific-dates-"));
  const filename = path.join(dir,"test.db"), port = 39000 + Math.floor(Math.random()*1000), base = "http://127.0.0.1:" + port;
  const server = spawn(process.execPath,["server.js"], { cwd:path.resolve(__dirname,".."), env:{ PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,NODE_ENV:"test",DB_PATH:filename,PORT:String(port) }, stdio:"ignore" });
  const profile=path.join(dir,"chrome");
  const chrome=spawn(chromePath,["--headless","--disable-gpu","--no-first-run","--remote-debugging-port=0","--user-data-dir="+profile],{stdio:"ignore"});
  t.after(()=>{server.kill();chrome.kill();});
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+"/health")).ok){ready=true;break;}}catch{}await pause(100);}assert.ok(ready);
  const db=new sqlite.Database(filename);
  const sql=(query,params=[])=>new Promise((resolve,reject)=>db.all(query,params,(error,rows)=>error?reject(error):resolve(rows)));
  t.after(()=>db.close());
  await sql("INSERT INTO users(email,username,passwordHash,role,city) VALUES(?,?,?,?,?)",["dates@example.test","dates",await hashPassword("disposable dates password"),"developer","Enumclaw"]);
  const originalItems=[
    {date:"2027-01-20",start:"2027-01-20T22:00:00Z",end:"2027-01-21T04:00:00Z",occurrenceKey:"preserve-me",label:"First"},
    {date:"2027-03-14",start:"2027-03-14T01:00:00-08:00",end:"2027-03-15T03:00:00-07:00",label:"DST overnight"},
  ];
  await sql("INSERT INTO events(id,city,slug,title,organizer,location,startDateTime,endDateTime,hasRecurrence,recurrenceRule) VALUES(?,?,?,?,?,?,?,?,?,?)",[101,"Enumclaw","dates-fixture","Dates fixture","Organizer","Hall",originalItems[0].start,originalItems[0].end,1,JSON.stringify({type:"custom",items:originalItems})]);
  await sql("INSERT INTO events(id,city,slug,title,organizer,location,startDateTime,endDateTime,hasRecurrence,recurrenceRule) VALUES(?,?,?,?,?,?,?,?,?,?)",[102,"Enumclaw","partial-fixture","Partial fixture","Organizer","Hall",originalItems[0].start,originalItems[0].end,1,JSON.stringify({type:"custom",items:[originalItems[0],{date:"2027-04-01",start:"",end:"2027-04-01T20:00:00-07:00"}]})]);
  await sql("INSERT INTO events(id,city,slug,title,organizer,location,startDateTime,endDateTime,hasRecurrence,recurrenceRule,recurrenceDates) VALUES(?,?,?,?,?,?,?,?,?,?,?)",[103,"Enumclaw","legacy-fixture","Legacy fixture","Organizer","Hall","2027-03-13T23:00:00-08:00","2027-03-14T03:00:00-07:00",1,JSON.stringify({type:"custom",items:[]}),JSON.stringify(["2027-03-13","2027-03-20"])]);
  const foldItem={date:"2027-11-07",start:"2027-11-07T01:50:00-07:00",end:"2027-11-07T01:10:00-08:00",label:"Fall-back interval"};
  await sql("INSERT INTO events(id,city,slug,title,organizer,location,startDateTime,endDateTime,hasRecurrence,recurrenceRule) VALUES(?,?,?,?,?,?,?,?,?,?)",[104,"Enumclaw","fold-fixture","Fold fixture","Organizer","Hall",foldItem.start,foldItem.end,1,JSON.stringify({type:"custom",items:[foldItem]})]);
  const login=await fetch(base+"/login",{method:"POST",redirect:"manual",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({username:"dates",password:"disposable dates password"})});
  assert.equal(login.status,302);const cookie=login.headers.get("set-cookie").split(";")[0],split=cookie.indexOf("=");
  for(let i=0;i<100&&!fs.existsSync(path.join(profile,"DevToolsActivePort"));i++)await pause(50);
  const debugPort=fs.readFileSync(path.join(profile,"DevToolsActivePort"),"utf8").split("\n")[0];
  const target=await(await fetch("http://127.0.0.1:"+debugPort+"/json/new?about:blank",{method:"PUT"})).json();
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener("open",resolve,{once:true}));t.after(()=>ws.close());
  let id=0;const pending=new Map();ws.addEventListener("message",event=>{const message=JSON.parse(event.data);if(pending.has(message.id)){const p=pending.get(message.id);pending.delete(message.id);message.error?p.reject(message.error):p.resolve(message.result);}});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  await send("Page.enable");await send("Network.enable");
  await send("Page.addScriptToEvaluateOnNewDocument",{source:`const realFetch=window.fetch;window.fetch=function(url,options){if(String(url).includes('preview-recurrence')) window.__previewRequest=JSON.parse(options.body);return realFetch.apply(this,arguments);};`});
  await send("Network.setBlockedURLs",{urls:["https://*"]});
  await send("Network.setCookie",{name:cookie.slice(0,split),value:cookie.slice(split+1),url:base});
  const evaluate=async expression=>{const result=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text+" "+JSON.stringify(result.exceptionDetails.exception));return result.result.value;};
  const navigate=async url=>{await send("Page.navigate",{url});for(let i=0;i<100;i++){if(await evaluate('document.readyState === "complete" && !!window.ocRefreshRecurrencePreview'))return;await pause(50);}throw new Error("Editor did not initialize");};
  const rows=()=>evaluate(`Array.from(document.querySelectorAll('#customDatesWrap .chip')).map(chip=>Array.from(chip.querySelectorAll('input')).map(i=>i.value))`);
  const preview=()=>evaluate(`({count:document.querySelectorAll('[data-preview-list] li').length,text:document.querySelector('[data-preview-summary]').textContent})`);
  const waitPreview=()=>pause(450);
  const change=async(index,name,value,event="change")=>evaluate(`(()=>{const input=document.querySelectorAll('#customDatesWrap .chip')[${index}].querySelector('[name="${name}"]');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('${event}',{bubbles:true}));})()`);
  await send("Emulation.setTimezoneOverride",{timezoneId:"Asia/Tokyo"});
  await navigate(base+"/admin/create-events?edit=101");await waitPreview();
  assert.deepEqual(await rows(),[["2027-01-20","14:00","2027-01-20","20:00"],["2027-03-14","01:00","2027-03-15","03:00"]]);
  assert.equal((await preview()).count,2,JSON.stringify({preview:await preview(),payload:await evaluate("window.__previewRequest")}));
  // No keyboard event is needed for the server-prefilled rows or original item identity.
  const serialized=await evaluate(`(()=>{const form=document.querySelector('form[action="/admin/events"]');form.addEventListener('submit',e=>e.preventDefault(),{once:true,capture:true});form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('[name="saveChangesDraft"]')}));return document.getElementById('recurrenceDatesJson').value;})()`);
  assert.deepEqual(JSON.parse(serialized),originalItems);
  await evaluate(`document.getElementById('addCustomDate').click()`);await waitPreview();
  assert.equal((await rows()).length,3);assert.equal((await rows())[2][0],"");assert.equal((await rows())[2][2],"");
  assert.equal((await preview()).count,2);assert.match((await preview()).text,/Enter start date for date 3/);
  assert.equal(await evaluate('window.ocValidateCustomDates()'),false);
  await change(2,"customDate","2027-04-02");await waitPreview();
  assert.equal((await rows())[2][2],"2027-04-03");assert.equal((await preview()).count,3);
  for(const [name,value]of [["customStart","15:00"],["customEndDate","2027-04-03"],["customEnd","22:00"],["customDate","2027-04-01"]]){
    await change(2,name,value,"input");await waitPreview();assert.equal((await preview()).count,3,name);
  }
  await evaluate(`(()=>{const row=document.querySelectorAll('#customDatesWrap .chip')[2];row.querySelector('[name="customDate"]').value='2027-01-05';row.querySelector('[name="customEndDate"]').value='2027-01-06';window.ocRefreshRecurrencePreview();})()`);await waitPreview();assert.equal((await preview()).count,3,"An earlier added date is not filtered by the first row");
  await change(2,"customEndDate","2026-03-01");await waitPreview();assert.match((await preview()).text,/End must be after start/);assert.equal((await preview()).count,2);
  await evaluate(`document.querySelectorAll('#customDatesWrap [data-remove-date]')[2].click()`);await waitPreview();assert.equal((await rows()).length,2);assert.equal((await preview()).count,2);
  // Programmatic Quick Add-style replacement is observed without dispatching field events.
  await evaluate(`(()=>{const wrap=document.getElementById('customDatesWrap');const row=wrap.children[0].cloneNode(true);row.removeAttribute('data-original-index');row.querySelector('[name="customDate"]').value='2027-05-05';row.querySelector('[name="customEndDate"]').value='2027-05-06';wrap.appendChild(row);})()`);await waitPreview();assert.equal((await preview()).count,3);
  await change(2,"customDate","2020-01-01");await change(2,"customEndDate","2020-01-02");await evaluate(`document.getElementById('prunePastDates').click()`);await waitPreview();assert.equal((await rows()).length,2);
  // A removed row retains the remaining rows' original indexes and metadata.
  await evaluate(`document.querySelector('#customDatesWrap [data-remove-date]').click()`);await waitPreview();assert.equal((await preview()).count,1);
  const remainingSerialized=await evaluate(`(()=>{const form=document.querySelector('form[action="/admin/events"]');form.addEventListener('submit',e=>e.preventDefault(),{once:true,capture:true});form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('[name="saveChangesDraft"]')}));return document.getElementById('recurrenceDatesJson').value;})()`);
  assert.deepEqual(JSON.parse(remainingSerialized),[originalItems[1]]);
  for(const width of [1440,390]){
    await send("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:width<600});
    assert.equal(await evaluate('document.querySelector("#customDatesWrap input").checkValidity()'),true);
    await evaluate(`document.getElementById('customBox').scrollIntoView({block:'center'})`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('#customDatesWrap input')).every(input=>{const r=input.getBoundingClientRect(),wrap=document.getElementById('customDatesWrap').getBoundingClientRect();return r.left>=wrap.left-1&&r.right<=wrap.right+1;})`),true,"Specific Date fields fit the container at "+width);
    const image=await send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(dir,"editor-"+width+".png"),Buffer.from(image.data,"base64"));
  }
  // New-event entry: reproduce the original blank-start/populated-end case.
  await navigate(base+"/admin/create-events");
  await evaluate(`(()=>{window.confirm=()=>true;document.querySelector('input[name="recurrenceChoice"][value="yes"]').click();document.getElementById('startDateTime').value='2027-11-25T14:00';document.getElementById('endDateTime').value='2027-11-25T20:00';document.getElementById('recurrenceType').value='custom';document.getElementById('recurrenceType').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('addCustomDate').click();})()`);await waitPreview();
  assert.deepEqual((await rows())[0],["2027-11-25","14:00","2027-11-25","20:00"]);assert.equal((await preview()).count,1);
  await evaluate(`document.getElementById('addCustomDate').click();document.getElementById('addCustomDate').click()`);await waitPreview();assert.equal((await rows()).length,3);assert.equal((await preview()).count,1);
  await evaluate(`document.getElementById('recurrenceType').value='weekly';document.getElementById('recurrenceType').dispatchEvent(new Event('change',{bubbles:true}))`);await waitPreview();
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('#customDatesWrap input')).every(i=>!i.validationMessage)`),true);
  await evaluate(`document.getElementById('recurrenceType').value='custom';document.getElementById('recurrenceType').dispatchEvent(new Event('change',{bubbles:true}))`);await waitPreview();assert.equal((await preview()).count,1);
  // Responses from an older form state must be ignored even during the debounce interval.
  await evaluate(`window.__realFetch=window.fetch;window.__pending=[];window.fetch=(url,options)=>String(url).includes('preview-recurrence')?new Promise(resolve=>window.__pending.push(resolve)):window.__realFetch(url,options);window.ocRefreshRecurrencePreview();`);await pause(250);
  assert.equal(await evaluate('window.__pending.length'),1);
  await change(0,"customStart","15:00");
  await evaluate(`window.__pending[0]({ok:true,json:async()=>({occurrences:[{label:'STALE',startDateTime:'2027-11-25T14:00:00-08:00'}]})})`);await pause(30);
  assert.equal(await evaluate(`document.querySelector('[data-preview-list]').textContent.includes('STALE')`),false);
  await pause(250);assert.equal(await evaluate('window.__pending.length'),2);
  await evaluate(`window.__pending[1]({ok:true,json:async()=>({occurrences:[{label:'LATEST',startDateTime:'2027-11-25T15:00:00-08:00'}]})})`);await pause(30);
  assert.match(await evaluate(`document.querySelector('[data-preview-list]').textContent`),/LATEST/);
  await evaluate(`window.fetch=()=>Promise.reject(new Error('Fixture failure'));window.ocRefreshRecurrencePreview();`);await waitPreview();assert.match((await preview()).text,/temporarily unavailable/);assert.equal((await preview()).count,0);
  await send("Emulation.setTimezoneOverride",{timezoneId:"America/New_York"});
  await evaluate(`window.fetch=window.__realFetch;window.ocRefreshRecurrencePreview()`);await waitPreview();assert.equal((await preview()).count,1);
  await navigate(base+"/admin/create-events?edit=102");await waitPreview();
  assert.equal((await rows()).length,2);assert.deepEqual((await rows())[1],["2027-04-01","","2027-04-01","20:00"]);
  assert.equal((await preview()).count,1);assert.match((await preview()).text,/Enter start time for date 2/);
  await navigate(base+"/admin/create-events?edit=103");await waitPreview();
  assert.deepEqual(await rows(),[["2027-03-13","23:00","2027-03-14","03:00"],["2027-03-20","23:00","2027-03-21","03:00"]]);
  assert.equal((await preview()).count,2);
  await navigate(base+"/admin/create-events?edit=104");await waitPreview();
  assert.equal((await preview()).count,1);assert.equal(await evaluate('window.ocValidateCustomDates()'),true,"Unchanged fall-back instants remain valid despite reversed wall-clock times");
  t.diagnostic("Desktop/mobile screenshots and disposable fixtures: "+dir);
});
