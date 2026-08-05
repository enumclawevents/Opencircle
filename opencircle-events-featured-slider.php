<?php
/**
 * Module: OpenCircle Featured Event Slider
 * Description: Featured event row slider + full-width hero slider pulled from OpenCircle API.
 * Version: 0.3.4
 */

if (!defined('ABSPATH')) exit;

class OpenCircle_Featured_Slider {
  const SHORTCODE       = 'oc_featured_slider';
  const HERO_SHORTCODE  = 'oc_featured_hero';
  const STYLE_HANDLE    = 'oc-featured-slider-style';
  const SCRIPT_HANDLE   = 'oc-featured-slider-script';
  private static $assets_printed = false;

  public static function init() {
    add_shortcode(self::SHORTCODE,      [__CLASS__, 'render_shortcode']);
    add_shortcode(self::HERO_SHORTCODE, [__CLASS__, 'render_hero_shortcode']);
    add_action('wp_enqueue_scripts',    [__CLASS__, 'register_assets']);
  }

  public static function register_assets() {
    wp_register_style(self::STYLE_HANDLE,  false, [], '0.3.4');
    wp_register_script(self::SCRIPT_HANDLE, false, [], '0.3.4', true);
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
    return rtrim($api, "/");
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
    $bad = ['none','null','undefined','#',''];
    if (in_array(strtolower($imgRaw), $bad, true)) return $placeholder;
    if (preg_match('~^https?://none/?$~i', $imgRaw)) return $placeholder;

    // force https
    $imgFixed = preg_replace('~^http://~i', 'https://', $imgRaw);

    return filter_var($imgFixed, FILTER_VALIDATE_URL) ? $imgFixed : $placeholder;
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

  // Format an ISO date string in WP timezone
  private static function wp_tz_format($iso, $format) {
    $iso = (string)$iso;
    if ($iso === '') return '';

    try {
      $dt = new DateTimeImmutable($iso);            // respects the -07:00 / -08:00 in the string
      $dt = $dt->setTimezone(wp_timezone());       // forces WordPress timezone (Los Angeles)
      return wp_date($format, $dt->getTimestamp(), wp_timezone());
    } catch (Exception $e) {
      $ts = strtotime($iso);
      if (!$ts) return '';
      return wp_date($format, $ts, wp_timezone());
    }
  }

  // Consistent timestamp conversion for sliders
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

  private static function is_featured_flag($e) {
    $f1 = (!empty($e['featured']) && (int)$e['featured'] === 1);
    $f2 = (!empty($e['isFeatured']) && (int)$e['isFeatured'] === 1);
    return ($f1 || $f2);
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
        $itemStart = (string)($it['startDateTime'] ?? $it['start'] ?? '');
        if ($itemStart === '') continue;

        $start_ts = self::wp_tz_ts($itemStart);
        if (!$start_ts) continue;

        $itemEnd = (string)($it['endDateTime'] ?? $it['end'] ?? '');
        $end_ts = $itemEnd !== '' ? self::wp_tz_ts($itemEnd) : 0;
        $effective_end = $end_ts ?: $start_ts;

        if ($bestAny === null) $bestAny = [$itemStart, $itemEnd];
        if ($effective_end >= $now) {
          $bestCurrentOrUpcoming = [$itemStart, $itemEnd];
          break;
        }
      }

      $pick = $bestCurrentOrUpcoming ?: $bestAny;
      if (is_array($pick) && !empty($pick[0])) {
        $start = (string)$pick[0];
        $end = (string)($pick[1] ?? '');
      }
    }

    return [$start, $end];
  }

  private static function fetch_featured($api_base, $city, $limit) {
    $api_base = self::normalize_api_base($api_base);
    if ($api_base === '') return [];

    $cities = self::normalize_city_list($city);
    if (empty($cities)) {
      $default_city = sanitize_text_field((string) (function_exists('oc_integration_get_default_area') ? oc_integration_get_default_area() : ''));
      if ($default_city !== '') $cities = [$default_city];
    }

    $fetch_limit = $limit > 0 ? max($limit * 4, 40) : 40;
    $fetch_limit = min(100, $fetch_limit);

    $cache_scope = self::city_list_to_attr($cities);
    $cache_key = 'ocfs_' . md5($api_base . '|featured|' . $cache_scope . '|' . intval($fetch_limit));
    $cached = get_transient($cache_key);
    if (is_array($cached)) return $cached;

    $events = [];
    $seen = [];
    $request_cities = !empty($cities) ? $cities : [''];

    foreach ($request_cities as $request_city) {
      $query = [
        'featured' => 1,
        'limit' => $fetch_limit,
      ];
      if ($request_city !== '') $query['city'] = $request_city;

      $url1 = add_query_arg($query, $api_base . '/events');
      $chunk = self::wp_remote_json($url1);

      if (empty($chunk)) {
        $fallback_query = [
          'limit' => $fetch_limit,
        ];
        if ($request_city !== '') $fallback_query['city'] = $request_city;
        $url2 = add_query_arg($fallback_query, $api_base . '/events');
        $all = self::wp_remote_json($url2);
        if (!empty($all)) {
          $chunk = array_values(array_filter($all, function($e){
            return is_array($e) && OpenCircle_Featured_Slider::is_featured_flag($e);
          }));
        }
      }

      if (empty($chunk) || !is_array($chunk)) continue;

      foreach ($chunk as $event) {
        if (!is_array($event) || !self::is_featured_flag($event)) continue;
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

    $events = array_values(array_filter($events, function($e){
      if (!is_array($e)) return false;
      list($start, $end) = OpenCircle_Featured_Slider::pick_occurrence_start_end($e);
      $start_ts = OpenCircle_Featured_Slider::wp_tz_ts($start);
      if (!$start_ts) return false;
      $end_ts = OpenCircle_Featured_Slider::wp_tz_ts($end);
      $effective_end = $end_ts ?: $start_ts;
      return $effective_end >= time();
    }));

    set_transient($cache_key, $events, 60);
    return $events;
  }

  private static function dedupe_recurring_occurrences($events) {
    $now = time();
    $bestBySeries = [];

    foreach ($events as $e) {
      if (!is_array($e)) continue;
      if (!self::is_featured_flag($e)) continue;

      list($start, $end) = self::pick_occurrence_start_end($e);
      $ts = self::wp_tz_ts($start);
      if (!$ts) continue;
      $endTs = self::wp_tz_ts($end);
      $effectiveEndTs = $endTs ?: $ts;

      $seriesKey = (string)($e['recurrenceId'] ?? $e['seriesId'] ?? $e['seriesKey'] ?? $e['parentId'] ?? '');

      if ($seriesKey === '') {
        $slug = isset($e['slug']) ? sanitize_title((string)$e['slug']) : '';
        if ($slug !== '') {
          $seriesKey = 'slug:' . $slug;
        } else {
          $title = strtolower(trim((string)($e['title'] ?? '')));
          $loc   = strtolower(trim((string)($e['location'] ?? '')));
          $seriesKey = 'tl:' . md5($title . '|' . $loc);
        }
      }

      if (!isset($bestBySeries[$seriesKey])) {
        $bestBySeries[$seriesKey] = $e + ['__ts' => $ts, '__end_ts' => $effectiveEndTs];
        continue;
      }

      $cur = $bestBySeries[$seriesKey];
      $curTs = (int)($cur['__ts'] ?? 0);
      $curEndTs = (int)($cur['__end_ts'] ?? $curTs);

      $isUpcoming  = $effectiveEndTs >= $now;
      $curUpcoming = $curEndTs >= $now;

      $replace = false;
      if ($isUpcoming && !$curUpcoming) $replace = true;
      elseif ($isUpcoming && $curUpcoming) $replace = ($ts < $curTs);
      elseif (!$isUpcoming && !$curUpcoming) $replace = ($ts > $curTs);

      if ($replace) $bestBySeries[$seriesKey] = $e + ['__ts' => $ts, '__end_ts' => $effectiveEndTs];
    }

    $out = array_values($bestBySeries);
    foreach ($out as &$x) { unset($x['__ts'], $x['__end_ts']); }
    return $out;
  }

  /**
   * Row slider: [oc_featured_slider]
   */
  public static function render_shortcode($atts) {
    $atts = shortcode_atts([
      'city'       => function_exists('oc_integration_get_default_area') ? oc_integration_get_default_area() : 'Enumclaw',
      'limit'      => 10,
      'api'        => (defined('OC_API_BASE') ? OC_API_BASE : 'https://api.opencircleapi.com'),
      'title'      => 'Featured Events',
      'autoplay'   => 'false',
      'interval'   => 5000,
      'show_meta'  => 'true',
      'event_base' => '/events/',
    ], $atts, self::SHORTCODE);

    $cities = self::normalize_city_list($atts['city']);
    $city  = self::city_list_to_attr($cities);
    $limit = max(1, intval($atts['limit']));
    $api   = self::normalize_api_base(esc_url_raw($atts['api']));
    $title = sanitize_text_field($atts['title']);

    $autoplay  = self::esc_attr_bool($atts['autoplay']);
    $interval  = max(1500, intval($atts['interval']));
    $show_meta = self::esc_attr_bool($atts['show_meta']);

    $event_base = self::normalize_event_base($atts['event_base']);

    if ($api === '') {
      return '<div class="oc-events-error">OpenCircle Featured Slider: missing api.</div>';
    }

    $events = self::fetch_featured($api, $city, $limit);
    $events = self::dedupe_recurring_occurrences($events);
    $events = array_slice($events, 0, $limit);

    $placeholder = 'https://via.placeholder.com/1200x675.png?text=Event';

    $uid = 'ocfs_' . wp_generate_uuid4();

    ob_start();
    echo self::render_assets();
    ?>
    <div id="<?php echo esc_attr($uid); ?>" class="ocfs-wrap"
         data-ocfs="1"
         data-api="<?php echo esc_attr($api); ?>"
         data-event-base="<?php echo esc_attr($event_base); ?>"
         data-autoplay="<?php echo esc_attr($autoplay ? '1' : '0'); ?>"
         data-interval="<?php echo esc_attr($interval); ?>">

      <div class="ocfs-head">
        <div class="oc-label"><?php echo esc_html($title); ?></div>
        <div class="ocfs-controls">
          <button class="oc-icon-btn ocfs-prev" type="button" aria-label="Previous"><span aria-hidden="true">‹</span></button>
          <button class="oc-icon-btn ocfs-next" type="button" aria-label="Next"><span aria-hidden="true">›</span></button>
        </div>
      </div>

      <?php if (empty($events)) : ?>
        <h2 class="tribe-events-single-event-title">No featured events found.</h2>
      <?php else : ?>
        <div class="ocfs-track" role="list" aria-label="Featured events slider">
          <?php foreach ($events as $e):
            if (!is_array($e)) continue;

            $id   = intval($e['id'] ?? 0);
            $slug = isset($e['slug']) ? sanitize_title((string)$e['slug']) : '';
            $key  = $slug ? $slug : (string)$id;

            $title_e = (string)($e['title'] ?? '');
            list($start, $end) = self::pick_occurrence_start_end($e);
            $loc     = (string)($e['location'] ?? '');
            $img     = self::normalize_image(($e['imageUrl'] ?? ''), $placeholder);

            $ts = self::wp_tz_ts($start);
            if (!$ts) continue;

            $day       = wp_date('j', $ts, wp_timezone());
            $mon       = wp_date('M', $ts, wp_timezone());
            $dateLabel = self::build_slider_date_label($e, $ts);
            $timeLabel = wp_date('g:i a', $ts, wp_timezone());
            $is_happening_now = self::is_happening_now($e);

            $url = self::build_wp_event_url($key, $event_base);
          ?>
            <a href="<?php echo esc_url($url); ?>"
               class="oc-card-link ocfs-slide"
               data-oc-eid="<?php echo esc_attr($id); ?>"
               data-oc-slug="<?php echo esc_attr($slug); ?>"
              aria-label="<?php echo esc_attr($title_e); ?>">
              <article class="oc-card" role="listitem">
                <div class="oc-media">
                  <div class="oc-featured-badges">
                    <div class="oc-featured-badge">
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M12 2.8l2.85 5.77 6.37.93-4.61 4.49 1.09 6.35L12 17.37 6.3 20.34l1.09-6.35L2.78 9.5l6.37-.93L12 2.8z"></path>
                      </svg>
                      <span>Featured</span>
                    </div>
                    <?php if ($is_happening_now): ?>
                      <div class="oc-happening-badge">Happening Now</div>
                    <?php endif; ?>
                  </div>

                  <img class="oc-thumb"
                       src="<?php echo esc_url($img); ?>"
                       alt="<?php echo esc_attr($title_e); ?>"
                       loading="lazy" />

                  <div class="oc-badge">
                    <div class="oc-badge-day"><?php echo esc_html($day); ?></div>
                    <div class="oc-badge-mon"><?php echo esc_html($mon); ?></div>
                  </div>
                </div>

                <div class="oc-body">
                  <h3 class="oc-title"><?php echo esc_html($title_e); ?></h3>

                  <?php if ($show_meta): ?>
                    <div class="oc-meta">
                      <span class="oc-ico" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                          <line x1="16" y1="2" x2="16" y2="6"></line>
                          <line x1="8" y1="2" x2="8" y2="6"></line>
                          <line x1="3" y1="10" x2="21" y2="10"></line>
                        </svg>
                      </span>
                      <span><?php echo esc_html($dateLabel); ?></span>
                    </div>

                    <div class="oc-meta">
                      <span class="oc-ico" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="10"></circle>
                          <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                      </span>
                      <span><?php echo esc_html($timeLabel); ?></span>
                    </div>

                    <div class="oc-meta">
                      <span class="oc-ico" aria-hidden="true">
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

  /**
   * Hero slider: [oc_featured_hero]
   */
  public static function render_hero_shortcode($atts) {
    $atts = shortcode_atts([
      'city'       => function_exists('oc_integration_get_default_area') ? oc_integration_get_default_area() : 'Enumclaw',
      'limit'      => 6,
      'api'        => (defined('OC_API_BASE') ? OC_API_BASE : 'https://api.opencircleapi.com'),
      'autoplay'   => 'true',
      'interval'   => 6000,
      'show_meta'  => 'true',
      'height'     => 520,
      'fullbleed'  => 'true',
      'event_base' => '/events/',
    ], $atts, self::HERO_SHORTCODE);

    $cities = self::normalize_city_list($atts['city']);
    $city  = self::city_list_to_attr($cities);
    $limit = max(1, intval($atts['limit']));
    $api   = self::normalize_api_base(esc_url_raw($atts['api']));

    $autoplay  = self::esc_attr_bool($atts['autoplay']);
    $interval  = max(1500, intval($atts['interval']));
    $show_meta = self::esc_attr_bool($atts['show_meta']);
    $height    = max(260, intval($atts['height']));
    $fullbleed = self::esc_attr_bool($atts['fullbleed']);

    $event_base = self::normalize_event_base($atts['event_base']);

    if ($api === '') {
      return '<div class="oc-events-error">OpenCircle Featured Hero: missing api.</div>';
    }

    $events = self::fetch_featured($api, $city, $limit);
    $events = self::dedupe_recurring_occurrences($events);
    $events = array_slice($events, 0, $limit);

    $placeholder = 'https://via.placeholder.com/1600x900.png?text=Event';

    $uid = 'ocfh_' . wp_generate_uuid4();

    ob_start();
    echo self::render_assets();
    ?>
    <section id="<?php echo esc_attr($uid); ?>"
      class="ocfh <?php echo $fullbleed ? 'ocfh-fullbleed' : ''; ?>"
      data-ocfh="1"
      data-api="<?php echo esc_attr($api); ?>"
      data-event-base="<?php echo esc_attr($event_base); ?>"
      data-autoplay="<?php echo esc_attr($autoplay ? '1' : '0'); ?>"
      data-interval="<?php echo esc_attr($interval); ?>"
      style="--ocfh-h: <?php echo esc_attr($height); ?>px;">

      <?php if (empty($events)) : ?>
        <div class="ocfh-empty">
          <h2 class="tribe-events-single-event-title">No featured events found.</h2>
        </div>
      <?php else : ?>
        <div class="ocfh-viewport" aria-roledescription="carousel">
          <div class="ocfh-track" role="list">
          <?php foreach ($events as $e):
            if (!is_array($e)) continue;

            $id   = intval($e['id'] ?? 0);
            $slug = isset($e['slug']) ? sanitize_title((string)$e['slug']) : '';
            $key  = $slug ? $slug : (string)$id;

            $title_e = (string)($e['title'] ?? '');
            list($start, $end) = self::pick_occurrence_start_end($e);
            $loc     = (string)($e['location'] ?? '');
            $img     = self::normalize_image(($e['imageUrl'] ?? ''), $placeholder);

              $ts = self::wp_tz_ts($start);
              $dateLabel = $ts ? self::build_slider_date_label($e, $ts) : '';
              $timeLabel = $ts ? wp_date('g:i a', $ts, wp_timezone()) : '';

              $url = self::build_wp_event_url($key, $event_base);
            ?>
              <a class="ocfh-slide"
                 href="<?php echo esc_url($url); ?>"
                 data-oc-eid="<?php echo esc_attr($id); ?>"
                 data-oc-slug="<?php echo esc_attr($slug); ?>"
                 role="listitem"
                 aria-label="<?php echo esc_attr($title_e); ?>"
                 style="--ocfh-bg: url('<?php echo esc_url($img); ?>');">

                <span class="ocfh-sr-img">
                  <img src="<?php echo esc_url($img); ?>" alt="<?php echo esc_attr($title_e); ?>" loading="lazy" />
                </span>

                <div class="ocfh-overlay">
                  <div class="ocfh-card">
                    <h2 class="ocfh-title"><?php echo esc_html($title_e); ?></h2>

                    <?php if ($show_meta): ?>
                      <div class="ocfh-meta">
                        <?php if ($dateLabel !== ''): ?>
                          <span class="ocfh-meta-item">
                            <span class="ocfh-ico" aria-hidden="true">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                <line x1="3" y1="10" x2="21" y2="10"></line>
                              </svg>
                            </span>
                            <span><?php echo esc_html($dateLabel); ?></span>
                          </span>
                        <?php endif; ?>

                        <?php if ($timeLabel !== ''): ?>
                          <span class="ocfh-meta-item">
                            <span class="ocfh-ico" aria-hidden="true">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                              </svg>
                            </span>
                            <span><?php echo esc_html($timeLabel); ?></span>
                          </span>
                        <?php endif; ?>

                        <?php if (trim($loc) !== ''): ?>
                          <span class="ocfh-meta-item">
                            <span class="ocfh-ico" aria-hidden="true">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                                <circle cx="12" cy="10" r="3"></circle>
                              </svg>
                            </span>
                            <span><?php echo esc_html($loc); ?></span>
                          </span>
                        <?php endif; ?>
                      </div>
                    <?php endif; ?>

                    <div class="ocfh-cta">VIEW EVENT</div>
                  </div>
                </div>
              </a>
            <?php endforeach; ?>
          </div>

          <div class="ocfh-dots" aria-label="Slide navigation"></div>
        </div>
      <?php endif; ?>
    </section>
    <?php
    return ob_get_clean();
  }

  /* =========================
   * Assets
   * ========================= */

  private static function inline_css() {
    return "
/* ===== Row slider wrapper ===== */
.ocfs-wrap{ margin: 0 0 22px; }
.ocfs-head{ display:flex; align-items:center; gap:18px; margin:0 0 12px; }
.ocfs-controls{ margin-left:auto; display:flex; gap:12px; }

/* Row track: full width, 3 visible, fade right */
.ocfs-track{
  --ocfs-gap: 22px;
  --ocfs-fade: 70px;

  display:flex;
  gap: var(--ocfs-gap);
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 10px;

  -ms-overflow-style: none;
  scrollbar-width: none;

  -webkit-mask-image: linear-gradient(to right,#000 0%,#000 calc(100% - var(--ocfs-fade)),transparent 100%);
  mask-image: linear-gradient(to right,#000 0%,#000 calc(100% - var(--ocfs-fade)),transparent 100%);
  -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat;
  -webkit-mask-size:100% 100%; mask-size:100% 100%;
}
.ocfs-track::-webkit-scrollbar{ display:none; }

.ocfs-slide{
  flex: 0 0 calc((100% - (var(--ocfs-gap) * 2)) / 3);
  scroll-snap-align: start;
  text-decoration:none;
  color: inherit;
  min-width: 280px;
}
@media (max-width: 1024px){
  .ocfs-slide{ flex-basis: calc((100% - var(--ocfs-gap)) / 2); }
}
@media (max-width: 640px){
  .ocfs-slide{ flex-basis: 86vw; min-width: 0; }
}

/* ===== Shared label/button ===== */
.oc-label{
  font-size: 2rem !important;
  margin: 30px 0px 15px;
  font-weight: 600;
  line-height: 1.1;
  color: #4a4a4a;
}
.oc-icon-btn{
  width: 40px; height: 40px;
  border-radius: 5px;
  border: 1px solid #a5a5a5;
  background: #fff;
  color: #a5a5a5;
  display:flex; align-items:center; justify-content:center;
  padding:0;
  cursor:pointer;
  transition: all 0.15s ease;
}
.oc-icon-btn:hover{ background:#a5a5a5; border-color:#a5a5a5; color:#fff; }

/* Featured badge (row slider only) */
.oc-featured-badges{
  position:absolute;
  top:12px;
  right:12px;
  display:flex;
  align-items:center;
  gap:10px;
  z-index:2;
}
.oc-featured-badge{
  background:var(--oc-accent, #3fabd1);
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
.oc-happening-badge{
  background:#16a34a;
  color:#fff;
  font-size:11px;
  font-weight:600;
  padding:6px 10px;
  border-radius:6px;
  text-transform:uppercase;
  letter-spacing:.04em;
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.oc-featured-badge svg{
  width:.95em;
  height:.95em;
  display:block;
  flex:0 0 auto;
  fill:currentColor;
}

/* ===== Card styles (match your grid) ===== */
.oc-card-link{ text-decoration:none; color:inherit; display:block; }
.oc-card-link:hover .oc-title{ text-decoration: underline; }
.oc-card-link:focus-visible{ outline: 2px solid var(--oc-accent-focus, #2ea7ff); outline-offset: 4px; }
.oc-card{ background:#fff; border-radius:4px; overflow:hidden; box-shadow:none; }
.oc-media{ position:relative; }
.oc-thumb{
  width:100%;
  aspect-ratio:16/9;
  object-fit:cover;
  display:block;
  border-radius:4px;
  background:#e9e9e9;
}
.oc-badge{
  position:absolute; left:14px; top:14px;
  display:inline-flex;
  flex-direction:column;
  align-items:center;
  background: rgba(255,255,255,.92);
  color:#111;
  border-radius:4px;
  padding:8px 10px;
  font-weight:800;
  font-size:12px;
  letter-spacing:.02em;
  line-height:1;
  text-align:center;
  z-index:2;
}
.oc-badge .oc-badge-day,
.oc-badge .oc-badge-mon{
  display:block;
  margin:0;
  padding:0;
  border:0;
  background:none;
  box-shadow:none;
}
.oc-badge .oc-badge-day{ font-size:18px; line-height:1; }
.oc-badge .oc-badge-mon{ font-size:12px; line-height:1.1; opacity:.75; margin-top:2px; }

.oc-body{ padding: 15px 0 0; }
.oc-title{
  margin: 0 0 15px;
  font-size: 1.231rem;
  line-height: 1.4;
  font-weight: 700;
  color:#111;
  letter-spacing:-0.03em;
  display:-webkit-box;
  -webkit-line-clamp:2;
  -webkit-box-orient:vertical;
  overflow:hidden;
}
.oc-meta{
  display:flex;
  gap:10px;
  align-items:center;
  color:#777;
  font-size:0.9231rem;
  line-height:0.9231rem;
  margin: 8px 0;
}
.oc-meta .oc-ico{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex: 0 0 18px;
  width:18px;
  min-width:18px;
  max-width:18px;
  height:18px;
  min-height:18px;
  max-height:18px;
  overflow:hidden;
  line-height:1;
}
.oc-meta .oc-ico svg{
  display:block !important;
  flex: 0 0 18px;
  width:18px !important;
  min-width:18px !important;
  max-width:18px !important;
  height:18px !important;
  min-height:18px !important;
  max-height:18px !important;
}

/* Force hero nav buttons to be DOTS (override theme button styles) */
.ocfh-dots .ocfh-dot{
  all: unset;
  box-sizing: border-box;
  display: inline-block;
  width: 10px !important;
  height: 10px !important;
  border-radius: 999px !important;
  background: rgba(255,255,255,.35) !important;
  border: 1px solid rgba(255,255,255,.45) !important;
  cursor: pointer;
}
.ocfh-dots .ocfh-dot.is-active{
  background: #fff !important;
  border-color: #fff !important;
}
.ocfh-dots .ocfh-dot:focus-visible{
  outline: 2px solid #fff;
  outline-offset: 4px;
}

/* ===== HERO SLIDER (EventChamp-ish style) ===== */
.ocfh{
  --ocfh-h: 520px;
  position: relative;
  margin: 0;
}
.ocfh-title{ margin-bottom: 26px !important; }
.ocfh-meta{ margin-top: 0 !important; margin-bottom: 28px !important; }
.ocfh-cta{ margin-top: 0 !important; }

/* HERO: accent icons (text stays white) */
.ocfh-ico svg{
  color: var(--oc-accent, #3fabd1) !important;
  stroke: currentColor !important;
}

.ocfh-fullbleed{
  width: 100vw;
  margin-left: calc(50% - 50vw);
  margin-right: calc(50% - 50vw);
}
.ocfh-viewport{
  position: relative;
  height: var(--ocfh-h);
  border-radius: 0;
  overflow: hidden;
}
.ocfh-track{
  height: 100%;
  display:flex;
  will-change: transform;
  transition: transform .45s ease;
}
.ocfh-slide{
  flex: 0 0 100%;
  height: 100%;
  position: relative;
  text-decoration:none;
  color: inherit;
  background-image: var(--ocfh-bg);
  background-size: cover;
  background-position: center;
}
.ocfh-sr-img{
  position:absolute;
  width:1px; height:1px;
  overflow:hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  clip-path: inset(50%);
}
.ocfh-slide::before{
  content:\"\"; position:absolute; inset:0;
  background: rgba(0,0,0,.58);
}

.ocfh-overlay{
  position:absolute;
  inset:0;
  display:flex;
  align-items:center;
  justify-content:center;
  text-align:center;
  padding: 0 18px;
}

.ocfh-card{
  background: transparent;
  padding: 0;
  margin: 0;
  max-width: 980px;
}

.ocfh-title{
  color: #fff;
  font-size: clamp(2.2rem, 4vw, 4.2rem);
  line-height: 1.05;
  margin: 0 0 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
  text-shadow: 0 8px 30px rgba(0,0,0,.45);
}

.ocfh-meta{
  display:flex;
  gap: 22px;
  justify-content:center;
  align-items:center;
  flex-wrap: wrap;
  color: rgba(255,255,255,.92);
  font-size: 0.95rem;
  line-height: 1.2;
  text-shadow: 0 6px 20px rgba(0,0,0,.35);
}
.ocfh-meta-item{
  display:inline-flex;
  gap: 10px;
  align-items:center;
}
.ocfh-ico svg{
  width: 18px;
  height: 18px;
  display:block;
  color: var(--oc-accent, #3fabd1);
  stroke: currentColor !important;
}

.ocfh-cta{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  height: 44px;
  padding: 0 26px;
  border-radius: 8px;
  border: 2px solid rgba(255,255,255,.85);
  color: #fff;
  margin-top: 22px;
  font-size: 14px;
  font-weight: 400;
  letter-spacing: .04em;
  text-transform: uppercase;
  background: rgba(0,0,0,.12);
}
.ocfh-slide:hover .ocfh-cta{
  background: rgba(255,255,255,.12);
  border-color: #fff;
}

/* Dots */
.ocfh-dots{
  position:absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 20px;
  display:flex;
  gap: 8px;
  z-index: 3;
}
.ocfh-dot{
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: rgba(255,255,255,.35);
  border: 1px solid rgba(255,255,255,.4);
  cursor:pointer;
}
.ocfh-dot.is-active{
  background: #fff;
  border-color: #fff;
}

@media (max-width: 768px){
  .ocfh{ --ocfh-h: 380px; }
  .ocfh-title{ font-size: clamp(1.6rem, 7vw, 2.4rem); }
  .ocfh-meta{ gap: 14px; font-size: 0.9rem; }
}
";
  }

  private static function inline_js() {
    return "
(function(){
  // ===== View tracking for slider cards =====
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
    var root = link.closest('[data-ocfs=\"1\"], [data-ocfh=\"1\"]');
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
    var link = e.target.closest('.ocfs-slide, .ocfh-slide');
    if(!link) return;
    trackViewFromLink(link);
  }, true);

  // ===== Row slider init =====
  function initRow(root){
    if(!root || root.__ocfsInit) return;
    root.__ocfsInit = true;

    var track = root.querySelector('.ocfs-track');
    if(!track) return;

    var prev = root.querySelector('.ocfs-prev');
    var next = root.querySelector('.ocfs-next');

    function slideWidth(){
      var slide = track.querySelector('.ocfs-slide');
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

  // ===== Hero slider init =====
  function initHero(root){
    if(!root || root.__ocfhInit) return;
    root.__ocfhInit = true;

    var track = root.querySelector('.ocfh-track');
    var slides = Array.prototype.slice.call(root.querySelectorAll('.ocfh-slide'));
    var dotsWrap = root.querySelector('.ocfh-dots');

    if(!track || slides.length === 0) return;

    var idx = 0;

    function renderDots(){
      if(!dotsWrap) return;
      dotsWrap.innerHTML = '';
      slides.forEach(function(_, i){
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ocfh-dot' + (i === idx ? ' is-active' : '');
        b.setAttribute('aria-label', 'Go to slide ' + (i+1));
        b.addEventListener('click', function(){ go(i); stop(); });
        dotsWrap.appendChild(b);
      });
    }

    function update(){
      track.style.transform = 'translateX(' + (-idx * 100) + '%)';
      if(dotsWrap){
        Array.prototype.slice.call(dotsWrap.children).forEach(function(el, i){
          el.classList.toggle('is-active', i === idx);
        });
      }
    }

    function go(n){
      idx = (n + slides.length) % slides.length;
      update();
    }
    function nextSlide(){ go(idx + 1); }

    renderDots();
    update();

    var autoplay = root.getAttribute('data-autoplay') === '1';
    var interval = parseInt(root.getAttribute('data-interval') || '6000', 10);
    if(interval < 1500) interval = 1500;

    var timer = null;
    function stop(){ if(timer){ clearInterval(timer); timer=null; } }
    function start(){
      if(!autoplay) return;
      stop();
      timer = setInterval(nextSlide, interval);
    }

    root.addEventListener('mouseenter', stop);
    root.addEventListener('mouseleave', start);
    root.addEventListener('focusin', stop);
    root.addEventListener('focusout', start);

    var startX = 0, dx = 0, touching = false;
    root.addEventListener('touchstart', function(e){
      if(!e.touches || !e.touches[0]) return;
      touching = true;
      startX = e.touches[0].clientX;
      dx = 0;
      stop();
    }, {passive:true});

    root.addEventListener('touchmove', function(e){
      if(!touching || !e.touches || !e.touches[0]) return;
      dx = e.touches[0].clientX - startX;
    }, {passive:true});

    root.addEventListener('touchend', function(){
      if(!touching) return;
      touching = false;
      if(Math.abs(dx) > 40){
        if(dx < 0) nextSlide();
        else go(idx - 1);
      }
      start();
    });

    start();
  }

  function boot(){
    document.querySelectorAll('[data-ocfs=\"1\"]').forEach(initRow);
    document.querySelectorAll('[data-ocfh=\"1\"]').forEach(initHero);
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

OpenCircle_Featured_Slider::init();
