<?php
/**
 * Module: OpenCircle Virtual Venue Pages
 * Description: Venue virtual pages extracted from virtual event pages module.
 */

if (!function_exists('oc_venue_format_time_12h')) {
  function oc_venue_format_time_12h($time_raw) {
    $t = trim((string)$time_raw);
    if ($t === '') return '';

    // Already 12-hour text; normalize am/pm casing.
    if (preg_match('/\b(am|pm)\b/i', $t)) {
      return strtolower($t);
    }

    $dt = DateTime::createFromFormat('H:i', $t);
    if (!$dt) $dt = DateTime::createFromFormat('H:i:s', $t);
    if (!$dt) return $t;

    return strtolower($dt->format('g:i A'));
  }
}

if (!function_exists('oc_venue_format_phone')) {
  function oc_venue_format_phone($phone_raw) {
    $digits = preg_replace('/\D+/', '', (string)$phone_raw);
    if (strlen($digits) === 11 && strpos($digits, '1') === 0) {
      $digits = substr($digits, 1);
    }
    if (strlen($digits) === 10) {
      return sprintf('(%s) %s-%s', substr($digits, 0, 3), substr($digits, 3, 3), substr($digits, 6, 4));
    }
    return trim((string)$phone_raw);
  }
}


if (!function_exists('oc_venue_format_date_range_label')) {
  function oc_venue_format_date_range_label($start_ts, $end_ts = 0, $tz = null) {
    $start_ts = (int)$start_ts;
    $end_ts = (int)$end_ts;
    if ($start_ts <= 0) return '';
    if (!$tz) $tz = wp_timezone();

    if ($end_ts <= 0) return wp_date('F j, Y', $start_ts, $tz);

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
}

if (!function_exists('oc_venue_linkify_description')) {
  function oc_venue_linkify_description($html, $address_raw = '', $phone_raw = '', $website_raw = '', $track_phone_url = '', $track_website_url = '') {
    $html = (string)$html;
    if ($html === '') return $html;
    // Preserve authored links.
    if (stripos($html, '<a ') !== false) return $html;

    $out = $html;

    $maps = oc_build_maps_link((string)$address_raw);
    $address = trim((string)$address_raw);
    if ($maps && $address !== '') {
      $quoted = preg_quote($address, '/');
      $out = preg_replace('/' . $quoted . '/u', '<a class="oc-map-link" href="' . esc_url($maps) . '" target="_blank" rel="noopener noreferrer">$0</a>', $out, 1);
    }

    $out = preg_replace_callback(
      '/(?:\+?1[\s\.-]?)?(?:\(\d{3}\)|\d{3})[\s\.-]\d{3}[\s\.-]\d{4}/',
      function ($m) use ($track_phone_url) {
        $text = (string)($m[0] ?? '');
        $digits = preg_replace('/\D+/', '', $text);
        if ($digits === '') return $text;
        if (strlen($digits) === 11 && strpos($digits, '1') === 0) $digits = substr($digits, 1);
        if (strlen($digits) !== 10) return $text;
        $href = trim((string)$track_phone_url) !== '' ? esc_url($track_phone_url) : ('tel:' . esc_attr($digits));
        return '<a class="oc-map-link oc-venue-link" href="' . $href . '">' . esc_html($text) . '</a>';
      },
      $out,
      1
    );

    $website = trim((string)$website_raw);
    if ($website !== '') {
      $host = (string)parse_url($website, PHP_URL_HOST);
      $host = preg_replace('/^www\./i', '', $host);
      $site_text = $host !== '' ? $host : preg_replace('#^https?://#i', '', $website);
      $site_text = trim((string)$site_text, " \t\n\r\0\x0B/");
      if ($site_text !== '') {
        $quoted = preg_quote($site_text, '/');
        $website_href = trim((string)$track_website_url) !== '' ? esc_url($track_website_url) : esc_url(oc_normalize_remote_url($website));
        $out = preg_replace('/\b' . $quoted . '\b/i', '<a class="oc-map-link" href="' . $website_href . '" target="_blank" rel="noopener noreferrer">$0</a>', $out, 1);
      }
    }

    return $out;
  }
}


/**
 * Render virtual venue page
 */
add_action('template_redirect', function () {
  $key = get_query_var('oc_venue_key');
  $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);

  if (!$key && $path && preg_match('#^/' . preg_quote(OC_VENUE_BASE, '#') . '/([^/]+)/?$#', $path, $m)) {
    $key = $m[1];
  }
  if (!$key) return;

  remove_action('template_redirect', 'redirect_canonical');

  $key = trim((string)$key);
  if ($key === '') return;

  $is_id = ctype_digit($key);
  $key_safe = $is_id ? $key : sanitize_title($key);
  if ($key_safe === '') return;

  $url = rtrim(OC_API_BASE, '/') . ($is_id
    ? '/venues/' . rawurlencode($key_safe)
    : '/venues/slug/' . rawurlencode($key_safe)
  );

  $res = wp_remote_get($url, [
    'timeout' => 12,
    'headers' => ['Accept' => 'application/json'],
  ]);

  if (is_wp_error($res)) {
    status_header(502);
    wp_die('Could not load venue from API.');
  }

  $json = json_decode(wp_remote_retrieve_body($res), true);
  $venue = $json['data'] ?? null;

  if (!$venue || !is_array($venue)) {
    status_header(404);
    wp_die('Venue not found.');
  }

  $venue_slug = trim((string)($venue['slug'] ?? ''));
  if ($is_id && $venue_slug !== '') {
    $preferred = home_url('/' . OC_VENUE_BASE . '/' . rawurlencode($venue_slug) . '/');
    $current_path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    $current = home_url($current_path);

    if (rtrim($preferred, '/') !== rtrim($current, '/')) {
      wp_redirect($preferred, 301);
      exit;
    }
  }

  $venue_name_raw = trim((string)($venue['name'] ?? 'Venue'));
  if ($venue_name_raw === '') $venue_name_raw = 'Venue';
  $title = esc_html($venue_name_raw);
  $address_raw = (string)($venue['address'] ?? '');
  $address = esc_html($address_raw);
  $website_raw = trim((string)($venue['website'] ?? ''));
  $website = oc_normalize_remote_url($website_raw);
  $phone_raw = trim((string)($venue['phone'] ?? ''));
  $phone = oc_venue_format_phone($phone_raw);
  $description = oc_render_rich_text($venue['description'] ?? '');

  $imageUrl = oc_normalize_remote_url((string)($venue['imageUrl'] ?? ''));

  $gallery_images_raw = $venue['galleryImages'] ?? [];
  if (!is_array($gallery_images_raw)) $gallery_images_raw = [];
  $gallery_images = [];
  foreach ($gallery_images_raw as $g) {
    $u = oc_normalize_remote_url((string)$g);
    if ($u === '') continue;
    if (in_array($u, $gallery_images, true)) continue;
    $gallery_images[] = $u;
    if (count($gallery_images) >= 3) break;
  }
  if ($imageUrl === '' && !empty($gallery_images)) {
    $imageUrl = $gallery_images[0];
  }

  $hero_images = [];
  if ($imageUrl !== '') {
    $hero_images[] = $imageUrl;
  }
  foreach ($gallery_images as $gimg) {
    if (in_array($gimg, $hero_images, true)) continue;
    $hero_images[] = $gimg;
    if (count($hero_images) >= 4) break;
  }

  $categories = $venue['categories'] ?? [];
  if (!is_array($categories)) $categories = [];
  $categories = array_values(array_filter(array_map(function($c){
    $c = trim((string)$c);
    return $c !== '' ? $c : null;
  }, $categories)));
  $categories = array_slice($categories, 0, 3);

  $hours = $venue['hours'] ?? [];
  if (!is_array($hours)) $hours = [];
  $social = $venue['social'] ?? [];
  if (!is_array($social)) $social = [];

  $venue_id = (string)($venue['id'] ?? '');
  $venue_key = $venue_slug !== '' ? $venue_slug : $venue_id;
  $venue_url = home_url('/' . OC_VENUE_BASE . '/' . rawurlencode($venue_key) . '/');

  $venue_api_base = rtrim((string)OC_API_BASE, '/');
  $venue_api_key  = rawurlencode($venue_key);
  $track_phone_url = ($venue_api_base !== '' && $venue_api_key !== '') ? ($venue_api_base . '/venues/' . $venue_api_key . '/out/phone') : '';
  $track_website_url = ($venue_api_base !== '' && $venue_api_key !== '') ? ($venue_api_base . '/venues/' . $venue_api_key . '/out/website') : '';

  $seo_title = trim((string)($venue['seoTitle'] ?? ''));
  $focus_keyphrase = trim((string)($venue['focusKeyphrase'] ?? ''));
  $meta_desc_raw = trim((string)($venue['metaDescription'] ?? ''));
  $api_excerpt_plain = trim((string) oc_integration_api_seo_field($venue, 'excerptPlainText', ''));
  $meta_desc = $meta_desc_raw !== '' ? $meta_desc_raw : ($api_excerpt_plain !== '' ? $api_excerpt_plain : wp_html_excerpt(trim(wp_strip_all_tags($venue['description'] ?? '')), 180, '…'));
  $image_alt = trim((string)($venue['imageAlt'] ?? ''));
  $canonical_url = oc_integration_api_seo_url($venue, $venue_url);
  $robots_state = oc_integration_api_robots_state($venue);
  $api_last_modified = trim((string) oc_integration_api_seo_field($venue, 'lastModified', ''));
  $api_structured_data = oc_integration_api_seo_field($venue, 'structuredData', null);
  $document_title = $seo_title !== '' ? $seo_title : $venue_name_raw;
  $description = oc_venue_linkify_description($description, $address_raw, $phone_raw, $website_raw, $track_phone_url, $track_website_url);
  oc_integration_apply_last_modified_header($api_last_modified);

  $upcoming = $venue['upcomingEvents'] ?? [];
  if (!is_array($upcoming)) $upcoming = [];

  add_filter('body_class', function ($classes) {
    $classes[] = 'single';
    $classes[] = 'single-venue';
    $classes[] = 'single-oc_venue';
    return $classes;
  });

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

  // Force common SEO plugins to use venue-level SEO fields on virtual venue pages.
  add_filter('wpseo_title', function () use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('wpseo_metadesc', function () use ($meta_desc) {
    return $meta_desc;
  }, 999);

  add_filter('wpseo_canonical', function ($url) use ($canonical_url) {
    return $canonical_url;
  }, 999);

  add_filter('wpseo_opengraph_title', function () use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('wpseo_opengraph_desc', function () use ($meta_desc) {
    return $meta_desc;
  }, 999);

  add_filter('wpseo_opengraph_url', function ($url) use ($canonical_url) {
    return $canonical_url;
  }, 999);

  add_filter('wpseo_opengraph_type', function () {
    return 'website';
  }, 999);

  add_filter('wpseo_twitter_title', function () use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('wpseo_twitter_description', function () use ($meta_desc) {
    return $meta_desc;
  }, 999);

  if ($imageUrl !== '') {
    add_filter('wpseo_twitter_image', function () use ($imageUrl) {
      return $imageUrl;
    }, 999);
  }

  add_filter('rank_math/frontend/title', function ($title) use ($document_title) {
    return $document_title;
  }, 999);

  add_filter('rank_math/frontend/description', function ($desc) use ($meta_desc) {
    return $meta_desc;
  }, 999);

  add_filter('rank_math/frontend/canonical', function ($url) use ($canonical_url) {
    return $canonical_url;
  }, 999);

  add_action('wp_head', function () use ($document_title, $meta_desc, $imageUrl, $image_alt, $canonical_url, $address_raw, $website_raw, $phone, $focus_keyphrase, $robots_state, $api_last_modified, $api_structured_data) {
    echo "\n" . '<meta name="description" content="' . esc_attr($meta_desc) . '" />' . "\n";
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

    echo '<meta property="og:type" content="website" />' . "\n";
    echo '<meta property="og:title" content="' . esc_attr(wp_strip_all_tags($document_title)) . '" />' . "\n";
    echo '<meta property="og:description" content="' . esc_attr($meta_desc) . '" />' . "\n";
    echo '<meta property="og:url" content="' . esc_url($canonical_url) . '" />' . "\n";
    echo '<meta property="og:site_name" content="' . esc_attr(get_bloginfo('name')) . '" />' . "\n";

    echo '<meta name="twitter:card" content="summary_large_image" />' . "\n";
    echo '<meta name="twitter:title" content="' . esc_attr(wp_strip_all_tags($document_title)) . '" />' . "\n";
    echo '<meta name="twitter:description" content="' . esc_attr($meta_desc) . '" />' . "\n";
    if (!empty($imageUrl)) {
      echo '<meta property="og:image" content="' . esc_url($imageUrl) . '" />' . "\n";
      if ($image_alt !== '') {
        echo '<meta property="og:image:alt" content="' . esc_attr($image_alt) . '" />' . "\n";
      }
    }

    $schema = [
      "@context" => "https://schema.org",
      "@type" => "Place",
      "name" => wp_strip_all_tags($document_title),
      "description" => wp_strip_all_tags($meta_desc),
      "url" => $canonical_url,
      "image" => $imageUrl ? [$imageUrl] : null,
      "telephone" => $phone ? wp_strip_all_tags($phone) : null,
      "address" => [
        "@type" => "PostalAddress",
        "streetAddress" => $address_raw,
      ],
    ];
    if (!empty($website_raw)) $schema["sameAs"] = [$website_raw];
    $schema = array_filter($schema, function($v){ return $v !== null && $v !== ''; });
    oc_integration_print_structured_data($api_structured_data, $schema);
  }, 1);

  global $wp_query, $post;
  $fake = (object) [
    'ID' => 0,
    'post_author' => 1,
    'post_date' => current_time('mysql'),
    'post_date_gmt' => current_time('mysql', 1),
    'post_content' => '',
    'post_title' => wp_strip_all_tags($document_title),
    'post_excerpt' => '',
    'post_status' => 'publish',
    'comment_status' => 'closed',
    'ping_status' => 'closed',
    'post_password' => '',
    'post_name' => sanitize_title($venue_name_raw),
    'to_ping' => '',
    'pinged' => '',
    'post_modified' => current_time('mysql'),
    'post_modified_gmt' => current_time('mysql', 1),
    'post_content_filtered' => '',
    'post_parent' => 0,
    'guid' => $venue_url,
    'menu_order' => 0,
    'post_type' => 'page',
    'post_mime_type' => '',
    'comment_count' => 0,
  ];

  $post = new WP_Post($fake);
  $wp_query->is_404 = false;
  $wp_query->is_singular = true;
  $wp_query->is_page = true;
  $wp_query->is_home = false;
  $wp_query->is_archive = false;
  $wp_query->queried_object = $post;
  $wp_query->queried_object_id = $post->ID;

  status_header(200);
  setup_postdata($post);

  get_header();
  ?>

  <div id="tribe-events-pg-template" class="tribe-events-pg-template oc-venue-template">
    <div id="tribe-events-content" class="tribe-events-single hentry tribe-clearfix oc-venue-template__content">
      <div class="oc-venue-wrap">
        <section class="oc-venue-hero-card<?php echo $imageUrl ? '' : ' oc-venue-hero-card--no-image'; ?>">
          <?php if ($imageUrl): ?>
            <div class="oc-venue-hero-media">
              <img class="oc-venue-hero-main-image" src="<?php echo esc_url($imageUrl); ?>" alt="<?php echo esc_attr($image_alt !== '' ? $image_alt : $title); ?>" />

              <?php if (!empty($hero_images)): ?>
                <div class="oc-venue-gallery-thumbs" aria-label="Venue image gallery">
                  <?php foreach ($hero_images as $idx => $gimg): ?>
                    <?php $is_active = ($gimg === $imageUrl) || ($idx === 0 && !in_array($imageUrl, $hero_images, true)); ?>
                    <button type="button"
                            class="oc-venue-gallery-thumb<?php echo $is_active ? ' is-active' : ''; ?>"
                            data-image-src="<?php echo esc_url($gimg); ?>"
                            aria-label="Show image <?php echo esc_attr((string)($idx + 1)); ?>"
                            aria-pressed="<?php echo $is_active ? 'true' : 'false'; ?>">
                      <img src="<?php echo esc_url($gimg); ?>" alt="<?php echo esc_attr($title . ' image ' . ($idx + 1)); ?>" />
                    </button>
                  <?php endforeach; ?>
                </div>
              <?php endif; ?>

              <div class="oc-venue-hero-content">
                <h1 class="tribe-events-single-event-title oc-venue-title"><?php echo $title; ?></h1>

                <?php if ($address): ?>
                  <?php $v_maps = oc_build_maps_link($address_raw); ?>
                  <div class="oc-venue-address">
                    <?php if ($v_maps): ?>
                      <a class="oc-map-link" href="<?php echo esc_url($v_maps); ?>" target="_blank" rel="noopener noreferrer"><?php echo $address; ?></a>
                    <?php else: ?>
                      <?php echo $address; ?>
                    <?php endif; ?>
                  </div>
                <?php endif; ?>

                <div class="oc-venue-links">
                  <?php if ($phone): ?>
                    <a class="oc-venue-btn oc-venue-btn--ghost" href="<?php echo esc_url($track_phone_url !== '' ? $track_phone_url : ('tel:' . preg_replace('/[^0-9+]/', '', (string)$phone_raw))); ?>">Call</a>
                  <?php endif; ?>
                  <?php if ($website): ?>
                    <a class="oc-venue-btn" href="<?php echo esc_url($track_website_url !== '' ? $track_website_url : $website); ?>" target="_blank" rel="noopener noreferrer">Website</a>
                  <?php endif; ?>
                </div>
              </div>
            </div>
          <?php else: ?>
            <div class="oc-venue-hero-content">
              <h1 class="tribe-events-single-event-title oc-venue-title"><?php echo $title; ?></h1>

              <?php if ($address): ?>
                <?php $v_maps = oc_build_maps_link($address_raw); ?>
                <div class="oc-venue-address">
                  <?php if ($v_maps): ?>
                    <a class="oc-map-link" href="<?php echo esc_url($v_maps); ?>" target="_blank" rel="noopener noreferrer"><?php echo $address; ?></a>
                  <?php else: ?>
                    <?php echo $address; ?>
                  <?php endif; ?>
                </div>
              <?php endif; ?>

              <div class="oc-venue-links">
                <?php if ($phone): ?>
                  <a class="oc-venue-btn oc-venue-btn--ghost" href="<?php echo esc_url($track_phone_url !== '' ? $track_phone_url : ('tel:' . preg_replace('/[^0-9+]/', '', (string)$phone_raw))); ?>">Call</a>
                <?php endif; ?>
                <?php if ($website): ?>
                  <a class="oc-venue-btn" href="<?php echo esc_url($track_website_url !== '' ? $track_website_url : $website); ?>" target="_blank" rel="noopener noreferrer">Website</a>
                <?php endif; ?>
              </div>
            </div>
          <?php endif; ?>

          <?php if (!empty($categories)): ?>
            <div class="oc-event-cats oc-venue-cats" aria-label="Venue categories">
              <?php foreach ($categories as $c): ?>
                <span class="oc-cat-pill"><?php echo esc_html($c); ?></span>
              <?php endforeach; ?>
            </div>
          <?php endif; ?>
        </section>

        <div class="oc-venue-grid">
          <section class="oc-venue-card oc-venue-card--content">
            <?php if (!empty($description)): ?>
              <div class="oc-venue-card--description">
                <h3 class="oc-event-section-title">About <?php echo $title; ?></h3>
                <div class="oc-venue-desc tribe-events-single-event-description tribe-events-content entry-content oc-venue-description"><?php echo $description; ?></div>
              </div>
            <?php endif; ?>

          <section class="oc-venue-upcoming<?php echo !empty($description) ? ' has-desc' : ''; ?>">
            <hr class="oc-meta-divider oc-venue-upcoming-divider" />
            <div class="oc-more-head">
              <h3 class="oc-event-section-title">Upcoming Events</h3>
              <a class="oc-see-all-btn" href="<?php echo esc_url(home_url('/' . OC_VIRTUAL_BASE . '/')); ?>">See all</a>
            </div>

            <?php if (!empty($upcoming)): ?>
              <div class="oc-venue-events-grid">
                <?php foreach (array_slice($upcoming, 0, 3) as $ev): ?>
                  <?php
                    $ev_key = trim((string)($ev['slug'] ?? ''));
                    if ($ev_key === '') $ev_key = (string)($ev['id'] ?? '');
                    $ev_link = $ev_key !== '' ? home_url('/' . OC_VIRTUAL_BASE . '/' . rawurlencode($ev_key) . '/') : '';
                    $ev_title = esc_html((string)($ev['title'] ?? 'Event'));
                    $ev_start = trim((string)($ev['startDateTime'] ?? ''));
                    $ev_end   = trim((string)($ev['endDateTime'] ?? ''));
                    $ev_location = trim((string)($ev['location'] ?? ''));
                    $ev_img = oc_normalize_remote_url((string)($ev['imageUrl'] ?? ''));
                    $ev_start_ts = $ev_start ? oc_wp_timestamp_from_iso($ev_start) : false;
                    $ev_end_ts   = $ev_end ? oc_wp_timestamp_from_iso($ev_end) : false;
                    $ev_date = $ev_start_ts ? oc_venue_format_date_range_label($ev_start_ts, $ev_end_ts) : '';
                    $ev_time = $ev_start_ts ? wp_date('g:i a', $ev_start_ts) : '';
                    $ev_end_time = $ev_end_ts ? wp_date('g:i a', $ev_end_ts) : '';
                  ?>
                  <?php if ($ev_link): ?><a class="oc-venue-event-item" href="<?php echo esc_url($ev_link); ?>"><?php else: ?><article class="oc-venue-event-item"><?php endif; ?>
                    <div class="oc-venue-event-image">
                      <?php if ($ev_img): ?>
                        <img src="<?php echo esc_url($ev_img); ?>" alt="<?php echo esc_attr($ev_title); ?>" />
                      <?php else: ?>
                        <div class="oc-venue-event-image--empty" aria-hidden="true"></div>
                      <?php endif; ?>
                    </div>

                    <div class="oc-venue-event-main">
                      <div class="oc-venue-event-title"><?php echo $ev_title; ?></div>

                      <div class="oc-venue-event-meta">
                        <?php if ($ev_date): ?>
                          <div class="oc-meta">
                            <span class="oc-ico" aria-hidden="true">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                <line x1="3" y1="10" x2="21" y2="10"></line>
                              </svg>
                            </span>
                            <span><?php echo esc_html($ev_date); ?></span>
                          </div>
                        <?php endif; ?>

                        <?php if ($ev_time): ?>
                          <div class="oc-meta">
                            <span class="oc-ico" aria-hidden="true">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                              </svg>
                            </span>
                            <span><?php echo esc_html($ev_time . ($ev_end_time ? ' - ' . $ev_end_time : '')); ?></span>
                          </div>
                        <?php endif; ?>

                        <?php if ($ev_location !== ''): ?>
                          <div class="oc-meta">
                            <span class="oc-ico" aria-hidden="true">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                                <circle cx="12" cy="10" r="3"></circle>
                              </svg>
                            </span>
                            <span><?php echo esc_html($ev_location); ?></span>
                          </div>
                        <?php endif; ?>
                      </div>
                    </div>
                  <?php if ($ev_link): ?></a><?php else: ?></article><?php endif; ?>
                <?php endforeach; ?>
              </div>
            <?php else: ?>
              <p class="oc-venue-empty">No upcoming events at this venue right now.</p>
            <?php endif; ?>
          </section>
          </section>

          <aside class="oc-venue-side">
            <section class="oc-venue-card">
              <h3 class="oc-event-section-title">Venue Info</h3>
              <div class="oc-venue-kv"><span>City</span><strong><?php echo esc_html((string)($venue['city'] ?? '')); ?></strong></div>
              <?php if ($address): ?>
                <?php $v_maps_side = oc_build_maps_link($address_raw); ?>
                <div class="oc-venue-kv"><span>Address</span><strong><?php if ($v_maps_side): ?><a href="<?php echo esc_url($v_maps_side); ?>" target="_blank" rel="noopener noreferrer"><?php echo $address; ?></a><?php else: ?><?php echo $address; ?><?php endif; ?></strong></div>
              <?php endif; ?>
              <?php if ($website): ?><div class="oc-venue-kv"><span>Website</span><strong><a href="<?php echo esc_url($track_website_url !== "" ? $track_website_url : $website); ?>" target="_blank" rel="noopener noreferrer">Visit</a></strong></div><?php endif; ?>
              <?php if ($phone): ?><div class="oc-venue-kv"><span>Phone</span><strong><a href="<?php echo esc_url($track_phone_url !== '' ? $track_phone_url : ('tel:' . preg_replace('/[^0-9+]/', '', (string)$phone_raw))); ?>"><?php echo esc_html($phone); ?></a></strong></div><?php endif; ?>
            </section>

            <?php if (!empty($hours) && is_array($hours)): ?>
              <section class="oc-venue-card">
                <h3 class="oc-event-section-title">Hours</h3>
                <?php
                  $days = [
                    'sun' => 'Sunday',
                    'mon' => 'Monday',
                    'tue' => 'Tuesday',
                    'wed' => 'Wednesday',
                    'thu' => 'Thursday',
                    'fri' => 'Friday',
                    'sat' => 'Saturday',
                  ];
                ?>
                <div class="oc-venue-hours">
                  <?php foreach ($days as $dk => $dl): ?>
                    <?php $h = (isset($hours[$dk]) && is_array($hours[$dk])) ? $hours[$dk] : []; ?>
                    <?php
                      $is_closed = !empty($h['closed']);
                      $open = trim((string)($h['open'] ?? ''));
                      $close = trim((string)($h['close'] ?? ''));
                      $open_fmt = oc_venue_format_time_12h($open);
                      $close_fmt = oc_venue_format_time_12h($close);
                      $label = $is_closed ? 'Closed' : (($open_fmt && $close_fmt) ? ($open_fmt . ' - ' . $close_fmt) : '');
                    ?>
                    <?php if ($label !== ''): ?>
                      <div class="oc-venue-kv"><span><?php echo esc_html($dl); ?></span><strong><?php echo esc_html($label); ?></strong></div>
                    <?php endif; ?>
                  <?php endforeach; ?>
                </div>
              </section>
            <?php endif; ?>

            <?php
              $social_links = [];
              foreach (['facebook' => 'Facebook', 'instagram' => 'Instagram', 'x' => 'X', 'tiktok' => 'TikTok', 'youtube' => 'YouTube', 'linkedin' => 'LinkedIn'] as $k => $label) {
                $u = trim((string)($social[$k] ?? ''));
                if ($u && filter_var($u, FILTER_VALIDATE_URL)) {
                  $track_social = ($venue_api_base !== '' && $venue_api_key !== '')
                    ? ($venue_api_base . '/venues/' . $venue_api_key . '/out/social/' . rawurlencode($k))
                    : $u;
                  $social_links[] = ['label' => $label, 'url' => esc_url($track_social)];
                }
              }
            ?>
            <?php if (!empty($social_links)): ?>
              <section class="oc-venue-card">
                <h3 class="oc-event-section-title">Social</h3>
                <div class="oc-venue-social">
                  <?php foreach ($social_links as $s): ?>
                    <a href="<?php echo $s['url']; ?>" target="_blank" rel="noopener noreferrer"><?php echo esc_html($s['label']); ?></a>
                  <?php endforeach; ?>
                </div>
              </section>
            <?php endif; ?>
          </aside>
        </div>
      </div>
    </div>
  </div>

  <?php if ($venue_api_base !== '' && $venue_api_key !== ''): ?>
  <script>
    (function () {
      var endpoint = <?php echo wp_json_encode($venue_api_base . '/venues/' . $venue_api_key . '/view'); ?>;
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
    })();
  </script>
  <?php endif; ?>

  <style>
    .oc-venue-template,
    .oc-venue-template__content {
      max-width: 1370px;
      width: 100%;
      margin-left: auto;
      margin-right: auto;
      margin-top: 0 !important;
      padding-left: 24px;
      padding-right: 24px;
      padding-top: 0 !important;
      box-sizing: border-box;
    }
    .oc-venue-template {
      margin-top: 18px !important;
      margin-bottom: 18px !important;
    }
    .oc-venue-template .tribe-events-before-html,
    .oc-venue-template .tribe-events-before-content,
    .oc-venue-template .tribe-events-c-subscribe-dropdown {
      display: none !important;
      margin: 0 !important;
      padding: 0 !important;
      height: 0 !important;
      min-height: 0 !important;
    }
    .oc-venue-template__content > *:first-child {
      margin-top: 0 !important;
      padding-top: 0 !important;
    }

    .oc-venue-wrap { display: grid; gap: 24px; }

    .oc-venue-hero-card {
      background: #fff;
      border-radius: 10px;
      overflow: hidden;
      position: relative;
      padding-top: 18px !important;
      padding-right: 18px !important;
      padding-left: 18px !important;
      padding-bottom: 18px !important;
    }

    .oc-venue-hero-media img {
      width: 100%;
      height: 420px;
      object-fit: cover;
      display: block;
      border-radius: 10px;
    }
    .oc-venue-hero-media {
      position: relative;
    }

    .oc-venue-gallery-thumbs {
      position: absolute;
      right: 16px;
      bottom: 16px;
      display: inline-flex;
      gap: 8px;
      z-index: 3;
    }
    .oc-venue-gallery-thumb {
      appearance: none;
      border: 2px solid rgba(255,255,255,.66);
      border-radius: 10px;
      padding: 3px;
      width: 56px;
      height: 56px;
      overflow: hidden;
      cursor: pointer;
      background: #fff;
      box-shadow: 0 8px 18px rgba(0,0,0,.25);
    }
    .oc-venue-gallery-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      border-radius: 6px;
    }
    .oc-venue-gallery-thumb.is-active {
      border-color: var(--oc-accent, #3fabd1);
      box-shadow: 0 0 0 2px var(--oc-accent-rgb-24, rgba(63,171,209,.24)), 0 8px 18px rgba(0,0,0,.25);
    }

    .oc-venue-hero-content {
      position: absolute;
      left: 28px;
      bottom: 28px;
      background: #fff;
      border-radius: 10px;
      padding: 20px 20px 16px;
      width: min(460px, calc(100% - 52px));
      display: flex;
      flex-direction: column;
      gap: 0;
      box-shadow: 0 18px 40px rgba(10, 18, 32, .24);
    }
    .oc-venue-hero-content > *:last-child { margin-bottom: 0 !important; }

    .oc-venue-hero-card--no-image {
      padding: 22px;
    }
    .oc-venue-hero-card--no-image .oc-venue-hero-content {
      position: static;
      width: 100%;
      box-shadow: none;
      padding: 0;
    }
    .oc-venue-cats {
      margin-top: 12px;
      margin-bottom: 0;
    }

    .oc-event-cats{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
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

    .oc-venue-hero-content .tribe-events-single-event-title.oc-venue-title {
      margin: 0 0 10px !important;
      padding: 0 !important;
      font-size: 2rem !important;
      line-height: 1.03 !important;
      letter-spacing: -0.03em;
      color: #333333;
    }

    .oc-venue-address {
      margin: 0 0 12px;
      font-size: 1rem;
      line-height: 1.3;
      color: #111;
    }
    .oc-venue-address a { line-height: inherit; }
    .oc-venue-desc { font-size: 1rem; line-height: 1.6; color: #111; }

    .oc-venue-links {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 0;
    }
    .oc-venue-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--oc-accent, #3fabd1);
      background: var(--oc-accent, #3fabd1);
      color: #fff !important;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
    }
    .oc-venue-btn--ghost {
      background: #fff;
      color: var(--oc-accent, #3fabd1) !important;
    }

    .oc-venue-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 24px;
      align-items: start;
    }
    .oc-venue-grid > .oc-venue-card {
      grid-column: 1;
    }
    .oc-venue-side {
      grid-column: 2;
      grid-row: 1 / span 4;
      display: grid;
      gap: 24px;
    }

    .oc-venue-card--content {
      padding: 24px;
    }

    .oc-venue-card--description {
      margin-bottom: 0;
    }
    .oc-venue-card--description .oc-event-section-title {
      margin: 0 0 14px;
    }
    .oc-venue-desc > *:first-child { margin-top: 0; }
    .oc-venue-desc > *:last-child { margin-bottom: 0; }

    .oc-venue-card {
      background: #fff;
      border-radius: 10px;
      padding: 18px;
    }
    .oc-venue-card > .oc-event-section-title {
      margin: 0 0 12px !important;
      font-size: 1.25rem !important;
      line-height: 1.15 !important;
      font-weight: 600 !important;
      color: #333333;
    }

    .oc-venue-upcoming {
      grid-column: 1;
      background: transparent;
      border-radius: 0;
      padding: 0;
    }
    .oc-venue-upcoming-divider {
      margin: 0 0 28px;
    }
    .oc-venue-upcoming.has-desc .oc-venue-upcoming-divider {
      margin: 24px 0;
    }

    .oc-venue-upcoming .oc-event-section-title {
      margin: 0;
      font-size: 1.25rem;
      line-height: 1.15;
      font-weight: 600;
      letter-spacing: 0;
      color: #333333;
    }

    /* Enforce requested heading scale/colors across venue template */
    .oc-venue-template h1 {
      font-size: 2rem !important;
      color: #333333 !important;
    }
    .oc-venue-template h3 {
      font-size: 1.25rem !important;
      color: #333333 !important;
    }
    .oc-venue-template p {
      font-size: 1rem !important;
      color: #333333 !important;
    }

    .oc-venue-upcoming .oc-more-head {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      flex-wrap: nowrap !important;
      gap: 14px;
      margin-top: 0 !important;
      margin-bottom: 16px !important;
    }
    .oc-venue-upcoming .oc-more-head .oc-see-all-btn {
      flex: 0 0 auto;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 40px;
      padding: 0 14px;
      border-radius: 8px;
      border: 1px solid rgba(0,0,0,.12);
      background: #fff;
      color: var(--oc-accent, #3fabd1);
      text-decoration: none !important;
      font-size: 0.9231rem;
      font-weight: 600;
      line-height: 1;
    }
    .oc-venue-upcoming .oc-more-head .oc-see-all-btn:hover {
      border-color: rgba(0,0,0,.22);
    }

    .oc-venue-events-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 20px;
    }
    .oc-venue-event-item {
      border: 0;
      border-radius: 8px;
      padding: 0;
      background: #fff;
      text-decoration: none;
      color: inherit;
      display: block;
    }

    .oc-venue-event-image {
      border-radius: 8px;
      overflow: hidden;
      background: #e9ebef;
      margin-bottom: 12px;
    }
    .oc-venue-event-image img {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      height: auto;
      object-fit: cover;
      border-radius: 4px;
    }
    .oc-venue-event-image--empty {
      width: 100%;
      aspect-ratio: 16 / 9;
      background: #e9ebef;
      border-radius: 4px;
    }

    .oc-venue-event-title {
      margin: 0 0 12px;
      font-size: 1.231rem;
      font-weight: 700;
      color: #111;
      line-height: 1.4;
      letter-spacing: -0.03em;
    }
    .oc-venue-event-item:hover .oc-venue-event-title { color: var(--oc-accent-dark, #2f7f9f); }

    .oc-venue-event-meta {
      display: grid;
      gap: 0;
      color: #777;
      font-size: 0.9231rem;
    }
    .oc-venue-event-meta .oc-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 8px;
      line-height: 1.2;
      font-size: 0.9231rem;
    }
    .oc-venue-event-meta .oc-meta:last-child { margin-bottom: 0; }
    .oc-venue-event-meta .oc-ico {
      width: 18px;
      height: 18px;
      min-width: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #4b5563;
    }
    .oc-venue-event-meta .oc-ico svg {
      width: 18px;
      height: 18px;
      display: block;
      flex: 0 0 18px;
    }

    .oc-venue-kv {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(0,0,0,.08);
    }
    .oc-venue-kv:last-child { border-bottom: 0; }
    .oc-venue-kv span { color: #4b5563; font-size: .92rem; }
    .oc-venue-kv strong,
    .oc-venue-kv strong a {
      color: #333333;
      font-size: 1rem;
      font-weight: 400;
      line-height: normal;
      text-decoration: none;
      text-align: left;
    }
    .oc-venue-hours .oc-venue-kv strong,
    .oc-venue-hours .oc-venue-kv strong a {
      color: #333333;
      font-size: 1rem;
      font-weight: 400;
      line-height: normal;
      text-align: left;
    }

    .oc-venue-social { display: flex; flex-wrap: wrap; gap: 8px; }
    .oc-venue-social a {
      text-decoration: none;
      font-size: .86rem;
      font-weight: 600;
      color: var(--oc-accent-dark, #2f7f9f);
      border: 1px solid var(--oc-accent-rgb-24, rgba(63,171,209,.24));
      border-radius: 999px;
      padding: 6px 10px;
      background: var(--oc-accent-rgb-10, rgba(63,171,209,.10));
    }

    .oc-venue-empty { margin: 0; color: #4b5563; }

    @media (max-width: 1100px) {
      .oc-venue-hero-card {
        padding-top: 12px !important;
        padding-right: 12px !important;
        padding-left: 12px !important;
        padding-bottom: 12px !important;
      }
      .oc-venue-hero-content {
        position: static;
        width: 100%;
        border-radius: 0;
        box-shadow: none;
        padding: 14px 0 0;
      }
      .oc-venue-grid { grid-template-columns: 1fr; }
      .oc-venue-grid > .oc-venue-card { grid-column: auto; }
      .oc-venue-upcoming { grid-column: auto; }
      .oc-venue-side { grid-column: auto; grid-row: auto; }
      .oc-venue-hero-media img { height: 240px; }
      .oc-venue-gallery-thumbs {
        right: 10px;
        bottom: 10px;
        gap: 6px;
      }
      .oc-venue-gallery-thumb {
        width: 46px;
        height: 46px;
      }
      .oc-venue-events-grid { grid-template-columns: 1fr; gap: 14px; }
      .oc-venue-upcoming .oc-event-section-title {
        font-size: 1.25rem;
      }
      .oc-venue-upcoming .oc-more-head .oc-see-all-btn {
        height: 36px;
        padding: 0 14px;
        border-radius: 8px;
        font-size: 0.875rem;
      }
    }
  </style>

  <script>
    (function () {
      var root = document.querySelector('.oc-venue-hero-media');
      if (!root) return;

      var mainImage = root.querySelector('.oc-venue-hero-main-image');
      var thumbs = root.querySelectorAll('.oc-venue-gallery-thumb[data-image-src]');
      if (!mainImage || !thumbs.length) return;

      function setActive(btn) {
        thumbs.forEach(function (node) {
          var active = node === btn;
          node.classList.toggle('is-active', active);
          node.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      }

      thumbs.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var nextSrc = btn.getAttribute('data-image-src') || '';
          if (!nextSrc || nextSrc === mainImage.getAttribute('src')) {
            setActive(btn);
            return;
          }
          mainImage.setAttribute('src', nextSrc);
          setActive(btn);
        });
      });
    })();
  </script>

  <?php
  get_footer();
  wp_reset_postdata();
  exit;
}, 1);
