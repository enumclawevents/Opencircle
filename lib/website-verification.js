"use strict";
const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
function publicAddress(address) {
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    return /^[23]/.test(value) && !/^(2001:|2002:|3fff:)/.test(value);
  }
  if (net.isIP(address) !== 4) return false;
  const [a,b,c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
async function fetchInstallationProof(siteUrl, pendingId, { lookup = dns.lookup, request = https.request } = {}) {
  const url = new URL("wp-json/opencircle/v1/connection-proof", siteUrl);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.search) throw new Error("Website verification failed");
  let timer;
  const records = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Website verification failed")),5000);}),
  ]).finally(()=>clearTimeout(timer));
  if (!records.length || records.some(row => !publicAddress(row.address))) throw new Error("Website verification failed");
  const address = records.find(row => row.family === 4);
  if (!address) throw new Error("Website requires a public IPv4 address");
  return new Promise((resolve,reject) => {
    const fail = () => reject(new Error("Website verification failed"));
    const req = request(url, {
      method: "GET", agent: false, rejectUnauthorized: true, servername: url.hostname,
      maxHeaderSize: 8192,
      lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, 4),
      headers: { Accept: "application/json", "Accept-Encoding": "identity", "X-OC-Connection-ID": pendingId },
    }, res => {
      if (res.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(res.headers["content-type"] || "") ||
          res.headers["content-encoding"] || Number(res.headers["content-length"] || 0) > 8192) { res.destroy(); req.destroy(); fail(); return; }
      const chunks=[]; let size=0;
      res.on("data", chunk => { size += chunk.length; if (size > 8192) { res.destroy(); req.destroy(); fail(); } else chunks.push(chunk); });
      res.on("error", fail);
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { fail(); } });
    });
    const timer = setTimeout(() => { req.destroy(); fail(); }, 5000);
    req.on("close", () => clearTimeout(timer)); req.on("error", fail); req.end();
  });
}
module.exports = { fetchInstallationProof, publicAddress };
