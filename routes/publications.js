"use strict";
const router = require("express").Router();
const { publicationDirectory } = require("../lib/publications");
router.get("/", (_req, res) => {
  try {
    const payload = publicationDirectory();
    res.set("Cache-Control", "public, max-age=60");
    res.set("ETag", '"publications-' + payload.meta.revision + '"');
    return res.json(payload);
  } catch {
    res.set("Cache-Control", "no-store");
    return res.status(503).json({ data: [], areas: [], error: "Publication directory unavailable" });
  }
});
module.exports = router;
