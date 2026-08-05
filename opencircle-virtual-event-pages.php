<?php
/**
 * Module: OpenCircle Virtual Event Pages
 * Description: Creates /events/{id or slug}/ pages in WordPress that render events from the OpenCircle API (no WP posts needed). Redirects /oc-events/* to /events/*.
 * Version: 0.2.7
 */

if (!defined('ABSPATH')) exit;

if (!defined('OC_API_BASE')) {
  define('OC_API_BASE', 'https://api.opencircleapi.com');
}

// NEW primary base:
define('OC_VIRTUAL_BASE', 'events');
// OLD base kept for redirects:
define('OC_OLD_BASE', 'oc-events');
// Venue virtual base:
define('OC_VENUE_BASE', 'venues');

/**
 * Helper: does a request path match our virtual single event routes?
 */
function oc_path_is_virtual_event($path) {
  $path = (string)$path;
  return (bool)(
    preg_match('#^/' . preg_quote(OC_VIRTUAL_BASE, '#') . '/[^/]+/?$#', $path) ||
    preg_match('#^/' . preg_quote(OC_OLD_BASE, '#') . '/[^/]+/?$#', $path)
  );
}

function oc_path_is_virtual_venue($path) {
  $path = (string)$path;
  return (bool) preg_match('#^/' . preg_quote(OC_VENUE_BASE, '#') . '/[^/]+/?$#', $path);
}

function oc_path_is_virtual_page($path) {
  return oc_path_is_virtual_event($path) || oc_path_is_virtual_venue($path);
}

/**
 * FORCE WPBakery frontend assets on /events/* (and legacy /oc-events/*)
 * so VC footer/grid renders correctly.
 * Uses direct plugin path: /wp-content/plugins/js_composer/
 */
add_action('wp_enqueue_scripts', function () {
  $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);

  if (!oc_path_is_virtual_page($path)) return;

  $css_rel = 'js_composer/assets/css/js_composer.min.css';
  $js_rel  = 'js_composer/assets/js/dist/js_composer_front.min.js';

  $css_abs = WP_PLUGIN_DIR . '/' . $css_rel;
  $js_abs  = WP_PLUGIN_DIR . '/' . $js_rel;

  if (file_exists($css_abs)) {
    wp_enqueue_style('oc-wpbakery-front', plugins_url($css_rel), [], filemtime($css_abs));
  }

  if (file_exists($js_abs)) {
    wp_enqueue_script('oc-wpbakery-front-js', plugins_url($js_rel), ['jquery'], filemtime($js_abs), true);
  }
}, 99);

/**
 * Engagement counts (Interested / Going) stored in WP options.
 * Keys: oc_engage_{eventKey}_interested, oc_engage_{eventKey}_going
 */
function oc_engage_key($event_id, $type) {
  $event_id = (string)$event_id;
  $type = ($type === 'going') ? 'going' : 'interested';
  return "oc_engage_{$event_id}_{$type}";
}

/**
 * ✅ UPDATED: Timestamp parsing
 * Treat API datetimes as floating local time in WP timezone (your current behavior).
 */
function oc_wp_timestamp_from_iso($iso) {
  if (!$iso) return false;

  $tz = wp_timezone();
  $s  = trim((string)$iso);
  if ($s === '') return false;

  // strip fractional seconds
  $s = preg_replace('/\.\d+(?=(Z|[+\-]\d{2}:\d{2})?$)/', '', $s);

  // Treat API datetimes as floating local time in WP timezone:
  $s_local = preg_replace('/(Z|[+\-]\d{2}:\d{2})$/', '', $s);

  try {
    $dt = new DateTimeImmutable($s_local, $tz);
    return $dt->getTimestamp();
  } catch (Exception $e) {}

  try {
    $dt = new DateTimeImmutable($s, $tz);
    return $dt->getTimestamp();
  } catch (Exception $e) {}

  $ts = strtotime($s_local);
  return $ts ?: false;
}


function oc_event_format_date_range_label($start_ts, $end_ts = 0, $tz = null, $allow_range = true) {
  $start_ts = (int)$start_ts;
  $end_ts = (int)$end_ts;
  if ($start_ts <= 0) return '';
  if (!$tz) $tz = wp_timezone();

  if ($end_ts <= 0 || !$allow_range) return wp_date('F j, Y', $start_ts, $tz);

  $start_day = wp_date('Y-m-d', $start_ts, $tz);
  $end_day = wp_date('Y-m-d', $end_ts, $tz);
  if ($start_day === $end_day) return wp_date('F j, Y', $start_ts, $tz);

  if (wp_date('Y', $start_ts, $tz) === wp_date('Y', $end_ts, $tz)) {
    if (wp_date('F', $start_ts, $tz) === wp_date('F', $end_ts, $tz)) {
      return wp_date('F j', $start_ts, $tz) . '-' . wp_date('j, Y', $end_ts, $tz);
    }
    return wp_date('F j', $start_ts, $tz) . ' - ' . wp_date('F j, Y', $end_ts, $tz);
  }

  return wp_date('F j, Y', $start_ts, $tz) . ' - ' . wp_date('F j, Y', $end_ts, $tz);
}

function oc_event_format_compact_day_span($start_ts, $end_ts, $tz = null) {
  $start_ts = (int)$start_ts;
  $end_ts = (int)$end_ts;
  if ($start_ts <= 0) return '';
  if ($end_ts <= 0) $end_ts = $start_ts;
  if (!$tz) $tz = wp_timezone();

  $same_year = wp_date('Y', $start_ts, $tz) === wp_date('Y', $end_ts, $tz);
  $same_month = $same_year && (wp_date('n', $start_ts, $tz) === wp_date('n', $end_ts, $tz));

  if ($same_month) {
    $sDay = wp_date('j', $start_ts, $tz);
    $eDay = wp_date('j', $end_ts, $tz);
    return ($sDay === $eDay)
      ? wp_date('F j', $start_ts, $tz)
      : (wp_date('F', $start_ts, $tz) . ' ' . $sDay . '-' . $eDay);
  }

  if ($same_year) {
    return wp_date('F j', $start_ts, $tz) . ' - ' . wp_date('F j', $end_ts, $tz);
  }

  return wp_date('F j, Y', $start_ts, $tz) . ' - ' . wp_date('F j, Y', $end_ts, $tz);
}

function oc_event_build_multi_day_header_label($event, $tz = null) {
  if (!is_array($event)) return '';
  if (!$tz) $tz = wp_timezone();

  $day_map = [];

  $add_day = function($iso) use (&$day_map, $tz) {
    $ts = oc_wp_timestamp_from_iso((string)$iso);
    if (!$ts) return;
    $ymd = wp_date('Y-m-d', $ts, $tz);
    if ($ymd === '') return;
    $day_ts = oc_ts_from_date_time($ymd, '00:00', $tz);
    if (!$day_ts) $day_ts = strtotime($ymd . ' 00:00:00');
    if (!$day_ts) return;
    $day_map[(int)$day_ts] = 1;
  };

  $add_day($event['startDateTime'] ?? '');

  $occ = oc_collect_occurrences_from_api($event);
  foreach ($occ as $o) {
    if (!is_array($o)) continue;
    $add_day($o['startDateTime'] ?? '');
  }

  $days = array_keys($day_map);
  sort($days, SORT_NUMERIC);
  if (count($days) < 2) return '';

  $groups = [];
  $group_start = $days[0];
  $prev = $days[0];
  for ($i = 1; $i < count($days); $i++) {
    $cur = $days[$i];
    if (($cur - $prev) === DAY_IN_SECONDS) {
      $prev = $cur;
      continue;
    }
    $groups[] = [$group_start, $prev];
    $group_start = $cur;
    $prev = $cur;
  }
  $groups[] = [$group_start, $prev];

  $has_consecutive_span = false;
  foreach ($groups as $g) {
    if ((int)$g[1] > (int)$g[0]) {
      $has_consecutive_span = true;
      break;
    }
  }
  if (!$has_consecutive_span) return '';

  $parts = [];
  $years = [];
  foreach ($groups as $g) {
    $parts[] = oc_event_format_compact_day_span((int)$g[0], (int)$g[1], $tz);
    $years[wp_date('Y', (int)$g[0], $tz)] = 1;
    $years[wp_date('Y', (int)$g[1], $tz)] = 1;
  }

  $label = implode(' & ', array_filter($parts));
  if ($label === '') return '';

  if (count($years) === 1) {
    $only_year = (string)array_key_first($years);
    if ($only_year !== '') {
      $label .= ', ' . $only_year;
    }
  }

  return $label;
}

/**
 * ✅ NEW: Collect occurrences that match API logic (including custom date items).
 */
function oc_collect_occurrences_from_api($event) {
  $out = [];

  foreach (['occurrencesUpcoming', 'occurrences', 'upcomingOccurrences'] as $k) {
    if (!empty($event[$k]) && is_array($event[$k])) {
      foreach ($event[$k] as $o) {
        if (is_array($o)) {
          $s = trim((string)($o['startDateTime'] ?? ''));
          if ($s === '') continue;
          $out[] = [
            'startDateTime' => $s,
            'endDateTime'   => (string)($o['endDateTime'] ?? ''),
            'label'         => (string)($o['label'] ?? ''),
          ];
        } elseif (is_string($o) && trim($o) !== '') {
          $out[] = [
            'startDateTime' => trim($o),
            'endDateTime'   => '',
            'label'         => '',
          ];
        }
      }
      break;
    }
  }

  $rr = $event['recurrenceRule'] ?? null;
  if (is_array($rr) && !empty($rr['items']) && is_array($rr['items'])) {
    foreach ($rr['items'] as $it) {
      if (!is_array($it)) continue;

      $s = trim((string)($it['startDateTime'] ?? ''));
      $e = trim((string)($it['endDateTime'] ?? ''));

      if ($s === '') {
        $date = trim((string)($it['date'] ?? ''));
        $st   = trim((string)($it['startTime'] ?? ($it['start'] ?? '')));
        $en   = trim((string)($it['endTime'] ?? ($it['end'] ?? '')));

        if ($date !== '' && $st !== '') {
          $s = $date . 'T' . $st . ':00';
          if ($en !== '') $e = $date . 'T' . $en . ':00';
        }
      }

      if ($s === '') continue;

      $out[] = [
        'startDateTime' => $s,
        'endDateTime'   => $e,
        'label'         => (string)($it['label'] ?? ''),
      ];
    }
  }

  $seen = [];
  $deduped = [];
  foreach ($out as $o) {
    $s = (string)($o['startDateTime'] ?? '');
    if ($s === '' || isset($seen[$s])) continue;
    $seen[$s] = true;
    $deduped[] = $o;
  }

  return $deduped;
}

function oc_get_engage_counts($event_id) {
  $event_id = (string)$event_id;
  return [
    'interested' => (int) get_option(oc_engage_key($event_id, 'interested'), 0),
    'going'      => (int) get_option(oc_engage_key($event_id, 'going'), 0),
  ];
}

function oc_event_trending_score($event) {
  if (!is_array($event)) return 0.0;

  $candidates = [
    'views7d','views_7d','viewsLast7Days','views_last_7_days','weeklyViews','weekly_views','viewsWeek','views_week',
    'trendingWeek','trending_week','trendingScore7d','trending_score_7d',
    'trendingScore', 'trending_score',
    'views', 'viewCount', 'view_count',
  ];

  foreach ($candidates as $key) {
    if (isset($event[$key]) && $event[$key] !== '') {
      return (float) $event[$key];
    }
  }

  return 0.0;
}

function oc_fetch_event_payload($key) {
  $key = trim((string)$key);
  if ($key === '') return null;

  $is_id = ctype_digit($key);
  $key_safe = $is_id ? $key : sanitize_title($key);
  if ($key_safe === '') return null;

  $url = rtrim(OC_API_BASE, '/') . ($is_id
    ? '/events/' . rawurlencode($key_safe)
    : '/events/slug/' . rawurlencode($key_safe)
  );

  $res = wp_remote_get($url, [
    'timeout' => 12,
    'headers' => ['Accept' => 'application/json'],
  ]);

  if (is_wp_error($res)) return null;
  $json = json_decode(wp_remote_retrieve_body($res), true);
  $event = $json['data'] ?? null;
  return is_array($event) ? $event : null;
}

function oc_calendar_escape_text($value) {
  $value = wp_strip_all_tags(html_entity_decode((string)$value, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
  $value = preg_replace("/\r\n|\r|\n/", "\\n", $value);
  $value = str_replace(['\\', ';', ','], ['\\\\', '\;', '\,'], $value);
  return trim((string)$value);
}

function oc_calendar_format_utc($timestamp) {
  $timestamp = (int)$timestamp;
  if ($timestamp <= 0) return '';
  return gmdate('Ymd\THis\Z', $timestamp);
}

function oc_resolve_occurrence_for_calendar($event, $requested_start_ts = 0, $requested_end_ts = 0) {
  $requested_start_ts = (int)$requested_start_ts;
  $requested_end_ts = (int)$requested_end_ts;

  $base_start = oc_wp_timestamp_from_iso((string)($event['startDateTime'] ?? '')) ?: 0;
  $base_end = oc_wp_timestamp_from_iso((string)($event['endDateTime'] ?? '')) ?: 0;
  $best = [
    'start_ts' => $base_start,
    'end_ts' => $base_end,
  ];

  foreach (oc_collect_occurrences_from_api($event) as $occurrence) {
    if (!is_array($occurrence)) continue;
    $start_ts = oc_wp_timestamp_from_iso((string)($occurrence['startDateTime'] ?? '')) ?: 0;
    if (!$start_ts) continue;
    $end_ts = oc_wp_timestamp_from_iso((string)($occurrence['endDateTime'] ?? '')) ?: 0;
    if ($requested_start_ts && $start_ts !== $requested_start_ts) continue;
    if ($requested_end_ts && $end_ts && $requested_end_ts !== $end_ts) continue;
    $best = [
      'start_ts' => $start_ts,
      'end_ts' => $end_ts,
    ];
    break;
  }

  return $best;
}

function oc_build_event_calendar_url($event_key, $start_ts = 0, $end_ts = 0) {
  $args = [
    'action' => 'oc_event_calendar',
    'event' => trim((string)$event_key),
  ];
  if ((int)$start_ts > 0) $args['start_ts'] = (int)$start_ts;
  if ((int)$end_ts > 0) $args['end_ts'] = (int)$end_ts;
  return add_query_arg($args, admin_url('admin-ajax.php'));
}

function oc_event_calendar_download() {
  $event_key = sanitize_text_field(wp_unslash($_GET['event'] ?? ''));
  if ($event_key === '') {
    status_header(400);
    wp_die('Missing event.');
  }

  $event = oc_fetch_event_payload($event_key);
  if (!$event) {
    status_header(404);
    wp_die('Event not found.');
  }

  $timing = oc_resolve_occurrence_for_calendar(
    $event,
    isset($_GET['start_ts']) ? intval($_GET['start_ts']) : 0,
    isset($_GET['end_ts']) ? intval($_GET['end_ts']) : 0
  );

  $start_ts = (int)($timing['start_ts'] ?? 0);
  $end_ts = (int)($timing['end_ts'] ?? 0);
  if ($start_ts <= 0) {
    status_header(400);
    wp_die('Missing event time.');
  }

  $title = trim((string)($event['title'] ?? 'Event'));
  $description = oc_clean_event_description((string)($event['description'] ?? ''));
  $location = trim((string)($event['location'] ?? ''));
  $city = trim((string)($event['city'] ?? ''));
  $state = trim((string)($event['state'] ?? 'WA'));
  $postal = trim((string)($event['postalCode'] ?? ($event['zip'] ?? '')));
  $event_slug = trim((string)($event['slug'] ?? ''));
  $event_id = trim((string)($event['id'] ?? $event_key));
  $public_key = $event_slug !== '' ? $event_slug : $event_id;
  $public_url = home_url('/' . OC_VIRTUAL_BASE . '/' . rawurlencode($public_key) . '/');

  $location_parts = array_values(array_filter([$location, $city, $state, $postal], static function ($part) {
    return trim((string)$part) !== '';
  }));
  $location_line = implode(', ', $location_parts);

  $uid_key = sanitize_title($public_key !== '' ? $public_key : $event_key);
  if ($uid_key === '') $uid_key = 'event';
  $uid = sprintf('oc-%s-%d@%s', $uid_key, $start_ts, parse_url(home_url('/'), PHP_URL_HOST) ?: 'localhost');

  $lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpenCircle//Event Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' . $uid,
    'DTSTAMP:' . oc_calendar_format_utc(time()),
    'DTSTART:' . oc_calendar_format_utc($start_ts),
  ];

  if ($end_ts > $start_ts) {
    $lines[] = 'DTEND:' . oc_calendar_format_utc($end_ts);
  }

  $lines[] = 'SUMMARY:' . oc_calendar_escape_text($title);
  if ($description !== '') $lines[] = 'DESCRIPTION:' . oc_calendar_escape_text($description);
  if ($location_line !== '') $lines[] = 'LOCATION:' . oc_calendar_escape_text($location_line);
  if ($public_url !== '') $lines[] = 'URL:' . esc_url_raw($public_url);
  $lines[] = 'STATUS:CONFIRMED';
  $lines[] = 'END:VEVENT';
  $lines[] = 'END:VCALENDAR';

  $filename_slug = sanitize_title($title !== '' ? $title : $uid_key);
  if ($filename_slug === '') $filename_slug = 'event';

  nocache_headers();
  header('Content-Type: text/calendar; charset=utf-8');
  header('Content-Disposition: attachment; filename="' . $filename_slug . '.ics"');
  echo implode("\r\n", $lines) . "\r\n";
  exit;
}
add_action('wp_ajax_oc_event_calendar', 'oc_event_calendar_download');
add_action('wp_ajax_nopriv_oc_event_calendar', 'oc_event_calendar_download');

add_action('wp_ajax_oc_event_engage', 'oc_event_engage_ajax');
add_action('wp_ajax_nopriv_oc_event_engage', 'oc_event_engage_ajax');

function oc_iso_to_ts($iso) {
  $iso = (string) $iso;
  if ($iso === '') return 0;

  try {
    $dt = new DateTimeImmutable($iso);
    return $dt->getTimestamp();
  } catch (Exception $e) {
    return 0;
  }
}

function oc_event_engage_ajax() {
  check_ajax_referer('oc_engage_nonce', 'nonce');

  $event_id = isset($_POST['event_id']) ? sanitize_text_field($_POST['event_id']) : '';
  $type     = isset($_POST['type']) ? sanitize_key($_POST['type']) : '';

  if (!$event_id || !in_array($type, ['interested', 'going'], true)) {
    wp_send_json_error(['message' => 'Invalid request.'], 400);
  }

  $cookie_name = "oc_engaged_{$event_id}_{$type}";
  if (!empty($_COOKIE[$cookie_name])) {
    wp_send_json_success([
      'counts' => oc_get_engage_counts($event_id),
      'already' => true
    ]);
  }

  $key = oc_engage_key($event_id, $type);
  $current = (int) get_option($key, 0);
  update_option($key, $current + 1, false);

  setcookie($cookie_name, '1', time() + (30 * DAY_IN_SECONDS), COOKIEPATH ?: '/', COOKIE_DOMAIN, is_ssl(), true);

  wp_send_json_success([
    'counts' => oc_get_engage_counts($event_id),
    'already' => false
  ]);
}

/**
 * Register rewrite + query var
 * Supports:
 * - /events/{id or slug}/   (NEW primary)
 * - /oc-events/{id or slug}/ (OLD legacy redirect)
 */
function oc_vep_register_rewrites() {
  add_rewrite_tag('%oc_event_key%', '([^&]+)');
  add_rewrite_tag('%oc_venue_key%', '([^&]+)');

  add_rewrite_rule('^' . OC_VIRTUAL_BASE . '/([^/]+)/?$', 'index.php?oc_event_key=$matches[1]', 'top');
  add_rewrite_rule('^' . OC_OLD_BASE . '/([^/]+)/?$', 'index.php?oc_event_key=$matches[1]', 'top');
  add_rewrite_rule('^' . OC_VENUE_BASE . '/([^/]+)/?$', 'index.php?oc_venue_key=$matches[1]', 'top');
}
add_action('init', 'oc_vep_register_rewrites');

// Proxy /events-sitemap.xml -> API sitemap
add_action('init', function () {
  add_rewrite_rule('^events-sitemap\.xml$', 'index.php?oc_events_sitemap=1', 'top');
  add_rewrite_tag('%oc_events_sitemap%', '1');
});

add_action('template_redirect', function () {
  if (get_query_var('oc_events_sitemap') !== '1') return;

  $api_url = rtrim((string) OC_API_BASE, '/') . '/events/sitemap.xml';
  $res = wp_remote_get($api_url, ['timeout' => 15]);

  if (is_wp_error($res)) {
    status_header(502);
    echo 'Sitemap fetch failed.';
    exit;
  }

  $body = wp_remote_retrieve_body($res);
  if (!$body) {
    status_header(502);
    echo 'Empty sitemap.';
    exit;
  }

  header('Content-Type: application/xml; charset=UTF-8');
  echo $body;
  exit;
});

// Fallback: serve sitemap without rewrites
add_action('template_redirect', function () {
  $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
  if ($path !== '/events-sitemap.xml') return;

  $api_url = rtrim((string) OC_API_BASE, '/') . '/events/sitemap.xml';
  $res = wp_remote_get($api_url, ['timeout' => 15]);

  if (is_wp_error($res)) {
    status_header(502);
    echo 'Sitemap fetch failed.';
    exit;
  }

  $body = wp_remote_retrieve_body($res);
  if (!$body) {
    status_header(502);
    echo 'Empty sitemap.';
    exit;
  }

  header('Content-Type: application/xml; charset=UTF-8');
  echo $body;
  exit;
});

function oc_vep_on_activation() {
  oc_vep_register_rewrites();
  flush_rewrite_rules();
}

function oc_vep_on_deactivation() {
  flush_rewrite_rules();
}

add_filter('query_vars', function ($vars) {
  $vars[] = 'oc_event_key';
  $vars[] = 'oc_venue_key';
  $vars[] = 'oc_events_sitemap';
  return $vars;
});

/**
 * Detect our virtual page
 */
function oc_vep_is_virtual_event() {
  $key = get_query_var('oc_event_key');
  if ($key) return true;

  $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
  return oc_path_is_virtual_event($path);
}

function oc_vep_is_virtual_venue() {
  $key = get_query_var('oc_venue_key');
  if ($key) return true;

  $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
  return oc_path_is_virtual_venue($path);
}

function oc_vep_is_virtual_page() {
  return oc_vep_is_virtual_event() || oc_vep_is_virtual_venue();
}

function oc_vep_resolve_theme_context_post($virtual_base = OC_VIRTUAL_BASE) {
  $context_post = null;

  if (function_exists('oc_integration_get_events_grid_page_url')) {
    $events_page_url = trim((string) oc_integration_get_events_grid_page_url());
    if ($events_page_url !== '') {
      $events_page_id = url_to_postid($events_page_url);
      if ($events_page_id) {
        $candidate = get_post($events_page_id);
        if ($candidate instanceof WP_Post) {
          $context_post = $candidate;
        }
      }
    }
  }

  if (!$context_post instanceof WP_Post) {
    $candidate = get_page_by_path((string) $virtual_base, OBJECT, 'page');
    if ($candidate instanceof WP_Post) {
      $context_post = $candidate;
    }
  }

  if (!$context_post instanceof WP_Post) {
    $front_page_id = (int) get_option('page_on_front');
    if ($front_page_id > 0) {
      $candidate = get_post($front_page_id);
      if ($candidate instanceof WP_Post) {
        $context_post = $candidate;
      }
    }
  }

  return $context_post instanceof WP_Post ? $context_post : null;
}

/**
 * Force WPBakery frontend assets on virtual pages so footer grid/layout works.
 */
add_action('wp_enqueue_scripts', function () {
  if (!oc_vep_is_virtual_page()) return;

  if (defined('WPB_VC_VERSION')) {
    wp_enqueue_style('js_composer_front');
    if (wp_script_is('wpb_composer_front_js', 'registered')) {
      wp_enqueue_script('wpb_composer_front_js');
    }
  }
}, 20);

/**
 * CLEAN: API description that may contain VC shortcodes
 */
function oc_clean_event_description($raw) {
  $raw = (string)$raw;
  $raw = str_replace(["\r\n", "\r"], "\n", $raw);

  if (stripos($raw, '[vc_') !== false || stripos($raw, 'vc_custom_') !== false) {
    $raw = preg_replace('/\[[^\]]+\]/', '', $raw);
    $raw = preg_replace('/vc_custom_\d+\{[^}]*\}/i', '', $raw);
    $raw = preg_replace('/\b(css|offset|width|gap|content_placement|img_size|onclick|link|style)\s*=\s*(".*?"|\'.*?\'|\S+)/i', '', $raw);
  } else {
    $raw = strip_shortcodes($raw);
  }

  $raw = preg_replace("/\n{3,}/", "\n\n", $raw);
  $raw = trim($raw);

  if ($raw === '') return '';

  return wp_kses_post(wpautop($raw));
}

function oc_render_rich_text($raw) {
  if ($raw === null || $raw === '') return '';

  $raw = (string)$raw;

  $raw = html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8');
  $raw = htmlspecialchars_decode($raw, ENT_QUOTES);

  if (stripos($raw, '[vc_') !== false || stripos($raw, 'vc_custom_') !== false) {
    $raw = preg_replace('/\[[^\]]+\]/', '', $raw);
    $raw = preg_replace('/vc_custom_\d+\{[^}]*\}/i', '', $raw);
  } else {
    $raw = strip_shortcodes($raw);
  }

  $raw = trim($raw);
  if ($raw === '') return '';

  if ($raw !== strip_tags($raw)) {
    return wp_kses_post($raw);
  }

  return wp_kses_post(wpautop($raw));
}

function oc_build_maps_link($location_raw, $city_raw = '', $state_raw = 'WA', $postal_raw = '') {
  $loc = trim((string)$location_raw);
  if ($loc === '') return '';

  $full = $loc;
  $lower = strtolower($loc);
  $city = trim((string)$city_raw);
  $state = trim((string)$state_raw);
  $postal = trim((string)$postal_raw);

  if ($city !== '' && strpos($lower, strtolower($city)) === false) {
    $full .= ', ' . $city;
  }
  if ($state !== '' && strpos($lower, strtolower($state)) === false && strpos($lower, 'washington') === false) {
    $full .= ', ' . $state;
  }
  if ($postal !== '' && strpos($lower, strtolower($postal)) === false) {
    $full .= ' ' . $postal;
  }

  $q = rawurlencode($full);
  return "https://www.google.com/maps/search/?api=1&query={$q}";
}

function oc_normalize_remote_url($raw) {
  $u = trim((string)$raw);
  if ($u === '' || strtolower($u) === 'none' || strtolower($u) === 'null' || strtolower($u) === 'undefined') {
    return '';
  }

  if (strpos($u, '//') === 0) {
    $u = 'https:' . $u;
  } elseif (strpos($u, '/') === 0) {
    $u = rtrim(OC_API_BASE, '/') . $u;
  } elseif (!preg_match('#^https?://#i', $u) && preg_match('/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/.*)?$/i', $u)) {
    $u = 'https://' . $u;
  }

  $u = preg_replace('#^http://#i', 'https://', $u);
  return filter_var($u, FILTER_VALIDATE_URL) ? esc_url($u) : '';
}

function oc_venue_page_url($id_or_slug) {
  $k = trim((string)$id_or_slug);
  if ($k === '') return '';
  return home_url('/' . OC_VENUE_BASE . '/' . rawurlencode($k) . '/');
}

function oc_fetch_venue_match_for_location($location_raw, $city = '') {
  $location = trim((string)$location_raw);
  if ($location === '') return null;

  $url = rtrim(OC_API_BASE, '/') . '/venues/resolve?q=' . rawurlencode($location);
  if ($city !== '') {
    $url .= '&city=' . rawurlencode((string)$city);
  }

  $res = wp_remote_get($url, [
    'timeout' => 8,
    'headers' => ['Accept' => 'application/json'],
  ]);
  if (is_wp_error($res)) return null;

  $json = json_decode(wp_remote_retrieve_body($res), true);
  $venue = $json['data'] ?? null;
  if (!is_array($venue)) return null;

  $slug = trim((string)($venue['slug'] ?? ''));
  $name = trim((string)($venue['name'] ?? ''));
  $id   = trim((string)($venue['id'] ?? ''));
  if ($slug === '' && $id === '') return null;

  return [
    'slug' => $slug,
    'id'   => $id,
    'name' => $name,
  ];
}

function oc_ts_from_date_time($date, $time, $tz = null) {
  $tz = $tz ?: wp_timezone();
  $date = trim((string)$date);
  $time = trim((string)$time);

  if ($date === '') return 0;

  $str = $time !== '' ? ($date . ' ' . $time) : $date;

  $formats = [
    'Y-m-d g:i A', 'Y-m-d g:i a',
    'Y-m-d h:i A', 'Y-m-d h:i a',
    'Y-m-d H:i',   'Y-m-d',
    'm/d/Y g:i A', 'm/d/Y g:i a',
    'm/d/Y H:i',   'm/d/Y',
  ];

  foreach ($formats as $fmt) {
    $dt = DateTimeImmutable::createFromFormat($fmt, $str, $tz);
    if ($dt instanceof DateTimeImmutable) return $dt->getTimestamp();
  }

  try {
    $dt = new DateTimeImmutable($str, $tz);
    return $dt->getTimestamp();
  } catch (Exception $e) {
    return 0;
  }
}

/**
 * Render virtual event page
 */
add_action('template_redirect', function () {
  $key = get_query_var('oc_event_key');

  $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);

  if (!$key && $path) {
    if (preg_match('#^/' . preg_quote(OC_VIRTUAL_BASE, '#') . '/([^/]+)/?$#', $path, $m)) $key = $m[1];
    if (!$key && preg_match('#^/' . preg_quote(OC_OLD_BASE, '#') . '/([^/]+)/?$#', $path, $m)) $key = $m[1];
  }
  if (!$key) return;

  // If user hit legacy /oc-events/... redirect to /events/... (preserve key)
  if ($path && preg_match('#^/' . preg_quote(OC_OLD_BASE, '#') . '/([^/]+)/?$#', $path, $m)) {
    $to = home_url('/' . OC_VIRTUAL_BASE . '/' . rawurlencode($m[1]) . '/');
    wp_redirect($to, 301);
    exit;
  }

  remove_action('template_redirect', 'redirect_canonical');

  $key = trim((string)$key);
  if ($key === '') return;

  $is_id = ctype_digit($key);
  $key_safe = $is_id ? $key : sanitize_title($key);
  if ($key_safe === '') return;

  $url = rtrim(OC_API_BASE, '/') . ($is_id
    ? '/events/' . rawurlencode($key_safe)
    : '/events/slug/' . rawurlencode($key_safe)
  );

  $res = wp_remote_get($url, [
    'timeout' => 12,
    'headers' => ['Accept' => 'application/json'],
  ]);

  if (is_wp_error($res)) {
    status_header(502);
    wp_die('Could not load event from API.');
  }

  $json  = json_decode(wp_remote_retrieve_body($res), true);
  $event = $json['data'] ?? null;

  if (!$event) {
    status_header(404);
    wp_die('Event not found.');
  }

  // If we landed on /events/{id}/ but the event has a slug, redirect to /events/{slug}/
  $event_slug = trim((string)($event['slug'] ?? ''));
  if ($is_id && $event_slug !== '') {
    $preferred = home_url('/' . OC_VIRTUAL_BASE . '/' . rawurlencode($event_slug) . '/');
    $current_path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    $current = home_url($current_path);

    if (rtrim($preferred, '/') !== rtrim($current, '/')) {
      wp_redirect($preferred, 301);
      exit;
    }
  }

  $is_featured =
    (!empty($event['featured']) && (int)$event['featured'] === 1) ||
    (!empty($event['isFeatured']) && $event['isFeatured']);
  $is_trending = function_exists('oc_integration_event_is_trending')
    ? oc_integration_event_is_trending(oc_event_trending_score($event))
    : (oc_event_trending_score($event) >= 10);

  $eventId = isset($event['id']) ? (string)$event['id'] : $key;
  $eventIdInt = ctype_digit($eventId) ? (int)$eventId : 0;

  $title_raw = trim((string)($event['title'] ?? 'Event'));
  $title     = esc_html($title_raw);
  $seo_title = trim((string)($event['seoTitle'] ?? ''));
  $focus_keyphrase = trim((string)($event['focusKeyphrase'] ?? ''));
  $location  = esc_html($event['location'] ?? '');
  $organizer = esc_html($event['organizer'] ?? '');
  $venue_match = oc_fetch_venue_match_for_location((string)($event['location'] ?? ''), (string)($event['city'] ?? ''));
  $venue_url = '';
  if (is_array($venue_match)) {
    $venue_key = trim((string)($venue_match['slug'] ?? ''));
    if ($venue_key === '') $venue_key = trim((string)($venue_match['id'] ?? ''));
    if ($venue_key !== '') $venue_url = oc_venue_page_url($venue_key);
  }
  $organizer_venue_match = oc_fetch_venue_match_for_location((string)($event['organizer'] ?? ''), (string)($event['city'] ?? ''));
  $organizer_venue_url = '';
  if (is_array($organizer_venue_match)) {
    $organizer_venue_key = trim((string)($organizer_venue_match['slug'] ?? ''));
    if ($organizer_venue_key === '') $organizer_venue_key = trim((string)($organizer_venue_match['id'] ?? ''));
    if ($organizer_venue_key !== '') $organizer_venue_url = oc_venue_page_url($organizer_venue_key);
  }
  if ($organizer_venue_url === '' && $venue_url !== '') {
    $organizer_venue_url = $venue_url;
  }
  $organizer_grid_url = function_exists('oc_integration_get_organizer_grid_url')
    ? oc_integration_get_organizer_grid_url((string)($event['organizer'] ?? ''))
    : '';

  $imageUrl = oc_normalize_remote_url((string)($event['imageUrl'] ?? ''));
  $imageAlt = trim((string) oc_integration_api_seo_field($event, 'imageAlt', ''));

  $startISO = $event['startDateTime'] ?? '';
  $endISO   = $event['endDateTime'] ?? '';

  $startTS = oc_wp_timestamp_from_iso($startISO);
  $endTS   = oc_wp_timestamp_from_iso($endISO);

  $is_recurring_event = (int)($event['hasRecurrence'] ?? 0) === 1
    || !empty($event['recurrenceRule'])
    || !empty($event['recurrenceDates']);

  $dateLabel = $startTS ? oc_event_format_date_range_label($startTS, $endTS, null, !$is_recurring_event) : '';
  $nowTs = time();
  $effectiveDetailEndTs = $endTS ?: $startTS;
  $is_happening_now = $startTS && $startTS <= $nowTs && $effectiveDetailEndTs >= $nowTs;

  $headerDateLabel = $dateLabel;
  $lockMainDateToRangeSummary = false;
  $multiDayHeaderLabel = oc_event_build_multi_day_header_label($event);
  if ($multiDayHeaderLabel !== '') {
    $headerDateLabel = $multiDayHeaderLabel;
    $lockMainDateToRangeSummary = true;
  }

  $timeLabel = $startTS ? wp_date('g:i a', $startTS) : '';
  $endLabel  = $endTS ? wp_date('g:i a', $endTS) : '';

  $archivedRaw = $event['archived'] ?? ($event['Archived'] ?? 0);
  $archivedVal = strtolower(trim((string)$archivedRaw));
  $is_archived_event = in_array($archivedVal, ['1', 'true', 'yes', 'on'], true);

  $effectiveEndTS = $endTS ?: $startTS;
  $is_past_event = $effectiveEndTS ? ($effectiveEndTS < time()) : false;
  $canonical_url = oc_integration_api_seo_url($event, '');
  $robots_state = oc_integration_api_robots_state($event);
  $api_seo_title = trim((string) oc_integration_api_seo_field($event, 'seoTitle', ''));
  $api_meta_desc = trim((string) oc_integration_api_seo_field($event, 'metaDescription', ''));
  $api_excerpt_plain = trim((string) oc_integration_api_seo_field($event, 'excerptPlainText', ''));
  $api_last_modified = trim((string) oc_integration_api_seo_field($event, 'lastModified', ''));
  $api_structured_data = oc_integration_api_seo_field($event, 'structuredData', null);
  $should_noindex = ($is_archived_event || $is_past_event || $robots_state['has_noindex'] || $robots_state['indexable'] === false);
  oc_integration_apply_last_modified_header($api_last_modified);

  if ($should_noindex) {
    if (!headers_sent()) {
      header('X-Robots-Tag: noindex, follow', true);
    }

    add_filter('wp_robots', function ($robots) {
      if (!is_array($robots)) $robots = [];
      $robots['noindex'] = true;
      $robots['nofollow'] = false;
      return $robots;
    }, 99);

    add_filter('wpseo_robots', function () {
      return 'noindex,follow';
    }, 99);
  }

  $desc = oc_clean_event_description($event['description'] ?? '');

  $eventDetails = oc_render_rich_text($event['eventDetails'] ?? '');
  $goodToKnow   = oc_render_rich_text($event['goodToKnow'] ?? '');

  add_filter('body_class', function ($classes) {
    $classes[] = 'single';
    $classes[] = 'single-event';
    $classes[] = 'single-tribe_events';
    $classes[] = 'tribe-events-page-template';
    return $classes;
  });

  $document_title = $api_seo_title !== '' ? $api_seo_title : (wp_strip_all_tags($title_raw) . ' | EnumclawEvents.org');

  add_filter('document_title_parts', function ($parts) use ($document_title) {
    $parts['title'] = $document_title;
    unset($parts['tagline']);
    return $parts;
  }, 999);

  add_filter('pre_get_document_title', function ($current) use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('wp_title', function ($current) use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('wpseo_frontend_presenters', function ($presenters) {
    return [];
  }, 999);

  add_filter('wpseo_json_ld_output', function ($data) {
    return false;
  }, 999);

  add_filter('wpseo_schema_graph_pieces', function ($pieces) {
    return [];
  }, 999);

  remove_action('wp_head', 'wp_oembed_add_discovery_links');
  remove_action('wp_head', 'rest_output_link_wp_head');

  add_filter('post_thumbnail_id', function ($thumbnail_id, $post_obj = null) {
    return 0;
  }, 999, 2);

  add_filter('get_post_metadata', function ($value, $object_id, $meta_key, $single) {
    if ($meta_key === '_thumbnail_id') {
      return $single ? '' : [];
    }
    return $value;
  }, 999, 4);

  add_filter('wpseo_title', function () use ($document_title) {
    return $document_title;
  }, 999);

  global $wp_query, $post;

  $current_path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
  if (is_string($current_path) && strpos($current_path, '/' . OC_OLD_BASE . '/') === 0) {
    $current_path = '/' . OC_VIRTUAL_BASE . '/' . ltrim(substr($current_path, strlen('/' . OC_OLD_BASE . '/')), '/');
  }
  $event_url = home_url($current_path);
  if ($canonical_url === '') $canonical_url = $event_url;

  $meta_desc_raw = $api_meta_desc;
  $og_desc_raw = wp_strip_all_tags($event['description'] ?? '');
  $og_desc_raw = trim(preg_replace('/\s+/', ' ', $og_desc_raw));
  $og_desc = $meta_desc_raw !== '' ? $meta_desc_raw : ($api_excerpt_plain !== '' ? $api_excerpt_plain : ($og_desc_raw ? wp_html_excerpt($og_desc_raw, 180, '…') : get_bloginfo('description')));

  add_filter('wpseo_metadesc', function () use ($og_desc) {
    return $og_desc;
  }, 999);

  add_filter('wpseo_canonical', function ($url) use ($canonical_url) {
    return $canonical_url;
  }, 999);

  add_filter('wpseo_opengraph_title', function () use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('wpseo_opengraph_desc', function () use ($og_desc) {
    return $og_desc;
  }, 999);

  add_filter('wpseo_opengraph_url', function ($url) use ($canonical_url) {
    return $canonical_url;
  }, 999);

  add_filter('wpseo_opengraph_type', function () {
    return 'article';
  }, 999);

  if ($imageUrl !== '') {
    add_filter('wpseo_opengraph_image', function ($url) use ($imageUrl) {
      return $imageUrl;
    }, 999);

    add_filter('wpseo_twitter_image', function () use ($imageUrl) {
      return $imageUrl;
    }, 999);
  }

  add_filter('rank_math/opengraph/facebook/title', function ($title) use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('rank_math/opengraph/facebook/description', function ($desc) use ($og_desc) {
    return $og_desc;
  }, 999);

  add_filter('rank_math/opengraph/twitter/title', function ($title) use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('rank_math/opengraph/twitter/description', function ($desc) use ($og_desc) {
    return $og_desc;
  }, 999);

  if ($imageUrl !== '') {
    add_filter('rank_math/opengraph/facebook/image', function ($url) use ($imageUrl) {
      return $imageUrl;
    }, 999);

    add_filter('rank_math/opengraph/twitter/image', function ($url) use ($imageUrl) {
      return $imageUrl;
    }, 999);
  }

  add_filter('wpseo_twitter_title', function () use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('wpseo_twitter_description', function () use ($og_desc) {
    return $og_desc;
  }, 999);

  add_filter('rank_math/frontend/title', function ($title) use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('rank_math/frontend/description', function ($desc) use ($og_desc) {
    return $og_desc;
  }, 999);

  add_filter('rank_math/frontend/canonical', function ($url) use ($canonical_url) {
    return $canonical_url;
  }, 999);

  add_action('wp_head', function () use ($document_title, $og_desc, $imageUrl, $imageAlt, $canonical_url, $startISO, $endISO, $location, $organizer, $event, $focus_keyphrase, $api_last_modified, $api_structured_data, $robots_state) {
    echo '<title>' . esc_html(wp_strip_all_tags($document_title)) . '</title>' . "\n";
    echo "\n" . '<meta name="description" content="' . esc_attr($og_desc) . '" />' . "\n";
    if ($focus_keyphrase !== '') {
      echo '<meta name="keywords" content="' . esc_attr($focus_keyphrase) . '" />' . "\n";
    }
    if ($robots_state['raw'] !== '') {
      echo '<meta name="robots" content="' . esc_attr($robots_state['raw']) . '" />' . "\n";
    }
    if ($api_last_modified !== '') {
      echo '<meta property="article:modified_time" content="' . esc_attr($api_last_modified) . '" />' . "\n";
    }
    echo '<link rel="canonical" href="' . esc_url($canonical_url) . '" />' . "\n";
    echo "\n" . '<meta property="og:type" content="article" />' . "\n";
    echo '<meta property="og:title" content="' . esc_attr(wp_strip_all_tags($document_title)) . '" />' . "\n";
    echo '<meta property="og:description" content="' . esc_attr($og_desc) . '" />' . "\n";
    echo '<meta property="og:url" content="' . esc_url($canonical_url) . '" />' . "\n";
    echo '<meta property="og:site_name" content="' . esc_attr(get_bloginfo('name')) . '" />' . "\n";

    if (!empty($imageUrl)) {
      echo '<meta property="og:image" content="' . esc_url($imageUrl) . '" />' . "\n";
      echo '<meta property="og:image:secure_url" content="' . esc_url($imageUrl) . '" />' . "\n";
      if ($imageAlt !== '') {
        echo '<meta property="og:image:alt" content="' . esc_attr($imageAlt) . '" />' . "\n";
      }
    }

    $card = !empty($imageUrl) ? 'summary_large_image' : 'summary';
    echo '<meta name="twitter:card" content="' . esc_attr($card) . '" />' . "\n";
    echo '<meta name="twitter:title" content="' . esc_attr(wp_strip_all_tags($document_title)) . '" />' . "\n";
    echo '<meta name="twitter:description" content="' . esc_attr($og_desc) . '" />' . "\n";
    if (!empty($imageUrl)) {
      echo '<meta name="twitter:image" content="' . esc_url($imageUrl) . '" />' . "\n";
    }

    $schema = [
      "@context" => "https://schema.org",
      "@type" => "Event",
      "name" => wp_strip_all_tags($document_title),
      "startDate" => $startISO ? $startISO : null,
      "endDate" => $endISO ? $endISO : null,
      "eventAttendanceMode" => "https://schema.org/OfflineEventAttendanceMode",
      "eventStatus" => "https://schema.org/EventScheduled",
      "description" => wp_strip_all_tags($event['description'] ?? ''),
      "url" => $canonical_url,
      "image" => $imageUrl ? [$imageUrl] : null,
      "location" => [
        "@type" => "Place",
        "name" => $location ? $location : "Enumclaw",
        "address" => [
          "@type" => "PostalAddress",
          "streetAddress" => $location ? $location : "",
          "addressLocality" => "Enumclaw",
          "addressRegion" => "WA",
          "postalCode" => "98022",
          "addressCountry" => "US"
        ]
      ],
      "organizer" => $organizer ? [
        "@type" => "Organization",
        "name" => $organizer
      ] : null,
    ];
    $schema = array_filter($schema, function($v){ return $v !== null && $v !== ''; });
    oc_integration_print_structured_data($api_structured_data, $schema);
  }, 1);

  $context_post = oc_vep_resolve_theme_context_post(OC_VIRTUAL_BASE);

  if ($context_post instanceof WP_Post) {
    $post = get_post($context_post->ID);
  } else {
    $fake = (object) [
      'ID' => 0,
      'post_author' => 1,
      'post_date' => current_time('mysql'),
      'post_date_gmt' => current_time('mysql', 1),
      'post_content' => '',
      'post_title' => wp_strip_all_tags($title_raw),
      'post_excerpt' => '',
      'post_status' => 'publish',
      'comment_status' => 'closed',
      'ping_status' => 'closed',
      'post_password' => '',
      'post_name' => sanitize_title($title),
      'to_ping' => '',
      'pinged' => '',
      'post_modified' => current_time('mysql'),
      'post_modified_gmt' => current_time('mysql', 1),
      'post_content_filtered' => '',
      'post_parent' => 0,
      'guid' => home_url($current_path),
      'menu_order' => 0,
      'post_type' => 'page',
      'post_mime_type' => '',
      'comment_count' => 0,
    ];

    $post = new WP_Post($fake);
  }

  $wp_query->is_404 = false;
  $wp_query->is_singular = true;
  $wp_query->is_page = ($post instanceof WP_Post && $post->post_type === 'page');
  $wp_query->is_single = ($post instanceof WP_Post && $post->post_type === 'post');
  $wp_query->is_home = false;
  $wp_query->is_archive = false;
  $wp_query->queried_object = $post;
  $wp_query->queried_object_id = $post->ID;
  $wp_query->post = $post;
  $wp_query->posts = [$post];
  $wp_query->post_count = 1;
  $wp_query->found_posts = 1;
  $wp_query->max_num_pages = 1;

  status_header(200);
  setup_postdata($post);

  $GLOBALS['oc_vep_event_render_scope'] = get_defined_vars();
  $oc_render_event_content = function () {
    $scope = isset($GLOBALS['oc_vep_event_render_scope']) && is_array($GLOBALS['oc_vep_event_render_scope'])
      ? $GLOBALS['oc_vep_event_render_scope']
      : [];
    extract($scope, EXTR_SKIP);
?>

<div id="tribe-events-pg-template" class="tribe-events-pg-template oc-event-template">
  <div id="tribe-events-content" class="tribe-events-single hentry tribe-clearfix oc-event-template__content">


    <div class="oc-single-layout">

      <main class="oc-single-main">
        <article id="post-<?php echo (int) $eventIdInt; ?>" class="tribe_events type-tribe_events status-publish hentry oc-event-article">

<?php if ($imageUrl): ?>
  <button type="button"
          class="tribe-events-event-image oc-hero-image oc-hero-image__btn"
          data-oc-full="<?php echo esc_url($imageUrl); ?>">

    <?php if ($is_featured || $is_trending || $is_happening_now || $is_recurring_event): ?>
      <div class="oc-hero-badges" data-oc-hero-badges<?php echo (!$is_featured && !$is_trending && !$is_happening_now) ? ' hidden' : ''; ?>>
        <?php if ($is_featured): ?>
          <div class="oc-featured-badge oc-featured-badge--hero">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 2.8l2.85 5.77 6.37.93-4.61 4.49 1.09 6.35L12 17.37 6.3 20.34l1.09-6.35L2.78 9.5l6.37-.93L12 2.8z"></path>
            </svg>
            <span>Featured Event</span>
          </div>
        <?php endif; ?>
        <div class="oc-happening-badge oc-happening-badge--hero" data-oc-happening-badge<?php echo $is_happening_now ? '' : ' hidden'; ?>>Happening Now</div>
        <?php if ($is_trending): ?>
          <div class="oc-trending-badge oc-trending-badge--hero" aria-label="Trending event">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M16 6h5v5h-2.5V9.77l-6.03 6.03-3.5-3.5-5.24 5.24L2 15.8l6.97-6.97 3.5 3.5L16.23 8.5H16V6z"></path>
            </svg>
            <span>Trending</span>
          </div>
        <?php endif; ?>
      </div>
    <?php endif; ?>

    <img src="<?php echo esc_url($imageUrl); ?>" alt="<?php echo esc_attr($title); ?>" />

    <div class="oc-hero-image__fade" aria-hidden="true"></div>

    <div class="oc-hero-image__overlay" aria-hidden="true">
      <span class="oc-hero-image__overlay-inner">
        <span class="oc-hero-image__icon" aria-hidden="true">⤢</span>
        <span class="oc-hero-image__text">View full image</span>
      </span>
    </div>

  </button>
<?php endif; ?>


          <?php
            $cats = $event['categories'] ?? [];
            if (!is_array($cats)) $cats = [];

            $cats = array_values(array_filter(array_map(function($c){
              $c = trim((string)$c);
              return $c !== '' ? $c : null;
            }, $cats)));

            $cats = array_slice($cats, 0, 3);
          ?>

          <?php if (!empty($cats)): ?>
            <div class="oc-event-cats" aria-label="Event categories">
              <?php foreach ($cats as $c): ?>
                <span class="oc-cat-pill"><?php echo esc_html($c); ?></span>
              <?php endforeach; ?>
            </div>
          <?php endif; ?>

          <header class="tribe-events-single-event-title oc-event-header">
            <h1 class="tribe-events-single-event-title oc-event-title"><?php echo $title; ?></h1>
          </header>

          <?php if ($headerDateLabel): ?>
            <div class="tribe-events-schedule tribe-clearfix oc-event-schedule">
              <h2><span class="tribe-event-date-start" id="ocMainDate"<?php echo $lockMainDateToRangeSummary ? ' data-lock-occurrence-date="1"' : ''; ?>><?php echo esc_html($headerDateLabel); ?></span></h2>
            </div>
          <?php endif; ?>

          <?php if ($timeLabel || $location || $organizer): ?>
            <div class="oc-meta-grid">
              <div class="oc-meta-col">
                <div class="oc-meta-label">Time</div>
                <div class="oc-meta-value">
                  <span id="ocMainTime">
                    <?php echo esc_html($timeLabel ? (' From ' . $timeLabel . ($endLabel ? ' to ' . $endLabel : '')) : ''); ?>
                  </span>
                </div>
              </div>

              <div class="oc-meta-col">
                <div class="oc-meta-label">Location</div>
                <?php $mapsHref = oc_build_maps_link($event['location'] ?? '', $event['city'] ?? '', $event['state'] ?? 'WA', $event['postalCode'] ?? ($event['zip'] ?? '')); ?>
                <div class="oc-meta-value">
                  <?php if ($location && $mapsHref): ?>
                    <a class="oc-map-link" href="<?php echo esc_url($mapsHref); ?>" target="_blank" rel="noopener noreferrer">
                      <?php echo $location; ?>
                    </a>
                  <?php else: ?>
                    <?php echo $location ? $location : '&nbsp;'; ?>
                  <?php endif; ?>
                </div>
              </div>

              <div class="oc-meta-col">
                <div class="oc-meta-label">Organizer</div>
                <div class="oc-meta-value">
                  <?php if ($organizer && $organizer_grid_url): ?>
                    <a class="oc-map-link oc-venue-link" href="<?php echo esc_url($organizer_grid_url); ?>">
                      <?php echo $organizer; ?>
                    </a>
                  <?php elseif ($organizer && $organizer_venue_url): ?>
                    <a class="oc-map-link oc-venue-link" href="<?php echo esc_url($organizer_venue_url); ?>">
                      <?php echo $organizer; ?>
                    </a>
                  <?php else: ?>
                    <?php echo $organizer ? $organizer : '&nbsp;'; ?>
                  <?php endif; ?>
                </div>
              </div>
            </div>

            <hr class="oc-meta-divider" />
          <?php endif; ?>

          <div class="tribe-events-single-event-description tribe-events-content entry-content oc-event-description">
            <h3 class="oc-event-section-title">Event Description</h3>
            <?php echo $desc ?: ''; ?>

            <?php if (!empty($eventDetails)): ?>
              <h3 class="oc-event-section-title oc-section-spacer">Event Details</h3>
              <?php echo $eventDetails; ?>
            <?php endif; ?>

            <?php if (!empty($goodToKnow)): ?>
              <h3 class="oc-event-section-title oc-section-spacer">Good to Know</h3>
              <?php echo $goodToKnow; ?>
            <?php endif; ?>
          </div>

          <hr class="oc-meta-divider" />

<?php
/**
 * RELATED EVENTS (3)
 */
$related = [];
$city = $event['city'] ?? '';

if ($city) {
  $related_url = rtrim(OC_API_BASE, '/') . '/events?city=' . rawurlencode($city);

  $related_res = wp_remote_get($related_url, [
    'timeout' => 12,
    'headers' => ['Accept' => 'application/json'],
  ]);

  if (!is_wp_error($related_res)) {
    $related_json = json_decode(wp_remote_retrieve_body($related_res), true);
    $items = $related_json['data'] ?? [];

    if (is_array($items)) {
      $seen = [];

      foreach ($items as $it) {
        $it_id_raw = (string)($it['id'] ?? '');
        $it_id = trim($it_id_raw);
        if ($it_id === '') continue;

        if ($it_id === (string)$eventId) continue;

        $it_slug = sanitize_title((string)($it['slug'] ?? ''));
        $dedupe_key = $it_slug !== '' ? $it_slug : $it_id;

        if (isset($seen[$dedupe_key])) continue;
        $seen[$dedupe_key] = true;

        $it_start = $it['startDateTime'] ?? '';
        $it_ts = $it_start ? oc_wp_timestamp_from_iso($it_start) : false;
        $it_end_ts = oc_wp_timestamp_from_iso((string)($it['endDateTime'] ?? '')) ?: 0;
        $it_is_recurring = (int)($it['hasRecurrence'] ?? 0) === 1
          || !empty($it['recurrenceRule'])
          || !empty($it['recurrenceDates']);

        $img = (string)($it['imageUrl'] ?? '');

        $related[] = [
          'id'          => $it_id,
          'slug'        => $it_slug,
          'key'         => $it_slug !== '' ? $it_slug : $it_id,
          'title'       => (string)($it['title'] ?? 'Event'),
          'start_ts'    => $it_ts ?: 0,
          'start_label' => $it_ts ? oc_event_format_date_range_label($it_ts, $it_end_ts, null, !$it_is_recurring) : '',
          'time_label'  => $it_ts ? wp_date('g:i a', $it_ts) : '',
          'location'    => (string)($it['location'] ?? ''),
          'image'       => $img,
        ];
      }

      usort($related, function($a, $b){
        return ($a['start_ts'] <=> $b['start_ts']);
      });

      $related = array_slice($related, 0, 3);
    }
  }
}
?>

          <?php if (!empty($related)): ?>
            <section class="oc-related" aria-label="Related events">
              <div class="oc-more-head oc-section-spacer">
                <h3 class="oc-event-section-title">More Events</h3>

                <!-- UPDATED: listing page is /events/ -->
                <a class="oc-see-all-btn" href="<?php echo esc_url(home_url('/' . OC_VIRTUAL_BASE . '/')); ?>">
                  See all
                </a>
              </div>

              <div class="oc-related-grid">
                <?php foreach ($related as $r): ?>
                  <?php
                    // UPDATED: related single page links use /events/{key}/
                    $r_link = home_url('/' . OC_VIRTUAL_BASE . '/' . rawurlencode((string)($r['key'] ?? $r['id'])) . '/');
                    $r_img = oc_normalize_remote_url((string)$r['image']);
                    $r_img_ok = ($r_img !== '');
                  ?>

                  <a class="oc-related-card" href="<?php echo esc_url($r_link); ?>">
                    <?php if ($r_img_ok): ?>
                      <div class="oc-related-image">
                        <img src="<?php echo esc_url($r_img); ?>" alt="<?php echo esc_attr($r['title']); ?>">
                      </div>
                    <?php endif; ?>

                    <div class="oc-related-text">
                      <div class="oc-related-title"><?php echo esc_html($r['title']); ?></div>

                      <?php if (!empty($r['start_label'])): ?>
                        <div class="oc-meta">
                          <span class="oc-ico" aria-hidden="true">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                              <line x1="16" y1="2" x2="16" y2="6"></line>
                              <line x1="8" y1="2" x2="8" y2="6"></line>
                              <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                          </span>
                          <span><?php echo esc_html($r['start_label']); ?></span>
                        </div>
                      <?php endif; ?>

                      <?php if (!empty($r['time_label'])): ?>
                        <div class="oc-meta">
                          <span class="oc-ico" aria-hidden="true">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <circle cx="12" cy="12" r="10"></circle>
                              <polyline points="12 6 12 12 16 14"></polyline>
                            </svg>
                          </span>
                          <span><?php echo esc_html($r['time_label']); ?></span>
                        </div>
                      <?php endif; ?>

                      <?php if (!empty($r['location'])): ?>
                        <div class="oc-meta">
                          <span class="oc-ico" aria-hidden="true">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                              <circle cx="12" cy="10" r="3"></circle>
                            </svg>
                          </span>
                          <span><?php echo esc_html($r['location']); ?></span>
                        </div>
                      <?php endif; ?>
                    </div>
                  </a>

                <?php endforeach; ?>
              </div>
            </section>
          <?php endif; ?>

        </article>
      </main>

      <aside class="oc-single-sidebar">

        <?php
          $ticketTrackedUrlRaw = trim((string)($event['ticketTrackedUrl'] ?? ''));
          $ticketUrlRaw = trim((string)($event['ticketUrl'] ?? ''));
          $ticketLabel  = trim((string)($event['ticketLabel'] ?? 'Tickets'));
          $ticketTrackedFallback = '';
          if ($ticketTrackedUrlRaw === '' && $ticketUrlRaw !== '' && !empty($eventId)) {
            $ticketTrackedFallback = trailingslashit(OC_API_BASE) . 'events/' . rawurlencode((string)$eventId) . '/tickets';
          }
          $ticketUrlCandidate = $ticketTrackedUrlRaw !== '' ? $ticketTrackedUrlRaw : ($ticketTrackedFallback !== '' ? $ticketTrackedFallback : $ticketUrlRaw);
          $ticketUrl = ($ticketUrlCandidate && filter_var($ticketUrlCandidate, FILTER_VALIDATE_URL)) ? esc_url($ticketUrlCandidate) : '';
          if ($ticketLabel === '') $ticketLabel = 'Tickets';
        ?>

<?php
  // Occurrences (your existing logic kept as-is)
  $occ = [];
  foreach (['occurrencesUpcoming', 'occurrences', 'upcomingOccurrences'] as $k) {
    if (!empty($event[$k]) && is_array($event[$k])) { $occ = $event[$k]; break; }
  }
  if (!is_array($occ)) $occ = [];

  $tz = wp_timezone();

  $baseStart = (string)($event['startDateTime'] ?? '');
  $baseEnd   = (string)($event['endDateTime'] ?? '');

  $baseStartTs = oc_wp_timestamp_from_iso($baseStart) ?: 0;
  $baseEndTs   = oc_wp_timestamp_from_iso($baseEnd) ?: 0;

  $baseStartHHMM = $baseStartTs ? wp_date('H:i', $baseStartTs, $tz) : '';
  $baseEndHHMM   = $baseEndTs   ? wp_date('H:i', $baseEndTs,   $tz) : '';
  $normalized = [];

  foreach ($occ as $o) {
    if (is_string($o) && trim($o) !== '') {
      $st = trim($o);
      $stTs = oc_wp_timestamp_from_iso($st) ?: 0;
      if (!$stTs) continue;
      $normalized[] = [
        '__start_ts' => $stTs,
        '__end_ts'   => 0,
        'label'      => '',
      ];
      continue;
    }

    if (!is_array($o)) continue;

    $o_start = trim((string)($o['startDateTime'] ?? ''));
    $o_end   = trim((string)($o['endDateTime'] ?? ''));

    if ($o_start !== '') {
      $stTs = oc_wp_timestamp_from_iso($o_start) ?: 0;
      if (!$stTs) continue;

      $enTs = $o_end !== '' ? (oc_wp_timestamp_from_iso($o_end) ?: 0) : 0;

      $normalized[] = [
        '__start_ts' => $stTs,
        '__end_ts'   => $enTs,
        'label'      => (string)($o['label'] ?? ''),
      ];
      continue;
    }

    $date = trim((string)($o['date'] ?? $o['day'] ?? $o['startDate'] ?? ''));
    if ($date === '') continue;

    $stTime = trim((string)($o['startTime'] ?? $o['time'] ?? ''));
    $enTime = trim((string)($o['endTime'] ?? ''));

    if ($stTime === '' && $baseStartHHMM !== '') $stTime = $baseStartHHMM;
    if ($enTime === '' && $baseEndHHMM   !== '') $enTime = $baseEndHHMM;

    $stTs = oc_ts_from_date_time($date, $stTime, $tz);
    if (!$stTs) continue;

    $enTs = $enTime !== '' ? oc_ts_from_date_time($date, $enTime, $tz) : 0;

    $normalized[] = [
      '__start_ts' => $stTs,
      '__end_ts'   => $enTs,
      'label'      => (string)($o['label'] ?? ''),
    ];
  }

  $has_api_occurrences = count($normalized) > 0;

  if ($baseStartTs && (($baseEndTs ?: $baseStartTs) >= $nowTs)) {
    array_unshift($normalized, [
      '__start_ts' => $baseStartTs,
      '__end_ts'   => $baseEndTs,
      'label'      => '',
    ]);
  }

  $seen = [];
  $occ_options = [];

  foreach ($normalized as $o) {
    $stTs = (int)($o['__start_ts'] ?? 0);
    if (!$stTs) continue;
    $enTs = (int)($o['__end_ts'] ?? 0);
    $effectiveEndTs = $enTs ?: $stTs;
    if ($effectiveEndTs < $nowTs) continue;
    if (isset($seen[$stTs])) continue;
    $seen[$stTs] = true;

    $o_date = oc_event_format_date_range_label($stTs, $enTs, $tz, !$is_recurring_event);
    $o_time = wp_date('g:i a',  $stTs, $tz);
    $o_endt = $enTs ? wp_date('g:i a', $enTs, $tz) : '';

    $occ_options[] = [
      'start_ts' => $stTs,
      'end_ts'   => $enTs,
      'date'     => $o_date,
      'time'     => $o_time,
      'end'      => $o_endt,
      'text'     => trim($o_date . ' • ' . $o_time),
    ];
  }

  usort($occ_options, fn($a,$b) => ($a['start_ts'] <=> $b['start_ts']));

  $show_occ_dropdown = $has_api_occurrences && (count($occ_options) > 1);
  $activeOccurrence = !empty($occ_options) ? $occ_options[0] : null;
  $calendarUrl = oc_build_event_calendar_url(
    $key_safe,
    (int)($activeOccurrence['start_ts'] ?? $startTS),
    (int)($activeOccurrence['end_ts'] ?? $endTS)
  );
?>

<div class="oc-sidebar-card oc-eng-card"
     data-event-id="<?php echo esc_attr((string) $eventId); ?>"
     data-oc-start-ts="<?php echo esc_attr((int)($activeOccurrence['start_ts'] ?? $startTS)); ?>"
     data-oc-end-ts="<?php echo esc_attr((int)($activeOccurrence['end_ts'] ?? $endTS)); ?>">

<?php if ($show_occ_dropdown): ?>
  <div class="oc-basic-row">
    <div class="oc-sidebar-title">Occurrences</div>
    <div class="oc-basic-value">
      <select class="oc-occ-select" id="ocOccurrenceSelect">
        <?php foreach ($occ_options as $opt): ?>
          <option
            value="<?php echo esc_attr((string)$opt['start_ts']); ?>"
            data-start-ts="<?php echo esc_attr((int)$opt['start_ts']); ?>"
            data-end-ts="<?php echo esc_attr((int)$opt['end_ts']); ?>"
            data-date="<?php echo esc_attr($opt['date']); ?>"
            data-time="<?php echo esc_attr($opt['time']); ?>"
            data-end="<?php echo esc_attr($opt['end']); ?>"
            <?php selected((int)$opt['start_ts'], (int)($activeOccurrence['start_ts'] ?? 0)); ?>
          >
            <?php echo esc_html($opt['text']); ?>
          </option>
        <?php endforeach; ?>
      </select>
    </div>
  </div>
<?php endif; ?>

<?php if (!empty($startISO)): ?>
  <div class="oc-countdown" aria-label="Countdown to event">
    <div class="oc-countdown__label" data-oc-countdown-label><?php echo $is_happening_now ? 'Happening now' : 'Starts in'; ?></div>
    <div class="oc-countdown__value" data-oc-countdown>—</div>
  </div>
<?php endif; ?>

  <div class="oc-sidebar-title">Engagement</div>

  <div class="oc-eng-actions">
    <button type="button" class="oc-eng-btn" data-oc-eng="going" data-event-id="<?php echo esc_attr((string) $eventId); ?>">
      <span class="oc-eng-btn__label">I’m Going</span>
      <span class="oc-eng-count" data-oc-count="going"><?php echo (int) oc_get_engage_counts($eventId)['going']; ?></span>
    </button>

    <button type="button" class="oc-eng-btn" data-oc-eng="interested" data-event-id="<?php echo esc_attr((string) $eventId); ?>">
      <span class="oc-eng-btn__label">I’m Interested</span>
      <span class="oc-eng-count" data-oc-count="interested"><?php echo (int) oc_get_engage_counts($eventId)['interested']; ?></span>
    </button>
  </div>

  <div class="oc-sidebar-note">
    Counts update instantly. Repeat clicks are blocked per browser.
  </div>

  <?php if ($ticketUrl): ?>
    <a class="oc-ticket-btn" href="<?php echo $ticketUrl; ?>" target="_blank" rel="noopener noreferrer">
      <?php echo esc_html($ticketLabel); ?>
    </a>
  <?php endif; ?>

  <a class="oc-calendar-btn"
     href="<?php echo esc_url($calendarUrl); ?>"
     data-oc-calendar-btn
     data-calendar-base="<?php echo esc_attr(oc_build_event_calendar_url($key_safe)); ?>">
    Add to Calendar
  </a>
</div>

<div class="oc-eng-mobile-lightbox" id="ocEngMobileLightbox" aria-hidden="true">
  <div class="oc-eng-mobile-lightbox__backdrop" data-oc-eng-mobile-close></div>
  <div class="oc-eng-mobile-lightbox__dialog" role="dialog" aria-modal="true" aria-labelledby="ocEngMobileLightboxTitle">
    <button type="button" class="oc-eng-mobile-lightbox__close" aria-label="Close" data-oc-eng-mobile-close>×</button>
    <div class="oc-eng-mobile-lightbox__head">
      <h2 id="ocEngMobileLightboxTitle">Event Actions</h2>
    </div>
    <div class="oc-eng-mobile-lightbox__body" data-oc-eng-mobile-body></div>
  </div>
</div>

        <div class="oc-sidebar-card">
          <div class="oc-sidebar-title">Event Details</div>

          <div class="oc-basic-row">
  <div class="oc-basic-label">Date</div>
  <div class="oc-basic-value"><span id="ocSidebarDate"><?php echo esc_html($dateLabel); ?></span></div>
</div>

<div class="oc-basic-row">
  <div class="oc-basic-label">Time</div>
  <div class="oc-basic-value"><span id="ocSidebarTime"><?php echo esc_html($timeLabel . ($endLabel ? ' – ' . $endLabel : '')); ?></span></div>
</div>

          <div class="oc-basic-row">
            <div class="oc-basic-label">Location</div>
            <?php $mapsHref = oc_build_maps_link($event['location'] ?? '', $event['city'] ?? '', $event['state'] ?? 'WA', $event['postalCode'] ?? ($event['zip'] ?? '')); ?>
<div class="oc-basic-value">
  <?php if ($location && $mapsHref): ?>
    <a class="oc-map-link" href="<?php echo esc_url($mapsHref); ?>" target="_blank" rel="noopener noreferrer">
      <?php echo $location; ?>
    </a>
  <?php else: ?>
    <?php echo $location; ?>
  <?php endif; ?>
</div>

          </div>

          <div class="oc-basic-row">
            <div class="oc-basic-label">Organizer</div>
            <div class="oc-basic-value">
              <?php if ($organizer && $organizer_grid_url): ?>
                <a class="oc-map-link oc-venue-link" href="<?php echo esc_url($organizer_grid_url); ?>">
                  <?php echo $organizer; ?>
                </a>
              <?php elseif ($organizer && $organizer_venue_url): ?>
                <a class="oc-map-link oc-venue-link" href="<?php echo esc_url($organizer_venue_url); ?>">
                  <?php echo $organizer; ?>
                </a>
              <?php else: ?>
                <?php echo esc_html($organizer); ?>
              <?php endif; ?>
            </div>
          </div>
        </div>

      </aside>
    </div>

  </div>
</div>

<style>
.oc-event-template,
.oc-event-template__content {
  max-width: 1140px;
  width: 100%;
  margin-left: auto;
  margin-right: auto;
  padding-left: 0;
  padding-right: 0;
  box-sizing: border-box;
}

/* Remove the blue focus border around the hero image button */
.oc-hero-image__btn:focus,
.oc-hero-image__btn:focus-visible,
.oc-hero-image:focus-within {
  outline: none !important;
  box-shadow: none !important;
}



@media (min-width: 1140px) {
  .oc-event-template,
  .oc-event-template__content { max-width: 1140px; }
}

/* Kill stray top margin from first child */
.oc-single-main > article > :first-child{
  margin-top: 0;
}

/* Remove excess vertical gap above main + sidebar cards */
.oc-single-layout{
  margin-top: 0;
}

/* ===== Featured badge (single event hero) ===== */
.oc-hero-badges{
  position:absolute;
  top:14px;
  left:14px;
  display:flex;
  align-items:flex-start;
  gap:14px;
  z-index:6;
}
.oc-featured-badge--hero{
  background:var(--oc-accent, #3fabd1);
  color:#fff;
  font-size:12px;
  font-weight:600;
  padding:8px 12px;
  border-radius:8px;
  text-transform:uppercase;
  letter-spacing:.04em;
  z-index:6;
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.oc-happening-badge--hero{
  background:#16a34a;
  color:#fff;
  font-size:12px;
  font-weight:600;
  padding:8px 12px;
  border-radius:8px;
  text-transform:uppercase;
  letter-spacing:.04em;
  z-index:6;
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.oc-featured-badge--hero svg{
  width:.95em;
  height:.95em;
  display:block;
  flex:0 0 auto;
  fill:currentColor;
}
.oc-trending-badge--hero{
  background:#f28c28;
  color:#fff;
  font-size:12px;
  font-weight:600;
  padding:8px 12px;
  border-radius:8px;
  text-transform:uppercase;
  letter-spacing:.04em;
  z-index:6;
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.oc-trending-badge--hero svg{
  width: 16px;
  height: 16px;
  display:block;
  fill: currentColor;
}
.oc-hero-badges[hidden],
.oc-featured-badge--hero[hidden],
.oc-happening-badge--hero[hidden],
.oc-trending-badge--hero[hidden]{
  display:none !important;
}

/* Normalize spacing inside the plugin template */
.oc-event-template__content{
  padding-top: 0;
}

/* Some themes add top margin to the article */
.oc-single-main > article{
  margin-top: 0;
}

/* === MAIN CONTENT WHITE CARD (matches sidebar card look) === */
/* Add this WITHOUT changing any of your existing values */
.oc-single-main > article{
  background: #fff;
  border: 1px solid #ececec;
  border-radius: 8px;     /* same as your sidebar cards */
  padding: 22px;
}

/* HERO IMAGE: crop height without squish */
.oc-hero-image{
  position: relative;
  border-radius: 6px;
  overflow: hidden;
}

/* Remove zoom cursor on hero image */
.oc-hero-image,
.oc-hero-image__btn{
  cursor: pointer !important;
}

.oc-hero-image {
  position: relative;
}

.oc-hero-image__btn {
  display: block;
  width: 100%;
  border: 0;
  padding: 0;
  background: transparent;
}

.oc-hero-image__btn img {
  display: block;
  width: 100%;
  height: auto;
}

/* your existing fade can stay; just ensure it doesn't block clicks */
.oc-hero-image__fade {
  pointer-events: none;
}

/* overlay */
.oc-hero-image__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;

  background: rgba(0,0,0,0.0); /* starts clear */
  opacity: 0;
  transition: opacity 0.2s ease, background 0.2s ease;
  pointer-events: none; /* button remains clickable */
}

.oc-hero-image__overlay-inner {
  display: inline-flex;
  align-items: center;
  gap: 10px;

  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(0,0,0,0.55);
  color: #fff;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.oc-hero-image__btn:focus { outline: none; box-shadow: none; }

.oc-hero-image__btn:focus-visible {
  outline-offset: 3px;
  border-radius: 8px;
  outline: none !important;
  box-shadow: none !important;
}


.oc-hero-image__icon {
  font-size: 18px;
  line-height: 1;
}

/* show on hover + keyboard focus */
.oc-hero-image:hover .oc-hero-image__overlay,
.oc-hero-image:focus-within .oc-hero-image__overlay {
  opacity: 1;
  background: rgba(0,0,0,0.25);
}

.oc-occ-select{
  width: 100%;
  height: 40px;
  border-radius: 8px;
  border: 1px solid rgba(0,0,0,.12);
  background: #fff;
  padding: 0 12px;
  font-size: 1rem;
}

/* Make the image shorter by cropping (no distortion) */
.oc-hero-image img{
  width: 100%;
  height: 380px;          /* adjust height */
  object-fit: cover;
  object-position: center;
  display: block;
}

/* button reset WITHOUT breaking positioning */
.oc-hero-image__btn{
  display: block;
  width: 100%;
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  text-align: left;
  cursor: zoom-in;
}

/* Fix close button shape */
.oc-modal-close,
.modal-close,
button[aria-label="Close"],
button.close {
  width: 36px;
  height: 36px;
  border-radius: 8px !important;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #222;
  padding: 0;
}

.oc-ticket-btn{
  display: inline-flex;
  width: 100%;
  justify-content: center;
  align-items: center;

  margin-top: 18px;
  padding: 12px 12px;
  border: 1px solid var(--oc-accent, #3fabd1);
  border-radius: 8px;
  background: var(--oc-accent, #3fabd1);
  color: #fff !important;
  text-decoration: none;
  font-weight: 600;
  position: relative;
  overflow: hidden;
}

.oc-ticket-btn:hover{
  background: #fff;
  color: var(--oc-accent, #3fabd1) !important;
  border: 1px solid var(--oc-accent, #3fabd1);
}

.oc-calendar-btn{
  display: inline-flex;
  width: 100%;
  justify-content: center;
  align-items: center;
  margin-top: 12px;
  padding: 12px 12px;
  border: 1px solid rgba(0,0,0,.14);
  border-radius: 8px;
  background: #fff;
  color: var(--oc-accent, #3fabd1) !important;
  text-decoration: none;
  font-weight: 600;
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
}

.oc-calendar-btn:hover{
  background: var(--oc-accent, #3fabd1);
  color: #fff !important;
  border-color: var(--oc-accent, #3fabd1);
}

/* gradient fade overlay (bottom) */
.oc-hero-image__fade{
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 48%;
  pointer-events: none;
  background: linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,.55) 100%);
}

/* Optional: subtle zoom hover */
.oc-hero-image:hover img{
  transform: scale(1.02);
  transition: transform .25s ease;
}

/* Responsive height */
@media (max-width: 768px){
  .oc-hero-image img{ height: 240px; }
}

/* Layout */
.oc-single-layout{
  display: grid;
  grid-template-columns: 2fr 1fr; /* 75% / 25% */
  gap: 15px !important;
  align-items: start;
}

@media (max-width: 1100px){
  .oc-single-layout{ grid-template-columns: 1fr; }
}

/* Engagement card */
.oc-eng-card{
  border-radius: 8px;
  padding: 18px;
  background: #fff;
  text-decoration: none !important;
}

.oc-eng-head{
  font-size: 1rem;
  line-height: 1.25;
  font-weight: 400;
  margin: 0 0 14px;
  color: #222;
}

.oc-eng-actions{
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.oc-eng-action{
  height: 60px;
  border-radius: 8px;
  border: 1px solid rgba(0,0,0,.12);
  background: #f8fafc;
  align-items: center;
  justify-content: center;
  gap: 10px;
  cursor: pointer;
  font-weight: 400;
  color: #222;
  letter-spacing: .02em;
}

.oc-eng-btn {
  text-transform: none !important;
  letter-spacing: 0 !important;
  font-weight: 400;
}

.oc-eng-btn span:first-child {
  font-size: 1rem;
}

.oc-eng-action:hover{
  border-color: rgba(0,0,0,.18);
}

.oc-eng-icon{
  font-size: 1rem;
  line-height: 1;
}

.oc-eng-counts{
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 12px;
}

.oc-eng-countline{
  font-size: 1rem;
  font-weight: 400;
  color: #666;
}

.oc-eng-countnum{ margin-right: 6px; }
.oc-eng-counttext{
  font-size: 1rem !important;
  font-weight: 400;
}

/* Selected state (blue) */
.oc-eng-action.is-selected{
  background: var(--oc-accent, #3fabd1);
  border-color: var(--oc-accent, #3fabd1);
  color: #fff;
}

.oc-eng-btn,
.oc-eng-action{
  position: relative;
  overflow: hidden;
}

.oc-ticket-btn.oc-attention,
.oc-eng-btn.oc-attention,
.oc-eng-action.oc-attention{
  animation: ocAttentionPulse 2.8s cubic-bezier(.22,.61,.36,1) 1;
}

.oc-ticket-btn.oc-attention{
  background:#fff;
  color:var(--oc-accent, #3fabd1) !important;
  border-color:var(--oc-accent, #3fabd1);
}

.oc-eng-action.oc-attention,
.oc-eng-btn.oc-attention{
  background:#fff;
  color:var(--oc-accent, #3fabd1);
  border-color:var(--oc-accent, #3fabd1);
}

.oc-eng-action.oc-attention .oc-eng-count,
.oc-eng-btn.oc-attention .oc-eng-count,
.oc-eng-action.oc-attention .oc-eng-btn__label,
.oc-eng-btn.oc-attention .oc-eng-btn__label{
  color: inherit;
}

.oc-ticket-btn.oc-attention::after,
.oc-eng-btn.oc-attention::after,
.oc-eng-action.oc-attention::after{
  content:"";
  position:absolute;
  inset:-1px;
  border-radius: inherit;
  pointer-events:none;
  box-shadow: 0 0 0 0 rgba(63,171,209,.55);
  animation: ocAttentionRing 2.8s cubic-bezier(.22,.61,.36,1) 1;
}

.oc-ticket-btn.oc-attention::before,
.oc-eng-btn.oc-attention::before,
.oc-eng-action.oc-attention::before{
  content:"";
  position:absolute;
  top:0;
  bottom:0;
  left:-45%;
  width:38%;
  pointer-events:none;
  background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.22) 42%, rgba(255,255,255,.65) 50%, rgba(255,255,255,.22) 58%, rgba(255,255,255,0) 100%);
  transform: skewX(-18deg);
  animation: ocAttentionSweep 1.25s ease-out 2;
}

@keyframes ocAttentionPulse {
  0% { transform: scale(1); }
  8% { transform: scale(1.03); }
  18% { transform: scale(1); }
  30% { transform: scale(1.028); }
  42% { transform: scale(1); }
  100% { transform: scale(1); }
}

@keyframes ocAttentionRing {
  0% { box-shadow: 0 0 0 0 rgba(63,171,209,.58); }
  24% { box-shadow: 0 0 0 16px rgba(63,171,209,0); }
  48% { box-shadow: 0 0 0 0 rgba(63,171,209,0); }
  72% { box-shadow: 0 0 0 16px rgba(63,171,209,0); }
  100% { box-shadow: 0 0 0 0 rgba(63,171,209,0); }
}

@keyframes ocAttentionSweep {
  0% { left: -45%; opacity: 0; }
  12% { opacity: 1; }
  55% { left: 108%; opacity: 1; }
  100% { left: 108%; opacity: 0; }
}

@media (prefers-reduced-motion: reduce){
  .oc-ticket-btn.oc-attention,
  .oc-eng-btn.oc-attention,
  .oc-eng-action.oc-attention{
    animation: none;
  }
  .oc-ticket-btn.oc-attention::after,
  .oc-eng-btn.oc-attention::after,
  .oc-eng-action.oc-attention::after{
    animation: none;
    box-shadow: none;
  }
  .oc-ticket-btn.oc-attention::before,
  .oc-eng-btn.oc-attention::before,
  .oc-eng-action.oc-attention::before{
    animation: none;
    opacity: 0;
  }
}

.oc-related-grid{
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

@media (max-width: 900px){
  .oc-related-grid{
    grid-template-columns: 1fr;
  }
}

.oc-related-card{
  display: block;
  background: #fff;
  overflow: hidden;
  text-decoration: none !important;
}

.oc-related-image{
  width: 100%;
  overflow: hidden;
  border-radius: 8px;
}

.oc-related-image img{
  width: 100%;
  height: 75%;
  object-fit: cover;
  display: block;
}

.oc-related-text{
  padding-top:14px;
}

.oc-related-title{
  font-size: 1rem;
  font-weight: 600;
  color: #222;
  line-height: 1.25;
  margin-bottom: 6px;
}

.oc-related-date{
  font-size: .875rem;
  color: #666;
}

/* Sidebar layout (image + all text left, sidebar right) */
.oc-single-layout{
  display:grid;
  grid-template-columns: minmax(0, 1fr) 320px; /* ~80/20 depending on container */
  gap: 32px;
  align-items:start;
}

.oc-single-main{ min-width:0; }
.oc-single-sidebar{ position:relative; }

@media (max-width: 1100px){
  .oc-single-layout{ grid-template-columns: 1fr; }
}

/* Image */
.oc-hero-image {
  max-height: 380px;      /* ← adjust this number */
  overflow: hidden;
  border-radius: 6px;
}

.oc-hero-image img{
  width:100%;
  height:auto;
  display:block;
  border-radius:6px;
}

.oc-event-title{
  font-size: 2rem !important;
}

/* Fix schedule size */
.oc-event-schedule h2{
  font-size: 1rem !important;
  line-height: 1.25 !important;
  margin: 18px 0 10px !important;
  font-weight: 400 !important;
}

/* Meta grid */
.oc-meta-grid{
  display:grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap:48px;
  margin: 22px 0 18px;
}
@media (max-width: 900px){
  .oc-meta-grid{ grid-template-columns: 1fr; gap: 18px; }
}
.oc-meta-label{
  text-transform:uppercase;
  letter-spacing:.08em;
  font-weight:600;
  font-size:11px;
  opacity:.55;
  margin-bottom:10px;
}
.oc-meta-value{
  font-size:1rem;
  line-height:1.2;
  font-weight:400;
  color:#111;
}
.oc-meta-divider{
  border:0;
  border-top:1px solid rgba(0,0,0,.10);
  margin:18px 0 28px;
}

/* Section titles */
.oc-event-section-title{
  margin: 0 0 14px;
  font-size: 1.25rem;
  line-height: 1.15;
  font-weight: 600;
}
.oc-section-spacer{ margin-top: 28px; }

/* Sidebar card + buttons */
.oc-sidebar-card{
  border: 1px solid #ececec;
  border-radius: 8px;
  padding: 16px;
  background: #fff;
}
.oc-sidebar-title{
  font-weight: 600;
  font-size: 1.25rem;
  margin: 0 0 12px;
  text-transform: none;
}
.oc-eng-btn{
  width: 100%;
  text-decoration: none !important;
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-top: 10px;
  border-radius: 8px;
  border: 1px solid rgba(0,0,0,.12);
  background:#fff;
  color: #777;
  cursor:pointer;
  font-weight:400;
  padding: 5px;
  padding-left: 15px;     /* ⬅ less horizontal padding */
  font-size: 1rem;        /* slightly smaller text */
  min-height: 50px;
}
.oc-eng-btn:hover{ border-color: rgba(0,0,0,.22); }
.oc-eng-count{
  display:inline-flex;
  min-width: 34px;
  height: 26px;
  align-items:center;
  justify-content:center;
  border-radius:999px;
  border:1px solid rgba(0,0,0,.12);
  font-weight:400;
  font-size:1rem;
  padding:0 10px;
  opacity:.85;
}
.oc-eng-btn.is-clicked{ border-color: rgba(0,0,0,.28); }
.oc-eng-btn.is-loading{ opacity:.7; cursor:progress; }
.oc-eng-btn.is-locked{ opacity:.75; }
.oc-sidebar-note{
  margin-top: 12px;
  font-size: .75rem;
  line-height: 1.35;
}
</style>

<!-- Lightbox Modal -->
<div class="oc-lightbox" id="ocLightbox" aria-hidden="true">
  <button type="button" class="oc-lightbox__backdrop" aria-label="Close image"></button>
  <div class="oc-lightbox__panel" role="dialog" aria-modal="true" aria-label="Full image view">
    <button type="button" class="oc-lightbox__close" aria-label="Close">×</button>
    <img class="oc-lightbox__img" src="" alt="" />
  </div>
</div>

<style>
  .oc-lightbox{
    position: fixed;
    inset: 0;
    display: none;
    z-index: 999999;
  }
  .oc-lightbox.is-open{ display: block; }

  .oc-lightbox__backdrop{
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,.78);
    border: 0;
    width: 100%;
    height: 100%;
    cursor: zoom-out;
  }

  .oc-lightbox__panel{
    position: relative;
    max-width: 92vw;
    max-height: 92vh;
    margin: 4vh auto 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .oc-lightbox__img{
    max-width: 92vw;
    max-height: 92vh;
    height: auto;
    width: auto;
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0,0,0,.45);
    pointer-events: auto;
    background: #111;
  }

  .oc-lightbox__close{
    position: absolute;
    top: -14px;
    right: -14px;
    width: 40px;
    height: 40px;
    border-radius: 999px;
    border: 0;
    background: rgba(255,255,255,.92);
    font-size: 26px;
    line-height: 1;
    cursor: pointer;
    pointer-events: auto;
  }

  /* Event Info sidebar card */
  .oc-event-info-card {
    margin-top: 18px;
  }

  .oc-info-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
  }

  .oc-info-row:last-child {
    border-bottom: none;
  }

  .oc-basic-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .06em;
    padding-top: 14px;
    padding-bottom: 14px;
    font-weight: 600;
    opacity: .6;
  }

  .oc-basic-value {
    font-size: 1rem;
    font-weight: 400;
    text-align: left;
    max-width: 100%
  }

  /* ===== Sidebar Cards ===== */
  .oc-sidebar-card{
    background: #fff;
    border: 1px solid #ececec;
    border-radius: 8px;
    padding: 22px;
    margin-bottom: 18px;
  }

  .oc-basic-row:not(:last-child) {
    padding-bottom: 14px;
    padding-top: 14px;
    border-bottom: 1px solid rgba(0,0,0,.08);
  }

  /* Tighten side padding on mobile */
  @media (max-width: 768px){
    .oc-event-template,
    .oc-event-template__content{
      padding-left: 12px;
      padding-right: 12px;
    }

    /* Optional: make cards feel edge-to-edge but still soft */
    .oc-sidebar-card,
    .oc-single-main article{
      border-radius: 8px;
    }
  }

  /* Space before footer so content card breathes */
  .oc-event-template__content {
    margin-bottom: 30px;
  }

  /* Related event image hover overlay */
  .oc-related-image {
    position: relative;
    overflow: hidden;
    border-radius: 8px;
  }

  .oc-related-image::after {
    content: "";
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.25);
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }

  .oc-related-card:hover .oc-related-image::after,
  .oc-related-card:focus-visible .oc-related-image::after {
    opacity: 1;
  }

  .oc-related-image img {
    transition: transform 0.25s ease;
  }

  .oc-related-card:hover .oc-related-image img {
    transform: scale(1.02);
  }

  /* ===== Categories (above image) ===== */
  .oc-event-cats{
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .oc-cat-pill{
    display: inline-flex;
    align-items: center;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: .85rem;
    font-weight: 400;
    line-height: 1;
    text-transform: none;
    letter-spacing: 0;
    background: #efefef;
    color: #b2b2b2;
    border: 1px solid rgba(0,0,0,.10);
    cursor: default !important;
  }

  .oc-cat-pill:hover{
  background: #e3e3e3;
  cursor: default !important;
  }

  /* ===== Countdown (above engagement) ===== */
  .oc-countdown{
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 20px;
    background: var(--oc-accent, #3fabd1);
  }

  .oc-countdown__label{
    font-size: .75rem;
    text-transform: uppercase;
    font-weight: 400;
    margin-bottom: 6px;
    color: #fff;
  }

  .oc-countdown__value{
    font-size: 1.25rem;
    font-weight: 400;
    line-height: 1.2;
    color: #fff;
  }
/* === Option B mobile: force moved engagement to full section width === */
@media (max-width: 1100px){

  /* When engagement is moved into the main column, don't double-pad it */
  .oc-single-main .oc-eng-card.oc-eng-card--moved{
    padding: 0 !important;
    background: transparent !important; /* optional: makes it feel like part of the page */
    margin: 18px 0 22px !important;
  }

  /* Make inner elements span full width */
  .oc-single-main .oc-eng-card.oc-eng-card--moved .oc-countdown,
  .oc-single-main .oc-eng-card.oc-eng-card--moved .oc-eng-btn,
  .oc-single-main .oc-eng-card.oc-eng-card--moved .oc-ticket-btn{
    width: 100% !important;
    max-width: none !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    box-sizing: border-box !important;
  }

  .oc-single-main .oc-eng-card.oc-eng-card--moved{
    position: relative;
    padding-bottom: 22px !important;   /* space before the line */
    margin-bottom: 26px !important;    /* space after the line */
  }

  .oc-single-main .oc-eng-card.oc-eng-card--moved::after{
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    background: rgba(0,0,0,.10);       /* matches your oc-meta-divider vibe */
  }

  .oc-single-sidebar > .oc-sidebar-card:not(.oc-eng-card){
    display: none !important;
  }
}

.oc-eng-mobile-lightbox{
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: none;
}
.oc-eng-mobile-lightbox.is-open{
  display: block;
}
.oc-eng-mobile-lightbox__backdrop{
  position: absolute;
  inset: 0;
  background: rgba(15,23,42,.48);
  backdrop-filter: blur(6px);
}
.oc-eng-mobile-lightbox__dialog{
  position: relative;
  width: min(92vw, 520px);
  max-height: calc(100vh - 40px);
  margin: 20px auto;
  overflow: auto;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 28px 80px rgba(15,23,42,.28);
}
.oc-eng-mobile-lightbox__head{
  padding: 18px 22px 0;
}
.oc-eng-mobile-lightbox__head h2{
  margin: 0;
  font-size: 1.2rem;
  font-weight: 700;
  color: #111827;
}
.oc-eng-mobile-lightbox__close{
  position: absolute;
  top: 14px;
  right: 14px;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 999px;
  background: rgba(15,23,42,.08);
  color: #111827;
  font-size: 28px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.oc-eng-mobile-lightbox__body{
  padding: 16px 16px 18px;
}
.oc-eng-mobile-lightbox__body .oc-eng-card{
  margin: 0;
}
@media (min-width: 1101px){
  .oc-eng-mobile-lightbox{
    display: none !important;
  }
}

/* ===== More Events: smaller meta rows + icons ===== */
.oc-related-text .oc-meta{
  margin: 6px 0 !important;
  font-size: 0.875rem !important;     /* smaller text */
  line-height: 1.1 !important;
  gap: 8px !important;
}

.oc-related-text .oc-ico svg{
  width: 14px !important;
  height: 14px !important;
}

/* =========================================================
   MORE EVENTS: match Events Grid card styling
   ========================================================= */

/* Make the card feel like your grid "card link" */
.oc-related-card{
  text-decoration: none !important;
  color: inherit !important;
  display: block;
}

.oc-related-card:hover .oc-related-title{
  text-decoration: underline;
}

/* Image behaves like grid thumb (16:9, cover, rounded) */
.oc-related-image{
  width: 100%;
  overflow: hidden;
  border-radius: 4px;          /* matches .oc-thumb/.oc-card radius */
  background: #e9e9e9;         /* matches grid thumb bg */
}

.oc-related-image img{
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
  border-radius: 4px;
}

/* Body spacing matches grid .oc-body { padding: 15px 0 0; } */
.oc-related-text{
  padding: 15px 0 0;
}

/* Title matches grid .oc-title */
.oc-related-title{
  margin: 0 0 15px;
  font-size: 1.231rem;
  line-height: 1.4;
  font-weight: 700;
  color: #111;
  letter-spacing: -0.03em;

  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Meta rows match grid exactly */
.oc-related-text .ocg-meta{
      display:flex;
      gap:10px;
      align-items:center;
      color:#777;
      font-size: 0.9231rem;
      line-height: 0.9231rem;
      margin: 8px 0;
}

.oc-related-text .ocg-ico svg{
  width: 18px;
  height: 18px;
  display:block;
}

/* Keep location tidy */
.oc-related-text .ocg-loc{
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.oc-more-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:14px;
  margin-top: 28px;
  margin-bottom: 14px;
}
.oc-more-head .oc-event-section-title{ margin:0; }

.oc-see-all-btn{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  height:40px;
  padding:0 14px;
  border-radius:8px;
  border:1px solid rgba(0,0,0,.12);
  background:#fff;
  color:var(--oc-accent, #3fabd1);
  text-decoration:none !important;
  font-weight:600;
  font-size:0.9231rem;
}
.oc-see-all-btn:hover{ border-color: rgba(0,0,0,.22); color: var(--oc-accent-dark, #2f7f9f);}

@media (max-width: 640px){
  .oc-see-all-btn{ height:36px; padding:0 12px; font-size:0.875rem; }
}

/* ==== HARD KILL: blue focus ring / border around the hero image/button ==== */
button.oc-hero-image.oc-hero-image__btn,
button.oc-hero-image.oc-hero-image__btn:focus,
button.oc-hero-image.oc-hero-image__btn:focus-visible,
button.oc-hero-image.oc-hero-image__btn:active,
button.oc-hero-image.oc-hero-image__btn:focus-within,
button.oc-hero-image.oc-hero-image__btn:hover {
  outline: none !important;
  box-shadow: none !important;
  border: 0 !important;
}

/* some themes draw the ring using a pseudo element */
button.oc-hero-image.oc-hero-image__btn::after,
button.oc-hero-image.oc-hero-image__btn:focus::after,
button.oc-hero-image.oc-hero-image__btn:focus-visible::after {
  content: none !important;
  box-shadow: none !important;
  outline: none !important;
  border: 0 !important;
}

/* iOS/Chrome tap highlight (can look like a blue outline on click) */
button.oc-hero-image.oc-hero-image__btn {
  -webkit-tap-highlight-color: transparent;
}


/* Occurrences dropdown: consistent single-line rows */
.oc-occ-select{
  width: 100%;
  height: 44px;                 /* consistent control height */
  line-height: 44px;            /* keeps the selected line vertically centered */
  white-space: nowrap;          /* don’t wrap */
  overflow: hidden;             /* clip overflow */
  text-overflow: ellipsis;      /* show … when needed */
}

/* Some browsers need option line-height too */
.oc-occ-select option{
  white-space: nowrap;
  line-height: 1.2;
}


</style>

<script>
/* =========================================================
   OCCURRENCE SELECTION + COUNTDOWN (SINGLE SOURCE OF TRUTH)
   ========================================================= */
(function () {
  const sidebarDateEl = document.getElementById("ocSidebarDate");
  const sidebarTimeEl = document.getElementById("ocSidebarTime");
  const mainDateEl    = document.getElementById("ocMainDate");
  const mainTimeEl    = document.getElementById("ocMainTime");
  const countdownLabelEls = Array.from(document.querySelectorAll("[data-oc-countdown-label]"));
  const happeningBadgeEls = Array.from(document.querySelectorAll("[data-oc-happening-badge]"));
  const heroBadgeWraps = Array.from(document.querySelectorAll("[data-oc-hero-badges]"));
  const calendarButtons = Array.from(document.querySelectorAll("[data-oc-calendar-btn]"));

  function setText(el, txt) {
    if (!el) return;
    el.textContent = (txt == null ? "" : String(txt));
  }

  function fmtCountdown(ms) {
    if (ms <= 0) return "Started";
    const sec  = Math.floor(ms / 1000);
    const days = Math.floor(sec / 86400);
    const hrs  = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);

    if (days > 0) return days + "d " + hrs + "h " + mins + "m";
    if (hrs > 0)  return hrs + "h " + mins + "m";
    return mins + "m";
  }

  function getStartTsFromCard(card) {
    return Number(card.getAttribute("data-oc-start-ts") || 0);
  }

  function getEndTsFromCard(card) {
    return Number(card.getAttribute("data-oc-end-ts") || 0);
  }

  function updateOccurrenceUiState(startTs, endTs) {
    const nowTs = Math.floor(Date.now() / 1000);
    const effectiveEndTs = endTs || startTs || 0;
    let happeningNow = false;
    if (startTs) {
      happeningNow = startTs <= nowTs;
      if (happeningNow) {
        happeningNow = effectiveEndTs >= nowTs;
      }
    }

    countdownLabelEls.forEach(function (el) {
      setText(el, happeningNow ? "Happening now" : "Starts in");
    });

    happeningBadgeEls.forEach(function (el) {
      el.hidden = !happeningNow;
    });

    heroBadgeWraps.forEach(function (wrap) {
      const visibleBadges = Array.from(wrap.children).some(function (child) { return !child.hidden; });
      wrap.hidden = !visibleBadges;
    });
  }

  function tickCountdown(card) {
    const cdEl = card.querySelector("[data-oc-countdown]");
    if (!cdEl) return;
    const startTs = getStartTsFromCard(card);
    const endTs = getEndTsFromCard(card);
    updateOccurrenceUiState(startTs, endTs);
    if (!startTs) { cdEl.textContent = "—"; return; }
    cdEl.textContent = fmtCountdown((startTs * 1000) - Date.now());
  }

  function startCountdownTimer(card) {
    const cdEl = card.querySelector("[data-oc-countdown]");
    if (!cdEl) return;
    if (card.__ocCountdownTimer) clearInterval(card.__ocCountdownTimer);
    tickCountdown(card);
    card.__ocCountdownTimer = setInterval(function () { tickCountdown(card); }, 30000);
  }

  function optionData(opt) {
    if (!opt) return;
    return {
      startTs: Number(opt.getAttribute("data-start-ts") || 0),
      endTs: Number(opt.getAttribute("data-end-ts") || 0),
      dateLbl: opt.getAttribute("data-date") || "",
      timeLbl: opt.getAttribute("data-time") || "",
      endLbl: opt.getAttribute("data-end") || ""
    };
  }

  function applyOccurrenceData(data) {
    if (!data) return;
    document.querySelectorAll(".oc-eng-card").forEach(function (card) {
      card.setAttribute("data-oc-start-ts", data.startTs ? String(data.startTs) : "");
      card.setAttribute("data-oc-end-ts", data.endTs ? String(data.endTs) : "");
      const sel = card.querySelector(".oc-occ-select");
      if (sel) {
        const match = Array.from(sel.options).find(function (opt) { return Number(opt.getAttribute("data-start-ts") || 0) === data.startTs; });
        if (match) sel.value = match.value;
      }
      startCountdownTimer(card);
    });

    calendarButtons.forEach(function (button) {
      const base = button.getAttribute("data-calendar-base") || "";
      if (!base) return;
      try {
        const url = new URL(base, window.location.origin);
        if (data.startTs) {
          url.searchParams.set("start_ts", String(data.startTs));
        } else {
          url.searchParams.delete("start_ts");
        }
        if (data.endTs) {
          url.searchParams.set("end_ts", String(data.endTs));
        } else {
          url.searchParams.delete("end_ts");
        }
        button.setAttribute("href", url.toString());
      } catch (e) {}
    });

    setText(sidebarDateEl, data.dateLbl);
    const mainDateLocked = mainDateEl ? mainDateEl.hasAttribute("data-lock-occurrence-date") : false;
    if (!mainDateLocked) {
      setText(mainDateEl, data.dateLbl);
    }
    const fullTime = data.timeLbl ? (data.endLbl ? (data.timeLbl + " – " + data.endLbl) : data.timeLbl) : "";
    setText(sidebarTimeEl, fullTime);
    setText(mainTimeEl, fullTime);
  }

  function initOccurrenceCard(card) {
    if (!card || card.dataset.ocOccurrenceInit === "1") return;
    card.dataset.ocOccurrenceInit = "1";

    const sel = card.querySelector(".oc-occ-select");
    if (sel) {
      sel.addEventListener("change", function () {
        applyOccurrenceData(optionData(sel.options[sel.selectedIndex]));
      });
    }

    startCountdownTimer(card);
  }

  window.ocInitOccurrenceCards = function(root) {
    const scope = root || document;
    scope.querySelectorAll(".oc-eng-card").forEach(initOccurrenceCard);

    const firstSelect = document.querySelector(".oc-eng-card .oc-occ-select");
    const firstSelectedOption = firstSelect ? firstSelect.options[firstSelect.selectedIndex] : null;
    if (firstSelectedOption) {
      applyOccurrenceData(optionData(firstSelectedOption));
      return;
    }

    document.querySelectorAll(".oc-eng-card").forEach(startCountdownTimer);
  };

  window.ocInitOccurrenceCards(document);
})();

</script>

<script>
/* =========================================================
   VIEW TRACKING (PAGE LOAD)
   ========================================================= */
(function () {
  const eventId = <?php echo wp_json_encode((string)$eventId); ?>;
  if (!eventId) return;

  // avoid double-count on back/forward cache restores
  if (window.__oc_view_sent) return;
  window.__oc_view_sent = true;

  const endpoint = "https://api.opencircleapi.com/events/" + encodeURIComponent(eventId) + "/view";

  function classifySource() {
    const qp = new URLSearchParams(window.location.search || "");
    const utmSource = (qp.get("utm_source") || "").trim().toLowerCase();
    const referrer = (document.referrer || "").trim();

    let sourceType = "direct";
    let sourceHost = "";

    if (referrer) {
      try {
        const u = new URL(referrer);
        sourceHost = (u.hostname || "").toLowerCase();
        if (sourceHost) {
          sourceType = sourceHost === window.location.hostname.toLowerCase() ? "internal" : "referral";
        }
      } catch (e) {
        sourceType = "referral";
      }
    }

    if (utmSource) sourceType = "campaign";

    return { referrer, sourceType, sourceHost, utmSource };
  }

  const source = classifySource();

  const payload = JSON.stringify({
    sid: (function(){
      try {
        let sid = localStorage.getItem("oc_sid");
        if (!sid) {
          let hasUUID = false;
          if (typeof crypto !== "undefined") {
            if (crypto) {
              hasUUID = typeof crypto.randomUUID === "function";
            }
          }
          sid = hasUUID ? crypto.randomUUID() : ("sid_" + Math.random().toString(36).slice(2) + Date.now());
          localStorage.setItem("oc_sid", sid);
        }
        return sid;
      } catch (e) { return null; }
    })(),
    referrer: source.referrer,
    sourceType: source.sourceType,
    sourceHost: source.sourceHost,
    utmSource: source.utmSource,
  });

  if (navigator.sendBeacon) {
    navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
    return;
  }

  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(function () {});
})();




</script>

<script>
/* =========================================================
   ENGAGEMENT (GOING / INTERESTED)
   ========================================================= */
(function () {
  const ajaxUrl = "<?php echo esc_js(admin_url('admin-ajax.php')); ?>";
  const nonce   = "<?php echo esc_js(wp_create_nonce('oc_engage_nonce')); ?>";

  function setCounts(counts) {
    if (!counts) return;
    const countGoingEls = document.querySelectorAll('[data-oc-count="going"]');
    const countIntEls   = document.querySelectorAll('[data-oc-count="interested"]');
    let goingCount = 0;
    let interestedCount = 0;
    if (counts) {
      if (counts.going != null) goingCount = counts.going;
      if (counts.interested != null) interestedCount = counts.interested;
    }
    countGoingEls.forEach(function (el) { el.textContent = String(goingCount); });
    countIntEls.forEach(function (el) { el.textContent = String(interestedCount); });
  }

  const initialCounts = <?php echo wp_json_encode(oc_get_engage_counts($eventId)); ?>;
  setCounts(initialCounts || { going: 0, interested: 0 });

  function applySelected(eventId, type, btn) {
    if (!btn) return;
    const cookie = "oc_engaged_" + eventId + "_" + type + "=1";
    if (document.cookie.split("; ").includes(cookie)) {
      btn.classList.add("is-selected");
    }
  }

  function markSelected(eventId, type) {
    document.querySelectorAll('[data-oc-eng="' + type + '"][data-event-id="' + eventId + '"]').forEach(function (el) {
      el.classList.add("is-selected");
    });
    try {
      document.cookie = "oc_engaged_" + eventId + "_" + type + "=1; path=/; max-age=" + (30 * 24 * 60 * 60) + "; SameSite=Lax";
    } catch (e) {}
  }

  function engage(eventId, type, btn) {
    if (!btn || btn.classList.contains("is-selected")) return;

    btn.disabled = true;
    const body = new URLSearchParams();
    body.set("action", "oc_event_engage");
    body.set("nonce", nonce);
    body.set("event_id", eventId);
    body.set("type", type);

    fetch(ajaxUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body.toString(),
      credentials: "same-origin"
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json || !json.success) return;

        setCounts(json.data.counts || {});
        markSelected(eventId, type);

        fetch("https://api.opencircleapi.com/events/" + encodeURIComponent(eventId) + "/engagement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            going: Number((json.data.counts || {}).going || 0),
            interested: Number((json.data.counts || {}).interested || 0),
          }),
          keepalive: true
        }).catch(function () {});
      })
      .then(function () {
        btn.disabled = false;
      }, function (e) {
        console.error(e);
        btn.disabled = false;
      });
  }

  function initEngagementCard(card) {
    if (!card || card.dataset.ocEngagementInit === "1") return;
    card.dataset.ocEngagementInit = "1";

    const eventId = card.getAttribute("data-event-id");
    const btnGoing = card.querySelector('[data-oc-eng="going"]');
    const btnInt   = card.querySelector('[data-oc-eng="interested"]');

    applySelected(eventId, "going", btnGoing);
    applySelected(eventId, "interested", btnInt);

    if (btnGoing) btnGoing.addEventListener("click", function () { engage(eventId, "going", btnGoing); });
    if (btnInt)   btnInt.addEventListener("click", function () { engage(eventId, "interested", btnInt); });
  }

  window.ocInitEngagementCards = function(root) {
    const scope = root || document;
    scope.querySelectorAll(".oc-eng-card").forEach(initEngagementCard);
  };

  window.ocInitEngagementCards(document);
})();

</script>

<script>
/* =========================================================
   FIRST-LOAD ATTENTION HIGHLIGHT
   ========================================================= */
(function () {
  const card = document.querySelector(".oc-eng-card");
  if (!card) return;
  const eventId = (card.getAttribute("data-event-id") || "").trim() || "event";
  const storageKey = "oc_attention_seen_" + eventId;

  try {
    if (sessionStorage.getItem(storageKey) === "1") return;
    sessionStorage.setItem(storageKey, "1");
  } catch (e) {}

  window.setTimeout(function () {
    const ticketBtn = card.querySelector(".oc-ticket-btn");
    const goingBtn = card.querySelector('[data-oc-eng="going"]');
    const interestedBtn = card.querySelector('[data-oc-eng="interested"]');
    const targets = [goingBtn, interestedBtn, ticketBtn].filter(Boolean);
    targets.forEach(function (el, index) {
      window.setTimeout(function () {
        el.classList.add("oc-attention");
        window.setTimeout(function () { el.classList.remove("oc-attention"); }, 2200);
      }, index * 240);
    });
  }, 500);
})();

</script>

<script>
/* =========================================================
   LIGHTBOX
   ========================================================= */
(function () {
  const mq = window.matchMedia("(max-width: 1100px)");
  const originalCard = document.querySelector(".oc-eng-card");
  const modal = document.getElementById("ocEngMobileLightbox");
  const modalBody = modal ? modal.querySelector("[data-oc-eng-mobile-body]") : null;
  const closeEls = modal ? modal.querySelectorAll("[data-oc-eng-mobile-close]") : [];
  if (!originalCard || !modal || !modalBody) return;

  const eventId = (originalCard.getAttribute("data-event-id") || "").trim() || "event";
  const storageKey = "oc_mobile_eng_lightbox_seen_" + eventId;

  function buildClone() {
    modalBody.innerHTML = "";
    const clone = originalCard.cloneNode(true);
    clone.classList.add("oc-eng-card--lightbox");
    modalBody.appendChild(clone);
    if (window.ocInitOccurrenceCards) window.ocInitOccurrenceCards(modalBody);
    if (window.ocInitEngagementCards) window.ocInitEngagementCards(modalBody);
  }

  function openModal() {
    if (!mq.matches) return;
    buildClone();
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.documentElement.style.overflow = "hidden";
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.style.overflow = "";
  }

  closeEls.forEach(function (el) { el.addEventListener("click", closeModal); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (modal.classList.contains("is-open")) closeModal();
    }
  });

  try {
    if (mq.matches) {
      if (sessionStorage.getItem(storageKey) !== "1") {
        sessionStorage.setItem(storageKey, "1");
        window.setTimeout(openModal, 600);
      }
    }
  } catch (e) {
    if (mq.matches) window.setTimeout(openModal, 600);
  }
})();

</script>

<script>
/* =========================================================
   HERO IMAGE LIGHTBOX
   ========================================================= */
(function () {
  const hero = document.querySelector(".oc-hero-image");
  if (!hero) return;

  const fullUrl = hero.getAttribute("data-oc-full");
  const title   = <?php echo wp_json_encode(wp_strip_all_tags($title)); ?>;

  const lb = document.getElementById("ocLightbox");
  const img = lb.querySelector(".oc-lightbox__img");
  const closeBtn = lb.querySelector(".oc-lightbox__close");
  const backdrop = lb.querySelector(".oc-lightbox__backdrop");

  function openLb() {
    img.src = fullUrl;
    img.alt = title || "Event image";
    lb.classList.add("is-open");
    document.documentElement.style.overflow = "hidden";
  }

  function closeLb() {
    lb.classList.remove("is-open");
    img.src = "";
    document.documentElement.style.overflow = "";
  }

  hero.addEventListener("click", openLb);
  closeBtn.addEventListener("click", closeLb);
  backdrop.addEventListener("click", closeLb);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (lb.classList.contains("is-open")) closeLb();
    }
  });
})();

</script>

<script>
/* =========================================================
   OPTION B (MOBILE): Move Engagement Card above Description
   ========================================================= */
(function () {
  const mq = window.matchMedia("(max-width: 1100px)"); // matches your layout breakpoint
  const eng = document.querySelector(".oc-eng-card");
  const desc = document.querySelector(".oc-event-description");

  if (!eng || !desc) return;

  // Remember original position so we can restore if resized back to desktop
  const originalParent = eng.parentNode;
  const originalNext = eng.nextElementSibling;

  function apply() {
    if (mq.matches) {
      // Move above description (only once)
      if (!eng.classList.contains("oc-eng-card--moved")) {
        desc.parentNode.insertBefore(eng, desc);
        eng.classList.add("oc-eng-card--moved");
      }
    } else {
      // Restore to sidebar on desktop
      if (eng.classList.contains("oc-eng-card--moved")) {
        if (originalNext) {
          if (originalNext.parentNode === originalParent) {
            originalParent.insertBefore(eng, originalNext);
          } else {
            originalParent.appendChild(eng);
          }
        } else {
          originalParent.insertBefore(eng, originalNext);
        }
        eng.classList.remove("oc-eng-card--moved");
      }
    }
  }

  apply();

  // Watch breakpoint changes
  if (mq.addEventListener) mq.addEventListener("change", apply);
  else mq.addListener(apply); // older Safari fallback
})();
</script>

<?php
  };

  $theme_template = '';
  if ($context_post instanceof WP_Post) {
    $template_slug = get_page_template_slug($context_post->ID);
    if (is_string($template_slug) && $template_slug !== '') {
      $theme_template = locate_template($template_slug);
    }

    if ((!is_string($theme_template) || $theme_template === '') && function_exists('get_page_template')) {
      $theme_template = get_page_template();
    }
  }

  if (is_string($theme_template) && $theme_template !== '' && file_exists($theme_template)) {
    add_filter('the_content', function ($content) use ($oc_render_event_content) {
      static $rendered = false;
      if ($rendered) return $content;
      $rendered = true;
      ob_start();
      $oc_render_event_content();
      return ob_get_clean();
    }, 9999);

    add_filter('post_class', function ($classes) {
      if (!is_array($classes)) $classes = [];
      $classes[] = 'oc-virtual-event-wrapper';
      return array_values(array_unique($classes));
    }, 9999);

    include $theme_template;
    unset($GLOBALS['oc_vep_event_render_scope']);
    wp_reset_postdata();
    exit;
  }

  get_header();
  $oc_render_event_content();
  get_footer();
  unset($GLOBALS['oc_vep_event_render_scope']);
  wp_reset_postdata();
  exit;
}, 0);

require_once __DIR__ . '/opencircle-virtual-venue-pages.php';
