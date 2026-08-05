<?php
/**
 * Plugin Name: OpenCircle Integration
 * Description: Pull events from OpenCircle API and render a theme-style event grid with search/sort filters + API pagination.
 * Version: 0.3.2
 */

if (!defined('ABSPATH')) exit;

function oc_integration_default_api_base() {
  return 'https://api.opencircleapi.com';
}

function oc_integration_get_api_base() {
  $stored = get_option('oc_integration_api_base', oc_integration_default_api_base());
  $url = esc_url_raw((string)$stored);
  if ($url === '') $url = oc_integration_default_api_base();
  return rtrim($url, '/');
}

function oc_integration_default_accent_color() {
  return '#3fabd1';
}

function oc_integration_default_events_grid_page_url() {
  return home_url('/events/');
}

function oc_integration_default_area() {
  return 'Enumclaw';
}

function oc_integration_normalize_area($value) {
  $value = strtolower(trim((string) $value));
  if ($value === 'buckley') return 'Buckley';
  return 'Enumclaw';
}

function oc_integration_get_default_area() {
  $stored = get_option('oc_integration_default_area', oc_integration_default_area());
  return oc_integration_normalize_area($stored);
}

function oc_integration_plateau_city_list() {
  return ['Buckley', 'Carbonado', 'South Prairie', 'Wilkeson'];
}

function oc_integration_plateau_city_csv() {
  return implode(', ', oc_integration_plateau_city_list());
}

function oc_integration_plateau_label() {
  return 'Plateau Area';
}

function oc_integration_newsletter_scope() {
  return oc_integration_plateau_label();
}

function oc_integration_jobs_scope() {
  return oc_integration_plateau_city_csv();
}

function oc_integration_jobs_scope_label() {
  return oc_integration_plateau_label();
}

function oc_integration_ads_scope_cities() {
  return oc_integration_plateau_city_list();
}

function oc_integration_organizer_scope() {
  return oc_integration_plateau_city_csv();
}

function oc_integration_get_accent_color() {
  $stored = get_option('oc_integration_accent_color', oc_integration_default_accent_color());
  $color = sanitize_hex_color((string)$stored);
  if (!$color) $color = oc_integration_default_accent_color();
  return strtolower($color);
}

function oc_integration_get_events_grid_page_url() {
  $stored = get_option('oc_integration_events_grid_page_url', oc_integration_default_events_grid_page_url());
  $url = esc_url_raw((string)$stored);
  if ($url === '') $url = oc_integration_default_events_grid_page_url();
  return $url;
}

function oc_integration_get_organizer_grid_url($organizer) {
  $organizer = trim((string)$organizer);
  if ($organizer === '') return '';

  $base_url = oc_integration_get_events_grid_page_url();
  if ($base_url === '') return '';

  return add_query_arg([
    'organizer' => $organizer,
    'city'      => oc_integration_organizer_scope(),
  ], $base_url);
}

function oc_integration_get_filtered_events_grid_url($args = []) {
  $base_url = oc_integration_get_events_grid_page_url();
  if ($base_url === '') return '';

  $clean = [];
  foreach ((array) $args as $key => $value) {
    $key = sanitize_key($key);
    $value = is_scalar($value) ? trim((string) $value) : '';
    if ($key === '' || $value === '') continue;
    $clean[$key] = $value;
  }

  return !empty($clean) ? add_query_arg($clean, $base_url) : $base_url;
}

function oc_integration_get_category_grid_url($category) {
  $category = trim((string)$category);
  if ($category === '') return '';

  $base_url = oc_integration_get_events_grid_page_url();
  if ($base_url === '') return '';

  $category_map = [
    'workshops & classes' => 'Classes & Workshops',
    'live music' => 'Music',
    'community events' => 'Community',
    'seasonal & holiday' => 'Seasonal & Holiday',
    'arts & culture' => 'Arts & Culture',
    'nightlife' => 'Nightlife',
    'markets & shopping' => 'Markets & Shopping',
    'food & drink' => 'Food & Drink',
    'games & trivia' => 'Games & Trivia',
    'family & kids' => 'Family & Kids',
    'sports & fitness' => 'Sports & Fitness',
    'outdoors' => 'Outdoors',
    'business & networking' => 'Business & Networking',
    'charity & fundraising' => 'Charity & Fundraising',
    'music' => 'Music',
    'community' => 'Community',
    'classes & workshops' => 'Classes & Workshops',
  ];

  $normalized = strtolower($category);
  $target_category = isset($category_map[$normalized]) ? $category_map[$normalized] : $category;

  return rtrim($base_url, '?&') . '?cat=' . rawurlencode(strtolower($target_category));
}

function oc_integration_get_venue_grid_url($venue) {
  $venue = trim((string)$venue);
  if ($venue === '') return '';
  return oc_integration_get_filtered_events_grid_url(['venue' => $venue]);
}

function oc_integration_hex_to_rgb($hex) {
  $hex = ltrim((string)$hex, '#');
  if (strlen($hex) === 3) {
    $hex = $hex[0] . $hex[0] . $hex[1] . $hex[1] . $hex[2] . $hex[2];
  }
  if (!preg_match('/^[0-9a-fA-F]{6}$/', $hex)) {
    return [63, 171, 209];
  }
  return [
    hexdec(substr($hex, 0, 2)),
    hexdec(substr($hex, 2, 2)),
    hexdec(substr($hex, 4, 2)),
  ];
}

function oc_integration_adjust_color($hex, $percent) {
  $rgb = oc_integration_hex_to_rgb($hex);
  $out = [];
  foreach ($rgb as $channel) {
    if ($percent >= 0) {
      $channel = (int) round($channel + ((255 - $channel) * ($percent / 100)));
    } else {
      $channel = (int) round($channel * ((100 + $percent) / 100));
    }
    $out[] = max(0, min(255, $channel));
  }
  return sprintf('#%02x%02x%02x', $out[0], $out[1], $out[2]);
}

function oc_integration_rgba($hex, $alpha) {
  $rgb = oc_integration_hex_to_rgb($hex);
  $alpha = max(0, min(1, (float)$alpha));
  return sprintf('rgba(%d,%d,%d,%.3F)', $rgb[0], $rgb[1], $rgb[2], $alpha);
}

function oc_integration_get_color_tokens() {
  $base = oc_integration_get_accent_color();
  return [
    'base' => $base,
    'dark' => oc_integration_adjust_color($base, -20),
    'darker' => oc_integration_adjust_color($base, -35),
    'light' => oc_integration_adjust_color($base, 90),
    'soft' => oc_integration_adjust_color($base, 82),
    'focus' => oc_integration_adjust_color($base, -5),
    'rgb_10' => oc_integration_rgba($base, 0.10),
    'rgb_24' => oc_integration_rgba($base, 0.24),
  ];
}

function oc_integration_event_iso_to_ts($iso) {
  $iso = trim((string)$iso);
  if ($iso === '') return 0;

  $tz = wp_timezone();
  $iso_local = preg_replace('/(Z|[+\-]\d{2}:\d{2})$/', '', $iso);

  try {
    $dt = new DateTimeImmutable($iso_local, $tz);
    return $dt->getTimestamp();
  } catch (Exception $e) {}

  try {
    $dt = new DateTimeImmutable($iso, $tz);
    return $dt->getTimestamp();
  } catch (Exception $e) {}

  $ts = strtotime($iso_local);
  return $ts ? (int) $ts : 0;
}

function oc_integration_event_happening_now($event, $now_ts = null) {
  if (!is_array($event)) return false;
  $now_ts = $now_ts ? (int) $now_ts : time();

  $start_ts = oc_integration_event_iso_to_ts((string) ($event['startDateTime'] ?? ''));
  if ($start_ts) {
    $end_ts = oc_integration_event_iso_to_ts((string) ($event['endDateTime'] ?? ''));
    $effective_end = $end_ts ?: $start_ts;
    return $start_ts <= $now_ts && $effective_end >= $now_ts;
  }

  $pairs = [];

  foreach (['occurrencesUpcoming', 'occurrences', 'upcomingOccurrences'] as $key) {
    if (empty($event[$key]) || !is_array($event[$key])) continue;
    foreach ($event[$key] as $occurrence) {
      if (!is_array($occurrence)) continue;
      $pairs[] = [
        (string) ($occurrence['startDateTime'] ?? ''),
        (string) ($occurrence['endDateTime'] ?? ''),
      ];
    }
    if (!empty($pairs)) break;
  }

  $items = $event['recurrenceRule']['items'] ?? null;
  if (is_array($items)) {
    foreach ($items as $item) {
      if (!is_array($item)) continue;
      $pairs[] = [
        (string) ($item['startDateTime'] ?? $item['start'] ?? ''),
        (string) ($item['endDateTime'] ?? $item['end'] ?? ''),
      ];
    }
  }

  foreach ($pairs as $pair) {
    $start_ts = oc_integration_event_iso_to_ts($pair[0] ?? '');
    if (!$start_ts) continue;
    $end_ts = oc_integration_event_iso_to_ts($pair[1] ?? '');
    $effective_end = $end_ts ?: $start_ts;
    if ($start_ts <= $now_ts && $effective_end >= $now_ts) {
      return true;
    }
  }

  return false;
}

function oc_integration_api_seo_field($data, $key, $default = '') {
  if (!is_array($data)) return $default;
  if (array_key_exists($key, $data) && $data[$key] !== null && $data[$key] !== '') {
    return $data[$key];
  }
  return $default;
}

function oc_integration_api_seo_url($data, $fallback = '') {
  $candidate = trim((string) oc_integration_api_seo_field($data, 'canonicalUrl', ''));
  if ($candidate === '') $candidate = trim((string) oc_integration_api_seo_field($data, 'publicUrl', ''));
  if ($candidate === '') $candidate = trim((string) $fallback);
  return $candidate !== '' ? esc_url_raw($candidate) : '';
}

function oc_integration_api_robots_state($data) {
  $robots_raw = strtolower(trim((string) oc_integration_api_seo_field($data, 'robots', '')));
  $indexable_raw = oc_integration_api_seo_field($data, 'indexable', null);
  $indexable = null;
  if ($indexable_raw !== null && $indexable_raw !== '') {
    $indexable = filter_var($indexable_raw, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
  }

  return [
    'raw' => $robots_raw,
    'has_noindex' => $robots_raw !== '' && strpos($robots_raw, 'noindex') !== false,
    'has_nofollow' => $robots_raw !== '' && strpos($robots_raw, 'nofollow') !== false,
    'indexable' => $indexable,
  ];
}

function oc_integration_apply_last_modified_header($value) {
  $value = trim((string) $value);
  if ($value === '' || headers_sent()) return;
  $ts = strtotime($value);
  if (!$ts) return;
  header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $ts) . ' GMT', true);
}

function oc_integration_print_structured_data($structured_data, $fallback_schema = null) {
  if (is_string($structured_data)) {
    $decoded = json_decode($structured_data, true);
    if (json_last_error() === JSON_ERROR_NONE) {
      $structured_data = $decoded;
    }
  }

  if (is_array($structured_data) && !empty($structured_data)) {
    echo "\n" . '<script type="application/ld+json">' . wp_json_encode($structured_data) . '</script>' . "\n";
    return;
  }

  if (is_array($fallback_schema) && !empty($fallback_schema)) {
    echo "\n" . '<script type="application/ld+json">' . wp_json_encode($fallback_schema) . '</script>' . "\n";
  }
}

function oc_integration_admin_menu_icon() {
  return 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iTGF5ZXJfMSIgZGF0YS1uYW1lPSJMYXllciAxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NzkuOTkgNDc5Ljk5Ij4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjZmZmOwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik00NzQuOTMsMTIzLjY5Yy01LjUxLTYzLjA5LTU1LjU0LTExMy4xMy0xMTguNjMtMTE4LjYzLTc3LjM5LTYuNzUtMTU1LjIyLTYuNzUtMjMyLjYxLDBDNjAuNiwxMC41NywxMC41Niw2MC42LDUuMDYsMTIzLjY5Yy02Ljc1LDc3LjM5LTYuNzUsMTU1LjIyLDAsMjMyLjYxLDUuNTEsNjMuMDksNTUuNTQsMTEzLjEzLDExOC42MywxMTguNjMsNzcuMzksNi43NSwxNTUuMjIsNi43NSwyMzIuNjEsMCw2My4wOS01LjUxLDExMy4xMy01NS41NCwxMTguNjMtMTE4LjYzLDYuNzUtNzcuMzksNi43NS0xNTUuMjIsMC0yMzIuNjFaTTIxMi4zOCw3My40NXYzNi4wMmMtNTQuOTUsNi41MS05OC41MSw1MC4xMS0xMDQuOTQsMTA1LjA5aC0zNi4wMWM2LjcxLTc0Ljc4LDY2LjE5LTEzNC4zMiwxNDAuOTUtMTQxLjExWk0yNDMuNDksMzgzLjMyYy0zNS44MSwwLTY5Ljg3LTEzLjQ5LTk1Ljg5LTM3Ljk5LTI2LTI0LjQ5LTQxLjUtNTcuNjItNDMuNjQtOTMuM2wtLjM4LTYuMzZoMzUuMTdsLjQsNS41NmMzLjk1LDU0LjM2LDQ5Ljc5LDk2Ljk0LDEwNC4zNCw5Ni45NCw1Ny43LDAsMTA0LjY0LTQ4Ljg1LDEwNC42NC0xMDQuNjRzLTQzLjYxLTEwMS42OS05OS4yOC0xMDQuNDhsLTUuNy0uMjl2LTM1LjEyaDBzNi4yNS4yNiw2LjI1LjI2YzM2LjM3LDEuNTEsNzAuMTYsMTYuNjgsOTUuMTMsNDIuNzEsMjQuOTksMjYuMDQsMzguNzUsNjAuNDcsMzguNzUsOTYuOTIsMCw3Ny4wOC02Mi43MSwxMzkuNzktMTM5Ljc5LDEzOS43OVoiLz4KPC9zdmc+';
}

function oc_integration_output_accent_css() {
  if (is_admin()) return;

  $colors = oc_integration_get_color_tokens();
  ?>
  <style id="oc-integration-accent-overrides">
    :root{
      --oc-accent: <?php echo esc_html($colors['base']); ?>;
      --oc-accent-dark: <?php echo esc_html($colors['dark']); ?>;
      --oc-accent-darker: <?php echo esc_html($colors['darker']); ?>;
      --oc-accent-light: <?php echo esc_html($colors['light']); ?>;
      --oc-accent-soft: <?php echo esc_html($colors['soft']); ?>;
      --oc-accent-rgb-10: <?php echo esc_html($colors['rgb_10']); ?>;
      --oc-accent-rgb-24: <?php echo esc_html($colors['rgb_24']); ?>;
      --oc-accent-focus: <?php echo esc_html($colors['focus']); ?>;
    }
    .oc-featured-badge,
    .oc-featured-badge--hero,
    .oc-feature-btn,
    .oc-submit-btn,
    .oc-ticket-btn,
    .oc-eng-action.is-selected,
    .oc-venue-btn:not(.oc-venue-btn--ghost){
      background: var(--oc-accent) !important;
      border-color: var(--oc-accent) !important;
      color: #fff !important;
    }
    .oc-featured-badge,
    .oc-featured-badge--hero,
    .oc-happening-badge,
    .oc-happening-badge--hero,
    .oc-trending-badge,
    .oc-trending-badge--hero,
    .ocmf-trending-badge{
      display: inline-flex !important;
      align-items: center !important;
      gap: 8px !important;
    }
    .oc-featured-badge::before,
    .oc-featured-badge--hero::before{
      content: none !important;
      display: none !important;
    }
    .oc-featured-badge svg,
    .oc-featured-badge--hero svg{
      width: 0.95em;
      height: 0.95em;
      display: block;
      flex: 0 0 auto;
      fill: currentColor;
    }
    .ocfh-ico svg,
    .oc-submit-disclaimer a,
    .oc-ticket-btn:hover,
    .oc-venue-btn--ghost,
    .oc-venue-upcoming .oc-more-head .oc-see-all-btn,
    .oc-see-all-btn,
    .oc-venue-social a,
    .oc-venue-event-item:hover .oc-venue-event-title {
      color: var(--oc-accent) !important;
    }
    .oc-ticket-btn:hover,
    .oc-venue-btn--ghost {
      background: #fff !important;
      border-color: var(--oc-accent) !important;
    }
    .oc-venue-upcoming .oc-more-head .oc-see-all-btn:hover,
    .oc-see-all-btn:hover {
      color: var(--oc-accent-dark) !important;
    }
    .oc-venue-social a{
      border-color: var(--oc-accent-rgb-24) !important;
      background: var(--oc-accent-rgb-10) !important;
      color: var(--oc-accent-dark) !important;
    }
    .oc-venue-gallery-thumb.is-active {
      border-color: var(--oc-accent) !important;
      box-shadow: 0 0 0 2px var(--oc-accent-rgb-24), 0 8px 18px rgba(0,0,0,.25) !important;
    }
    .oc-card-link:focus-visible,
    .ocmf-card-link:focus-visible {
      outline-color: var(--oc-accent-focus) !important;
    }
  </style>
  <?php
}
add_action('wp_head', 'oc_integration_output_accent_css', 999);

function oc_integration_trending_threshold() {
  $threshold = (float) apply_filters('oc_integration_trending_threshold', 25);
  if (!is_finite($threshold)) $threshold = 25;
  return max(0, $threshold);
}

function oc_integration_event_is_trending($score) {
  return (float) $score >= oc_integration_trending_threshold();
}

require_once plugin_dir_path(__FILE__) . 'opencircle-events-basic-slider.php';
require_once plugin_dir_path(__FILE__) . 'opencircle-events-featured-slider.php';
require_once plugin_dir_path(__FILE__) . 'opencircle-front-end-submission-form.php';
require_once plugin_dir_path(__FILE__) . 'opencircle-virtual-event-pages.php';

function oc_events_grid_register_assets() {
  $js_path = plugin_dir_path(__FILE__) . 'oc-events-grid.js';
  $ver = file_exists($js_path) ? filemtime($js_path) : '0.3.2';

  wp_register_script(
    'oc-events-grid',
    plugin_dir_url(__FILE__) . 'oc-events-grid.js',
    [],
    $ver,
    true
  );
}
add_action('wp_enqueue_scripts', 'oc_events_grid_register_assets');

if (!defined('OC_API_BASE')) {
  define('OC_API_BASE', oc_integration_get_api_base());
}

function oc_ads_normalize_api_base() {
  return rtrim((string)OC_API_BASE, '/');
}

function oc_integration_normalize_city_list($raw) {
  if (is_array($raw)) {
    $raw = implode(',', array_map('strval', $raw));
  }

  $parts = preg_split('/\s*,\s*/', (string) $raw);
  if (!is_array($parts)) return [];

  $cities = [];
  foreach ($parts as $part) {
    $city = sanitize_text_field($part);
    if ($city === '') continue;
    $cities[strtolower($city)] = $city;
  }

  return array_values($cities);
}

function oc_ads_cache_key($placement, $city) {
  return 'ocad_' . md5(strtolower(trim((string)$placement)) . '|' . strtolower(trim((string)$city)));
}

function oc_ads_sanitize_wrapper_classes($placement, $extra_class = '') {
  $classes = ['opencircle-ad'];

  $placement_class = sanitize_html_class('opencircle-ad--' . sanitize_title((string)$placement));
  if ($placement_class !== '') {
    $classes[] = $placement_class;
  }

  $extra_parts = preg_split('/\s+/', trim((string)$extra_class));
  if (is_array($extra_parts)) {
    foreach ($extra_parts as $part) {
      $part = sanitize_html_class($part);
      if ($part !== '') $classes[] = $part;
    }
  }

  $classes = array_values(array_unique(array_filter($classes)));
  return implode(' ', $classes);
}

function oc_ads_fetch_ad($placement, $city = '') {
  $placement = trim((string)$placement);
  $city = trim((string)$city);
  if ($placement === '') return null;

  $cache_key = oc_ads_cache_key($placement, $city);
  $cached = get_transient($cache_key);
  if (is_array($cached)) {
    return !empty($cached['found']) && !empty($cached['ad']) && is_array($cached['ad'])
      ? $cached['ad']
      : null;
  }

  $api_base = oc_ads_normalize_api_base();
  if ($api_base === '') return null;

  $url = $api_base . '/ads/serve?placement=' . rawurlencode($placement);
  if ($city !== '') {
    $url .= '&city=' . rawurlencode($city);
  }

  $res = wp_remote_get($url, [
    'timeout' => 12,
    'headers' => ['Accept' => 'application/json'],
  ]);

  if (is_wp_error($res)) {
    return null;
  }

  $code = wp_remote_retrieve_response_code($res);
  if ($code < 200 || $code >= 300) {
    return null;
  }

  $body = wp_remote_retrieve_body($res);
  if (!$body) {
    set_transient($cache_key, ['found' => 0], 120);
    return null;
  }

  $json = json_decode($body, true);
  $ad = $json['data'] ?? null;

  if (!is_array($ad) || empty($ad['imageUrl']) || empty($ad['clickUrl'])) {
    set_transient($cache_key, ['found' => 0], 120);
    return null;
  }

  set_transient($cache_key, [
    'found' => 1,
    'ad'    => $ad,
  ], 120);

  return $ad;
}

function oc_ads_fetch_ad_for_cities($placement, $city = '') {
  $cities = oc_integration_ads_scope_cities();

  if (empty($cities)) {
    return oc_ads_fetch_ad($placement, '');
  }

  foreach ($cities as $request_city) {
    $ad = oc_ads_fetch_ad($placement, $request_city);
    if (is_array($ad) && !empty($ad)) {
      return $ad;
    }
  }

  return null;
}

function oc_ad_shortcode($atts) {
  $atts = shortcode_atts([
    'placement' => '',
    'city'      => '',
    'class'     => '',
    'fallback'  => '',
  ], $atts, 'opencircle_ad');

  $placement = sanitize_text_field($atts['placement']);
  $city = sanitize_text_field($atts['city']);
  $extra_class = sanitize_text_field($atts['class']);
  $fallback = $atts['fallback'];

  if ($placement === '') return '';

  $ad = oc_ads_fetch_ad_for_cities($placement, $city);
  if (!is_array($ad)) {
    return $fallback !== '' ? wp_kses_post($fallback) : '';
  }

  $image_url = esc_url((string)($ad['imageUrl'] ?? ''));
  $alt_text = esc_attr((string)($ad['altText'] ?? ''));
  $click_url = esc_url((string)($ad['clickUrl'] ?? ''));

  if ($image_url === '' || $click_url === '') {
    return $fallback !== '' ? wp_kses_post($fallback) : '';
  }

  $wrapper_class = oc_ads_sanitize_wrapper_classes($placement, $extra_class);

  ob_start();
  ?>
  <div class="<?php echo esc_attr($wrapper_class); ?>">
    <a href="<?php echo esc_url($click_url); ?>" target="_blank" rel="noopener noreferrer sponsored">
      <img src="<?php echo esc_url($image_url); ?>" alt="<?php echo esc_attr($alt_text); ?>" loading="lazy" />
    </a>
  </div>
  <?php
  return ob_get_clean();
}
add_shortcode('opencircle_ad', 'oc_ad_shortcode');

function oc_newsletter_signup_resolve_city($value = '') {
  return sanitize_text_field(oc_integration_newsletter_scope());
}

function oc_newsletter_signup_api_url() {
  $base = oc_integration_get_api_base();
  if ($base === '') return '';
  return trailingslashit($base) . 'newsletter/subscribe';
}

function oc_newsletter_signup_darken_hex($hex, $amount = 36) {
  $color = sanitize_hex_color((string) $hex);
  if (!$color) return '#2f89a7';

  $amount = max(0, min(255, intval($amount)));
  $rgb = [
    hexdec(substr($color, 1, 2)),
    hexdec(substr($color, 3, 2)),
    hexdec(substr($color, 5, 2)),
  ];

  $adjusted = array_map(function($channel) use ($amount) {
    return max(0, min(255, intval($channel) - $amount));
  }, $rgb);

  return sprintf('#%02x%02x%02x', $adjusted[0], $adjusted[1], $adjusted[2]);
}

function oc_newsletter_signup_ajax() {
  if (!check_ajax_referer('oc_newsletter_signup', 'nonce', false)) {
    wp_send_json_error(['message' => 'Your session expired. Please refresh the page and try again.'], 403);
  }

  $honeypot = trim((string) wp_unslash($_POST['company'] ?? ''));
  if ($honeypot !== '') {
    wp_send_json_success(['message' => 'Thanks for signing up. You are on the list.']);
  }

  $email = sanitize_email(wp_unslash($_POST['email'] ?? ''));
  $city = oc_newsletter_signup_resolve_city(wp_unslash($_POST['city'] ?? ''));

  if ($email === '' || !is_email($email)) {
    wp_send_json_error(['message' => 'Please enter a valid email address.'], 400);
  }

  $endpoint = oc_newsletter_signup_api_url();
  if ($endpoint === '') {
    wp_send_json_error(['message' => 'Newsletter signup is not available right now.'], 500);
  }

  $response = wp_remote_post($endpoint, [
    'timeout' => 12,
    'headers' => [
      'Accept' => 'application/json',
    ],
    'body' => [
      'email' => $email,
      'city' => $city,
      'source' => 'wordpress',
    ],
  ]);

  if (is_wp_error($response)) {
    wp_send_json_error(['message' => 'We could not submit your signup right now. Please try again in a moment.'], 502);
  }

  $code = wp_remote_retrieve_response_code($response);
  $body = wp_remote_retrieve_body($response);
  $json = $body ? json_decode($body, true) : null;

  if ($code < 200 || $code >= 300 || !is_array($json) || empty($json['ok'])) {
    $error_key = is_array($json) ? (string) ($json['error'] ?? '') : '';
    $message = $error_key === 'invalid_email'
      ? 'Please enter a valid email address.'
      : 'We could not submit your signup right now. Please try again in a moment.';
    wp_send_json_error(['message' => $message], $code >= 400 ? $code : 500);
  }

  $duplicate = !empty($json['duplicate']);
  $message = $duplicate
    ? 'You are already signed up for this newsletter.'
    : 'Thanks for signing up. You are on the list.';

  wp_send_json_success([
    'message' => $message,
    'duplicate' => $duplicate,
    'city' => $city,
  ]);
}
add_action('wp_ajax_oc_newsletter_signup', 'oc_newsletter_signup_ajax');
add_action('wp_ajax_nopriv_oc_newsletter_signup', 'oc_newsletter_signup_ajax');

function oc_newsletter_signup_shortcode($atts) {
  $atts = shortcode_atts([
    'city' => '',
    'title' => 'Stay in the loop',
    'description' => 'Get local event highlights, updates, and newsletter picks delivered to your inbox.',
    'button' => 'Sign Up',
    'placeholder' => 'Enter your email address',
  ], $atts, 'opencircle_newsletter_signup');

  $city = oc_newsletter_signup_resolve_city($atts['city']);
  $title = sanitize_text_field($atts['title']);
  $description = sanitize_text_field($atts['description']);
  $button = sanitize_text_field($atts['button']);
  $placeholder = sanitize_text_field($atts['placeholder']);
  $uid = 'oc-newsletter-' . wp_generate_uuid4();
  $accent_raw = oc_integration_get_accent_color();
  $accent = esc_attr($accent_raw);
  $accent_dark = esc_attr(oc_newsletter_signup_darken_hex($accent_raw, 36));

  ob_start();
  ?>
  <div id="<?php echo esc_attr($uid); ?>" class="oc-newsletter-signup" data-oc-newsletter-signup>
    <style>
      #<?php echo esc_html($uid); ?>{
        --oc-newsletter-accent: <?php echo $accent; ?>;
        --oc-newsletter-accent-dark: <?php echo $accent_dark; ?>;
        --oc-newsletter-border: rgba(17, 24, 39, 0.08);
        --oc-newsletter-text: #1f2937;
        --oc-newsletter-muted: #5b6472;
        --oc-newsletter-bg: #ffffff;
        background: var(--oc-newsletter-bg);
        border: 1px solid var(--oc-newsletter-border);
        border-radius: 18px;
        padding: 24px;
        box-shadow: 0 16px 36px rgba(15, 23, 42, 0.06);
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        margin: 0 !important;
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-title{
        margin: 0 0 10px;
        font-size: clamp(28px, 3.6vw, 40px);
        line-height: 1.05;
        color: var(--oc-newsletter-text);
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-description{
        margin: 0 0 18px;
        font-size: 17px;
        line-height: 1.6;
        color: var(--oc-newsletter-muted);
        max-width: 58ch;
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-form{
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 16px;
        align-items: end;
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-field{
        display: grid;
        gap: 8px;
        min-width: 0;
      }
      #<?php echo esc_html($uid); ?> label{
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--oc-newsletter-muted);
      }
      #<?php echo esc_html($uid); ?> input[type="email"]{
        width: 100%;
        height: 58px;
        border-radius: 14px;
        border: 1px solid rgba(17, 24, 39, 0.12);
        padding: 0 18px;
        font-size: 16px;
        line-height: 1.2;
        font-family: inherit;
        color: var(--oc-newsletter-text);
        background: #fff;
        box-sizing: border-box;
        appearance: none;
        -webkit-appearance: none;
      }
      #<?php echo esc_html($uid); ?> input[type="email"]:focus{
        outline: none;
        border-color: var(--oc-newsletter-accent);
        box-shadow: 0 0 0 3px rgba(63, 171, 209, 0.18);
      }
      #<?php echo esc_html($uid); ?> input[type="email"]:-webkit-autofill,
      #<?php echo esc_html($uid); ?> input[type="email"]:-webkit-autofill:hover,
      #<?php echo esc_html($uid); ?> input[type="email"]:-webkit-autofill:focus{
        -webkit-text-fill-color: var(--oc-newsletter-text);
        box-shadow: 0 0 0 1000px #fff inset;
        transition: background-color 9999s ease-in-out 0s;
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-button{
        height: 58px;
        min-width: 184px;
        border-radius: 14px;
        border: 0;
        padding: 0 24px;
        background: var(--oc-newsletter-accent);
        color: #fff;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        transition: background-color 0.2s ease, transform 0.2s ease;
        white-space: nowrap;
        margin-top: 0;
        align-self: end;
        justify-self: start;
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-button:hover,
      #<?php echo esc_html($uid); ?> .oc-newsletter-button:focus{
        background: var(--oc-newsletter-accent-dark);
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-button:disabled{
        opacity: 0.65;
        cursor: wait;
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-message{
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 12px;
        font-size: 14px;
        line-height: 1.5;
        display: none;
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-message.is-visible{
        display: block;
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-message.is-success{
        background: rgba(16, 185, 129, 0.12);
        color: #065f46;
        border: 1px solid rgba(16, 185, 129, 0.2);
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-message.is-error{
        background: rgba(239, 68, 68, 0.1);
        color: #991b1b;
        border: 1px solid rgba(239, 68, 68, 0.18);
      }
      #<?php echo esc_html($uid); ?> .oc-newsletter-hp{
        position: absolute !important;
        left: -9999px !important;
        width: 1px !important;
        height: 1px !important;
        overflow: hidden !important;
      }
      @media (max-width: 640px){
        #<?php echo esc_html($uid); ?>{
          padding: 20px;
        }
        #<?php echo esc_html($uid); ?> .oc-newsletter-form{
          grid-template-columns: 1fr;
          gap: 14px;
        }
        #<?php echo esc_html($uid); ?> .oc-newsletter-button{
          width: 100%;
          min-width: 0;
          margin-top: 0;
        }
      }
    </style>

    <h2 class="oc-newsletter-title"><?php echo esc_html($title); ?></h2>
    <p class="oc-newsletter-description"><?php echo esc_html($description); ?></p>

    <form class="oc-newsletter-form" method="post" action="<?php echo esc_url(admin_url('admin-ajax.php')); ?>" novalidate>
      <input type="hidden" name="action" value="oc_newsletter_signup" />
      <input type="hidden" name="nonce" value="<?php echo esc_attr(wp_create_nonce('oc_newsletter_signup')); ?>" />
      <input type="hidden" name="city" value="<?php echo esc_attr($city); ?>" />
      <div class="oc-newsletter-hp" aria-hidden="true">
        <label for="<?php echo esc_attr($uid); ?>-company">Leave this field empty</label>
        <input id="<?php echo esc_attr($uid); ?>-company" type="text" name="company" tabindex="-1" autocomplete="off" />
      </div>
      <div class="oc-newsletter-field">
        <label for="<?php echo esc_attr($uid); ?>-email">Email</label>
        <input id="<?php echo esc_attr($uid); ?>-email" type="email" name="email" placeholder="<?php echo esc_attr($placeholder); ?>" required />
      </div>
      <button type="submit" class="oc-newsletter-button"><?php echo esc_html($button); ?></button>
    </form>

    <div class="oc-newsletter-message" data-oc-newsletter-message aria-live="polite"></div>

    <script>
      (function(){
        var root = document.getElementById(<?php echo wp_json_encode($uid); ?>);
        if (!root || root.dataset.ocNewsletterReady === '1') return;
        root.dataset.ocNewsletterReady = '1';

        var form = root.querySelector('.oc-newsletter-form');
        var button = root.querySelector('.oc-newsletter-button');
        var message = root.querySelector('[data-oc-newsletter-message]');
        var emailField = root.querySelector('input[name="email"]');
        var honeypot = root.querySelector('input[name="company"]');

        function setMessage(type, text) {
          if (!message) return;
          message.className = 'oc-newsletter-message is-visible ' + (type === 'success' ? 'is-success' : 'is-error');
          message.textContent = text || '';
        }

        if (!form) return;
        form.addEventListener('submit', function(event){
          event.preventDefault();
          if (honeypot && honeypot.value) return;

          var email = emailField ? String(emailField.value || '').trim() : '';
          if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            setMessage('error', 'Please enter a valid email address.');
            if (emailField) emailField.focus();
            return;
          }

          if (button) button.disabled = true;
          setMessage('success', 'Submitting...');

          var formData = new FormData(form);
          fetch(form.getAttribute('action'), {
            method: 'POST',
            body: formData,
            credentials: 'same-origin'
          })
          .then(function(response){ return response.json().catch(function(){ return null; }); })
          .then(function(json){
            if (!json || !json.success) {
              var errorText = json && json.data && json.data.message ? json.data.message : 'We could not submit your signup right now. Please try again in a moment.';
              setMessage('error', errorText);
              return;
            }

            var successText = json.data && json.data.message ? json.data.message : 'Thanks for signing up. You are on the list.';
            setMessage('success', successText);
            form.reset();
          })
          .catch(function(){
            setMessage('error', 'We could not submit your signup right now. Please try again in a moment.');
          })
          .finally(function(){
            if (button) button.disabled = false;
          });
        });
      })();
    </script>
  </div>
  <?php
  return ob_get_clean();
}
add_shortcode('opencircle_newsletter_signup', 'oc_newsletter_signup_shortcode');

function oc_jobs_cache_key($city, $limit, $q = '') {
  return 'ocjobs_' . md5(strtolower(trim((string)$city)) . '|' . intval($limit) . '|' . strtolower(trim((string)$q)));
}

function oc_job_single_cache_key($id_or_slug) {
  return 'ocjob_' . md5(strtolower(trim((string)$id_or_slug)));
}

function oc_jobs_fetch_list_for_city($api_base, $city = '', $limit = 20, $q = '') {
  $url = $api_base . '/jobs?limit=' . $limit;
  if ($city !== '') {
    $url .= '&city=' . rawurlencode($city);
  }
  if ($q !== '') {
    $url .= '&q=' . rawurlencode($q);
  }

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
  $jobs = $json['data'] ?? [];
  if (!is_array($jobs)) $jobs = [];

  return array_values(array_filter($jobs, function ($job) {
    return is_array($job);
  }));
}

function oc_jobs_fetch_list($city = '', $limit = 20, $q = '') {
  $city = trim((string)$city);
  $limit = max(1, intval($limit));
  $q = trim((string)$q);

  $cache_key = oc_jobs_cache_key($city, $limit, $q);
  $cached = get_transient($cache_key);
  if (is_array($cached)) return $cached;

  $api_base = oc_ads_normalize_api_base();
  if ($api_base === '') return [];

  $cities = oc_integration_normalize_city_list($city);
  if (empty($cities)) {
    $jobs = oc_jobs_fetch_list_for_city($api_base, '', $limit, $q);
    set_transient($cache_key, $jobs, 120);
    return $jobs;
  }

  $jobs = [];
  $seen = [];
  foreach ($cities as $request_city) {
    $city_jobs = oc_jobs_fetch_list_for_city($api_base, $request_city, $limit, $q);
    foreach ($city_jobs as $job) {
      $key = '';
      if (!empty($job['slug'])) {
        $key = 'slug:' . strtolower((string) $job['slug']);
      } elseif (!empty($job['id'])) {
        $key = 'id:' . (string) $job['id'];
      } else {
        $key = md5(wp_json_encode($job));
      }
      if (isset($seen[$key])) continue;
      $seen[$key] = true;
      $jobs[] = $job;
    }
  }

  set_transient($cache_key, $jobs, 120);
  return $jobs;
}

function oc_jobs_fetch_single($id_or_slug) {
  $id_or_slug = trim((string)$id_or_slug);
  if ($id_or_slug === '') return null;

  $cache_key = oc_job_single_cache_key($id_or_slug);
  $cached = get_transient($cache_key);
  if (is_array($cached)) return $cached;

  $api_base = oc_ads_normalize_api_base();
  if ($api_base === '') return null;

  $url = $api_base . '/jobs/' . rawurlencode($id_or_slug);

  $res = wp_remote_get($url, [
    'timeout' => 12,
    'headers' => ['Accept' => 'application/json'],
  ]);

  if (is_wp_error($res)) return null;

  $code = wp_remote_retrieve_response_code($res);
  if ($code < 200 || $code >= 300) return null;

  $body = wp_remote_retrieve_body($res);
  if (!$body) {
    set_transient($cache_key, [], 120);
    return null;
  }

  $json = json_decode($body, true);
  $job = $json['data'] ?? null;
  if (!is_array($job)) {
    set_transient($cache_key, [], 120);
    return null;
  }

  set_transient($cache_key, $job, 120);
  return $job;
}

function oc_jobs_build_summary($job) {
  $parts = [];

  $company = trim((string)($job['company'] ?? ''));
  $employment = oc_jobs_format_employment_types(oc_jobs_normalize_employment_types($job));
  $salary = trim((string)($job['salaryRange'] ?? ''));
  $location = trim((string)($job['location'] ?? ''));

  if ($company !== '') $parts[] = $company;
  if ($employment !== '') $parts[] = $employment;
  if ($salary !== '') $parts[] = $salary;
  if ($location !== '') $parts[] = $location;

  return implode(' • ', $parts);
}

function oc_jobs_build_excerpt($description) {
  $text = trim(wp_strip_all_tags((string)$description));
  if ($text === '') return '';
  return wp_html_excerpt($text, 180, '…');
}

function oc_jobs_detect_salary_type($job) {
  $explicit = trim((string)($job['salaryType'] ?? ''));
  if ($explicit !== '') return $explicit;

  $salary = strtolower(trim((string)($job['salaryRange'] ?? '')));
  if ($salary === '') return '';

  if (strpos($salary, '/hour') !== false || strpos($salary, ' per hour') !== false || strpos($salary, 'hourly') !== false) {
    return 'Hourly';
  }
  if (strpos($salary, '/year') !== false || strpos($salary, ' per year') !== false || strpos($salary, 'annual') !== false || strpos($salary, 'salary') !== false) {
    return 'Salary';
  }
  if (strpos($salary, '/month') !== false || strpos($salary, ' per month') !== false) {
    return 'Monthly';
  }
  if (strpos($salary, '/week') !== false || strpos($salary, ' per week') !== false) {
    return 'Weekly';
  }

  return '';
}

function oc_jobs_build_pay_bucket($salary_range) {
  $salary_range = trim((string)$salary_range);
  if ($salary_range === '') return '';

  if (!preg_match_all('/\d+(?:\.\d+)?/', $salary_range, $matches) || empty($matches[0])) {
    return '';
  }

  $numbers = array_map('floatval', $matches[0]);
  $amount = max($numbers);

  if ($amount < 20) return 'Under $20';
  if ($amount < 30) return '$20-$29';
  if ($amount < 50) return '$30-$49';
  if ($amount < 75) return '$50-$74';
  if ($amount < 100) return '$75-$99';
  return '$100+';
}

function oc_jobs_normalize_employment_label($value) {
  $value = trim((string)$value);
  if ($value === '') return '';

  $normalized = strtolower($value);
  $normalized = str_replace(['_', '-'], ' ', $normalized);
  $normalized = str_replace('/', ' / ', $normalized);
  $normalized = preg_replace('/\s+/', ' ', $normalized);

  if (in_array($normalized, ['full time', 'fulltime', 'ft'], true)) return 'Full-Time';
  if (in_array($normalized, ['part time', 'parttime', 'pt'], true)) return 'Part-Time';
  if (strpos($normalized, '/') !== false) {
    $parts = preg_split('/\s*\/\s*/', $normalized);
    $labels = [];
    if (is_array($parts)) {
      foreach ($parts as $part) {
        $label = oc_jobs_normalize_employment_label($part);
        if ($label !== '' && !in_array($label, $labels, true)) {
          $labels[] = $label;
        }
      }
    }
    return oc_jobs_format_employment_types($labels);
  }

  return ucwords($value);
}

function oc_jobs_normalize_employment_types($job) {
  if (!is_array($job)) return [];

  $types = [];
  $push_type = function($value) use (&$types) {
    $value = trim((string)$value);
    if ($value === '') return;

    $parts = preg_split('/\s*\/\s*/', str_replace(['|', ','], '/', $value));
    if (!is_array($parts) || empty($parts)) {
      $parts = [$value];
    }

    foreach ($parts as $part) {
      $label = oc_jobs_normalize_employment_label($part);
      if ($label !== '' && !in_array($label, $types, true)) {
        $types[] = $label;
      }
    }
  };

  $list_fields = [
    $job['employmentTypes'] ?? null,
    $job['jobTypes'] ?? null,
    $job['positionTypes'] ?? null,
  ];

  foreach ($list_fields as $list) {
    if (!is_array($list)) continue;
    foreach ($list as $value) {
      $push_type($value);
    }
  }

  $push_type($job['employmentType'] ?? '');

  $flag_map = [
    'isFullTime' => 'Full-Time',
    'fullTime' => 'Full-Time',
    'hiringFullTime' => 'Full-Time',
    'acceptsFullTime' => 'Full-Time',
    'isPartTime' => 'Part-Time',
    'partTime' => 'Part-Time',
    'hiringPartTime' => 'Part-Time',
    'acceptsPartTime' => 'Part-Time',
  ];

  foreach ($flag_map as $field => $label) {
    if (!empty($job[$field])) $push_type($label);
  }

  return $types;
}

function oc_jobs_format_employment_types($types) {
  $types = is_array($types) ? array_values(array_filter(array_map('trim', $types))) : [];
  if (empty($types)) return '';
  return implode(' / ', $types);
}

function oc_jobs_normalize_application_fields($fields) {
  $defaults = [
    'firstName'   => 'required',
    'lastName'    => 'required',
    'email'       => 'required',
    'phone'       => 'optional',
    'coverLetter' => 'optional',
    'resume'      => 'optional',
  ];

  $normalized = [];
  $fields = is_array($fields) ? $fields : [];

  foreach ($defaults as $key => $default) {
    $value = strtolower(trim((string)($fields[$key] ?? $default)));
    if (!in_array($value, ['required', 'optional', 'off'], true)) $value = $default;
    $normalized[$key] = $value;
  }

  return $normalized;
}

function oc_jobs_application_endpoint($job) {
  $application_url = trim((string)($job['applicationUrl'] ?? ''));
  if ($application_url !== '') return $application_url;

  $slug = trim((string)($job['slug'] ?? ''));
  $id = trim((string)($job['id'] ?? ''));
  $key = $slug !== '' ? $slug : $id;
  if ($key === '') return '';

  return oc_ads_normalize_api_base() . '/jobs/' . rawurlencode($key) . '/apply';
}

function oc_jobs_accepts_website_applications($job) {
  $mode = strtolower(trim((string)($job['applicationMode'] ?? '')));
  $flag = !empty($job['acceptsWebsiteApplications']);
  return ($mode === 'website' || $mode === 'both' || $flag);
}

function oc_jobs_normalize_job($job, $apply_html = '') {
  if (!is_array($job)) return null;

  $title = trim((string)($job['title'] ?? ''));
  if ($title === '') return null;

  $description = (string)($job['description'] ?? '');
  $industry = trim((string)($job['industry'] ?? $job['category'] ?? ''));
  $field = trim((string)($job['field'] ?? $job['fieldOfWork'] ?? $job['workField'] ?? $industry));
  $employment_types = oc_jobs_normalize_employment_types($job);
  $employment_type = oc_jobs_format_employment_types($employment_types);
  $salary_type = oc_jobs_detect_salary_type($job);
  $salary_range = trim((string)($job['salaryRange'] ?? ''));
  $slug = trim((string)($job['slug'] ?? ''));
  $id = trim((string)($job['id'] ?? ''));
  $mode = strtolower(trim((string)($job['applicationMode'] ?? 'external')));
  if (!in_array($mode, ['external', 'website', 'both'], true)) $mode = 'external';
  $excerpt_plain = trim((string) oc_integration_api_seo_field($job, 'excerptPlainText', ''));

  return [
    'id' => $id,
    'slug' => $slug,
    'key' => $slug !== '' ? $slug : $id,
    'title' => $title,
    'company' => trim((string)($job['company'] ?? '')),
    'location' => trim((string)($job['location'] ?? '')),
    'employmentType' => $employment_type,
    'employmentTypes' => $employment_types,
    'field' => $field,
    'industry' => $industry,
    'salaryType' => $salary_type,
    'salaryRange' => $salary_range,
    'payBucket' => oc_jobs_build_pay_bucket($salary_range),
    'applyUrl' => esc_url_raw((string)($job['applyUrl'] ?? '')),
    'imageUrl' => esc_url_raw((string)($job['imageUrl'] ?? '')),
    'imageAlt' => trim((string) oc_integration_api_seo_field($job, 'imageAlt', $title)),
    'summary' => oc_jobs_build_summary($job),
    'excerpt' => $excerpt_plain !== '' ? $excerpt_plain : oc_jobs_build_excerpt($description),
    'descriptionHtml' => wp_kses_post(wpautop($description)),
    'updatedAt' => trim((string)($job['updatedAt'] ?? '')),
    'lastModified' => trim((string) oc_integration_api_seo_field($job, 'lastModified', (string)($job['updatedAt'] ?? ''))),
    'status' => trim((string)($job['status'] ?? '')),
    'seoTitle' => trim((string) oc_integration_api_seo_field($job, 'seoTitle', '')),
    'metaDescription' => trim((string) oc_integration_api_seo_field($job, 'metaDescription', '')),
    'focusKeyphrase' => trim((string) oc_integration_api_seo_field($job, 'focusKeyphrase', '')),
    'canonicalUrl' => oc_integration_api_seo_url($job, ''),
    'publicUrl' => esc_url_raw((string) oc_integration_api_seo_field($job, 'publicUrl', '')),
    'robots' => trim((string) oc_integration_api_seo_field($job, 'robots', '')),
    'indexable' => oc_integration_api_seo_field($job, 'indexable', null),
    'structuredData' => oc_integration_api_seo_field($job, 'structuredData', null),
    'applicationMode' => $mode,
    'applicationFields' => oc_jobs_normalize_application_fields($job['applicationFields'] ?? []),
    'acceptsWebsiteApplications' => oc_jobs_accepts_website_applications($job),
    'applicationUrl' => esc_url_raw(oc_jobs_application_endpoint($job)),
    'jsonUrl' => esc_url_raw((string)($job['jsonUrl'] ?? '')),
    'applyHtml' => $apply_html,
  ];
}

function oc_jobs_render_apply_form($job, $instance = '', $external_html = '') {
  if (!is_array($job) || empty($job['acceptsWebsiteApplications'])) return '';

  $fields = is_array($job['applicationFields'] ?? null)
    ? $job['applicationFields']
    : oc_jobs_normalize_application_fields([]);
  $job_key = trim((string)($job['key'] ?? $job['slug'] ?? $job['id'] ?? ''));
  if ($job_key === '') return '';

  $instance = sanitize_html_class((string)$instance);
  $uid_prefix = $instance !== '' ? $instance . '_' : 'oc_job_';
  $resume_accept = '.pdf,.doc,.docx,.rtf,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/rtf,text/plain';
  $company_name = trim((string)($job['company'] ?? ''));
  if ($company_name === '') $company_name = 'The organization hiring';
  $privacy_policy_url = function_exists('get_privacy_policy_url') ? trim((string)get_privacy_policy_url()) : '';

  $render_input = function($field_key, $label, $type = 'text') use ($fields, $uid_prefix) {
    $mode = $fields[$field_key] ?? 'off';
    if ($mode === 'off') return '';
    $required = ($mode === 'required');
    $field_id = $uid_prefix . $field_key;

    ob_start();
    ?>
    <div class="oc-job-apply__field">
      <label for="<?php echo esc_attr($field_id); ?>"><?php echo esc_html($label); ?><?php if ($required): ?> *<?php endif; ?></label>
      <input id="<?php echo esc_attr($field_id); ?>" type="<?php echo esc_attr($type); ?>" name="<?php echo esc_attr($field_key); ?>"<?php echo $required ? ' required' : ''; ?> />
    </div>
    <?php
    return ob_get_clean();
  };

  $cover_letter_mode = $fields['coverLetter'] ?? 'off';
  $resume_mode = $fields['resume'] ?? 'off';

  ob_start();
  ?>
  <div class="oc-job-apply">
    <h3 class="oc-job-modal__section-title">Apply on This Website</h3>
    <form class="oc-job-apply-form" method="post" enctype="multipart/form-data" novalidate>
      <input type="hidden" name="action" value="oc_job_apply" />
      <input type="hidden" name="nonce" value="<?php echo esc_attr(wp_create_nonce('oc_job_apply')); ?>" />
      <input type="hidden" name="job" value="<?php echo esc_attr($job_key); ?>" />
      <input type="hidden" name="source" value="wordpress" />

      <div class="oc-job-apply__grid">
        <?php echo $render_input('firstName', 'First Name'); ?>
        <?php echo $render_input('lastName', 'Last Name'); ?>
        <?php echo $render_input('email', 'Email', 'email'); ?>
        <?php echo $render_input('phone', 'Phone', 'tel'); ?>
      </div>

      <?php if ($cover_letter_mode !== 'off'): ?>
        <div class="oc-job-apply__field">
          <label for="<?php echo esc_attr($uid_prefix . 'coverLetter'); ?>">Cover Letter<?php if ($cover_letter_mode === 'required'): ?> *<?php endif; ?></label>
          <textarea id="<?php echo esc_attr($uid_prefix . 'coverLetter'); ?>" name="coverLetter" rows="6"<?php echo $cover_letter_mode === 'required' ? ' required' : ''; ?>></textarea>
        </div>
      <?php endif; ?>

      <?php if ($resume_mode !== 'off'): ?>
        <div class="oc-job-apply__field">
          <label for="<?php echo esc_attr($uid_prefix . 'resume'); ?>">Resume<?php if ($resume_mode === 'required'): ?> *<?php endif; ?></label>
          <input id="<?php echo esc_attr($uid_prefix . 'resume'); ?>" type="file" name="resume" accept="<?php echo esc_attr($resume_accept); ?>"<?php echo $resume_mode === 'required' ? ' required' : ''; ?> />
        </div>
      <?php endif; ?>

      <div class="oc-job-apply__messages" aria-live="polite"></div>
      <div class="oc-job-apply__separator" aria-hidden="true"></div>
      <div class="oc-job-apply__actions">
        <button type="submit" class="oc-job-modal__apply oc-job-modal__apply--form">Submit Application</button>
        <?php if ($external_html !== ''): ?><div class="oc-job-apply__or">or</div><?php endif; ?>
        <?php echo $external_html; ?>
      </div>
      <div class="oc-job-apply__legal">
        <p>By submitting this application, you consent to <?php echo esc_html($company_name); ?> collecting and reviewing the information and files you provide for employment consideration. Please do not include sensitive personal information not requested in this form. <?php if ($privacy_policy_url !== ''): ?><a href="<?php echo esc_url($privacy_policy_url); ?>" target="_blank" rel="noopener noreferrer">View our Privacy Policy.</a><?php else: ?>View our Privacy Policy.<?php endif; ?></p>
        <p><?php echo esc_html($company_name); ?> is an equal opportunity employer and considers applicants in accordance with applicable law.</p>
      </div>
    </form>
  </div>
  <?php
  return ob_get_clean();
}

function oc_jobs_render_external_apply_button($job) {
  $apply_url = trim((string)($job['applyUrl'] ?? ''));
  if ($apply_url === '') return '';

  ob_start();
  ?>
  <a class="oc-job-modal__apply oc-job-modal__apply--secondary" href="<?php echo esc_url($apply_url); ?>" target="_blank" rel="noopener noreferrer sponsored">Apply Externally</a>
  <?php
  return ob_get_clean();
}

function oc_jobs_track_view_js($job) {
  $job_key = trim((string)($job['slug'] ?? $job['id'] ?? $job['key'] ?? ''));
  $api_base = rtrim((string) oc_ads_normalize_api_base(), '/');
  if ($job_key === '' || $api_base === '') return '';

  return '(function(){var endpoint=' . wp_json_encode($api_base . '/jobs/' . rawurlencode($job_key) . '/view') . ';try{if(navigator.sendBeacon){navigator.sendBeacon(endpoint,new Blob([JSON.stringify({source:"wordpress"})],{type:"application/json"}));return;}fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({source:"wordpress"}),keepalive:true}).catch(function(){});}catch(e){}})();';
}

function oc_jobs_apply_single_seo($job) {
  if (!is_array($job) || empty($job['title'])) return;
  static $applied = false;
  if ($applied) return;
  $applied = true;

  $title = trim((string)($job['title'] ?? ''));
  $document_title = trim((string)($job['seoTitle'] ?? ''));
  if ($document_title === '') $document_title = $title;

  $meta_desc = trim((string)($job['metaDescription'] ?? ''));
  if ($meta_desc === '') $meta_desc = trim((string)($job['excerpt'] ?? ''));
  $canonical_url = trim((string)($job['canonicalUrl'] ?? ''));
  if ($canonical_url === '') $canonical_url = trim((string)($job['publicUrl'] ?? ''));
  $image_url = trim((string)($job['imageUrl'] ?? ''));
  $image_alt = trim((string)($job['imageAlt'] ?? $title));
  $focus_keyphrase = trim((string)($job['focusKeyphrase'] ?? ''));
  $last_modified = trim((string)($job['lastModified'] ?? ''));
  $structured_data = $job['structuredData'] ?? null;
  $robots_state = oc_integration_api_robots_state($job);

  oc_integration_apply_last_modified_header($last_modified);

  add_filter('document_title_parts', function ($parts) use ($document_title) {
    $parts['title'] = $document_title;
    unset($parts['tagline']);
    return $parts;
  }, 999);
  add_filter('pre_get_document_title', function () use ($document_title) { return $document_title; }, 999);
  add_filter('wp_title', function () use ($document_title) { return $document_title; }, 999);
  add_filter('wpseo_title', function () use ($document_title) { return $document_title; }, 999);
  add_filter('wpseo_metadesc', function () use ($meta_desc) { return $meta_desc; }, 999);
  add_filter('rank_math/frontend/title', function () use ($document_title) { return $document_title; }, 999);
  add_filter('rank_math/frontend/description', function () use ($meta_desc) { return $meta_desc; }, 999);
  if ($canonical_url !== '') {
    add_filter('wpseo_canonical', function () use ($canonical_url) { return $canonical_url; }, 999);
    add_filter('rank_math/frontend/canonical', function () use ($canonical_url) { return $canonical_url; }, 999);
  }
  if ($robots_state['raw'] !== '') {
    add_filter('wp_robots', function ($robots) use ($robots_state) {
      if (!is_array($robots)) $robots = [];
      if ($robots_state['indexable'] === false || $robots_state['has_noindex']) $robots['noindex'] = true;
      if ($robots_state['has_nofollow']) $robots['nofollow'] = true;
      return $robots;
    }, 999);
  }

  add_action('wp_head', function () use ($document_title, $meta_desc, $canonical_url, $image_url, $image_alt, $focus_keyphrase, $last_modified, $structured_data, $robots_state, $job) {
    echo '<title>' . esc_html(wp_strip_all_tags($document_title)) . '</title>' . "\n";
    if ($meta_desc !== '') echo '<meta name="description" content="' . esc_attr($meta_desc) . '" />' . "\n";
    if ($focus_keyphrase !== '') echo '<meta name="keywords" content="' . esc_attr($focus_keyphrase) . '" />' . "\n";
    if ($robots_state['raw'] !== '') echo '<meta name="robots" content="' . esc_attr($robots_state['raw']) . '" />' . "\n";
    if ($last_modified !== '') echo '<meta property="article:modified_time" content="' . esc_attr($last_modified) . '" />' . "\n";
    if ($canonical_url !== '') echo '<link rel="canonical" href="' . esc_url($canonical_url) . '" />' . "\n";
    if ($image_url !== '') {
      echo '<meta property="og:image" content="' . esc_url($image_url) . '" />' . "\n";
      if ($image_alt !== '') echo '<meta property="og:image:alt" content="' . esc_attr($image_alt) . '" />' . "\n";
    }
    $fallback_schema = [
      "@context" => "https://schema.org",
      "@type" => "JobPosting",
      "title" => $job['title'] ?? '',
      "description" => wp_strip_all_tags((string)($job['excerpt'] ?? '')),
      "hiringOrganization" => !empty($job['company']) ? ["@type" => "Organization", "name" => $job['company']] : null,
      "jobLocation" => !empty($job['location']) ? ["@type" => "Place", "address" => ["@type" => "PostalAddress", "streetAddress" => $job['location']]] : null,
      "employmentType" => $job['employmentType'] ?? '',
      "url" => $canonical_url !== '' ? $canonical_url : ($job['publicUrl'] ?? ''),
      "datePosted" => $last_modified !== '' ? $last_modified : ($job['updatedAt'] ?? ''),
    ];
    $fallback_schema = array_filter($fallback_schema, function($v){ return $v !== null && $v !== ''; });
    oc_integration_print_structured_data($structured_data, $fallback_schema);
  }, 1);
}

function oc_jobs_render_apply_section($job, $instance = '') {
  if (!is_array($job)) return '';

  $mode = strtolower(trim((string)($job['applicationMode'] ?? 'external')));
  $external_html = ($mode === 'external' || $mode === 'both')
    ? oc_jobs_render_external_apply_button($job)
    : '';
  $website_html = ($mode === 'website' || $mode === 'both' || !empty($job['acceptsWebsiteApplications']))
    ? oc_jobs_render_apply_form($job, $instance, $mode === 'both' ? $external_html : '')
    : '';

  if ($website_html === '' && $external_html === '') return '';

  ob_start();
  ?>
  <div class="oc-job-apply-wrap">
    <?php echo $website_html; ?>
    <?php if ($website_html === ''): ?><?php echo $external_html; ?><?php endif; ?>
  </div>
  <?php
  return ob_get_clean();
}

function oc_jobs_allowed_resume_exts() {
  return ['pdf', 'doc', 'docx', 'rtf', 'txt'];
}

function oc_jobs_validate_application($job, &$values, &$errors) {
  $fields = is_array($job['applicationFields'] ?? null)
    ? $job['applicationFields']
    : oc_jobs_normalize_application_fields([]);

  foreach (['firstName', 'lastName', 'email', 'phone', 'coverLetter'] as $field_key) {
    $mode = $fields[$field_key] ?? 'off';
    $values[$field_key] = $field_key === 'coverLetter'
      ? sanitize_textarea_field($_POST[$field_key] ?? '')
      : sanitize_text_field($_POST[$field_key] ?? '');
    if ($mode === 'required' && $values[$field_key] === '') {
      $errors[] = ucfirst(preg_replace('/([A-Z])/', ' $1', $field_key)) . ' is required.';
    }
  }

  if (($fields['email'] ?? 'off') !== 'off' && $values['email'] !== '' && !is_email($values['email'])) {
    $errors[] = 'Please enter a valid email address.';
  }

  $resume_mode = $fields['resume'] ?? 'off';
  $resume = $_FILES['resume'] ?? null;

  if ($resume_mode === 'required' && (empty($resume['tmp_name']) || !empty($resume['error']))) {
    $errors[] = 'Resume is required.';
  }

  if (!empty($resume['tmp_name']) && empty($resume['error'])) {
    $ext = strtolower(pathinfo((string)($resume['name'] ?? ''), PATHINFO_EXTENSION));
    if ($ext !== '' && !in_array($ext, oc_jobs_allowed_resume_exts(), true)) {
      $errors[] = 'Resume must be a PDF, DOC, DOCX, RTF, or TXT file.';
    }
  }
}

function oc_jobs_build_multipart_payload($fields, $files) {
  $boundary = '--------------------------' . md5((string)microtime(true));
  $eol = "\r\n";
  $body = '';

  foreach ($fields as $name => $value) {
    if ($value === null || $value === '') continue;
    $body .= '--' . $boundary . $eol;
    $body .= 'Content-Disposition: form-data; name="' . $name . '"' . $eol . $eol;
    $body .= $value . $eol;
  }

  foreach ($files as $name => $file) {
    if (empty($file['tmp_name']) || !empty($file['error'])) continue;
    $filename = sanitize_file_name((string)($file['name'] ?? 'upload'));
    $type = trim((string)($file['type'] ?? 'application/octet-stream'));
    $contents = @file_get_contents((string)$file['tmp_name']);
    if ($contents === false) continue;

    $body .= '--' . $boundary . $eol;
    $body .= 'Content-Disposition: form-data; name="' . $name . '"; filename="' . $filename . '"' . $eol;
    $body .= 'Content-Type: ' . $type . $eol . $eol;
    $body .= $contents . $eol;
  }

  $body .= '--' . $boundary . '--' . $eol;

  return [
    'body' => $body,
    'boundary' => $boundary,
  ];
}

function oc_job_apply_ajax() {
  check_ajax_referer('oc_job_apply', 'nonce');

  $job_key = sanitize_text_field($_POST['job'] ?? '');
  if ($job_key === '') {
    wp_send_json_error(['message' => 'Missing job identifier.'], 400);
  }

  $job_raw = oc_jobs_fetch_single($job_key);
  $job = oc_jobs_normalize_job($job_raw);
  if (!$job) {
    wp_send_json_error(['message' => 'Job not found.'], 404);
  }

  if (empty($job['acceptsWebsiteApplications'])) {
    wp_send_json_error(['message' => 'This job is not accepting website applications.'], 400);
  }

  $endpoint = trim((string)($job['applicationUrl'] ?? ''));
  if ($endpoint === '') {
    wp_send_json_error(['message' => 'Application endpoint is not configured.'], 500);
  }

  $values = [];
  $errors = [];
  oc_jobs_validate_application($job, $values, $errors);
  if (!empty($errors)) {
    wp_send_json_error(['message' => implode(' ', $errors)], 400);
  }

  $multipart = oc_jobs_build_multipart_payload([
    'firstName' => $values['firstName'] ?? '',
    'lastName' => $values['lastName'] ?? '',
    'email' => $values['email'] ?? '',
    'phone' => $values['phone'] ?? '',
    'coverLetter' => $values['coverLetter'] ?? '',
    'source' => 'wordpress',
  ], [
    'resumeFile' => $_FILES['resume'] ?? null,
  ]);

  $res = wp_remote_post($endpoint, [
    'timeout' => 20,
    'headers' => [
      'Content-Type' => 'multipart/form-data; boundary=' . $multipart['boundary'],
      'Accept' => 'application/json',
    ],
    'body' => $multipart['body'],
  ]);

  if (is_wp_error($res)) {
    wp_send_json_error(['message' => 'Application request failed: ' . $res->get_error_message()], 500);
  }

  $code = wp_remote_retrieve_response_code($res);
  $body = wp_remote_retrieve_body($res);
  $json = json_decode($body, true);

  if ($code < 200 || $code >= 300) {
    $message = 'Application could not be submitted.';
    if (is_array($json)) {
      if (!empty($json['message'])) $message = (string)$json['message'];
      elseif (!empty($json['error'])) $message = (string)$json['error'];
    }
    wp_send_json_error(['message' => $message], $code ?: 500);
  }

  $message = 'Application submitted successfully.';
  if (is_array($json) && !empty($json['message'])) {
    $message = (string)$json['message'];
  }

  wp_send_json_success(['message' => $message]);
}
add_action('wp_ajax_oc_job_apply', 'oc_job_apply_ajax');
add_action('wp_ajax_nopriv_oc_job_apply', 'oc_job_apply_ajax');

function oc_jobs_shortcode($atts) {
  $atts = shortcode_atts([
    'city'         => oc_integration_jobs_scope(),
    'limit'        => 20,
    'q'            => '',
    'class'        => '',
    'fallback'     => '',
    'title'        => '',
    'description'  => '',
  ], $atts, 'opencircle_jobs');

  $city = sanitize_text_field(oc_integration_jobs_scope());
  $limit = max(1, intval($atts['limit']));
  $q = sanitize_text_field($atts['q']);
  $extra_class = sanitize_text_field($atts['class']);
  $fallback = $atts['fallback'];
  $title = sanitize_text_field($atts['title']);
  $description = sanitize_textarea_field($atts['description']);

  $city_labels = oc_integration_normalize_city_list($city);
  $city_label = !empty($city_labels) ? oc_integration_jobs_scope_label() : oc_integration_jobs_scope_label();
  if ($title === '') {
    $title = sprintf('Local Jobs in %s', $city_label);
  }
  if ($description === '') {
    $description = sprintf('Browse current job openings in %s, including part-time, full-time, and local hiring opportunities from businesses and organizations in the area.', $city_label);
  }

  $jobs = oc_jobs_fetch_list($city, $limit, $q);

  $uid = 'oc_jobs_' . wp_generate_uuid4();
  $wrapper_classes = ['opencircle-jobs'];
  foreach (preg_split('/\s+/', trim((string)$extra_class)) as $part) {
    $part = sanitize_html_class($part);
    if ($part !== '') $wrapper_classes[] = $part;
  }
  $wrapper_class = implode(' ', array_values(array_unique(array_filter($wrapper_classes))));

  $normalized_jobs = [];
  foreach ($jobs as $job) {
    $normalized = oc_jobs_normalize_job($job);
    if (!$normalized) continue;
    $normalized['applyHtml'] = oc_jobs_render_apply_section($normalized, $uid . '_' . count($normalized_jobs));
    $normalized_jobs[] = $normalized;
  }

  $show_empty_state = empty($normalized_jobs);

  ob_start();
  ?>
  <div id="<?php echo esc_attr($uid); ?>" class="<?php echo esc_attr($wrapper_class); ?>">
    <style>
      #<?php echo esc_html($uid); ?> { --oc-job-line: rgba(0,0,0,.10); --oc-job-text: #111827; --oc-job-muted: rgba(17,17,17,.55); --oc-job-accent: #111827; }
      #<?php echo esc_html($uid); ?> .oc-jobs-shell { display:grid; gap:18px; }
      #<?php echo esc_html($uid); ?> .oc-jobs-intro { display:grid; gap:12px; margin:0 0 10px; }
      #<?php echo esc_html($uid); ?> .oc-jobs-page-title { margin:0; color:var(--oc-job-text); font-size:clamp(32px, 4vw, 64px); line-height:1.02; font-weight:700; }
      #<?php echo esc_html($uid); ?> .oc-jobs-page-description { margin:0; max-width:72ch; color:var(--oc-job-muted); font-size:17px; line-height:1.6; }
      #<?php echo esc_html($uid); ?> .oc-jobs-filters { display:grid; grid-template-columns:minmax(0,1.6fr) repeat(5,minmax(140px,1fr)); gap:12px; align-items:end; }
      #<?php echo esc_html($uid); ?> .oc-jobs-filter { display:grid; gap:6px; }
      #<?php echo esc_html($uid); ?> .oc-jobs-filter label,
      #<?php echo esc_html($uid); ?> .oc-job-apply__field label,
      #<?php echo esc_html($uid); ?> .oc-job-modal__meta-label,
      #<?php echo esc_html($uid); ?> .oc-job-modal__eyebrow,
      #<?php echo esc_html($uid); ?> .oc-job-apply__or { font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--oc-job-muted); }
      #<?php echo esc_html($uid); ?> .oc-jobs-search,
      #<?php echo esc_html($uid); ?> .oc-jobs-filter select,
      #<?php echo esc_html($uid); ?> .oc-job-apply__field input,
      #<?php echo esc_html($uid); ?> .oc-job-apply__field textarea { width:100%; padding:12px 14px; border:1px solid var(--oc-job-line); border-radius:8px; background:#fff; font-size:15px; color:var(--oc-job-text); box-sizing:border-box; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field input[type="file"] { padding:10px 12px; }
      #<?php echo esc_html($uid); ?> .oc-jobs-list { display:grid; gap:16px; }
      #<?php echo esc_html($uid); ?> .oc-job-card { width:100%; text-align:left; background:#fff; border:1px solid var(--oc-job-line); border-radius:8px; padding:22px; cursor:pointer; transition:border-color .16s ease, box-shadow .16s ease; }
      #<?php echo esc_html($uid); ?> .oc-job-card:hover,
      #<?php echo esc_html($uid); ?> .oc-job-card:focus-visible { border-color:rgba(0,0,0,.22); box-shadow:0 12px 28px rgba(0,0,0,.05); outline:none; }
      #<?php echo esc_html($uid); ?> .oc-job-image { width:100%; height:220px; object-fit:cover; border-radius:8px; margin:0 0 16px; display:block; }
      #<?php echo esc_html($uid); ?> .oc-job-title { margin:0 0 10px; color:var(--oc-job-accent); font-size:1.25rem; line-height:1.15; font-weight:600; }
      #<?php echo esc_html($uid); ?> .oc-job-summary { margin:0; color:var(--oc-job-text); font-size:1rem; line-height:1.35; }
      #<?php echo esc_html($uid); ?> .oc-job-tags { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 0; }
      #<?php echo esc_html($uid); ?> .oc-job-tag { display:inline-flex; align-items:center; padding:6px 10px; border-radius:999px; border:1px solid rgba(0,0,0,.08); background:#fff; color:#666; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; }
      #<?php echo esc_html($uid); ?> .oc-job-excerpt { margin:16px 0 0; color:var(--oc-job-muted); line-height:1.55; }
      #<?php echo esc_html($uid); ?> .oc-jobs-empty { margin:0; padding:16px; border:1px solid var(--oc-job-line); border-radius:8px; color:var(--oc-job-muted); background:#fff; }
      #<?php echo esc_html($uid); ?> .oc-job-modal[hidden] { display:none; }
      #<?php echo esc_html($uid); ?> .oc-job-modal { position:fixed; inset:0; z-index:999999; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__backdrop { position:absolute; inset:0; background:rgba(0,0,0,.78); }
      #<?php echo esc_html($uid); ?> .oc-job-modal__dialog { position:relative; z-index:1; width:min(920px, calc(100vw - 32px)); max-height:calc(100vh - 32px); margin:16px auto; background:#fff; border-radius:10px; overflow:hidden; display:grid; grid-template-rows:auto 1fr; box-shadow:0 20px 60px rgba(0,0,0,.45); }
      #<?php echo esc_html($uid); ?> .oc-job-modal__head { display:flex; justify-content:space-between; gap:18px; align-items:start; padding:22px 24px 18px; border-bottom:1px solid var(--oc-job-line); }
      #<?php echo esc_html($uid); ?> .oc-job-modal__eyebrow { margin:0 0 10px; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__title { margin:0 0 8px; color:var(--oc-job-text); font-size:2rem; line-height:1.1; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__meta { margin:0; color:var(--oc-job-muted); line-height:1.6; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__close { border:0; background:rgba(255,255,255,.92); color:#111; border-radius:999px; width:40px; height:40px; font-size:24px; line-height:1; cursor:pointer; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__body { overflow:auto; padding:24px; background:#fff; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__image { display:none; width:100%; max-height:260px; object-fit:cover; border-radius:14px; margin-bottom:18px; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__meta-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:32px; margin:0 0 18px; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__meta-value { color:var(--oc-job-text); font-size:1rem; line-height:1.3; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__divider { border:0; border-top:1px solid var(--oc-job-line); margin:18px 0 28px; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__section-title { margin:0 0 14px; font-size:1.25rem; line-height:1.15; font-weight:600; color:var(--oc-job-text); }
      #<?php echo esc_html($uid); ?> .oc-job-modal__content { color:var(--oc-job-text); line-height:1.7; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__content > *:first-child { margin-top:0; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__content > *:last-child { margin-bottom:0; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__apply { display:inline-flex; align-items:center; justify-content:center; min-height:50px; padding:12px 18px; border-radius:8px; background:#111; color:#fff; text-decoration:none; font-weight:600; border:0; cursor:pointer; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__apply--secondary { background:#fff; color:#111; border:1px solid rgba(0,0,0,.18); }
      #<?php echo esc_html($uid); ?> .oc-job-apply-wrap { margin-top:26px; display:block; width:100%; }
      #<?php echo esc_html($uid); ?> .oc-job-apply { width:100%; max-width:none; min-width:0; }
      #<?php echo esc_html($uid); ?> .oc-job-apply-form { display:grid; gap:16px; width:100%; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__separator { height:1px; background:var(--oc-job-line); margin:4px 0 0; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__actions { display:flex; align-items:center; justify-content:flex-start; gap:14px; flex-wrap:wrap; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__or { margin:0; align-self:center; flex:0 0 auto; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__legal { margin-top:4px; color:var(--oc-job-muted); font-size:.9rem; line-height:1.6; max-width:78ch; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__legal p { margin:0 0 10px; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__legal p:last-child { margin-bottom:0; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__legal a { color:inherit; text-decoration:underline; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px 24px; align-items:start; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field { display:grid; align-content:start; gap:8px; margin:0; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field label { display:block; margin:0; line-height:1.1; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field textarea { min-height:220px; resize:vertical; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__messages { margin:0; font-size:.95rem; line-height:1.5; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__messages.is-error { color:#b42318; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__messages.is-success { color:#067647; }
      @media (max-width:768px) {
        #<?php echo esc_html($uid); ?> .oc-jobs-filters,
        #<?php echo esc_html($uid); ?> .oc-job-modal__meta-grid,
        #<?php echo esc_html($uid); ?> .oc-job-apply__grid { grid-template-columns:1fr; }
        #<?php echo esc_html($uid); ?> .oc-job-modal__dialog { width:calc(100vw - 20px); max-height:calc(100vh - 20px); margin:10px auto; }
        #<?php echo esc_html($uid); ?> .oc-job-modal__head,
        #<?php echo esc_html($uid); ?> .oc-job-modal__body { padding:18px; }
        #<?php echo esc_html($uid); ?> .oc-job-modal__title { font-size:1.5rem; }
        #<?php echo esc_html($uid); ?> .oc-job-apply__actions { align-items:stretch; }
      }
    </style>
    <div class="oc-jobs-shell">
      <div class="oc-jobs-intro">
        <h2 class="oc-jobs-page-title"><?php echo esc_html($title); ?></h2>
        <p class="oc-jobs-page-description"><?php echo esc_html($description); ?></p>
      </div>
      <div class="oc-jobs-filters">
        <div class="oc-jobs-filter"><label for="<?php echo esc_attr($uid); ?>_search">Search</label><input id="<?php echo esc_attr($uid); ?>_search" type="search" class="oc-jobs-search" placeholder="Search job titles, companies, or keywords..." aria-label="Search job listings" value="<?php echo esc_attr($q); ?>" /></div>
        <div class="oc-jobs-filter"><label for="<?php echo esc_attr($uid); ?>_type">Job Type</label><select id="<?php echo esc_attr($uid); ?>_type" class="oc-jobs-type-filter"><option value="">All job types</option></select></div>
        <div class="oc-jobs-filter"><label for="<?php echo esc_attr($uid); ?>_industry">Industry</label><select id="<?php echo esc_attr($uid); ?>_industry" class="oc-jobs-industry-filter"><option value="">All industries</option></select></div>
        <div class="oc-jobs-filter"><label for="<?php echo esc_attr($uid); ?>_field">Field</label><select id="<?php echo esc_attr($uid); ?>_field" class="oc-jobs-field-filter"><option value="">All fields</option></select></div>
        <div class="oc-jobs-filter"><label for="<?php echo esc_attr($uid); ?>_pay">Pay Range</label><select id="<?php echo esc_attr($uid); ?>_pay" class="oc-jobs-pay-filter"><option value="">All pay ranges</option></select></div>
        <div class="oc-jobs-filter"><label for="<?php echo esc_attr($uid); ?>_salary_type">Salary Type</label><select id="<?php echo esc_attr($uid); ?>_salary_type" class="oc-jobs-salary-type-filter"><option value="">All salary types</option></select></div>
      </div>
      <div class="oc-jobs-list" role="list">
        <?php foreach ($normalized_jobs as $index => $job): ?>
          <button type="button" class="oc-job-card" data-oc-job-open="<?php echo esc_attr($index); ?>" role="listitem">
            <?php if ($job['imageUrl'] !== ''): ?><img class="oc-job-image" src="<?php echo esc_url($job['imageUrl']); ?>" alt="<?php echo esc_attr($job['imageAlt'] !== '' ? $job['imageAlt'] : $job['title']); ?>" loading="lazy" /><?php endif; ?>
            <h3 class="oc-job-title"><?php echo esc_html($job['title']); ?></h3>
            <?php if ($job['summary'] !== ''): ?><p class="oc-job-summary"><?php echo esc_html($job['summary']); ?></p><?php endif; ?>
            <?php if ($job['employmentType'] !== '' || $job['field'] !== '' || $job['industry'] !== '' || $job['salaryType'] !== '' || $job['payBucket'] !== ''): ?>
              <div class="oc-job-tags">
                <?php if ($job['employmentType'] !== ''): ?>
                  <span class="oc-job-tag"><?php echo esc_html($job['employmentType']); ?></span>
                <?php endif; ?>
                <?php if ($job['field'] !== ''): ?><span class="oc-job-tag"><?php echo esc_html($job['field']); ?></span><?php endif; ?>
                <?php if ($job['industry'] !== ''): ?><span class="oc-job-tag"><?php echo esc_html($job['industry']); ?></span><?php endif; ?>
                <?php if ($job['salaryType'] !== ''): ?><span class="oc-job-tag"><?php echo esc_html($job['salaryType']); ?></span><?php endif; ?>
                <?php if ($job['payBucket'] !== ''): ?><span class="oc-job-tag"><?php echo esc_html($job['payBucket']); ?></span><?php endif; ?>
              </div>
            <?php endif; ?>
            <?php if ($job['excerpt'] !== ''): ?><p class="oc-job-excerpt"><?php echo esc_html($job['excerpt']); ?></p><?php endif; ?>
          </button>
        <?php endforeach; ?>
      </div>
      <p class="oc-jobs-empty"<?php echo $show_empty_state ? '' : ' hidden'; ?>>No job listings are available right now.</p>
    </div>
    <div class="oc-job-modal" hidden aria-hidden="true">
      <div class="oc-job-modal__backdrop" data-oc-job-close></div>
      <div class="oc-job-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="<?php echo esc_attr($uid); ?>_title">
        <div class="oc-job-modal__head">
          <div>
            <p class="oc-job-modal__eyebrow">Job Posting</p>
            <h2 id="<?php echo esc_attr($uid); ?>_title" class="oc-job-modal__title"></h2>
            <p class="oc-job-modal__meta"></p>
          </div>
          <button type="button" class="oc-job-modal__close" aria-label="Close job details" data-oc-job-close>&times;</button>
        </div>
        <div class="oc-job-modal__body">
          <img class="oc-job-modal__image" alt="" />
          <div class="oc-job-modal__meta-grid">
            <div><div class="oc-job-modal__meta-label">Company</div><div class="oc-job-modal__meta-value" data-oc-job-company></div></div>
            <div><div class="oc-job-modal__meta-label">Job Type</div><div class="oc-job-modal__meta-value" data-oc-job-type></div></div>
            <div><div class="oc-job-modal__meta-label">Pay</div><div class="oc-job-modal__meta-value" data-oc-job-pay></div></div>
          </div>
          <hr class="oc-job-modal__divider" />
          <h3 class="oc-job-modal__section-title">Job Description</h3>
          <div class="oc-job-modal__content"></div>
          <div class="oc-job-modal__actions"></div>
        </div>
      </div>
    </div>
    <script type="application/json" class="oc-jobs-data"><?php echo wp_json_encode($normalized_jobs); ?></script>
    <script>
      (function () {
        var root = document.getElementById(<?php echo wp_json_encode($uid); ?>);
        if (!root) return;
        var dataEl = root.querySelector('.oc-jobs-data');
        if (!dataEl) return;
        var jobs = [];
        try { jobs = JSON.parse(dataEl.textContent || '[]'); } catch (e) { jobs = []; }
        if (!Array.isArray(jobs) || !jobs.length) return;

        var search = root.querySelector('.oc-jobs-search');
        var typeFilter = root.querySelector('.oc-jobs-type-filter');
        var industryFilter = root.querySelector('.oc-jobs-industry-filter');
        var fieldFilter = root.querySelector('.oc-jobs-field-filter');
        var payFilter = root.querySelector('.oc-jobs-pay-filter');
        var salaryTypeFilter = root.querySelector('.oc-jobs-salary-type-filter');
        var cards = Array.prototype.slice.call(root.querySelectorAll('[data-oc-job-open]'));
        var empty = root.querySelector('.oc-jobs-empty');
        var modal = root.querySelector('.oc-job-modal');
        var titleEl = root.querySelector('.oc-job-modal__title');
        var metaEl = root.querySelector('.oc-job-modal__meta');
        var contentEl = root.querySelector('.oc-job-modal__content');
        var actionsEl = root.querySelector('.oc-job-modal__actions');
        var imageEl = root.querySelector('.oc-job-modal__image');
        var companyEl = root.querySelector('[data-oc-job-company]');
        var typeEl = root.querySelector('[data-oc-job-type]');
        var payEl = root.querySelector('[data-oc-job-pay]');
        var lastTrigger = null;

        function fillSelect(select, values, emptyLabel) {
          if (!select) return;
          var current = select.value || '';
          var unique = [];
          values.forEach(function (value) {
            var normalized = String(value || '').trim();
            if (!normalized) return;
            if (unique.indexOf(normalized) === -1) unique.push(normalized);
          });
          unique.sort(function (a, b) { return a.localeCompare(b); });
          select.innerHTML = '';
          var baseOpt = document.createElement('option');
          baseOpt.value = '';
          baseOpt.textContent = emptyLabel;
          select.appendChild(baseOpt);
          unique.forEach(function (value) {
            var opt = document.createElement('option');
            opt.value = value;
            opt.textContent = value;
            select.appendChild(opt);
          });
          if (current) {
            if (unique.indexOf(current) !== -1) select.value = current;
          }
          var wrap = select.closest('.oc-jobs-filter');
          if (wrap) wrap.hidden = unique.length === 0;
        }

        fillSelect(typeFilter, jobs.reduce(function (all, job) {
          var values = Array.isArray(job.employmentTypes)
            ? (job.employmentTypes.length ? job.employmentTypes : [])
            : [job.employmentType || ''];
          return all.concat(values);
        }, []), 'All job types');
        fillSelect(industryFilter, jobs.map(function (job) { return job.industry || ''; }), 'All industries');
        fillSelect(fieldFilter, jobs.map(function (job) { return job.field || ''; }), 'All fields');
        fillSelect(payFilter, jobs.map(function (job) { return job.payBucket || ''; }), 'All pay ranges');
        fillSelect(salaryTypeFilter, jobs.map(function (job) { return job.salaryType || ''; }), 'All salary types');

        function trackJobView(job) {
          var jobRef = job || {};
          var key = String(jobRef.key || jobRef.slug || jobRef.id || '').trim();
          if (!key) return;
          var endpoint = <?php echo wp_json_encode(rtrim((string) OC_API_BASE, '/') . '/jobs/'); ?> + encodeURIComponent(key) + '/view';
          try {
            if (navigator.sendBeacon) {
              navigator.sendBeacon(endpoint, new Blob([JSON.stringify({ source: 'wordpress' })], { type: 'application/json' }));
              return;
            }
            fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source: 'wordpress' }),
              keepalive: true
            }).catch(function () {});
          } catch (e) {}
        }

        function openModal(index, trigger) {
          var job = jobs[index];
          if (!job || !modal) return;
          lastTrigger = trigger || null;
          trackJobView(job);
          if (titleEl) titleEl.textContent = job.title || '';
          if (metaEl) metaEl.textContent = job.summary || '';
          if (companyEl) companyEl.textContent = job.company || 'Not listed';
          if (typeEl) typeEl.textContent = job.employmentType || 'Not listed';
          if (payEl) payEl.textContent = job.salaryRange || job.salaryType || 'Not listed';
          if (contentEl) contentEl.innerHTML = job.descriptionHtml || '<p></p>';
          if (actionsEl) actionsEl.innerHTML = job.applyHtml || '';
          if (imageEl) {
            if (job.imageUrl) {
              imageEl.src = job.imageUrl;
              imageEl.alt = job.imageAlt || job.title || '';
              imageEl.style.display = 'block';
            } else {
              imageEl.removeAttribute('src');
              imageEl.alt = '';
              imageEl.style.display = 'none';
            }
          }
          modal.hidden = false;
          modal.setAttribute('aria-hidden', 'false');
          document.body.style.overflow = 'hidden';
        }

        function closeModal() {
          if (!modal) return;
          modal.hidden = true;
          modal.setAttribute('aria-hidden', 'true');
          document.body.style.overflow = '';
          if (lastTrigger) {
            if (typeof lastTrigger.focus === 'function') lastTrigger.focus();
          }
        }

        cards.forEach(function (card) {
          card.addEventListener('click', function () {
            openModal(card.getAttribute('data-oc-job-open'), card);
          });
        });
        root.querySelectorAll('[data-oc-job-close]').forEach(function (el) { el.addEventListener('click', closeModal); });
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') {
            if (modal) {
              if (!modal.hidden) closeModal();
            }
          }
        });

        function applyFilters() {
          var qv = ((search ? search.value : '') || '').trim().toLowerCase();
          var typeValue = ((typeFilter ? typeFilter.value : '') || '').toLowerCase();
          var industryValue = ((industryFilter ? industryFilter.value : '') || '').toLowerCase();
          var fieldValue = ((fieldFilter ? fieldFilter.value : '') || '').toLowerCase();
          var payValue = ((payFilter ? payFilter.value : '') || '').toLowerCase();
          var salaryTypeValue = ((salaryTypeFilter ? salaryTypeFilter.value : '') || '').toLowerCase();
          var visible = 0;

          cards.forEach(function (card) {
            var index = Number(card.getAttribute('data-oc-job-open'));
            var job = jobs[index] || {};
            var jobTypes = Array.isArray(job.employmentTypes)
              ? (job.employmentTypes.length ? job.employmentTypes.join(' ') : '')
              : (job.employmentType || '');
            var haystack = [job.title || '', job.company || '', job.location || '', jobTypes, job.field || '', job.industry || '', job.salaryType || '', job.salaryRange || '', job.payBucket || '', job.summary || '', job.excerpt || ''].join(' ').toLowerCase();
            var normalizedTypes = Array.isArray(job.employmentTypes)
              ? (job.employmentTypes.length ? job.employmentTypes : [])
              : [job.employmentType || ''];
            var typeMatches = !typeValue || normalizedTypes.some(function (value) {
              return String(value || '').toLowerCase() === typeValue;
            });
            var show = (!qv || haystack.indexOf(qv) !== -1);
            if (show) show = !!typeMatches;
            if (show) {
              if (industryValue) show = String(job.industry || '').toLowerCase() === industryValue;
            }
            if (show) {
              if (fieldValue) show = String(job.field || '').toLowerCase() === fieldValue;
            }
            if (show) {
              if (payValue) show = String(job.payBucket || '').toLowerCase() === payValue;
            }
            if (show) {
              if (salaryTypeValue) show = String(job.salaryType || '').toLowerCase() === salaryTypeValue;
            }
            card.hidden = !show;
            if (show) visible++;
          });

          if (empty) empty.hidden = visible > 0;
        }

        root.addEventListener('submit', function (event) {
          var form = event.target.closest('.oc-job-apply-form');
          if (!form) return;
          event.preventDefault();
          var msg = form.querySelector('.oc-job-apply__messages');
          var submitBtn = form.querySelector('button[type="submit"]');
          if (msg) { msg.className = 'oc-job-apply__messages'; msg.textContent = ''; }
          if (submitBtn) submitBtn.disabled = true;
          fetch(<?php echo wp_json_encode(admin_url('admin-ajax.php')); ?>, {
            method: 'POST',
            body: new FormData(form),
            credentials: 'same-origin'
          }).then(function (res) { return res.json(); }).then(function (json) {
            if (json) {
              if (json.success) {
                var successMessage = 'Application submitted successfully.';
                if (json.data) {
                  if (json.data.message) successMessage = json.data.message;
                }
                if (msg) { msg.className = 'oc-job-apply__messages is-success'; msg.textContent = successMessage; }
                form.reset();
                return;
              }
            }
            var errorMessage = 'Application could not be submitted.';
            if (json) {
              if (json.data) {
                if (json.data.message) errorMessage = json.data.message;
              }
            }
            if (msg) { msg.className = 'oc-job-apply__messages is-error'; msg.textContent = errorMessage; }
          }).catch(function () {
            if (msg) { msg.className = 'oc-job-apply__messages is-error'; msg.textContent = 'Application could not be submitted.'; }
          }).finally(function () {
            if (submitBtn) submitBtn.disabled = false;
          });
        });

        if (search) search.addEventListener('input', applyFilters);
        if (typeFilter) typeFilter.addEventListener('change', applyFilters);
        if (industryFilter) industryFilter.addEventListener('change', applyFilters);
        if (fieldFilter) fieldFilter.addEventListener('change', applyFilters);
        if (payFilter) payFilter.addEventListener('change', applyFilters);
        if (salaryTypeFilter) salaryTypeFilter.addEventListener('change', applyFilters);
        applyFilters();
      })();
    </script>
  </div>
  <?php
  return ob_get_clean();
}
function oc_job_shortcode($atts) {
  $atts = shortcode_atts([
    'slug' => '',
    'id' => '',
    'class' => '',
    'fallback' => '',
  ], $atts, 'opencircle_job');

  $slug = sanitize_text_field($atts['slug']);
  $id = sanitize_text_field($atts['id']);
  $extra_class = sanitize_text_field($atts['class']);
  $fallback = $atts['fallback'];
  $key = $slug !== '' ? $slug : $id;
  if ($key === '') return '';

  $job = oc_jobs_normalize_job(oc_jobs_fetch_single($key));
  if (!$job) return $fallback !== '' ? wp_kses_post($fallback) : '';
  oc_jobs_apply_single_seo($job);

  $uid = 'oc_job_single_' . wp_generate_uuid4();
  $wrapper_classes = ['opencircle-job-single'];
  foreach (preg_split('/\s+/', trim((string)$extra_class)) as $part) {
    $part = sanitize_html_class($part);
    if ($part !== '') $wrapper_classes[] = $part;
  }
  $wrapper_class = implode(' ', array_values(array_unique(array_filter($wrapper_classes))));
  $apply_html = oc_jobs_render_apply_section($job, $uid);

  ob_start();
  ?>
  <div id="<?php echo esc_attr($uid); ?>" class="<?php echo esc_attr($wrapper_class); ?>">
    <style>
      #<?php echo esc_html($uid); ?> { color:#111827; }
      #<?php echo esc_html($uid); ?> .oc-job-single__hero img { width:100%; display:block; border-radius:8px; margin-bottom:18px; }
      #<?php echo esc_html($uid); ?> .oc-job-single__title { margin:0 0 12px; font-size:2rem; line-height:1.1; font-weight:600; }
      #<?php echo esc_html($uid); ?> .oc-job-single__summary { margin:0 0 20px; color:rgba(17,17,17,.55); }
      #<?php echo esc_html($uid); ?> .oc-job-single__meta,
      #<?php echo esc_html($uid); ?> .oc-job-apply__grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:32px; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
      #<?php echo esc_html($uid); ?> .oc-job-single__meta { margin:0 0 18px; }
      #<?php echo esc_html($uid); ?> .oc-job-single__label,
      #<?php echo esc_html($uid); ?> .oc-job-apply__field label,
      #<?php echo esc_html($uid); ?> .oc-job-apply__or { text-transform:uppercase; letter-spacing:.08em; font-weight:600; font-size:11px; color:rgba(17,17,17,.55); }
      #<?php echo esc_html($uid); ?> .oc-job-single__label { margin-bottom:10px; }
      #<?php echo esc_html($uid); ?> .oc-job-single__value { font-size:1rem; line-height:1.3; }
      #<?php echo esc_html($uid); ?> .oc-job-single__divider { border:0; border-top:1px solid rgba(0,0,0,.10); margin:18px 0 28px; }
      #<?php echo esc_html($uid); ?> .oc-job-single__section { margin:0 0 14px; font-size:1.25rem; line-height:1.15; font-weight:600; }
      #<?php echo esc_html($uid); ?> .oc-job-single__content { line-height:1.7; }
      #<?php echo esc_html($uid); ?> .oc-job-apply-wrap { margin-top:26px; display:block; width:100%; }
      #<?php echo esc_html($uid); ?> .oc-job-apply { width:100%; max-width:none; min-width:0; }
      #<?php echo esc_html($uid); ?> .oc-job-apply-form { display:grid; gap:16px; width:100%; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__separator { height:1px; background:rgba(0,0,0,.10); margin:4px 0 0; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__actions { display:flex; align-items:center; justify-content:flex-start; gap:14px; flex-wrap:wrap; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__or { margin:0; align-self:center; flex:0 0 auto; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__legal { margin-top:4px; color:rgba(17,17,17,.55); font-size:.9rem; line-height:1.6; max-width:78ch; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__legal p { margin:0 0 10px; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__legal p:last-child { margin-bottom:0; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__legal a { color:inherit; text-decoration:underline; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field { display:grid; align-content:start; gap:8px; margin:0; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field label { display:block; margin:0; line-height:1.1; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field input,
      #<?php echo esc_html($uid); ?> .oc-job-apply__field textarea { width:100%; border:1px solid rgba(0,0,0,.10); border-radius:8px; background:#fff; color:#111827; padding:12px 14px; font-size:15px; box-sizing:border-box; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field textarea { min-height:220px; resize:vertical; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__field input[type="file"] { padding:10px 12px; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__messages { margin:0; font-size:.95rem; line-height:1.5; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__messages.is-error { color:#b42318; }
      #<?php echo esc_html($uid); ?> .oc-job-apply__messages.is-success { color:#067647; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__apply { display:inline-flex; align-items:center; justify-content:center; min-height:50px; padding:12px 18px; border-radius:8px; background:#111; color:#fff; text-decoration:none; font-weight:600; border:0; cursor:pointer; }
      #<?php echo esc_html($uid); ?> .oc-job-modal__apply--secondary { background:#fff; color:#111; border:1px solid rgba(0,0,0,.18); }
      @media (max-width:768px){
        #<?php echo esc_html($uid); ?> .oc-job-single__meta,
        #<?php echo esc_html($uid); ?> .oc-job-apply__grid { grid-template-columns:1fr; gap:18px; }
        #<?php echo esc_html($uid); ?> .oc-job-single__title { font-size:1.5rem; }
        #<?php echo esc_html($uid); ?> .oc-job-apply__actions { align-items:stretch; }
      }
    </style>
    <div class="oc-job-single__hero"><?php if ($job['imageUrl'] !== ''): ?><img src="<?php echo esc_url($job['imageUrl']); ?>" alt="<?php echo esc_attr($job['imageAlt'] !== '' ? $job['imageAlt'] : $job['title']); ?>" loading="lazy" /><?php endif; ?></div>
    <h1 class="oc-job-single__title"><?php echo esc_html($job['title']); ?></h1>
    <?php if ($job['summary'] !== ''): ?><p class="oc-job-single__summary"><?php echo esc_html($job['summary']); ?></p><?php endif; ?>
    <div class="oc-job-single__meta">
      <div><div class="oc-job-single__label">Company</div><div class="oc-job-single__value"><?php echo esc_html($job['company'] !== '' ? $job['company'] : 'Not listed'); ?></div></div>
      <div><div class="oc-job-single__label">Job Type</div><div class="oc-job-single__value"><?php echo esc_html($job['employmentType'] !== '' ? $job['employmentType'] : 'Not listed'); ?></div></div>
      <div><div class="oc-job-single__label">Pay</div><div class="oc-job-single__value"><?php echo esc_html($job['salaryRange'] !== '' ? $job['salaryRange'] : ($job['salaryType'] !== '' ? $job['salaryType'] : 'Not listed')); ?></div></div>
    </div>
    <hr class="oc-job-single__divider" />
    <h2 class="oc-job-single__section">Job Description</h2>
    <div class="oc-job-single__content"><?php echo $job['descriptionHtml']; ?></div>
    <?php echo $apply_html; ?>
    <script>
      (function () {
        var root = document.getElementById(<?php echo wp_json_encode($uid); ?>);
        if (!root) return;
        <?php echo oc_jobs_track_view_js($job); ?>
        root.addEventListener('submit', function (event) {
          var form = event.target.closest('.oc-job-apply-form');
          if (!form) return;
          event.preventDefault();
          var msg = form.querySelector('.oc-job-apply__messages');
          var submitBtn = form.querySelector('button[type="submit"]');
          if (msg) { msg.className = 'oc-job-apply__messages'; msg.textContent = ''; }
          if (submitBtn) submitBtn.disabled = true;
          fetch(<?php echo wp_json_encode(admin_url('admin-ajax.php')); ?>, {
            method: 'POST',
            body: new FormData(form),
            credentials: 'same-origin'
          }).then(function (res) { return res.json(); }).then(function (json) {
            if (json) {
              if (json.success) {
                var successMessage = 'Application submitted successfully.';
                if (json.data) {
                  if (json.data.message) successMessage = json.data.message;
                }
                if (msg) { msg.className = 'oc-job-apply__messages is-success'; msg.textContent = successMessage; }
                form.reset();
                return;
              }
            }
            var errorMessage = 'Application could not be submitted.';
            if (json) {
              if (json.data) {
                if (json.data.message) errorMessage = json.data.message;
              }
            }
            if (msg) { msg.className = 'oc-job-apply__messages is-error'; msg.textContent = errorMessage; }
          }).catch(function () {
            if (msg) { msg.className = 'oc-job-apply__messages is-error'; msg.textContent = 'Application could not be submitted.'; }
          }).finally(function () {
            if (submitBtn) submitBtn.disabled = false;
          });
        });
      })();
    </script>
  </div>
  <?php
  return ob_get_clean();
}
add_shortcode('opencircle_jobs', 'oc_jobs_shortcode');
add_shortcode('opencircle_job', 'oc_job_shortcode');

function oc_integration_register_admin_menu() {
  add_menu_page(
    'OpenCircle Integration',
    'OpenCircle',
    'manage_options',
    'opencircle-integration',
    'oc_integration_render_shortcodes_page',
    oc_integration_admin_menu_icon(),
    58
  );
  add_submenu_page(
    'opencircle-integration',
    'OpenCircle Shortcodes',
    'Shortcodes',
    'manage_options',
    'opencircle-integration',
    'oc_integration_render_shortcodes_page'
  );
  add_submenu_page(
    'opencircle-integration',
    'OpenCircle Settings',
    'Settings',
    'manage_options',
    'opencircle-integration-settings',
    'oc_integration_render_settings_page'
  );
}
add_action('admin_menu', 'oc_integration_register_admin_menu');

function oc_integration_register_settings() {
  register_setting('oc_integration_settings', 'oc_integration_api_base', [
    'type' => 'string',
    'sanitize_callback' => function ($value) {
      $url = esc_url_raw((string)$value);
      return $url !== '' ? rtrim($url, '/') : oc_integration_default_api_base();
    },
    'default' => oc_integration_default_api_base(),
  ]);
  register_setting('oc_integration_settings', 'oc_integration_accent_color', [
    'type' => 'string',
    'sanitize_callback' => function ($value) {
      $color = sanitize_hex_color((string)$value);
      return $color ? strtolower($color) : oc_integration_default_accent_color();
    },
    'default' => oc_integration_default_accent_color(),
  ]);
  register_setting('oc_integration_settings', 'oc_integration_events_grid_page_url', [
    'type' => 'string',
    'sanitize_callback' => function ($value) {
      $url = esc_url_raw((string)$value);
      return $url !== '' ? $url : oc_integration_default_events_grid_page_url();
    },
    'default' => oc_integration_default_events_grid_page_url(),
  ]);
  register_setting('oc_integration_settings', 'oc_integration_default_area', [
    'type' => 'string',
    'sanitize_callback' => function ($value) {
      return oc_integration_normalize_area($value);
    },
    'default' => oc_integration_default_area(),
  ]);
}
add_action('admin_init', 'oc_integration_register_settings');

function oc_integration_render_admin_tabs($active_tab) {
  $tabs = [
    'shortcodes' => admin_url('admin.php?page=opencircle-integration'),
    'settings' => admin_url('admin.php?page=opencircle-integration-settings'),
  ];
  ?>
  <h1>OpenCircle Integration</h1>
  <nav class="nav-tab-wrapper oc-admin-tabs">
    <a href="<?php echo esc_url($tabs['shortcodes']); ?>" class="nav-tab <?php echo $active_tab === 'shortcodes' ? 'nav-tab-active' : ''; ?>">Shortcodes</a>
    <a href="<?php echo esc_url($tabs['settings']); ?>" class="nav-tab <?php echo $active_tab === 'settings' ? 'nav-tab-active' : ''; ?>">Settings</a>
  </nav>
  <?php
}

function oc_integration_render_admin_styles($active_tab) {
  $colors = oc_integration_get_color_tokens();
  ?>
  <style>
    .oc-admin-tabs { margin-top: 18px; }
    .oc-admin-tab-panel { margin-top: 18px; }
    .oc-admin-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      margin-top: 20px;
    }
    .oc-admin-subtabs {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 18px;
    }
    .oc-admin-subtab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      padding: 0 14px;
      border-radius: 999px;
      border: 1px solid #d0d7de;
      background: #fff;
      color: #1d2327;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease;
    }
    .oc-admin-subtab:hover {
      border-color: <?php echo esc_html($colors['base']); ?>;
      color: <?php echo esc_html($colors['dark']); ?>;
    }
    .oc-admin-subtab.is-active {
      background: <?php echo esc_html($colors['base']); ?>;
      border-color: <?php echo esc_html($colors['base']); ?>;
      color: #fff;
    }
    .oc-admin-subpanel { display: none; }
    .oc-admin-subpanel.is-active { display: block; }
    .oc-admin-subpanel-title {
      margin: 18px 0 6px;
      font-size: 18px;
    }
    .oc-admin-subpanel-copy {
      margin: 0 0 14px;
      color: #50575e;
      max-width: 78ch;
    }
    .oc-admin-card {
      background: #fff;
      border: 1px solid #dcdcde;
      border-radius: 10px;
      padding: 18px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }
    .oc-admin-card h2 {
      margin: 0 0 10px;
      font-size: 18px;
    }
    .oc-admin-card p {
      margin: 0 0 12px;
      color: #50575e;
    }
    .oc-admin-fields {
      display: grid;
      gap: 10px;
      margin: 14px 0;
    }
    .oc-admin-field {
      display: grid;
      gap: 6px;
    }
    .oc-admin-field label {
      font-weight: 600;
      color: #1d2327;
    }
    .oc-admin-field input,
    .oc-admin-field select,
    .oc-admin-field textarea {
      width: 100%;
    }
    .oc-admin-field textarea {
      min-height: 72px;
    }
    .oc-admin-field .oc-admin-static {
      display: block;
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #dcdcde;
      border-radius: 4px;
      background: #f6f7f7;
      color: #1d2327;
      box-sizing: border-box;
    }
    .oc-admin-code {
      display: block;
      padding: 10px 12px;
      background: #f6f7f7;
      border-radius: 8px;
      border: 1px solid #e2e4e7;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .oc-admin-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-top: 10px;
    }
    .oc-admin-copy {
      min-width: 96px;
    }
    .oc-admin-copy-status {
      color: <?php echo esc_html($colors['dark']); ?>;
      font-size: 12px;
    }
    .oc-admin-note {
      margin-top: 20px;
      padding: 12px 16px;
      background: <?php echo esc_html($colors['light']); ?>;
      border-left: 4px solid <?php echo esc_html($colors['base']); ?>;
    }
    .oc-admin-route {
      margin-top: 8px;
      display: block;
    }
    .oc-admin-note p {
      margin: 0 0 8px;
    }
    .oc-admin-note p:last-child {
      margin-bottom: 0;
    }
    .oc-settings-card {
      max-width: 720px;
    }
    .oc-settings-preview {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .oc-settings-chip,
    .oc-settings-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 0 16px;
      border-radius: 999px;
      font-weight: 600;
    }
    .oc-settings-chip {
      background: <?php echo esc_html($colors['base']); ?>;
      color: #fff;
    }
    .oc-settings-pill {
      background: #fff;
      color: <?php echo esc_html($colors['base']); ?>;
      border: 1px solid <?php echo esc_html($colors['base']); ?>;
    }
    .oc-settings-help {
      color: #50575e;
      max-width: 72ch;
    }
    .oc-admin-grid.oc-admin-tab-panel,
    .oc-settings-card {
      grid-column: 1 / -1;
    }
    @media (max-width: 1280px) {
      .oc-admin-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 900px) {
      .oc-admin-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
  <?php
}

function oc_integration_render_shortcodes_page() {
  ?>
  <div class="wrap">
    <?php oc_integration_render_admin_tabs('shortcodes'); ?>
    <?php oc_integration_render_admin_styles('shortcodes'); ?>
    <p class="oc-admin-tab-panel">Use the builders below to adjust supported options and copy the exact shortcode for each integration.</p>

    <nav class="oc-admin-subtabs" aria-label="Shortcode groups">
      <button type="button" class="oc-admin-subtab is-active" data-oc-subtab="event-views">Event Views</button>
      <button type="button" class="oc-admin-subtab" data-oc-subtab="sliders">Sliders</button>
      <button type="button" class="oc-admin-subtab" data-oc-subtab="marketing">Marketing & Browse</button>
      <button type="button" class="oc-admin-subtab" data-oc-subtab="jobs">Jobs</button>
      <button type="button" class="oc-admin-subtab" data-oc-subtab="forms">Forms</button>
      <button type="button" class="oc-admin-subtab" data-oc-subtab="system">System</button>
    </nav>

    <section class="oc-admin-subpanel is-active" data-oc-subpanel="event-views">
      <h2 class="oc-admin-subpanel-title">Event Views</h2>
      <p class="oc-admin-subpanel-copy">Grid-style event browsing shortcodes for live calendar pages and past-event archives.</p>
      <div class="oc-admin-grid">
      <div class="oc-admin-card" data-oc-builder data-shortcode="opencircle_events_grid">
        <h2>Events Grid</h2>
        <p>Full searchable event grid with pagination, sorting, category filter, and grid/list views.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-grid-limit">Events Per Page</label>
            <input id="oc-grid-limit" type="number" min="1" data-attr="limit" value="40" />
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>

      <div class="oc-admin-card" data-oc-builder data-shortcode="opencircle_past_events_grid">
        <h2>Past Events Grid</h2>
        <p>Archive version of the events grid for a dedicated past-events page with the same searchable grid experience.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-past-grid-limit">Events Per Page</label>
            <input id="oc-past-grid-limit" type="number" min="1" data-attr="limit" value="12" />
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>
      </div>
    </section>

    <section class="oc-admin-subpanel" data-oc-subpanel="sliders">
      <h2 class="oc-admin-subpanel-title">Sliders</h2>
      <p class="oc-admin-subpanel-copy">Homepage and landing-page slider shortcodes for upcoming, featured, recent, and trending event displays.</p>
      <div class="oc-admin-grid">

      <div class="oc-admin-card" data-oc-builder data-shortcode="oc_events_slider">
        <h2>Events Slider</h2>
        <p>Reusable slider for upcoming, recent, trending, or trending-this-week event lists.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-slider-city">City or Cities</label>
            <input id="oc-slider-city" type="text" data-attr="city" value="<?php echo esc_attr(oc_integration_get_default_area()); ?>" />
            <small>Use a comma-separated list like <code>Buckley, Wilkeson</code> to combine multiple areas in one slider.</small>
          </div>
          <div class="oc-admin-field">
            <label for="oc-slider-type">Slider Type</label>
            <select id="oc-slider-type" data-attr="type">
              <option value="upcoming">upcoming</option>
              <option value="recent">recent</option>
              <option value="trending">trending</option>
              <option value="trending_week">trending_week</option>
            </select>
          </div>
          <div class="oc-admin-field">
            <label for="oc-slider-limit">Events Per Slider</label>
            <input id="oc-slider-limit" type="number" min="1" data-attr="limit" value="12" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-slider-title">Title</label>
            <input id="oc-slider-title" type="text" data-attr="title" value="" data-omit-empty="1" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-slider-autoplay">Autoplay</label>
            <select id="oc-slider-autoplay" data-attr="autoplay">
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </div>
          <div class="oc-admin-field">
            <label for="oc-slider-interval">Autoplay Interval (ms)</label>
            <input id="oc-slider-interval" type="number" min="1500" step="100" data-attr="interval" value="5000" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-slider-meta">Show Meta</label>
            <select id="oc-slider-meta" data-attr="show_meta">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div class="oc-admin-field">
            <label for="oc-slider-dedupe">Dedupe Recurring</label>
            <select id="oc-slider-dedupe" data-attr="dedupe">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div class="oc-admin-field">
            <label for="oc-slider-fade">Fade Edges</label>
            <select id="oc-slider-fade" data-attr="fade">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>

      <div class="oc-admin-card" data-oc-builder data-shortcode="oc_featured_slider">
        <h2>Featured Slider</h2>
        <p>Carousel row of featured events pulled from the OpenCircle API.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-featured-city">City or Cities</label>
            <input id="oc-featured-city" type="text" data-attr="city" value="<?php echo esc_attr(oc_integration_get_default_area()); ?>" />
            <small>Use a comma-separated list like <code>Buckley, Wilkeson</code> to combine multiple areas in one featured slider.</small>
          </div>
          <div class="oc-admin-field">
            <label for="oc-featured-limit">Events Per Slider</label>
            <input id="oc-featured-limit" type="number" min="1" data-attr="limit" value="10" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-featured-title">Title</label>
            <input id="oc-featured-title" type="text" data-attr="title" value="Featured Events" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-featured-autoplay">Autoplay</label>
            <select id="oc-featured-autoplay" data-attr="autoplay">
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </div>
          <div class="oc-admin-field">
            <label for="oc-featured-interval">Autoplay Interval (ms)</label>
            <input id="oc-featured-interval" type="number" min="1500" step="100" data-attr="interval" value="5000" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-featured-meta">Show Meta</label>
            <select id="oc-featured-meta" data-attr="show_meta">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>

      <div class="oc-admin-card" data-oc-builder data-shortcode="oc_featured_hero">
        <h2>Featured Hero</h2>
        <p>Large hero treatment for featured events, useful at the top of a homepage or landing page.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-hero-city">City or Cities</label>
            <input id="oc-hero-city" type="text" data-attr="city" value="<?php echo esc_attr(oc_integration_get_default_area()); ?>" />
            <small>Use a comma-separated list like <code>Buckley, Wilkeson</code> to rotate featured hero slides from multiple areas.</small>
          </div>
          <div class="oc-admin-field">
            <label for="oc-hero-limit">Slides</label>
            <input id="oc-hero-limit" type="number" min="1" data-attr="limit" value="6" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-hero-autoplay">Autoplay</label>
            <select id="oc-hero-autoplay" data-attr="autoplay">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div class="oc-admin-field">
            <label for="oc-hero-interval">Autoplay Interval (ms)</label>
            <input id="oc-hero-interval" type="number" min="1500" step="100" data-attr="interval" value="6000" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-hero-meta">Show Meta</label>
            <select id="oc-hero-meta" data-attr="show_meta">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div class="oc-admin-field">
            <label for="oc-hero-height">Hero Height (px)</label>
            <input id="oc-hero-height" type="number" min="260" data-attr="height" value="520" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-hero-fullbleed">Full Bleed</label>
            <select id="oc-hero-fullbleed" data-attr="fullbleed">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>
      </div>
    </section>

    <section class="oc-admin-subpanel" data-oc-subpanel="forms">
      <h2 class="oc-admin-subpanel-title">Forms</h2>
      <p class="oc-admin-subpanel-copy">Front-end submission tools for collecting new event listings, newsletter signups, and optional featured-event upsells.</p>
      <div class="oc-admin-grid">

      <div class="oc-admin-card" data-oc-builder data-shortcode="oc_event_submit">
        <h2>Event Submission Form</h2>
        <p>Front-end form that sends event submissions to the API for admin review and optional WooCommerce upsell.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-submit-title">Form Title</label>
            <input id="oc-submit-title" type="text" data-attr="title" value="Submit an Event" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-submit-button">Submit Button Label</label>
            <input id="oc-submit-button" type="text" data-attr="button" value="Submit Event" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-submit-success">Success Message</label>
            <textarea id="oc-submit-success" data-attr="success">Thank you for submitting your event! An admin will review to ensure accuracy before it gets published live</textarea>
          </div>
          <div class="oc-admin-field">
            <label for="oc-submit-feature-id">Woo Featured Product ID</label>
            <input id="oc-submit-feature-id" type="number" min="0" data-attr="feature_product_id" value="" data-omit-empty="1" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-submit-feature-label">Feature Button Label</label>
            <input id="oc-submit-feature-label" type="text" data-attr="feature_label" value="Feature Until Event Date ($25)" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-submit-feature-copy">Feature Upsell Copy</label>
            <textarea id="oc-submit-feature-copy" data-attr="feature_copy">Want more visibility? Feature this event on EnumclawEvents.org until it happens.</textarea>
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>

      <div class="oc-admin-card" data-oc-builder data-shortcode="opencircle_newsletter_signup" data-fixed-attrs='{"city":"<?php echo esc_attr(oc_integration_newsletter_scope()); ?>"}'>
        <h2>Newsletter Signup</h2>
        <p>Public newsletter signup form that adds subscribers to the OpenCircle newsletter audience for the Plateau Area.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label>Coverage</label>
            <div class="oc-admin-static" aria-hidden="true"><?php echo esc_html(oc_integration_newsletter_scope()); ?></div>
          </div>
          <div class="oc-admin-field">
            <label for="oc-newsletter-title">Headline</label>
            <input id="oc-newsletter-title" type="text" data-attr="title" value="Stay in the loop" autocomplete="off" autocapitalize="off" spellcheck="false" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-newsletter-description">Description</label>
            <textarea id="oc-newsletter-description" data-attr="description" autocomplete="off" autocapitalize="off" spellcheck="false">Get local event highlights, updates, and newsletter picks delivered to your inbox.</textarea>
          </div>
          <div class="oc-admin-field">
            <label for="oc-newsletter-button">Button Label</label>
            <input id="oc-newsletter-button" type="text" data-attr="button" value="Sign Up" autocomplete="off" autocapitalize="off" spellcheck="false" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-newsletter-placeholder">Email Placeholder</label>
            <input id="oc-newsletter-placeholder" type="text" data-attr="placeholder" value="Enter your email address" autocomplete="off" autocapitalize="off" spellcheck="false" />
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>
      </div>
    </section>

    <section class="oc-admin-subpanel" data-oc-subpanel="marketing">
      <h2 class="oc-admin-subpanel-title">Marketing & Browse</h2>
      <p class="oc-admin-subpanel-copy">Ads, category browse sections, and popular link blocks that help users discover events from homepages and landing pages.</p>
      <div class="oc-admin-grid">

      <div class="oc-admin-card" data-oc-builder data-shortcode="opencircle_ad">
        <h2>Ads</h2>
        <p>Render a tracked ad placement from the OpenCircle API. Ads are pulled from the Plateau Area scope, and if no ad is available, the fallback can be shown instead.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-ad-coverage">Coverage</label>
            <input id="oc-ad-coverage" type="text" value="Plateau" readonly />
          </div>
          <div class="oc-admin-field">
            <label for="oc-ad-placement">Placement</label>
            <input id="oc-ad-placement" type="text" data-attr="placement" value="homepage-top" list="oc-ad-placement-options" />
            <datalist id="oc-ad-placement-options">
              <option value="homepage-top"></option>
              <option value="homepage-bottom"></option>
              <option value="events-top"></option>
              <option value="events-bottom"></option>
              <option value="venues-top"></option>
              <option value="single-event-main"></option>
              <option value="single-event-side"></option>
            </datalist>
          </div>
          <div class="oc-admin-field">
            <label for="oc-ad-class">Extra Wrapper Class</label>
            <input id="oc-ad-class" type="text" data-attr="class" value="" data-omit-empty="1" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-ad-fallback">Fallback HTML/Text</label>
            <textarea id="oc-ad-fallback" data-attr="fallback" data-omit-empty="1"></textarea>
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>

      <div class="oc-admin-card" data-oc-builder data-shortcode="opencircle_popular_event_links">
        <h2>Popular Event Links</h2>
        <p>Render Eventbrite-style browse links for popular categories, organizers, and venues. Organizer browse links use Plateau-wide event coverage, while event and venue browsing can still stay area-specific elsewhere.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-popular-links-limit">Links Per Section</label>
            <input id="oc-popular-links-limit" type="number" min="1" max="24" data-attr="limit" value="10" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-popular-links-source-limit">Events to Analyze</label>
            <input id="oc-popular-links-source-limit" type="number" min="10" max="400" data-attr="source_limit" value="200" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-popular-links-show">Show Sections</label>
            <input id="oc-popular-links-show" type="text" data-attr="show" value="categories,organizers" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-popular-links-title-categories">Categories Title</label>
            <input id="oc-popular-links-title-categories" type="text" data-attr="title_categories" value="Popular Categories" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-popular-links-title-organizers">Organizers Title</label>
            <input id="oc-popular-links-title-organizers" type="text" data-attr="title_organizers" value="Popular Organizers" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-popular-links-title-venues">Venues Title</label>
            <input id="oc-popular-links-title-venues" type="text" data-attr="title_venues" value="Popular Venues" />
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>

      <div class="oc-admin-card" data-oc-builder data-shortcode="opencircle_category_section">
        <h2>Category Section</h2>
        <p>Render an Explore Categories section with large image cards that link into the shared events grid with the matching category filter applied.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-category-section-title">Section Title</label>
            <input id="oc-category-section-title" type="text" data-attr="title" value="Explore Categories" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-category-section-categories">Categories</label>
            <textarea id="oc-category-section-categories" data-attr="categories">Workshops & Classes, Live Music, Community Events, Seasonal & Holiday, Arts & Culture, Nightlife</textarea>
          </div>
          <div class="oc-admin-field">
            <label for="oc-category-section-columns">Columns</label>
            <input id="oc-category-section-columns" type="number" min="1" max="4" data-attr="columns" value="3" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-category-section-source-limit">Events to Analyze</label>
            <input id="oc-category-section-source-limit" type="number" min="10" max="400" data-attr="source_limit" value="200" />
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>
      </div>
    </section>

    <section class="oc-admin-subpanel" data-oc-subpanel="jobs">
      <h2 class="oc-admin-subpanel-title">Jobs</h2>
      <p class="oc-admin-subpanel-copy">Jobs directory and single-job detail shortcodes with application handling.</p>
      <div class="oc-admin-grid">

      <div class="oc-admin-card" data-oc-builder data-shortcode="opencircle_jobs" data-fixed-attrs='{"city":"<?php echo esc_attr(oc_integration_jobs_scope()); ?>"}'>
        <h2>Jobs Directory</h2>
        <p>Render a jobs directory with an in-page popup detail view, similar to Indeed, plus website application support when the API allows it. Jobs are shown Plateau-wide.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label>Coverage</label>
            <div class="oc-admin-static" aria-hidden="true"><?php echo esc_html(oc_integration_jobs_scope_label()); ?></div>
          </div>
          <div class="oc-admin-field">
            <label for="oc-jobs-title">Title</label>
            <input id="oc-jobs-title" type="text" data-attr="title" value="" data-omit-empty="1" autocomplete="off" autocapitalize="off" spellcheck="false" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-jobs-description">Description</label>
            <textarea id="oc-jobs-description" data-attr="description" data-omit-empty="1" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
          </div>
          <div class="oc-admin-field">
            <label for="oc-jobs-limit">Jobs Per Directory</label>
            <input id="oc-jobs-limit" type="number" min="1" data-attr="limit" value="20" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-jobs-q">Initial Search</label>
            <input id="oc-jobs-q" type="text" data-attr="q" value="" data-omit-empty="1" autocomplete="off" autocapitalize="off" spellcheck="false" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-jobs-class">Extra Wrapper Class</label>
            <input id="oc-jobs-class" type="text" data-attr="class" value="" data-omit-empty="1" autocomplete="off" autocapitalize="off" spellcheck="false" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-jobs-fallback">Fallback HTML/Text</label>
            <textarea id="oc-jobs-fallback" data-attr="fallback" data-omit-empty="1" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>

      <div class="oc-admin-card" data-oc-builder data-shortcode="opencircle_job">
        <h2>Single Job</h2>
        <p>Render one job detail block with the correct apply UI for external links, website applications, or both.</p>
        <div class="oc-admin-fields">
          <div class="oc-admin-field">
            <label for="oc-job-slug">Job Slug</label>
            <input id="oc-job-slug" type="text" data-attr="slug" value="senior-hot-meals-coordinator-rainier-foothills-wellness-foundation" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-job-class">Extra Wrapper Class</label>
            <input id="oc-job-class" type="text" data-attr="class" value="" data-omit-empty="1" />
          </div>
          <div class="oc-admin-field">
            <label for="oc-job-fallback">Fallback HTML/Text</label>
            <textarea id="oc-job-fallback" data-attr="fallback" data-omit-empty="1"></textarea>
          </div>
        </div>
        <code class="oc-admin-code" data-oc-output></code>
        <div class="oc-admin-actions">
          <button type="button" class="button button-primary oc-admin-copy" data-oc-copy>Copy</button>
          <span class="oc-admin-copy-status" data-oc-copy-status></span>
        </div>
      </div>
      </div>
    </section>

    <section class="oc-admin-subpanel" data-oc-subpanel="system">
      <h2 class="oc-admin-subpanel-title">System</h2>
      <p class="oc-admin-subpanel-copy">Reference routes handled automatically by the plugin, without needing a shortcode.</p>
      <div class="oc-admin-grid">
      <div class="oc-admin-card">
        <h2>Virtual Event and Venue Pages</h2>
        <p>These do not use shortcodes. The plugin automatically serves event and venue detail pages from the API.</p>
        <code class="oc-admin-code">/events/{event-slug-or-id}/
/venues/{venue-slug-or-id}/</code>
        <span class="oc-admin-route">These routes are driven by plugin logic, not shortcode settings.</span>
      </div>
      </div>
    </section>

    <div class="oc-admin-note">
      <p><strong>Common attributes:</strong> Most shortcodes support <code>city</code>, and slider shortcodes can also accept a comma-separated multi-city value like <code>city="Buckley, Wilkeson"</code>. Several shortcodes also support <code>limit</code> and <code>event_base</code>. The shared API base is now managed under <code>OpenCircle &rarr; Settings</code>.</p>
      <p><strong>Past events shortcode:</strong> Use <code>[opencircle_past_events_grid]</code> on a dedicated archive page to render a searchable grid of archived/past events.</p>
      <p><strong>Slider type options:</strong> Use <code>type="upcoming"</code>, <code>type="recent"</code>, <code>type="trending"</code>, or <code>type="trending_week"</code> with <code>[oc_events_slider]</code>.</p>
      <p><strong>Ads shortcode:</strong> Use <code>[opencircle_ad placement="homepage-top"]</code> or one of <code>homepage-bottom</code>, <code>events-top</code>, <code>events-bottom</code>, <code>venues-top</code>, <code>single-event-main</code>, or <code>single-event-side</code>. Ads now pull from the Plateau Area scope automatically. Optional <code>class</code> and <code>fallback</code> attributes still work.</p>
      <p><strong>Newsletter shortcode:</strong> Use <code>[opencircle_newsletter_signup]</code> to add subscribers to the Plateau Area newsletter audience. Optional content attributes like <code>title</code>, <code>description</code>, <code>button</code>, and <code>placeholder</code> still work.</p>
      <p><strong>Popular links shortcode:</strong> Use <code>[opencircle_popular_event_links]</code> or customize <code>limit</code>, <code>source_limit</code>, <code>show</code>, and the section title attributes as needed.</p>
      <p><strong>Category section shortcode:</strong> Use <code>[opencircle_category_section]</code> or customize <code>title</code>, <code>categories</code>, <code>columns</code>, and <code>source_limit</code> to build an Explore Categories card section.</p>
      <p><strong>Jobs shortcode:</strong> Use <code>[opencircle_jobs]</code> to show Plateau-wide jobs, or add optional <code>limit</code>, <code>q</code>, <code>class</code>, <code>title</code>, <code>description</code>, and <code>fallback</code> attributes manually if needed.</p>
      <p><strong>Single job shortcode:</strong> Use <code>[opencircle_job slug="job-slug"]</code> to embed a full job detail block with application handling.</p>
    </div>

	    <script>
	      (function () {
        function setActiveSubtab(name) {
          document.querySelectorAll('[data-oc-subtab]').forEach(function (btn) {
            btn.classList.toggle('is-active', btn.getAttribute('data-oc-subtab') === name);
          });

          document.querySelectorAll('[data-oc-subpanel]').forEach(function (panel) {
            panel.classList.toggle('is-active', panel.getAttribute('data-oc-subpanel') === name);
          });
        }

	        function escapeAttr(value) {
	          return String(value)
	            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        }

        function buildShortcode(card) {
          const shortcode = card.getAttribute('data-shortcode');
          const fields = card.querySelectorAll('[data-attr]');
          const parts = ['[' + shortcode];
          var fixedAttrs = {};

          try {
            fixedAttrs = JSON.parse(card.getAttribute('data-fixed-attrs') || '{}') || {};
          } catch (e) {
            fixedAttrs = {};
          }

          Object.keys(fixedAttrs).forEach(function (attr) {
            const value = String(fixedAttrs[attr] || '').trim();
            if (!attr || value === '') return;
            parts.push(attr + '="' + escapeAttr(value) + '"');
          });

          fields.forEach(function (field) {
            const attr = field.getAttribute('data-attr');
            const omitEmpty = field.hasAttribute('data-omit-empty');
            const value = (field.value || '').trim();
            if (!attr) return;
            if (omitEmpty && value === '') return;
            parts.push(attr + '="' + escapeAttr(value) + '"');
          });

          parts.push(']');
          return parts.join(' ');
        }

        function renderCard(card) {
          const output = card.querySelector('[data-oc-output]');
          if (!output) return;
          output.textContent = buildShortcode(card);
        }

        function copyShortcode(card) {
          const output = card.querySelector('[data-oc-output]');
          const status = card.querySelector('[data-oc-copy-status]');
          if (!output) return;

          const text = output.textContent || '';
          const onSuccess = function () {
            if (status) status.textContent = 'Copied';
            window.setTimeout(function () {
              if (status) status.textContent = '';
            }, 1800);
          };

          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onSuccess).catch(function () {});
            return;
          }

          const helper = document.createElement('textarea');
          helper.value = text;
          document.body.appendChild(helper);
          helper.select();
          try {
            document.execCommand('copy');
            onSuccess();
          } catch (e) {}
          document.body.removeChild(helper);
        }

	        document.querySelectorAll('[data-oc-builder]').forEach(function (card) {
	          renderCard(card);

          card.querySelectorAll('[data-attr]').forEach(function (field) {
            field.addEventListener('input', function () {
              renderCard(card);
            });
            field.addEventListener('change', function () {
              renderCard(card);
            });
          });

          const copyBtn = card.querySelector('[data-oc-copy]');
          if (copyBtn) {
            copyBtn.addEventListener('click', function () {
              copyShortcode(card);
	            });
	          }
	        });

          document.querySelectorAll('[data-oc-subtab]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              setActiveSubtab(btn.getAttribute('data-oc-subtab') || 'event-views');
            });
          });
	      })();
	    </script>
  </div>
  <?php
}

function oc_integration_render_settings_page() {
  $colors = oc_integration_get_color_tokens();
  ?>
  <div class="wrap">
    <?php oc_integration_render_admin_tabs('settings'); ?>
    <?php oc_integration_render_admin_styles('settings'); ?>
    <div class="oc-admin-grid oc-admin-tab-panel">
      <div class="oc-admin-card oc-settings-card">
        <h2>Plugin Settings</h2>
        <p class="oc-settings-help">Manage the shared API base, default area, default events grid page, and accent color for the OpenCircle plugin. The API base is used across shortcode defaults, the default area controls the default city for event and venue browsing, the events grid page is used for organizer-driven browse links, and the accent color controls the blue styling used across event pages, venue pages, sliders, badges, links, buttons, focus states, and plugin-specific admin helpers.</p>
        <form method="post" action="options.php">
          <?php settings_fields('oc_integration_settings'); ?>
          <div class="oc-admin-fields">
            <div class="oc-admin-field">
              <label for="oc-integration-api-base">API Base</label>
              <input id="oc-integration-api-base" name="oc_integration_api_base" type="url" value="<?php echo esc_attr(oc_integration_get_api_base()); ?>" />
            </div>
            <div class="oc-admin-field">
              <label for="oc-integration-default-area">Default Area</label>
              <select id="oc-integration-default-area" name="oc_integration_default_area">
                <?php $default_area = oc_integration_get_default_area(); ?>
                <option value="Enumclaw" <?php selected($default_area, 'Enumclaw'); ?>>Enumclaw</option>
                <option value="Buckley" <?php selected($default_area, 'Buckley'); ?>>Buckley</option>
              </select>
            </div>
            <div class="oc-admin-field">
              <label for="oc-integration-events-grid-page-url">Events Grid Page URL</label>
              <input id="oc-integration-events-grid-page-url" name="oc_integration_events_grid_page_url" type="url" value="<?php echo esc_attr(oc_integration_get_events_grid_page_url()); ?>" />
            </div>
            <div class="oc-admin-field">
              <label for="oc-integration-accent-color">Accent Color</label>
              <input id="oc-integration-accent-color" name="oc_integration_accent_color" type="color" value="<?php echo esc_attr(oc_integration_get_accent_color()); ?>" />
            </div>
          </div>
          <div class="oc-admin-actions">
            <button type="submit" class="button button-primary">Save Settings</button>
          </div>
        </form>
        <div class="oc-settings-preview" aria-hidden="true">
          <span class="oc-settings-chip">Primary Accent</span>
          <span class="oc-settings-pill">Secondary Accent</span>
        </div>
      </div>
      <div class="oc-admin-note">
        <p><strong>API Base:</strong> <code><?php echo esc_html(oc_integration_get_api_base()); ?></code></p>
        <p><strong>Default Area:</strong> <code><?php echo esc_html(oc_integration_get_default_area()); ?></code></p>
        <p><strong>Events Grid Page:</strong> <code><?php echo esc_html(oc_integration_get_events_grid_page_url()); ?></code></p>
        <p><strong>Coverage:</strong> This setting overrides the plugin’s accent blue anywhere it appears in event pages, venue pages, sliders, submission forms, featured badges, and plugin-specific admin helpers.</p>
        <p><strong>Category Section Shortcode:</strong> <code>[opencircle_category_section]</code> also uses these shared settings for its default area, browse links, and accent-driven styling.</p>
        <p><strong>Newsletter Signup Shortcode:</strong> <code>[opencircle_newsletter_signup]</code></p>
        <p><strong>Default:</strong> <code><?php echo esc_html(oc_integration_default_accent_color()); ?></code></p>
        <p><strong>Current:</strong> <code><?php echo esc_html($colors['base']); ?></code></p>
      </div>
    </div>
  </div>
  <?php
}

function oc_events_grid_cache_key($city, $api, $event_base, $mode = 'upcoming') {
  return 'oc_events_fallback_' . md5(strtolower(trim((string)$city)) . '|' . trim((string)$api) . '|' . trim((string)$event_base) . '|' . strtolower(trim((string)$mode)));
}

function oc_events_grid_event_url($event, $event_base) {
  $slug = trim((string)($event['slug'] ?? ''));
  $id = trim((string)($event['id'] ?? ''));
  $key = $slug !== '' ? $slug : $id;
  if ($key === '') return '';

  $event_base = trim((string)$event_base);
  if ($event_base === '') $event_base = '/events/';
  if ($event_base[0] !== '/') $event_base = '/' . $event_base;
  if (substr($event_base, -1) !== '/') $event_base .= '/';

  return home_url($event_base . rawurlencode($key) . '/');
}

function oc_events_grid_event_datetime($event) {
  $start_raw = trim((string)($event['startDateTime'] ?? ''));
  if ($start_raw === '') return null;

  try {
    $start = new DateTimeImmutable($start_raw);
  } catch (Exception $e) {
    return null;
  }

  $end = null;
  $end_raw = trim((string)($event['endDateTime'] ?? ''));
  if ($end_raw !== '') {
    try {
      $end = new DateTimeImmutable($end_raw);
    } catch (Exception $e) {
      $end = null;
    }
  }

  return [
    'start' => $start,
    'end' => $end,
  ];
}

function oc_events_grid_normalize_image($img) {
  $img = trim((string)$img);
  if ($img === '') return 'https://via.placeholder.com/1200x675.png?text=Event';

  $bad = ['none', 'null', 'undefined', '#'];
  if (in_array(strtolower($img), $bad, true)) {
    return 'https://via.placeholder.com/1200x675.png?text=Event';
  }

  return preg_replace('#^http://#i', 'https://', $img);
}

function oc_events_grid_trending_score($event) {
  $keys = [
    'views7d', 'views_7d', 'viewsLast7Days', 'views_last_7_days',
    'weeklyViews', 'weekly_views', 'viewsWeek', 'views_week',
    'trendingWeek', 'trending_week', 'trendingScore7d', 'trending_score_7d',
    'trendingScore', 'trending_score',
    'views', 'viewCount', 'view_count',
  ];

  foreach ($keys as $key) {
    if (!isset($event[$key]) || $event[$key] === '' || $event[$key] === null) continue;
    $value = (float) $event[$key];
    if (is_finite($value)) return $value;
  }

  return 0;
}

function oc_events_grid_date_label($event) {
  $label = trim((string)($event['dateLabel'] ?? ''));
  if ($label !== '') return $label;

  $dt = oc_events_grid_event_datetime($event);
  if (!$dt || empty($dt['start'])) return '';
  return wp_date('F j, Y', $dt['start']->getTimestamp(), wp_timezone());
}

function oc_events_grid_time_label($event) {
  $label = trim((string)($event['timeLabel'] ?? ''));
  if ($label !== '') return $label;

  $dt = oc_events_grid_event_datetime($event);
  if (!$dt || empty($dt['start'])) return '';
  return strtolower(wp_date('g:i A', $dt['start']->getTimestamp(), wp_timezone()));
}

function oc_events_grid_event_matches_mode($event, $mode = 'upcoming', $now = null) {
  $dt = oc_events_grid_event_datetime($event);
  if (!$dt || empty($dt['start'])) return false;
  if (!$now instanceof DateTimeImmutable) $now = new DateTimeImmutable('now', wp_timezone());
  $end_dt = !empty($dt['end']) ? $dt['end'] : $dt['start'];
  $mode = strtolower(trim((string)$mode));
  if ($mode === 'past') return $end_dt < $now;
  return $end_dt >= $now;
}

function oc_events_grid_paginate_local_events($events, $limit, $offset = 0) {
  $limit = max(1, (int)$limit);
  $offset = max(0, (int)$offset);
  $events = array_values(is_array($events) ? $events : []);
  $total = count($events);
  $total_pages = max(1, (int)ceil($total / $limit));

  return [
    'events' => array_slice($events, $offset, $limit),
    'total' => $total,
    'total_pages' => $total_pages,
    'has_more' => ($offset + $limit) < $total,
  ];
}

function oc_events_grid_fetch_archive_api_page($api, $city, $limit, $offset = 0) {
  $api = rtrim((string)$api, '/');
  $city = trim((string)$city);
  $limit = max(1, (int)$limit);
  $offset = max(0, (int)$offset);
  $url = add_query_arg([
    'city' => $city,
    'status' => 'past',
    'expand' => 1,
    'sort' => 'latest',
    'windowDays' => 3650,
    'limit' => $limit,
    'offset' => $offset,
  ], $api . '/events');

  $res = wp_remote_get($url, [
    'timeout' => 12,
    'headers' => ['Accept' => 'application/json'],
  ]);

  if (is_wp_error($res)) {
    return ['rows' => [], 'meta' => [], 'ok' => false];
  }

  $code = (int) wp_remote_retrieve_response_code($res);
  $body = wp_remote_retrieve_body($res);
  $json = json_decode($body, true);
  if ($code < 200 || $code >= 300 || !is_array($json)) {
    return ['rows' => [], 'meta' => [], 'ok' => false];
  }

  return [
    'rows' => isset($json['data']) && is_array($json['data']) ? $json['data'] : [],
    'meta' => isset($json['meta']) && is_array($json['meta']) ? $json['meta'] : [],
    'ok' => true,
  ];
}

function oc_events_grid_fetch_initial_page($city, $api, $limit, $offset = 0, $mode = 'upcoming', $event_base = '/events/') {
  $city = trim((string)$city);
  $api = rtrim((string)$api, '/');
  $limit = max(1, (int) $limit);
  $offset = max(0, (int) $offset);
  $mode = strtolower(trim((string)$mode));

  if ($city === '' || $api === '') {
    return ['events' => [], 'total' => 0, 'total_pages' => 1, 'has_more' => false];
  }

  if ($mode === 'past') {
    $page = oc_events_grid_fetch_archive_api_page($api, $city, max(100, $limit), $offset);
    $rows = isset($page['rows']) && is_array($page['rows']) ? $page['rows'] : [];
    $meta = isset($page['meta']) && is_array($page['meta']) ? $page['meta'] : [];
    $now = new DateTimeImmutable('now', wp_timezone());
    $events = [];

    foreach ($rows as $event) {
      if (!is_array($event)) continue;
      if (!oc_events_grid_event_matches_mode($event, 'past', $now)) continue;
      $events[] = $event;
    }

    $total = max(count($events), (int)($meta['total'] ?? count($events)));
    $total_pages = max(1, (int)ceil($total / $limit));

    return [
      'events' => array_slice(array_values($events), 0, $limit),
      'total' => $total,
      'total_pages' => $total_pages,
      'has_more' => !empty($meta['hasMore']),
    ];
  }

  $url = add_query_arg([
    'city' => $city,
    'expand' => 1,
    'limit' => $limit,
    'offset' => $offset,
    'sort' => 'soonest',
  ], $api . '/events');

  $res = wp_remote_get($url, [
    'timeout' => 12,
    'headers' => ['Accept' => 'application/json'],
  ]);

  if (is_wp_error($res)) {
    return ['events' => [], 'total' => 0, 'total_pages' => 1, 'has_more' => false];
  }

  $code = (int) wp_remote_retrieve_response_code($res);
  $body = wp_remote_retrieve_body($res);
  $json = json_decode($body, true);
  if ($code < 200 || $code >= 300 || !is_array($json)) {
    return ['events' => [], 'total' => 0, 'total_pages' => 1, 'has_more' => false];
  }

  $rows = isset($json['data']) && is_array($json['data']) ? $json['data'] : [];
  $meta = isset($json['meta']) && is_array($json['meta']) ? $json['meta'] : [];
  $now = new DateTimeImmutable('now', wp_timezone());
  $events = [];

  foreach ($rows as $event) {
    if (!is_array($event)) continue;
    if (!oc_events_grid_event_matches_mode($event, 'upcoming', $now)) continue;
    $events[] = $event;
  }

  $total = max(count($events), (int) ($meta['total'] ?? count($events)));
  $total_pages = max(1, (int) ceil($total / $limit));

  return [
    'events' => $events,
    'total' => $total,
    'total_pages' => $total_pages,
    'has_more' => !empty($meta['hasMore']),
  ];
}

function oc_events_grid_render_initial_cards($events, $event_base, $mode = 'upcoming') {
  $featured_icon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.8l2.85 5.77 6.37.93-4.61 4.49 1.09 6.35L12 17.37 6.3 20.34l1.09-6.35L2.78 9.5l6.37-.93L12 2.8z"></path></svg>';
  $trending_icon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 6h5v5h-2.5V9.77l-6.03 6.03-3.5-3.5-5.24 5.24L2 15.8l6.97-6.97 3.5 3.5L16.23 8.5H16V6z"></path></svg>';
  $ico_cal = '<span class="oc-ico" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg></span>';
  $ico_clock = '<span class="oc-ico" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></span>';
  $ico_pin = '<span class="oc-ico" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg></span>';

  foreach ($events as $event) {
    if (!is_array($event)) continue;
    $title = trim((string)($event['title'] ?? ''));
    $url = oc_events_grid_event_url($event, $event_base);
    $location = trim((string)($event['location'] ?? ''));
    if ($title === '' || $url === '') continue;

    $dt = oc_events_grid_event_datetime($event);
    if (!$dt || empty($dt['start'])) continue;
    $start = $dt['start'];
    $day = wp_date('j', $start->getTimestamp(), wp_timezone());
    $mon = wp_date('M', $start->getTimestamp(), wp_timezone());
    $date_label = oc_events_grid_date_label($event);
    $time_label = oc_events_grid_time_label($event);
    $image = oc_events_grid_normalize_image($event['imageUrl'] ?? $event['image'] ?? $event['imageURL'] ?? '');
    $slug = trim((string)($event['slug'] ?? ''));
    $event_id = trim((string)($event['id'] ?? ''));
    $featured = !empty($event['isFeatured']) || (int) ($event['featured'] ?? 0) === 1;
    $trending = oc_integration_event_is_trending(oc_events_grid_trending_score($event));
    $happening_now = ($mode !== 'past') && oc_integration_event_happening_now($event);
    ?>
    <a
      href="<?php echo esc_url($url); ?>"
      class="oc-card-link"
      aria-label="<?php echo esc_attr($title); ?>"
      data-oc-eid="<?php echo esc_attr($event_id); ?>"
      data-oc-slug="<?php echo esc_attr($slug); ?>"
    >
      <article class="oc-card" role="listitem">
        <div class="oc-media">
          <div class="oc-grid-badges">
            <?php if ($featured): ?>
              <div class="oc-grid-badge oc-grid-badge--featured" aria-label="Featured event" title="Featured event"><?php echo $featured_icon; ?></div>
            <?php endif; ?>
            <?php if ($happening_now): ?>
              <div class="oc-grid-badge oc-grid-badge--happening" aria-label="Happening now" title="Happening now">Now</div>
            <?php endif; ?>
            <?php if ($trending): ?>
              <div class="oc-grid-badge oc-grid-badge--trending" aria-label="Trending event" title="Trending event"><?php echo $trending_icon; ?></div>
            <?php endif; ?>
          </div>
          <img class="oc-thumb" src="<?php echo esc_url($image); ?>" alt="<?php echo esc_attr($title); ?>" loading="lazy" />
          <div class="oc-badge">
            <div class="oc-badge-day"><?php echo esc_html($day); ?></div>
            <div class="oc-badge-mon"><?php echo esc_html($mon); ?></div>
          </div>
        </div>
        <div class="oc-body">
          <h3 class="oc-title"><?php echo esc_html($title); ?></h3>
          <?php if ($date_label !== ''): ?>
            <div class="oc-meta"><?php echo $ico_cal; ?><time datetime="<?php echo esc_attr($start->format(DATE_ATOM)); ?>"><?php echo esc_html($date_label); ?></time></div>
          <?php endif; ?>
          <?php if ($time_label !== ''): ?>
            <div class="oc-meta"><?php echo $ico_clock; ?><span><?php echo esc_html($time_label); ?></span></div>
          <?php endif; ?>
          <?php if ($location !== ''): ?>
            <div class="oc-meta"><?php echo $ico_pin; ?><span><?php echo esc_html($location); ?></span></div>
          <?php endif; ?>
        </div>
      </article>
    </a>
    <?php
  }
}

function oc_popular_links_increment_count(&$bucket, $label) {
  $label = trim((string)$label);
  if ($label === '') return;
  if (!isset($bucket[$label])) $bucket[$label] = 0;
  $bucket[$label] += 1;
}

function oc_popular_links_sort_counts($items, $limit) {
  if (!is_array($items) || empty($items)) return [];

  uksort($items, function ($a, $b) use ($items) {
    $countA = (int) ($items[$a] ?? 0);
    $countB = (int) ($items[$b] ?? 0);
    if ($countA !== $countB) return $countB <=> $countA;
    return strcasecmp($a, $b);
  });

  $out = [];
  foreach ($items as $label => $count) {
    $out[] = ['label' => $label, 'count' => (int) $count];
    if (count($out) >= $limit) break;
  }
  return $out;
}

function oc_popular_links_collect_groups($events, $limit = 10) {
  $categories = [];
  $organizers = [];
  $venues = [];

  foreach ((array) $events as $event) {
    if (!is_array($event)) continue;

    $event_categories = $event['categories'] ?? [];
    if (is_string($event_categories)) {
      $event_categories = array_map('trim', explode(',', $event_categories));
    }
    if (is_array($event_categories)) {
      foreach ($event_categories as $category) {
        $category = strtolower(trim((string) $category));
        if ($category === '') continue;
        oc_popular_links_increment_count($categories, ucwords($category));
      }
    }

    oc_popular_links_increment_count($organizers, (string) ($event['organizer'] ?? ''));
    oc_popular_links_increment_count($venues, (string) ($event['location'] ?? ''));
  }

  return [
    'categories' => oc_popular_links_sort_counts($categories, $limit),
    'organizers' => oc_popular_links_sort_counts($organizers, $limit),
    'venues' => oc_popular_links_sort_counts($venues, $limit),
  ];
}

function oc_popular_links_render_group($title, $items, $type) {
  if (empty($items) || !is_array($items)) return;
  $title = ucwords(strtolower(trim((string) $title)));
  ?>
  <section class="oc-popular-links-group">
    <h3><?php echo esc_html($title); ?></h3>
    <div class="oc-popular-links-pills">
      <?php foreach ($items as $item): ?>
        <?php
          $label = trim((string) ($item['label'] ?? ''));
          if ($label === '') continue;

          if ($type === 'category') {
            $url = oc_integration_get_category_grid_url($label);
          } elseif ($type === 'organizer') {
            $url = oc_integration_get_organizer_grid_url($label);
          } else {
            $url = oc_integration_get_venue_grid_url($label);
          }

          if ($url === '') continue;
        ?>
        <a class="oc-popular-links-pill" href="<?php echo esc_url($url); ?>">
          <span><?php echo esc_html($label); ?></span>
          <span class="oc-popular-links-pill__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false"><path d="M16 6h5v5h-2.5V9.77l-6.03 6.03-3.5-3.5-5.24 5.24L2 15.8l6.97-6.97 3.5 3.5L16.23 8.5H16V6z"></path></svg>
          </span>
        </a>
      <?php endforeach; ?>
    </div>
  </section>
  <?php
}

function oc_popular_links_shortcode($atts) {
  $atts = shortcode_atts([
    'city' => oc_integration_organizer_scope(),
    'limit' => 10,
    'source_limit' => 200,
    'show' => 'categories,organizers',
    'title_categories' => 'Popular Categories',
    'title_organizers' => 'Popular Organizers',
    'title_venues' => 'Popular Venues',
  ], $atts);

  $city = sanitize_text_field(oc_integration_organizer_scope());
  $limit = max(1, min(24, (int) $atts['limit']));
  $source_limit = max($limit, min(400, (int) $atts['source_limit']));
  $show_raw = array_filter(array_map('trim', explode(',', strtolower((string) $atts['show']))));
  $show = !empty($show_raw) ? array_values(array_unique($show_raw)) : ['categories', 'organizers', 'venues'];

  $events = oc_events_grid_fetch_server_events($city, oc_integration_get_api_base(), '/events/', $source_limit);
  $groups = oc_popular_links_collect_groups($events, $limit);

  ob_start();
  ?>
  <div class="oc-popular-links-wrap">
    <?php if (in_array('categories', $show, true)) oc_popular_links_render_group((string) $atts['title_categories'], $groups['categories'], 'category'); ?>
    <?php if (in_array('organizers', $show, true)) oc_popular_links_render_group((string) $atts['title_organizers'], $groups['organizers'], 'organizer'); ?>
    <?php if (in_array('venues', $show, true)) oc_popular_links_render_group((string) $atts['title_venues'], $groups['venues'], 'venue'); ?>
  </div>
  <style>
    .oc-popular-links-wrap{
      display:grid;
      gap: 34px;
    }
    .oc-popular-links-group h3{
      margin: 30px 0 15px;
      color: rgb(74, 74, 74);
      font-family: Poppins, sans-serif;
      font-size: 32px;
      line-height: 35.2px;
      font-weight: 600;
      letter-spacing: 0;
      text-align: left;
    }
    .oc-popular-links-pills{
      display:flex;
      flex-wrap:wrap;
      gap: 14px 16px;
    }
    .oc-popular-links-pill{
      display:inline-flex;
      align-items:center;
      gap: 10px;
      min-height: 44px;
      padding: 0 16px;
      border-radius: 999px;
      background:#fff;
      color:#111 !important;
      text-decoration:none;
      font-weight: 600;
      font-size: 15px;
      line-height: 1.2;
      box-shadow: 0 1px 0 rgba(17,24,39,.05), 0 10px 24px rgba(17,24,39,.05);
      transition: transform .16s ease, box-shadow .16s ease, color .16s ease;
    }
    .oc-popular-links-pill:hover{
      color:#111 !important;
      text-decoration:none;
      transform: translateY(-1px);
      box-shadow: 0 2px 0 rgba(17,24,39,.06), 0 14px 28px rgba(17,24,39,.08);
    }
    .oc-popular-links-pill span{
      color: inherit !important;
    }
    .oc-popular-links-pill__icon{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      flex: 0 0 auto;
      color:#111;
      line-height:1;
    }
    .oc-popular-links-pill__icon svg{
      width: 14px;
      height: 14px;
      display:block;
      fill: currentColor;
    }
    @media (max-width: 700px){
      .oc-popular-links-wrap{ gap: 28px; }
      .oc-popular-links-group h3{ margin-bottom: 14px; }
      .oc-popular-links-pills{ gap: 12px; }
      .oc-popular-links-pill{
        width: 100%;
        justify-content: space-between;
      }
    }
  </style>
  <?php
  return ob_get_clean();
}

function oc_category_section_default_categories() {
  return [
    'Workshops & Classes',
    'Live Music',
    'Community Events',
    'Seasonal & Holiday',
    'Arts & Culture',
    'Nightlife',
  ];
}

function oc_category_section_clean_text($value) {
  $value = trim(wp_strip_all_tags((string) $value));
  $value = trim($value);

  $leading_quotes = ['"', "'", '`', '“', '”', '‘', '’'];
  while ($value !== '' && in_array(mb_substr($value, 0, 1), $leading_quotes, true)) {
    $value = trim(mb_substr($value, 1));
  }

  while ($value !== '' && in_array(mb_substr($value, -1, 1), $leading_quotes, true)) {
    $value = trim(mb_substr($value, 0, mb_strlen($value) - 1));
  }

  return preg_replace('/\s+/', ' ', trim((string) $value));
}

function oc_category_section_parse_categories($raw) {
  if (is_array($raw)) {
    $items = $raw;
  } else {
    $items = preg_split('/\s*,\s*/', (string) $raw);
  }

  $out = [];
  foreach ((array) $items as $item) {
    $label = oc_category_section_clean_text($item);
    if ($label === '') continue;
    $out[strtolower($label)] = $label;
  }

  return array_values($out);
}

function oc_category_section_pattern_background($label) {
  $colors = oc_integration_get_color_tokens();
  $base = trim((string) ($colors['base'] ?? '#3fabd1'));
  $dark = trim((string) ($colors['dark'] ?? '#2e8fb0'));
  return 'background: linear-gradient(135deg, ' . $dark . ' 0%, ' . $base . ' 100%)';
}

function oc_category_section_collect_cards($events, $categories) {
  $cards = [];
  $wanted = [];
  foreach ((array) $categories as $category) {
    $label = oc_category_section_clean_text($category);
    if ($label === '') continue;
    $key = strtolower($label);
    $wanted[$key] = $label;
    $cards[$key] = [
      'label' => $label,
      'url' => oc_integration_get_category_grid_url($label),
      'image' => '',
    ];
  }

  foreach ((array) $events as $event) {
    if (!is_array($event)) continue;
    $event_categories = $event['categories'] ?? [];
    if (!is_array($event_categories)) continue;

    $image = oc_events_grid_normalize_image($event['imageUrl'] ?? $event['image'] ?? $event['imageURL'] ?? '');

    foreach ($event_categories as $event_category) {
      $event_category = oc_category_section_clean_text($event_category);
      if ($event_category === '') continue;
      $key = strtolower($event_category);
      if (!isset($wanted[$key])) continue;
      if ($cards[$key]['image'] !== '') continue;
      if ($image === '') continue;
      $cards[$key]['image'] = $image;
    }
  }

  return array_values(array_filter($cards, function ($card) {
    return !empty($card['label']) && !empty($card['url']);
  }));
}

function oc_category_section_shortcode($atts) {
  $atts = shortcode_atts([
    'city' => oc_integration_get_default_area(),
    'title' => 'Explore Categories',
    'categories' => implode(', ', oc_category_section_default_categories()),
    'columns' => 3,
    'source_limit' => 200,
  ], $atts, 'opencircle_category_section');

  $city = sanitize_text_field((string) $atts['city']);
  if ($city === '') $city = oc_integration_get_default_area();

  $title = html_entity_decode(oc_category_section_clean_text($atts['title']), ENT_QUOTES | ENT_HTML5, 'UTF-8');
  if ($title === '') $title = 'Explore Categories';

  $columns = max(1, min(4, (int) $atts['columns']));
  $source_limit = max(10, min(400, (int) $atts['source_limit']));
  $categories = oc_category_section_parse_categories((string) $atts['categories']);
  if (empty($categories)) $categories = oc_category_section_default_categories();

  $events = oc_events_grid_fetch_server_events($city, oc_integration_get_api_base(), '/events/', $source_limit, 'upcoming');
  $cards = oc_category_section_collect_cards($events, $categories);
  if (empty($cards)) return '';

  $uid = 'oc-category-section-' . wp_generate_uuid4();

  ob_start();
  ?>
  <section id="<?php echo esc_attr($uid); ?>" class="oc-category-section" style="--oc-category-columns: <?php echo (int) $columns; ?>;">
    <h2 class="oc-category-section__title"><?php echo esc_html($title); ?></h2>
    <div class="oc-category-section__grid">
      <?php foreach ($cards as $card): ?>
        <?php
          $label = html_entity_decode(oc_category_section_clean_text($card['label'] ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
          $url = trim((string) ($card['url'] ?? ''));
          if ($label === '' || $url === '') continue;
          $background = oc_category_section_pattern_background($label);
        ?>
        <a class="oc-category-section__card" href="<?php echo esc_url($url); ?>" style="<?php echo esc_attr($background); ?>">
          <span class="oc-category-section__label"><?php echo esc_html(strtoupper($label)); ?></span>
        </a>
      <?php endforeach; ?>
    </div>
  </section>
  <style>
    #<?php echo esc_html($uid); ?>{
      display:grid;
      gap: 26px;
    }
    #<?php echo esc_html($uid); ?> .oc-category-section__title{
      margin: 30px 0 15px;
      color: #4a4a4a;
      font-family: Poppins, sans-serif;
      font-size: 2rem;
      line-height: 1.1;
      font-weight: 600;
      letter-spacing: 0;
      text-align: left;
    }
    #<?php echo esc_html($uid); ?> .oc-category-section__grid{
      display:grid;
      grid-template-columns: repeat(var(--oc-category-columns), minmax(0, 1fr));
      gap: 22px 28px;
    }
    #<?php echo esc_html($uid); ?> .oc-category-section__card{
      position:relative;
      display:flex;
      align-items:center;
      justify-content:center;
      min-height: 76px;
      padding: 14px 16px;
      border-radius: 6px;
      border: none;
      overflow:hidden;
      text-decoration:none;
      box-shadow: inset 0 0 0 2px rgba(255,255,255,.92), inset 0 0 0 6px rgba(255,255,255,.12);
      transition: transform .18s ease, box-shadow .18s ease;
      isolation:isolate;
    }
    #<?php echo esc_html($uid); ?> .oc-category-section__card:hover{
      transform: translateY(-2px);
      box-shadow: inset 0 0 0 2px rgba(255,255,255,.92), inset 0 0 0 6px rgba(255,255,255,.12), 0 12px 30px rgba(15, 23, 42, .12);
      text-decoration:none;
    }
    #<?php echo esc_html($uid); ?> .oc-category-section__label{
      position:relative;
      z-index:1;
      color:#fff;
      text-align:center;
      font-family:Poppins, sans-serif;
      font-size: 18px;
      line-height:1.2;
      font-weight:700;
      letter-spacing:.02em;
      text-transform:uppercase;
      text-wrap:balance;
    }
    @media (max-width: 1100px){
      #<?php echo esc_html($uid); ?> .oc-category-section__grid{
        grid-template-columns: repeat(min(2, var(--oc-category-columns)), minmax(0, 1fr));
      }
    }
    @media (max-width: 700px){
      #<?php echo esc_html($uid); ?> .oc-category-section__grid{
        grid-template-columns: 1fr;
        gap: 14px;
      }
      #<?php echo esc_html($uid); ?> .oc-category-section__card{
        min-height: 68px;
      }
    }
  </style>
  <?php
  return ob_get_clean();
}

function oc_events_grid_fetch_server_events($city, $api, $event_base, $limit = 80, $mode = 'upcoming') {
  $mode = strtolower(trim((string)$mode));
  if (!in_array($mode, ['upcoming', 'past'], true)) $mode = 'upcoming';
  $cache_key = oc_events_grid_cache_key($city, $api, $event_base, $mode);
  $cached = get_transient($cache_key);
  if (is_array($cached)) return $cached;

  $city = trim((string)$city);
  $api = rtrim((string)$api, '/');
  if ($city === '' || $api === '') return [];

  $combined = [];
  $offset = 0;
  $loops = 0;
  $page_limit = 100;
  $seen = [];
  $now = new DateTimeImmutable('now', wp_timezone());
  $sort = $mode === 'past' ? 'latest' : 'soonest';

  while ($loops < 5 && count($combined) < $limit) {
    if ($mode === 'past') {
      $page = oc_events_grid_fetch_archive_api_page($api, $city, $page_limit, $offset);
      if (empty($page['ok'])) break;
      $rows = isset($page['rows']) && is_array($page['rows']) ? $page['rows'] : [];
      $meta = isset($page['meta']) && is_array($page['meta']) ? $page['meta'] : [];
    } else {
      $url = add_query_arg([
        'city' => $city,
        'expand' => 1,
        'limit' => $page_limit,
        'offset' => $offset,
        'sort' => $sort,
      ], $api . '/events');

      $res = wp_remote_get($url, [
        'timeout' => 12,
        'headers' => ['Accept' => 'application/json'],
      ]);

      if (is_wp_error($res)) break;

      $code = (int) wp_remote_retrieve_response_code($res);
      $body = wp_remote_retrieve_body($res);
      $json = json_decode($body, true);

      if ($code < 200 || $code >= 300 || !is_array($json)) break;

      $rows = isset($json['data']) && is_array($json['data']) ? $json['data'] : [];
      $meta = isset($json['meta']) && is_array($json['meta']) ? $json['meta'] : [];
    }

    foreach ($rows as $event) {
      if (!is_array($event)) continue;
      if (!oc_events_grid_event_matches_mode($event, $mode, $now)) continue;

      $series_key = trim((string)($event['recurrenceId'] ?? $event['seriesId'] ?? $event['seriesKey'] ?? $event['parentId'] ?? ''));
      if ($series_key === '') {
        $slug = trim((string)($event['slug'] ?? ''));
        if ($slug !== '') {
          $series_key = 'slug:' . strtolower($slug);
        } else {
          $series_key = 'event:' . trim((string)($event['id'] ?? ''));
        }
      }

      if ($series_key === '' || isset($seen[$series_key])) continue;
      $seen[$series_key] = true;

      $combined[] = $event;
      if (count($combined) >= $limit) break 2;
    }

    $loops += 1;
    $has_more = !empty($meta['hasMore']);
    $next_offset = isset($meta['nextOffset']) ? (int) $meta['nextOffset'] : ($offset + count($rows));

    if (!$has_more || empty($rows) || $next_offset <= $offset) break;
    $offset = $next_offset;
  }

  set_transient($cache_key, $combined, 300);
  return $combined;
}

function oc_events_grid_fallback_item_label($event) {
  $dt = oc_events_grid_event_datetime($event);
  if (!$dt || empty($dt['start'])) return '';

  $start = $dt['start'];
  $date = wp_date('F j, Y', $start->getTimestamp(), wp_timezone());
  $time = wp_date('g:i A', $start->getTimestamp(), wp_timezone());
  $location = trim((string)($event['location'] ?? ''));

  $parts = [$date, $time];
  if ($location !== '') $parts[] = $location;

  return implode(' · ', $parts);
}

function oc_events_grid_render_fallback_items($events, $event_base) {
  if (empty($events) || !is_array($events)) return;
  ?>
  <ul class="oc-fallback-list">
    <?php foreach ($events as $event): ?>
      <?php
      if (!is_array($event)) continue;
      $title = trim((string)($event['title'] ?? ''));
      $url = oc_events_grid_event_url($event, $event_base);
      $meta = oc_events_grid_fallback_item_label($event);
      if ($title === '' || $url === '') continue;
      ?>
      <li class="oc-fallback-item">
        <a href="<?php echo esc_url($url); ?>"><?php echo esc_html($title); ?></a>
        <?php if ($meta !== ''): ?>
          <span><?php echo esc_html($meta); ?></span>
        <?php endif; ?>
      </li>
    <?php endforeach; ?>
  </ul>
  <?php
}

function oc_events_grid_main_heading($city) {
  $city = trim((string)$city);
  if ($city === '') $city = oc_integration_get_default_area();
  return sprintf('Upcoming Events in %s, WA', $city);
}

function oc_events_grid_intro_copy($city) {
  $city = trim((string)$city);
  if ($city === '') $city = oc_integration_get_default_area();
  return sprintf(
    'Looking for upcoming events in %s, WA? Browse our local event calendar to find festivals, live music, markets, family activities, workshops, fundraisers, and community events happening soon.',
    $city
  );
}

function oc_events_grid_archive_heading($city) {
  $city = trim((string)$city);
  if ($city === '') $city = oc_integration_get_default_area();
  return sprintf('Past Events in %s, WA', $city);
}

function oc_events_grid_archive_intro_copy($city) {
  $city = trim((string)$city);
  if ($city === '') $city = oc_integration_get_default_area();
  return sprintf(
    'Browse past events in %s, WA, including festivals, live music, markets, family activities, workshops, fundraisers, and community events from the OpenCircle archive.',
    $city
  );
}

function oc_events_grid_page_city_from_content($content) {
  $content = (string)$content;
  if ($content === '') return '';

  $tags = [
    'opencircle_events_grid',
    'opencircle_past_events_grid',
    'oc_events_slider',
    'oc_featured_slider',
    'oc_featured_hero',
    'opencircle_jobs',
    'opencircle_popular_links',
    'opencircle_category_cards',
  ];

  foreach ($tags as $tag) {
    if (!has_shortcode($content, $tag)) continue;
    if (preg_match('/\[' . preg_quote($tag, '/') . '\b([^\]]*)\]/i', $content, $matches)) {
      $attrs = shortcode_parse_atts($matches[1]);
      if (is_array($attrs) && !empty($attrs['city'])) {
        return sanitize_text_field($attrs['city']);
      }
    }
  }

  return oc_integration_get_default_area();
}

function oc_events_grid_current_page_city($post_id = 0) {
  if (is_admin() || !is_singular()) return '';

  $target_id = $post_id ? (int) $post_id : (int) get_queried_object_id();
  if ($target_id <= 0) return '';

  $post = get_post($target_id);
  if (!$post || $post->post_type !== 'page') return '';

  return oc_events_grid_page_city_from_content($post->post_content);
}

function oc_events_grid_render_shortcode($atts, $mode = 'upcoming') {
  $atts = shortcode_atts([
    'city'       => oc_integration_get_default_area(),
    'limit'      => 12,
    'api'        => OC_API_BASE,
    'event_base' => '/events/', // ✅ NEW: where virtual single pages live
    'organizer'  => '',
    'venue'      => '',
  ], $atts);
  $mode = strtolower(trim((string)$mode));
  if (!in_array($mode, ['upcoming', 'past'], true)) $mode = 'upcoming';

  $city  = sanitize_text_field($atts['city']);
  $limit = max(1, intval($atts['limit']));
  $api   = rtrim(esc_url_raw($atts['api']), '/');
  $organizer = sanitize_text_field($atts['organizer']);
  $venue = sanitize_text_field($atts['venue']);
  if (isset($_GET['city']) && wp_unslash($_GET['city']) !== '') {
    $city = sanitize_text_field(wp_unslash($_GET['city']));
  }
  if ($organizer === '' && isset($_GET['organizer'])) {
    $organizer = sanitize_text_field(wp_unslash($_GET['organizer']));
  }
  if ($venue === '' && isset($_GET['venue'])) {
    $venue = sanitize_text_field(wp_unslash($_GET['venue']));
  }
  $organizer_venue_url = '';
  if ($organizer !== '' && function_exists('oc_fetch_venue_match_for_location') && function_exists('oc_venue_page_url')) {
    $organizer_venue_match = oc_fetch_venue_match_for_location($organizer, $city);
    if (is_array($organizer_venue_match)) {
      $organizer_venue_key = trim((string)($organizer_venue_match['slug'] ?? ''));
      if ($organizer_venue_key === '') $organizer_venue_key = trim((string)($organizer_venue_match['id'] ?? ''));
      if ($organizer_venue_key !== '') {
        $organizer_venue_url = oc_venue_page_url($organizer_venue_key);
      }
    }
  }

  // Normalize event_base: must start/end with /
  $event_base = trim((string)$atts['event_base']);
  if ($event_base === '') $event_base = '/events/';
  if ($event_base[0] !== '/') $event_base = '/' . $event_base;
  if (substr($event_base, -1) !== '/') $event_base .= '/';

  // Page from URL (shareable)
  $pg = isset($_GET['pg']) ? max(1, intval($_GET['pg'])) : 1;
  $offset = ($pg - 1) * $limit;

  // Fallback image:
  $placeholder = 'https://via.placeholder.com/1200x675.png?text=Event';
  $initial_payload = oc_events_grid_fetch_initial_page($city, $api, $limit, $offset, $mode, $event_base);
  $initial_events = isset($initial_payload['events']) && is_array($initial_payload['events']) ? $initial_payload['events'] : [];
  $initial_total = max(0, (int) ($initial_payload['total'] ?? 0));
  $initial_total_pages = max(1, (int) ($initial_payload['total_pages'] ?? 1));

  // Enqueue script ONLY when shortcode is used
  wp_enqueue_script('oc-events-grid');

  // Unique wrapper id
  $uid = 'oc_events_' . wp_generate_uuid4();

  ob_start();
  ?>
<div id="<?php echo esc_attr($uid); ?>"
     class="oc-events-wrap"
     data-api="<?php echo esc_attr($api); ?>"
     data-city="<?php echo esc_attr($city); ?>"
     data-trending-threshold="<?php echo esc_attr((string) oc_integration_trending_threshold()); ?>"
     data-limit="<?php echo esc_attr($limit); ?>"
     data-offset="<?php echo esc_attr($offset); ?>"
     data-total="<?php echo esc_attr($initial_total); ?>"
     data-total-pages="<?php echo esc_attr($initial_total_pages); ?>"
     data-placeholder="<?php echo esc_attr($placeholder); ?>"
     data-event-base="<?php echo esc_attr($event_base); ?>"
     data-organizer="<?php echo esc_attr($organizer); ?>"
     data-mode="<?php echo esc_attr($mode); ?>">

  <?php if ($organizer === ''): ?>
    <div class="oc-events-hub-intro">
      <h1><?php echo esc_html($mode === 'past' ? oc_events_grid_archive_heading($city) : oc_events_grid_main_heading($city)); ?></h1>
      <p><?php echo esc_html($mode === 'past' ? oc_events_grid_archive_intro_copy($city) : oc_events_grid_intro_copy($city)); ?></p>
    </div>
  <?php endif; ?>

  <div class="oc-controls">

    <div class="oc-search">
      <div class="oc-label">SEARCH</div>
      <div class="oc-search-row">
        <input class="oc-input" type="text" placeholder="Search events..." />
        <button class="oc-btn oc-btn-primary" type="button">SEARCH</button>
      </div>
    </div>

    <div class="oc-filters">
      <div class="oc-label">SORT BY</div>
      <div class="oc-filter-row">
        <select class="oc-select oc-sort">
          <option value="soonest"<?php selected($mode === 'upcoming'); ?>>Event Date (Soonest)</option>
          <option value="latest"<?php selected($mode === 'past'); ?>>Event Date (Latest)</option>
          <option value="trending_week">Trending This Week</option>
          <option value="recent">Recently Added</option>
          <option value="featured">Featured Events</option>
        </select>

        <select class="oc-select oc-category" disabled>
          <option value="">All Categories</option>
        </select>

        <select class="oc-select oc-date">
          <option value="any">Any Date</option>
          <option value="today">Today</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
        </select>

        <div class="oc-view">
          <button class="oc-icon-btn oc-view-list" type="button" aria-label="List view">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
          </button>
          <button class="oc-icon-btn oc-view-grid is-active" type="button" aria-label="Grid view">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>

  </div>

  <?php if ($organizer !== ''): ?>
    <div class="oc-organizer-bar">
      <div class="oc-organizer-copy">
        Showing events by <strong><?php echo esc_html($organizer); ?></strong>
      </div>
      <?php if ($organizer_venue_url !== ''): ?>
        <a class="oc-organizer-venue-link" href="<?php echo esc_url($organizer_venue_url); ?>">View Venue</a>
      <?php endif; ?>
    </div>
  <?php endif; ?>

  <?php if ($venue !== ''): ?>
    <div class="oc-organizer-bar">
      <div class="oc-organizer-copy">
        Showing events at <strong><?php echo esc_html($venue); ?></strong>
      </div>
    </div>
  <?php endif; ?>

<?php
  // initial page from URL
  $pg = isset($_GET['pg']) ? max(1, intval($_GET['pg'])) : 1;
?>
<!-- Pagination ABOVE grid (below forms) -->
<div class="oc-pagination oc-pagination-top" data-oc-pager="top">
  <button class="oc-btn oc-page-btn oc-page-first" type="button">First</button>
  <button class="oc-btn oc-page-btn oc-page-prev" type="button">Prev</button>

  <div class="oc-page-mid" aria-live="polite">
    <span class="oc-page-label">Page</span>
    <input class="oc-page-input" type="number" min="1" step="1" value="<?php echo esc_attr($pg); ?>" inputmode="numeric" />
    <span class="oc-page-of">of</span>
    <span class="oc-page-total"><?php echo esc_html($initial_total_pages); ?></span>
  </div>

  <button class="oc-btn oc-page-btn oc-page-next" type="button">Next</button>
  <button class="oc-btn oc-page-btn oc-page-last" type="button">Last</button>
</div>

<div class="oc-grid" role="list"><?php oc_events_grid_render_initial_cards($initial_events, $event_base, $mode); ?></div>

<!-- Pagination BELOW grid -->
<div class="oc-pagination oc-pagination-bottom" data-oc-pager="bottom">
  <button class="oc-btn oc-page-btn oc-page-first" type="button">First</button>
  <button class="oc-btn oc-page-btn oc-page-prev" type="button">Prev</button>

  <div class="oc-page-mid" aria-live="polite">
    <span class="oc-page-label">Page</span>
    <input class="oc-page-input" type="number" min="1" step="1" value="<?php echo esc_attr($pg); ?>" inputmode="numeric" />
    <span class="oc-page-of">of</span>
    <span class="oc-page-total"><?php echo esc_html($initial_total_pages); ?></span>
  </div>

  <button class="oc-btn oc-page-btn oc-page-next" type="button">Next</button>
  <button class="oc-btn oc-page-btn oc-page-last" type="button">Last</button>
</div>


</div>

  <style>

.oc-pagination{
  display:flex;
  align-items:center;
  justify-content:center;
  gap: 14px;
  margin-top: 18px;
}

.oc-pagination-top{
  margin-top: 6px;
  margin-bottom: 18px;
}

.oc-page-mid{
  display:flex;
  align-items:center;
  justify-content:center;
  gap: 10px;
  color:#777;
  font-size: 10pt;
  min-width: 220px;
}

.oc-page-input{
  padding: 0 12px;
  border: 1px solid #a5a5a5;
  border-radius: 5px;
  background: #fff;
  color: #a5a5a5;
  font-size: 10pt;
  text-align: center;
}

.oc-page-total{
  min-width: 36px;
  text-align: left;
}

.oc-page-btn.is-disabled,
.oc-page-btn:disabled{
  opacity: .55;
  cursor: not-allowed;
}


    .oc-grid-badges{
      position:absolute;
      top:12px;
      right:12px;
      display:flex;
      align-items:center;
      gap:8px;
      z-index:2;
    }
    .oc-grid-badge{
      width: 42px;
      height: 42px;
      border-radius: 10px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      color:#fff;
      line-height:1;
      box-shadow: 0 8px 20px rgba(15,23,42,.16);
    }
    .oc-grid-badge svg{
      width: 18px;
      height: 18px;
      display:block;
      fill: currentColor;
    }
    .oc-grid-badge--featured{
      background:var(--oc-accent, #3fabd1);
    }
    .oc-grid-badge--trending{
      background:#f28c28;
    }
    .oc-grid-badge--happening{
      width:auto;
      min-width: 42px;
      padding: 0 12px;
      background:#16a34a;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }

    .oc-controls { margin-bottom: 22px; }
    .oc-label {
      margin-bottom: 10px;
      font-weight: 400;
      font-size: 9pt !important;
      text-transform: uppercase !important;
    }
    .oc-search { margin-bottom: 18px; }
    .oc-organizer-bar{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 16px;
      margin: 0 0 18px;
      padding: 14px 16px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      background: #f8fafc;
    }
    .oc-organizer-copy{
      color:#111827;
      font-size: 0.98rem;
      line-height: 1.4;
    }
    .oc-organizer-copy strong{
      font-weight: 700;
      color:#111;
    }
    .oc-organizer-venue-link{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height: 40px;
      padding: 0 18px;
      border: 1px solid #a5a5a5;
      border-radius: 5px;
      background: #fff;
      color:#111;
      text-decoration:none;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .oc-organizer-venue-link:hover{
      border-color:#111;
      color:#111;
      text-decoration:none;
    }
    .oc-events-fallback{
      margin: 0 0 18px;
      padding: 0 0 2px;
      color:#111827;
    }
    .oc-events-fallback-grid{
      display:grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px 28px;
      align-items: start;
    }
    .oc-events-fallback-col{
      min-width: 0;
    }
    .oc-events-hub-intro{
      margin: 0 0 26px;
      color:#111827;
    }
    .oc-events-hub-intro h1,
    .oc-events-fallback h2{
      margin: 0 0 10px;
      color:#111;
      letter-spacing:-0.03em;
    }
    .oc-events-hub-intro h1{
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 1.05;
      font-weight: 700;
    }
    .oc-events-fallback h2{
      font-size: 1.15rem;
      line-height: 1.15;
      font-weight: 700;
    }
    .oc-events-hub-intro p{
      max-width: 760px;
      margin: 0 0 18px;
      color:#374151;
      font-size: 1rem;
      line-height: 1.65;
    }
    .oc-fallback-list{
      margin: 0;
      padding: 0;
      list-style: none;
      display:grid;
      gap: 5px;
    }
    .oc-fallback-item{
      display:flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 4px 0;
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .oc-fallback-item a{
      color:#111;
      font-weight: 600;
      text-decoration: none;
    }
    .oc-fallback-item a:hover{
      text-decoration: underline;
    }
    .oc-fallback-item span{
      color:#6b7280;
      font-size: 0.9rem;
      line-height: 1.45;
    }
    .oc-search-row {
      display: flex;
      gap: 14px;
      align-items: stretch;
      margin: 0 0 16px;
      font-size: 9pt !important;
    }
    .oc-input {
      box-sizing: border-box;
      display: block;
      flex: 1;
      min-width: 180px;
      width: 100%;
      min-height: 40px !important;
      height: 40px !important;
      margin: 0 !important;
      padding: 0 14px !important;
      border: 1px solid #a5a5a5;
      border-radius: 5px !important;
      color: #a5a5a5;
      background: #fff;
      font-size: 9pt !important;
      line-height: 1.2 !important;
      appearance: none;
      -webkit-appearance: none;
    }
    .oc-input::placeholder { color: #a5a5a5; }

    .oc-btn-primary,
    .oc-page-btn {
      box-sizing: border-box;
      height: 40px;
      padding: 0 22px;
      font-size: 9pt !important;
      border: 1px solid #a5a5a5;
      border-radius: 5px;
      background: #fff;
      color: #a5a5a5;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      letter-spacing: normal;
      cursor: pointer;
      transition: all 0.15s ease;
      appearance: none;
      -webkit-appearance: none;
    }
    .oc-search-row .oc-btn-primary{
      flex: 0 0 auto;
      min-width: 120px;
      min-height: 40px;
      height: 40px;
      margin: 0 !important;
      white-space: nowrap;
    }
    .oc-btn-primary:hover,
    .oc-page-btn:hover {
      background-color: #a5a5a5;
      border-color: #a5a5a5;
      color: #fff;
    }
    .oc-page-btn:disabled{
      opacity: .55;
      cursor: not-allowed;
    }

    .oc-filter-row {
      display:flex;
      align-items:center;
      gap: 18px;
      flex-wrap: nowrap;
    }

    .oc-select {
      height: 40px;
      font-size: 9pt !important;
      border-radius: 5px;
      min-width: 320px;
      padding: 0 14px !important;
      background: #fff;
    }
    .oc-select:disabled { opacity: .6; }

    .oc-view {
      margin-left: auto;
      display:flex;
      gap: 12px;
    }
    .oc-icon-btn {
      width: 40px;
      height: 40px;
      border-radius: 5px;
      border: 1px solid #a5a5a5;
      background: #fff;
      color: #a5a5a5;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:0;
      cursor:pointer;
      transition: all 0.15s ease;
    }
    .oc-icon-btn:hover {
      background-color: #a5a5a5;
      border-color: #a5a5a5;
      color: #fff;
    }
    .oc-icon-btn.is-active {
      background: #a5a5a5;
      border-color: #a5a5a5;
      color: #fff;
    }
    .oc-icon-btn svg{
      display:block;
      width:18px;
      height:18px;
      flex:0 0 18px;
    }

    @media (max-width: 1100px){
      .oc-filter-row{ flex-wrap: wrap; }
      .oc-select{ min-width: 240px; }
      .oc-input{ min-width: 240px; }
      .oc-organizer-bar{
        flex-direction: column;
        align-items: flex-start;
      }
      .oc-events-fallback-grid{
        grid-template-columns: 1fr;
        gap: 12px;
      }
      .oc-fallback-item{
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }
    }

    .oc-card-link{
      text-decoration: none;
      color: inherit;
      display: block;
    }
    .oc-card-link:hover .oc-title{ text-decoration: underline; }
    .oc-card-link:focus-visible{
      outline: 2px solid var(--oc-accent-focus, #2ea7ff);
      outline-offset: 4px;
    }

    .oc-grid {
      display:grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 22px;
    }
    @media (max-width: 1200px){ .oc-grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 900px){ .oc-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 640px){ .oc-grid { grid-template-columns: 1fr; } }

    .oc-card {
      background:#fff;
      border-radius: 4px;
      overflow:hidden;
      box-shadow: none;
    }

    .oc-media { position: relative; }
    .oc-thumb {
      width:100%;
      aspect-ratio: 16/9;
      object-fit: cover;
      display:block;
      border-radius: 4px;
      background: #e9e9e9;
    }

    .oc-badge {
      position: absolute;
      left: 14px;
      top: 14px;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      background: rgba(255,255,255,.92);
      color: #111;
      border-radius: 4px;
      padding: 8px 10px;
      font-weight: 800;
      font-size: 12px;
      letter-spacing: .02em;
      line-height: 1;
      text-align: center;
      z-index: 2;
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
    .oc-badge .oc-badge-day { font-size: 18px; line-height: 1; }
    .oc-badge .oc-badge-mon { font-size: 12px; line-height: 1.1; opacity: .75; margin-top: 2px; }

    .oc-body { padding: 15px 0 0; }
    .oc-title {
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

    .oc-meta {
      display:flex;
      gap:10px;
      align-items:center;
      color:#777;
      font-size: 0.9231rem;
      line-height: 0.9231rem;
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
    .oc-meta .oc-ico svg {
      display:block !important;
      flex: 0 0 18px;
      width: 18px !important;
      min-width: 18px !important;
      max-width: 18px !important;
      height: 18px !important;
      min-height: 18px !important;
      max-height: 18px !important;
    }

    .oc-grid.is-list { grid-template-columns: 1fr; }
    .oc-grid.is-list .oc-card { display:flex; gap:16px; }
    .oc-grid.is-list .oc-thumb { width: 340px; aspect-ratio: 16/9; }
    @media (max-width: 900px){
      .oc-grid.is-list .oc-card { display:block; }
      .oc-grid.is-list .oc-thumb { width:100%; }
    }

    .oc-pagination{
      display:flex;
      align-items:center;
      justify-content:center;
      gap: 14px;
      margin-top: 18px;
    }
    .oc-page-info{
      font-size: 10pt;
      color: #777;
      min-width: 140px;
      text-align:center;
    }
    /* --- Minimal, right-aligned, consistent height pagination --- */
.oc-pagination{
  display:flex;
  align-items:center;
  justify-content:flex-end;   /* right justify */
  gap: 10px;
  margin-top: 18px;
}

.oc-pagination-top{
  margin-top: 6px;
  margin-bottom: 18px;
}

.oc-page-mid{
  display:flex;
  align-items:center;
  gap: 8px;
  color:#777;
  font-size: 10pt;
  min-width: unset;          /* remove big center spacing */
}

.oc-page-label,
.oc-page-of{
  white-space: nowrap;
}

/* Make ALL controls the same height + more minimal */
.oc-page-btn,
.oc-page-input{
  height: 40px !important;
  border-radius: 5px;
  border: 1px solid #a5a5a5;
  background: #fff;
}

/* Buttons: more minimal (smaller padding/weight) */
.oc-page-btn{
  padding: 0 14px !important;
  font-size: 9pt !important;
  font-weight: 400;
  color: #a5a5a5;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  line-height: 1;
  cursor:pointer;
  transition: all 0.15s ease;
}

.oc-page-btn:hover{
  background-color: #a5a5a5;
  border-color: #a5a5a5;
  color: #fff;
}

.oc-page-btn:disabled{
  opacity: .45;
  cursor: not-allowed;
}

/* Input: compact + same height as buttons */
.oc-page-input{
  width: 15px;               /* smaller */
  padding: 0 10px;
  text-align: center;
  color: #a5a5a5;
  font-size: 10pt;
  outline: none;
}

/* Total: tight */
.oc-page-total{
  min-width: 0;
  white-space: nowrap;
}

/* Narrow the page number input */
.oc-page-input{
  width: 44px !important;   /* was 64px */
  min-width: 44px !important;
  padding: 0 6px !important;
  text-align: center;
}

/* Optional: tighten gaps a bit more so it stays compact */
.oc-pagination{ gap: 8px; }
.oc-page-mid{ gap: 6px; }


/* Mobile: allow wrapping but keep right alignment */
@media (max-width: 640px){
  .oc-pagination{
    flex-wrap: wrap;
    justify-content:flex-end;
  }
}

  </style>
  <?php
  return ob_get_clean();
}

function oc_events_grid_shortcode($atts) {
  return oc_events_grid_render_shortcode($atts, 'upcoming');
}

function oc_past_events_grid_shortcode($atts) {
  return oc_events_grid_render_shortcode($atts, 'past');
}

add_shortcode('opencircle_events_grid', 'oc_events_grid_shortcode');
add_shortcode('opencircle_past_events_grid', 'oc_past_events_grid_shortcode');
add_shortcode('opencircle_popular_event_links', 'oc_popular_links_shortcode');
add_shortcode('opencircle_category_section', 'oc_category_section_shortcode');

if (function_exists('oc_vep_on_activation')) {
  register_activation_hook(__FILE__, 'oc_vep_on_activation');
}
if (function_exists('oc_vep_on_deactivation')) {
  register_deactivation_hook(__FILE__, 'oc_vep_on_deactivation');
}
