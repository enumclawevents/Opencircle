"use strict";
function config() {
 const pub=(id,host,cities)=>({id,name:id==="enumclaw-events"?"Enumclaw fixture":"Plateau fixture",websiteUrl:`https://${host}/`,calendarUrl:`https://${host}/events/`,cities,eventRoute:{pathPrefix:"/events/",identifier:"slug-or-id",trailingSlash:false},enabled:true,nearbyCommunities:true});
 return {schemaVersion:1,approvedHosts:["enumclaw.example.test","plateau.example.test"],publications:[pub("enumclaw-events","enumclaw.example.test",["Enumclaw"]),pub("plateau-events","plateau.example.test",["Buckley","Carbonado","South Prairie","Wilkeson"])],canonicalCityPublications:[{city:"Enumclaw",publicationId:"enumclaw-events"},...["Buckley","Carbonado","South Prairie","Wilkeson"].map(city=>({city,publicationId:"plateau-events"}))]};
}
module.exports={config};
