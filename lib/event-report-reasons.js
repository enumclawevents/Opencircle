"use strict";

const EVENT_REPORT_REASON_LABELS = Object.freeze({
  cancelled: "Event canceled",
  date_time_changed: "Date or time changed",
  location_changed: "Location changed",
  incorrect_information: "Incorrect event information",
  prohibited_content: "Inappropriate or prohibited content",
  other: "Other",
  changed_details: "Event details changed",
});

const EVENT_REPORT_TYPES = Object.freeze(Object.keys(EVENT_REPORT_REASON_LABELS));

module.exports = { EVENT_REPORT_REASON_LABELS, EVENT_REPORT_TYPES };
