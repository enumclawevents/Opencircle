<?php
/**
 * Module: OpenCircle Multi-Filter Events Slider
 * Description: A reusable OpenCircle slider shortcode that can show Upcoming (by date), Recently Added, Trending, or Trending This Week (views). Filter is controlled via shortcode attribute.
 * Version: 0.1.2
 */

if (!defined('ABSPATH')) exit;

class OpenCircle_Multi_Filter_Slider {
  const SHORTCODE     = 'oc_events_slider';
  const STYLE_HANDLE  = 'oc-events-slider-mf-style';
  const SCRIPT_HANDLE = 'oc-events-slider-mf-script';
  private static $assets_printed = false;

  public static function init() {
    add_shortcode(self::SHORTCODE, [__CLASS__, 'render_shortcode']);
    add_action('wp_enqueue_scripts', [__CLASS__, 'register_assets']);
  }

  public static function register_assets() {
    wp_register_style(self::STYLE_HANDLE, false, [], '0.1.2');
    wp_register_script(self::SCRIPT_HANDLE, false, [], '0.1.2', true);
  }

  private static function render_assets() {
    if (self::$assets_printed) return '';
    self::$assets_printed = true;

    return '<style id="' . esc_attr(self::STYLE_HANDLE) . '">' . self::inline_css() . '</style>' .
      '<script id="' . esc_attr(self::SCRIPT_HANDLE) . '">' . self::inline_js() . '</script>';
  }

  /* =========================
   * Helpers
   * ========================= */

  private static function normalize_api_base($api) {
    $api = trim((string)$api);
    if ($api === '') return '';
    return rtrim($api, '/');
  }

  private static function normalize_event_base($event_base) {
    $event_base = trim((string)$event_base);
    if ($event_base === '') $event_base = '/events/';
    if ($event_base[0] !== '/') $event_base = '/' . $event_base;
    if (substr($event_base, -1) !== '/') $event_base .= '/';
    return $event_base;
  }

  private static function normalize_city_list($city_raw) {
    if (is_array($city_raw)) {
      $city_raw = implode(',', $city_raw);
    }

    $parts = preg_split('/\s*,\s*/', (string) $city_raw);
    if (!is_array($parts)) return [];

    $cities = [];
    foreach ($parts as $part) {
      $city = sanitize_text_field($part);
      if ($city === '') continue;
      $cities[strtolower($city)] = $city;
    }

    return array_values($cities);
  }

  private static function city_list_to_attr($cities) {
    $cities = array_values(array_filter(array_map('sanitize_text_field', (array) $cities)));
    return implode(', ', $cities);
  }

  private static function event_matches_cities($event, $cities) {
    if (empty($cities)) return true;
    if (!is_array($event)) return false;

    $event_city = strtolower(trim((string) ($event['city'] ?? '')));
    if ($event_city === '') return false;

    foreach ($cities as $city) {
      if ($event_city === strtolower(trim((string) $city))) {
        return true;
      }
    }

    return false;
  }

  private static function esc_attr_bool($v) {
    return (string)$v === '1' || strtolower((string)$v) === 'true' || strtolower((string)$v) === 'yes';
  }

  private static function wp_remote_json($url) {
    $res = wp_remote_get($url, [
      'timeout' => 12,
      'headers' => ['Accept' => 'application/json'],
    ]);
    if (is_wp_error($res)) return [];
    $code = wp_remote_retrieve_response_code($res);
    if ($code < 200 || $code >= 300) return [];
    $body = wp_remote_retrieve_body($res);
    if (!$body) return [];
    $json = json_decode($body, true);
    if (!is_array($json)) return [];
    if (isset($json['data']) && is_array($json['data'])) return $json['data'];
    return $json;
  }

  private static function normalize_image($imgRaw, $placeholder) {
    $imgRaw = trim((string)$imgRaw);
    $bad = ['none','null','undefined','#'];
    if ($imgRaw === '' || in_array(strtolower($imgRaw), $bad, true)) return $placeholder;
    if (preg_match('~^https?://none/?$~i', $imgRaw)) return $placeholder;

    $imgFixed = preg_replace('~^http://~i', 'https://', $imgRaw);
    return filter_var($imgFixed, FILTER_VALIDATE_URL) ? $imgFixed : $placeholder;
  }

  private static function wp_tz_ts($iso) {
    $iso = (string)$iso;
    if ($iso === '') return 0;

    $tz = wp_timezone();
    $iso_local = preg_replace('/(Z|[+\-]\d{2}:\d{2})$/', '', trim($iso));

    try {
      $dt = new DateTimeImmutable($iso_local, $tz);
      return $dt->getTimestamp();
    } catch (Exception $e) {}

    try {
      $dt = new DateTimeImmutable($iso, $tz);
      return $dt->getTimestamp();
    } catch (Exception $e) {}

    $ts = strtotime($iso_local);
    return $ts ? $ts : 0;
  }

  private static function format_compact_day_span($start_ts, $end_ts, $tz) {
    $start_ts = (int)$start_ts;
    $end_ts = (int)$end_ts;
    if ($start_ts <= 0) return '';
    if ($end_ts <= 0) $end_ts = $start_ts;

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

  private static function collect_occurrence_day_timestamps($e) {
    $days = [];
    $tz = wp_timezone();

    $add_day = function($iso) use (&$days, $tz) {
      $ts = self::wp_tz_ts((string)$iso);
      if (!$ts) return;
      $ymd = wp_date('Y-m-d', $ts, $tz);
      if ($ymd === '') return;
      try {
        $mid_dt = new DateTimeImmutable($ymd . ' 00:00:00', $tz);
        $days[(int)$mid_dt->getTimestamp()] = 1;
      } catch (Exception $e) {
        return;
      }
    };

    if (!is_array($e)) return [];

    $added_occurrence_day = false;
    foreach (['occurrencesUpcoming','occurrences','upcomingOccurrences'] as $k) {
      if (empty($e[$k]) || !is_array($e[$k])) continue;
      foreach ($e[$k] as $o) {
        if (is_array($o)) {
          $before = count($days);
          $add_day($o['startDateTime'] ?? '');
          // Include end day for true multi-day occurrence records.
          $add_day($o['endDateTime'] ?? '');
          if (count($days) > $before) $added_occurrence_day = true;
        } elseif (is_string($o) && trim($o) !== '') {
          $before = count($days);
          $add_day($o);
          if (count($days) > $before) $added_occurrence_day = true;
        }
      }
      break;
    }

    // If no explicit occurrences were provided, fall back to recurrence shapes.
    if (!$added_occurrence_day) {
      if (!empty($e['recurrenceDates']) && is_array($e['recurrenceDates'])) {
        foreach ($e['recurrenceDates'] as $iso) $add_day($iso);
      }

      $rrItems = $e['recurrenceRule']['items'] ?? null;
      if (is_array($rrItems)) {
        foreach ($rrItems as $it) {
          if (!is_array($it)) continue;
          $s = trim((string)($it['startDateTime'] ?? $it['start'] ?? ''));
          $en = trim((string)($it['endDateTime'] ?? $it['end'] ?? ''));

          if ($s === '') {
            $d = trim((string)($it['date'] ?? ''));
            $st = trim((string)($it['startTime'] ?? ''));
            $et = trim((string)($it['endTime'] ?? ''));
            if ($d !== '' && $st !== '') $s = $d . 'T' . $st . ':00';
            if ($d !== '' && $et !== '') $en = $d . 'T' . $et . ':00';
          }

          if ($s !== '') $add_day($s);
          if ($en !== '') $add_day($en);
        }
      }

      // Final fallback when recurrence fields are missing.
      if (count($days) === 0) {
        $add_day($e['startDateTime'] ?? '');
        $add_day($e['endDateTime'] ?? '');
      }
    }

    $out = array_keys($days);
    sort($out, SORT_NUMERIC);
    return $out;
  }

  private static function build_slider_date_label($e, $fallback_start_ts) {
    $fallback_start_ts = (int)$fallback_start_ts;
    $tz = wp_timezone();

    $days = self::collect_occurrence_day_timestamps($e);
    if (count($days) < 2) return $fallback_start_ts ? wp_date('F j, Y', $fallback_start_ts, $tz) : '';

    $groups = [];
    $group_start = $days[0];
    $prev = $days[0];
    for ($i=1; $i<count($days); $i++) {
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

    $has_span = false;
    foreach ($groups as $g) {
      if ((int)$g[1] > (int)$g[0]) { $has_span = true; break; }
    }
    if (!$has_span) return $fallback_start_ts ? wp_date('F j, Y', $fallback_start_ts, $tz) : '';

    $parts = [];
    $years = [];
    foreach ($groups as $g) {
      $parts[] = self::format_compact_day_span((int)$g[0], (int)$g[1], $tz);
      $years[wp_date('Y', (int)$g[0], $tz)] = 1;
      $years[wp_date('Y', (int)$g[1], $tz)] = 1;
    }

    $label = implode(' & ', array_filter($parts));
    if ($label === '') return $fallback_start_ts ? wp_date('F j, Y', $fallback_start_ts, $tz) : '';

    if (count($years) === 1) {
      $onlyYear = (string)array_key_first($years);
      if ($onlyYear !== '') $label .= ', ' . $onlyYear;
    }

    return $label;
  }

  private static function build_wp_event_url($key, $event_base = '/events/') {
    $base = self::normalize_event_base($event_base);
    return trailingslashit(home_url($base . rawurlencode((string)$key)));
  }

  private static function pick_occurrence_start_end($e) {
    $start = (string)($e['startDateTime'] ?? '');
    $end   = (string)($e['endDateTime'] ?? '');

    if (!is_array($e)) return [$start, $end];

    $items = $e['recurrenceRule']['items'] ?? null;
    if (is_array($items) && !empty($items)) {
      $now = time();
      $bestCurrentOrUpcoming = null;
      $bestAny = null;

      foreach ($items as $it) {
        if (!is_array($it)) continue;
        if (empty($it['start'])) continue;

        $start_ts = self::wp_tz_ts((string)$it['start']);
        if (!$start_ts) continue;
        $end_ts = !empty($it['end']) ? self::wp_tz_ts((string)$it['end']) : 0;
        $effective_end = $end_ts ?: $start_ts;

        if ($bestAny === null) $bestAny = $it;
        if ($effective_end >= $now) { $bestCurrentOrUpcoming = $it; break; }
      }

      $pick = $bestCurrentOrUpcoming ?: $bestAny;
      if (is_array($pick) && !empty($pick['start'])) {
        $start = (string)$pick['start'];
        if (!empty($pick['end'])) $end = (string)$pick['end'];
      }
    }

    return [$start, $end];
  }

  private static function dedupe_recurring_occurrences($events) {
    $now = time();
    $bestBySeries = [];

    foreach ($events as $e) {
      if (!is_array($e)) continue;

      list($start, $end) = self::pick_occurrence_start_end($e);
      $ts = self::wp_tz_ts($start);
      if (!$ts) continue;

      $seriesKey = (string)($e['recurrenceId'] ?? $e['seriesId'] ?? $e['seriesKey'] ?? $e['parentId'] ?? '');

      if ($seriesKey === '') {
        $slug = isset($e['slug']) ? sanitize_title((string)$e['slug']) : '';
        if ($slug !== '') $seriesKey = 'slug:' . $slug;
        else {
          $title = strtolower(trim((string)($e['title'] ?? '')));
          $loc   = strtolower(trim((string)($e['location'] ?? '')));
          $seriesKey = 'tl:' . md5($title . '|' . $loc);
        }
      }

      if (!isset($bestBySeries[$seriesKey])) {
        $bestBySeries[$seriesKey] = $e + ['__ts' => $ts];
        continue;
      }

      $cur = $bestBySeries[$seriesKey];
      $curTs = (int)($cur['__ts'] ?? 0);

      $isUpcoming = $ts >= $now;
      $curUpcoming = $curTs >= $now;

      $replace = false;
      if ($isUpcoming && !$curUpcoming) $replace = true;
      elseif ($isUpcoming && $curUpcoming) $replace = ($ts < $curTs);
      elseif (!$isUpcoming && !$curUpcoming) $replace = ($ts > $curTs);

      if ($replace) $bestBySeries[$seriesKey] = $e + ['__ts' => $ts];
    }

    $out = array_values($bestBySeries);
    foreach ($out as &$x) { unset($x['__ts']); }
    return $out;
  }

  /**
   * Trending score — supports multiple possible API field names.
   * Weekly variants come first so the website can stay aligned with the
   * admin dashboard's "Top events this week" ranking when the API exposes
   * weekly view fields for the current city/window.
   */
  private static function get_trending_score($e) {
    $candidates = [
      // weekly-ish (if your API provides it now or later)
      'views7d','views_7d','viewsLast7Days','views_last_7_days','weeklyViews','weekly_views','viewsWeek','views_week',
      'trendingWeek','trending_week','trendingScore7d','trending_score_7d',

      // general
      'trendingScore', 'trending_score',
      'views', 'viewCount', 'view_count',
      'clicks', 'clickCount', 'click_count',
      'likes', 'likeCount', 'like_count',
      'rsvps', 'rsvpCount', 'rsvp_count',
      'popularity', 'popularityScore'
    ];
    foreach ($candidates as $k) {
      if (isset($e[$k]) && $e[$k] !== '') return floatval($e[$k]);
    }
    return 0.0;
  }

  private static function is_happening_now($e) {
    if (!is_array($e)) return false;
    list($start, $end) = self::pick_occurrence_start_end($e);
    $start_ts = self::wp_tz_ts($start);
    $end_ts = self::wp_tz_ts($end);
    $effective_end = $end_ts ?: $start_ts;
    $now = time();
    return $start_ts && $start_ts <= $now && $effective_end >= $now;
  }

  private static function in_next_days($ts, $days) {
    $days = max(1, intval($days));
    $now = time();
    $end = $now + ($days * DAY_IN_SECONDS);
    return ($ts >= $now && $ts <= $end);
  }

  private static function fetch_events($api_base, $city, $limit, $ttl = 60, $sort = '', $expand = null) {
    $api_base = self::normalize_api_base($api_base);
    if ($api_base === '') return [];

    $cities = self::normalize_city_list($city);
    if (empty($cities)) {
      $default_city = sanitize_text_field((string) (function_exists('oc_integration_get_default_area') ? oc_integration_get_default_area() : ''));
      if ($default_city !== '') $cities = [$default_city];
    }

    $cache_key = 'ocmf_' . md5($api_base . '|events|' . self::city_list_to_attr($cities) . '|' . intval($limit) . '|' . (string) $sort . '|' . (string) $expand);
    $cached = get_transient($cache_key);
    if (is_array($cached)) return $cached;

    $events = [];
    $seen = [];
    $request_cities = !empty($cities) ? $cities : [''];

    foreach ($request_cities as $request_city) {
      $qs = [];
      if ($request_city !== '') $qs[] = 'city=' . rawurlencode($request_city);
      if ($limit > 0) $qs[] = 'limit=' . intval($limit);
      if ($sort !== '') $qs[] = 'sort=' . rawurlencode($sort);
      if ($expand !== null) $qs[] = 'expand=' . (intval($expand) === 0 ? '0' : '1');

      $url = $api_base . '/events' . (!empty($qs) ? ('?' . implode('&', $qs)) : '');
      $chunk = self::wp_remote_json($url);
      if (!is_array($chunk) || empty($chunk)) continue;

      foreach ($chunk as $event) {
        if (!is_array($event)) continue;
        if (!self::event_matches_cities($event, $cities)) continue;

        $dedupe_key = trim((string)($event['slug'] ?? ''));
        if ($dedupe_key === '') $dedupe_key = trim((string)($event['id'] ?? ''));
        if ($dedupe_key === '') {
          $dedupe_key = md5(wp_json_encode([
            $event['title'] ?? '',
            $event['startDateTime'] ?? '',
            $event['location'] ?? '',
            $event['city'] ?? '',
          ]));
        }

        if (isset($seen[$dedupe_key])) continue;
        $seen[$dedupe_key] = true;
        $events[] = $event;
      }
    }

    set_transient($cache_key, $events, max(1, intval($ttl)));
    return $events;
  }

  private static function apply_mode($events, $mode) {
    $mode = strtolower(trim((string)$mode));
    $now = time();

    if ($mode === 'upcoming') {
      $events = array_values(array_filter($events, function($e) use ($now) {
        if (!is_array($e)) return false;
        list($start, $end) = OpenCircle_Multi_Filter_Slider::pick_occurrence_start_end($e);
        $start_ts = OpenCircle_Multi_Filter_Slider::wp_tz_ts($start);
        if (!$start_ts) return false;
        $end_ts = OpenCircle_Multi_Filter_Slider::wp_tz_ts($end);
        $effective_end = $end_ts ?: $start_ts;
        return $effective_end >= $now;
      }));

      usort($events, function($a, $b){
        list($sa, $ea) = OpenCircle_Multi_Filter_Slider::pick_occurrence_start_end($a);
        list($sb, $eb) = OpenCircle_Multi_Filter_Slider::pick_occurrence_start_end($b);
        $ta = OpenCircle_Multi_Filter_Slider::wp_tz_ts($sa) ?: PHP_INT_MAX;
        $tb = OpenCircle_Multi_Filter_Slider::wp_tz_ts($sb) ?: PHP_INT_MAX;
        return $ta <=> $tb;
      });

      return $events;
    }

    if ($mode === 'recent' || $mode === 'recently_added' || $mode === 'new') {
      $events = array_values(array_filter($events, function($e){ return is_array($e); }));
      usort($events, function($a, $b){
        $ia = isset($a['id']) ? intval($a['id']) : 0;
        $ib = isset($b['id']) ? intval($b['id']) : 0;
        return $ib <=> $ia;
      });
      return $events;
    }

    // Trending This Week:
    // rank by the API's weekly view activity fields and do not filter by event start date.
    if ($mode === 'trending_week' || $mode === 'trending_this_week' || $mode === 'trending-week') {
      $events = array_values(array_filter($events, function($e){
        return is_array($e);
      }));

      $events = array_values(array_filter($events, function($e) use ($now) {
        list($start, $end) = OpenCircle_Multi_Filter_Slider::pick_occurrence_start_end($e);
        $start_ts = OpenCircle_Multi_Filter_Slider::wp_tz_ts($start);
        $end_ts = OpenCircle_Multi_Filter_Slider::wp_tz_ts($end);
        if ($end_ts) return $end_ts >= $now;
        return $start_ts && $start_ts >= $now;
      }));

      usort($events, function($a, $b) {
        $sa = OpenCircle_Multi_Filter_Slider::get_trending_score($a);
        $sb = OpenCircle_Multi_Filter_Slider::get_trending_score($b);

        if ($sa === $sb) {
          list($sta, $ea) = OpenCircle_Multi_Filter_Slider::pick_occurrence_start_end($a);
          list($stb, $eb) = OpenCircle_Multi_Filter_Slider::pick_occurrence_start_end($b);

          $ta = OpenCircle_Multi_Filter_Slider::wp_tz_ts($sta) ?: PHP_INT_MAX;
          $tb = OpenCircle_Multi_Filter_Slider::wp_tz_ts($stb) ?: PHP_INT_MAX;
          return $ta <=> $tb; // tie-breaker: sooner event first
        }

        return ($sb <=> $sa); // higher score first
      });

      return $events;
    }

    // Default: trending (overall)
    $events = array_values(array_filter($events, function($e){ return is_array($e); }));

    usort($events, function($a, $b) use ($now) {
      $sa = OpenCircle_Multi_Filter_Slider::get_trending_score($a);
      $sb = OpenCircle_Multi_Filter_Slider::get_trending_score($b);

      if ($sa === $sb) {
        list($sta, $ea) = OpenCircle_Multi_Filter_Slider::pick_occurrence_start_end($a);
        list($stb, $eb) = OpenCircle_Multi_Filter_Slider::pick_occurrence_start_end($b);

        $ta = OpenCircle_Multi_Filter_Slider::wp_tz_ts($sta) ?: PHP_INT_MAX;
        $tb = OpenCircle_Multi_Filter_Slider::wp_tz_ts($stb) ?: PHP_INT_MAX;

        $aUpcoming = $ta >= $now;
        $bUpcoming = $tb >= $now;

        if ($aUpcoming && !$bUpcoming) return -1;
        if (!$aUpcoming && $bUpcoming) return 1;

        return $ta <=> $tb;
      }

      return ($sb <=> $sa);
    });

    return $events;
  }

  public static function render_shortcode($atts) {
    $atts = shortcode_atts([
      'type'       => 'upcoming', // upcoming | recent | trending | trending_week
      'city'       => function_exists('oc_integration_get_default_area') ? oc_integration_get_default_area() : 'Enumclaw',
      'limit'      => 12,
      'api'        => (defined('OC_API_BASE') ? OC_API_BASE : 'https://api.opencircleapi.com'),
      'title'      => '',
      'autoplay'   => 'false',
      'interval'   => 5000,
      'show_meta'  => 'true',
      'dedupe'     => 'true',
      'fade'       => 'true',
      'event_base' => '/events/',
    ], $atts, self::SHORTCODE);

    $mode  = sanitize_text_field($atts['type']);
    $cities = self::normalize_city_list($atts['city']);
    $city  = self::city_list_to_attr($cities);
    $limit = max(1, intval($atts['limit']));
    $api   = self::normalize_api_base(esc_url_raw($atts['api']));
    $event_base = self::normalize_event_base($atts['event_base']);

    $autoplay  = self::esc_attr_bool($atts['autoplay']);
    $interval  = max(1500, intval($atts['interval']));
    $show_meta = self::esc_attr_bool($atts['show_meta']);
    $dedupe    = self::esc_attr_bool($atts['dedupe']);
    $fade      = self::esc_attr_bool($atts['fade']);

    if ($api === '') return '<div class="oc-events-error">OpenCircle Events Slider: missing api.</div>';

    $title = sanitize_text_field($atts['title']);
    if ($title === '') {
      $t = strtolower(trim((string)$mode));
      if ($t === 'recent' || $t === 'recently_added' || $t === 'new') $title = 'Recently Added';
      elseif ($t === 'trending_week' || $t === 'trending_this_week' || $t === 'trending-week') $title = 'Trending This Week';
      elseif ($t === 'trending') $title = 'Trending Events';
      else $title = 'Upcoming Events';
    }

    $t = strtolower(trim((string)$mode));

    $ttl = 60;
    $fetch_limit = max($limit * 4, 40);

    $api_sort = '';
    $api_expand = null;

    if ($t === 'recent' || $t === 'recently_added' || $t === 'new') {
      $ttl = 5;
      $fetch_limit = max($limit * 50, 200);
      $api_sort = 'id_desc';
      $api_expand = 0;
      $dedupe = false;
    }

    if ($t === 'trending' || $t === 'trending_week' || $t === 'trending_this_week' || $t === 'trending-week') {
      $ttl = 30;
      $fetch_limit = max($limit * 8, 80);

      // For website "Trending This Week", use the broader trending feed so we
      // can rank all non-past events locally by weekly-view fields without the
      // public endpoint pre-filtering by event date.
      $api_sort = 'trending';
      $api_expand = 1;
    }

    $events = self::fetch_events($api, $city, $fetch_limit, $ttl, $api_sort, $api_expand);

    if ($dedupe) $events = self::dedupe_recurring_occurrences($events);
    $events = self::apply_mode($events, $mode);
    $events = array_slice($events, 0, $limit);

    $placeholder = 'https://via.placeholder.com/1200x675.png?text=Event';

    $uid = 'ocmf_' . wp_generate_uuid4();

    ob_start();
    echo self::render_assets();
    ?>
    <div id="<?php echo esc_attr($uid); ?>"
         class="ocmf-wrap <?php echo $fade ? 'ocmf-has-fade' : ''; ?>"
         data-ocmf="1"
         data-api="<?php echo esc_attr($api); ?>"
         data-event-base="<?php echo esc_attr($event_base); ?>"
         data-autoplay="<?php echo esc_attr($autoplay ? '1' : '0'); ?>"
         data-interval="<?php echo esc_attr($interval); ?>">

      <div class="ocmf-head">
        <div class="ocmf-label"><?php echo esc_html($title); ?></div>

        <?php
          // "See more" URL (event archive)
          $see_more_url = home_url($event_base);
          $grid_sort = '';
          $mode_key = strtolower(trim((string)$mode));
          if ($mode_key === 'trending_week' || $mode_key === 'trending_this_week' || $mode_key === 'trending-week') {
            $grid_sort = 'trending_week';
          } elseif ($mode_key === 'recent' || $mode_key === 'recently_added' || $mode_key === 'new') {
            $grid_sort = 'recent';
          } elseif ($mode_key === 'trending') {
            $grid_sort = 'trending_week';
          }

          $see_more_args = [
            'city' => $city,
          ];
          if ($grid_sort !== '') {
            $see_more_args['sort'] = $grid_sort;
          }

          $see_more_url = add_query_arg($see_more_args, $see_more_url);
        ?>

        <div class="ocmf-controls">
          <a class="ocmf-btn ocmf-see-more"
             href="<?php echo esc_url($see_more_url); ?>"
             aria-label="<?php echo esc_attr('See more ' . $title); ?>">
            See more
          </a>

          <button class="ocmf-icon-btn ocmf-prev" type="button" aria-label="Previous"><span aria-hidden="true">‹</span></button>
          <button class="ocmf-icon-btn ocmf-next" type="button" aria-label="Next"><span aria-hidden="true">›</span></button>
        </div>
      </div>

      <?php if (empty($events)) : ?>
        <h2 class="tribe-events-single-event-title">No events found.</h2>
      <?php else : ?>
        <div class="ocmf-track" role="list" aria-label="OpenCircle events slider">
          <?php foreach ($events as $e):
            if (!is_array($e)) continue;

            $id   = intval($e['id'] ?? 0);
            $slug = isset($e['slug']) ? sanitize_title((string)$e['slug']) : '';
            $key  = $slug ? $slug : (string)$id;

            $title_e = (string)($e['title'] ?? '');
            $loc     = (string)($e['location'] ?? '');
            $img     = self::normalize_image(($e['imageUrl'] ?? ''), $placeholder);

            list($start, $end) = self::pick_occurrence_start_end($e);

            $ts = self::wp_tz_ts($start);
            if (!$ts) continue;

            $tz = wp_timezone();
            $day = wp_date('j', $ts, $tz);
            $mon = wp_date('M', $ts, $tz);
            $dateLabel = self::build_slider_date_label($e, $ts);
            $timeLabel = wp_date('g:i a', $ts, $tz);

            $url = self::build_wp_event_url($key, $event_base);
            $is_trending_mode = in_array($t, ['trending', 'trending_week', 'trending_this_week', 'trending-week'], true);
            $is_happening_now = self::is_happening_now($e);
          ?>
            <a href="<?php echo esc_url($url); ?>"
               class="ocmf-card-link ocmf-slide"
               data-oc-eid="<?php echo esc_attr($id); ?>"
               data-oc-slug="<?php echo esc_attr($slug); ?>"
               aria-label="<?php echo esc_attr($title_e); ?>">
              <article class="ocmf-card" role="listitem">
                <div class="ocmf-media">
                  <?php if ($is_happening_now): ?>
                    <div class="ocmf-happening-badge" aria-label="Happening now">
                      <span>Happening Now</span>
                    </div>
                  <?php endif; ?>
                  <?php if ($is_trending_mode): ?>
                    <div class="ocmf-trending-badge" aria-label="Trending event">
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M16 6h5v5h-2.5V9.77l-6.03 6.03-3.5-3.5-5.24 5.24L2 15.8l6.97-6.97 3.5 3.5L16.23 8.5H16V6z"></path>
                      </svg>
                      <span>Trending</span>
                    </div>
                  <?php endif; ?>
                  <img class="ocmf-thumb"
                       src="<?php echo esc_url($img); ?>"
                       alt="<?php echo esc_attr($title_e); ?>"
                       loading="lazy" />

                  <div class="ocmf-badge">
                    <div class="ocmf-badge-day"><?php echo esc_html($day); ?></div>
                    <div class="ocmf-badge-mon"><?php echo esc_html($mon); ?></div>
                  </div>
                </div>

                <div class="ocmf-body">
                  <h3 class="ocmf-title"><?php echo esc_html($title_e); ?></h3>

                  <?php if ($show_meta): ?>
                    <div class="ocmf-meta">
                      <span class="ocmf-ico" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                          <line x1="16" y1="2" x2="16" y2="6"></line>
                          <line x1="8" y1="2" x2="8" y2="6"></line>
                          <line x1="3" y1="10" x2="21" y2="10"></line>
                        </svg>
                      </span>
                      <span><?php echo esc_html($dateLabel); ?></span>
                    </div>

                    <div class="ocmf-meta">
                      <span class="ocmf-ico" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="10"></circle>
                          <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                      </span>
                      <span><?php echo esc_html($timeLabel); ?></span>
                    </div>

                    <div class="ocmf-meta">
                      <span class="ocmf-ico" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                          <circle cx="12" cy="10" r="3"></circle>
                        </svg>
                      </span>
                      <span><?php echo esc_html($loc); ?></span>
                    </div>
                  <?php endif; ?>
                </div>
              </article>
            </a>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </div>
    <?php
    return ob_get_clean();
  }

  private static function inline_css() {
    return "
/* ===== Container / header ===== */
.ocmf-wrap{ margin: 0 0 22px; }
.ocmf-head{
  display:flex;
  align-items:center;
  gap: 18px;
  margin: 0 0 12px;
}
.ocmf-controls{ margin-left:auto; display:flex; gap:12px; }

/* Text button that matches icon buttons */
.ocmf-btn{
  height: 40px;
  border-radius: 5px;
  border: 1px solid #a5a5a5;
  background: #fff;
  color: #a5a5a5;
  display:flex;
  align-items:center;
  justify-content:center;
  padding: 0 14px;
  cursor:pointer;
  transition: all 0.15s ease;
  text-decoration: none;
  font-weight: 400;
  font-size: 14px;
  line-height: 1;
}
.ocmf-btn:hover{
  background-color: #a5a5a5;
  border-color: #a5a5a5;
  color: #fff;
}
.ocmf-see-more{ white-space: nowrap; }

.ocmf-label{
  font-size: 2rem !important;
  margin: 30px 0px 15px;
  font-weight: 600;
  line-height: 1.1;
  color: #4a4a4a;
}

/* Buttons */
.ocmf-icon-btn{
  width: 40px;
  height: 40px;
  border-radius: 5px;
  border: 1px solid #a5a5a5;
  background: #fff;
  color: #a5a5a5 !important;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:0;
  cursor:pointer;
  transition: all 0.15s ease;
}
.ocmf-icon-btn:hover{
  background-color: #a5a5a5;
  border-color: #a5a5a5;
  color: #fff;
}

/* ===== Track ===== */
.ocmf-track{
  --ocmf-gap: 22px;
  display:flex;
  gap: var(--ocmf-gap);
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 10px;

  -ms-overflow-style: none;
  scrollbar-width: none;
}
.ocmf-track::-webkit-scrollbar{ display:none; }

.ocmf-wrap.ocmf-has-fade .ocmf-track{
  --ocmf-fade: 70px;
  -webkit-mask-image: linear-gradient(to right,#000 0%,#000 calc(100% - var(--ocmf-fade)),transparent 100%);
  mask-image: linear-gradient(to right,#000 0%,#000 calc(100% - var(--ocmf-fade)),transparent 100%);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
}

.ocmf-slide{
  flex: 0 0 calc((100% - (var(--ocmf-gap) * 3)) / 4);
  min-width: 240px;
  scroll-snap-align: start;
  text-decoration:none;
  color: inherit;
}

@media (max-width: 1024px){
  .ocmf-slide{ flex-basis: calc((100% - var(--ocmf-gap)) / 2); }
}
@media (max-width: 640px){
  .ocmf-slide{ flex-basis: 86vw; min-width: 0; }
}

.ocmf-card-link{ text-decoration:none; color:inherit; display:block; }
.ocmf-card-link:hover .ocmf-title{ text-decoration: underline; }
.ocmf-card-link:focus-visible{ outline: 2px solid var(--oc-accent-focus, #2ea7ff); outline-offset: 4px; }

.ocmf-card{ background:#fff; border-radius: 4px; overflow:hidden; box-shadow: none; }
.ocmf-media{ position: relative; }
.ocmf-thumb{ width:100%; aspect-ratio: 16/9; object-fit: cover; display:block; border-radius: 4px; background: #e9e9e9; }

.ocmf-badge{
  position: absolute; left: 14px; top: 14px;
  background: rgba(255,255,255,.92); color: #111;
  border-radius: 4px; padding: 8px 10px;
  font-weight: 800; font-size: 12px; letter-spacing: .02em;
}
.ocmf-trending-badge{
  position:absolute;
  top:12px;
  right:12px;
  background:#f28c28;
  color:#fff;
  font-size:11px;
  font-weight:600;
  padding:6px 10px;
  border-radius:6px;
  text-transform:uppercase;
  letter-spacing:.04em;
  z-index:2;
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.ocmf-happening-badge{
  position:absolute;
  top:12px;
  right:12px;
  background:#16a34a;
  color:#fff;
  font-size:11px;
  font-weight:600;
  padding:6px 10px;
  border-radius:6px;
  text-transform:uppercase;
  letter-spacing:.04em;
  z-index:2;
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.ocmf-happening-badge + .ocmf-trending-badge{
  right:auto;
  left:12px;
}
.ocmf-trending-badge svg{
  width: 16px;
  height: 16px;
  display:block;
  fill: currentColor;
}
.ocmf-badge-day{ font-size: 18px; line-height: 1; }
.ocmf-badge-mon{ font-size: 12px; line-height: 1.1; opacity: .75; margin-top: 2px; }

.ocmf-body{ padding: 15px 0 0; }
.ocmf-title{
  margin: 0 0 15px;
  font-size: 1.231rem;
  line-height: 1.4;
  font-weight: 700;
  color:#111;
  letter-spacing:-0.03em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ocmf-meta{
  display:flex; gap:10px; align-items:center;
  color:#777; font-size: 0.9231rem; line-height: 0.9231rem;
  margin: 8px 0;
}
.ocmf-ico svg{ width: 18px; height: 18px; display:block; }
";
  }

  private static function inline_js() {
    return "
(function(){
  function ocGetSid(){
    try{
      var sid = localStorage.getItem('oc_sid');
      if(!sid){
        var hasUUID = typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function';
        sid = hasUUID ? crypto.randomUUID() : ('sid_' + Math.random().toString(36).slice(2) + Date.now());
        localStorage.setItem('oc_sid', sid);
      }
      return sid;
    }catch(e){ return null; }
  }

  function trackViewFromLink(link){
    if(!link) return;
    var root = link.closest('[data-ocmf=\"1\"]');
    if(!root) return;

    var api = (root.getAttribute('data-api') || '').trim();
    if(!api) return;

    var eid = (link.getAttribute('data-oc-eid') || '').trim();
    var slug = (link.getAttribute('data-oc-slug') || '').trim();
    var idOrSlug = (eid && eid !== '0') ? eid : slug;
    if(!idOrSlug) return;

    var endpoint = api.replace(/\\/$/, '') + '/events/' + encodeURIComponent(idOrSlug) + '/view';
    var payload = JSON.stringify({ sid: ocGetSid() });

    if(navigator.sendBeacon){
      navigator.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' }));
      return;
    }

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(function(){});
  }

  document.addEventListener('click', function(e){
    var link = e.target.closest('.ocmf-slide');
    if(!link) return;
    trackViewFromLink(link);
  }, true);

  function init(root){
    if(!root || root.__ocmfInit) return;
    root.__ocmfInit = true;

    var track = root.querySelector('.ocmf-track');
    if(!track) return;

    var prev = root.querySelector('.ocmf-prev');
    var next = root.querySelector('.ocmf-next');

    function slideWidth(){
      var slide = track.querySelector('.ocmf-slide');
      if(!slide) return 340;
      var style = window.getComputedStyle(track);
      var gap = parseFloat(style.gap || style.columnGap || '22') || 22;
      return slide.getBoundingClientRect().width + gap;
    }
    function scrollByDir(dir){
      track.scrollBy({ left: dir * slideWidth(), behavior: 'smooth' });
    }

    if(prev) prev.addEventListener('click', function(){ scrollByDir(-1); });
    if(next) next.addEventListener('click', function(){ scrollByDir(1); });

    var autoplay = root.getAttribute('data-autoplay') === '1';
    var interval = parseInt(root.getAttribute('data-interval') || '5000', 10);
    if(interval < 1500) interval = 1500;

    var timer = null;
    function stop(){ if(timer){ clearInterval(timer); timer=null; } }
    function start(){
      if(!autoplay) return;
      stop();
      timer = setInterval(function(){
        var maxScroll = track.scrollWidth - track.clientWidth - 2;
        if(track.scrollLeft >= maxScroll){
          track.scrollTo({ left: 0, behavior: 'smooth' });
        } else {
          scrollByDir(1);
        }
      }, interval);
    }

    root.addEventListener('mouseenter', stop);
    root.addEventListener('mouseleave', start);
    root.addEventListener('focusin', stop);
    root.addEventListener('focusout', start);

    start();
  }

  function boot(){
    document.querySelectorAll('[data-ocmf=\"1\"]').forEach(init);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
";
  }
}

OpenCircle_Multi_Filter_Slider::init();
