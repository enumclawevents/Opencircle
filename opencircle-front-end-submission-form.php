<?php
/**
 * Module: OpenCircle Event Submissions
 * Description: Front-end event submission form that sends events to OpenCircle API for approval. Includes optional WooCommerce Featured Event upsell tied to a submissionId (featured until event happens).
 * Version: 0.1.7
 */

if (!defined('ABSPATH')) exit;

/**
 * Recommended: set a single API base for Woo fulfillment callbacks.
 * The submission form still uses the shortcode "api" attribute for /events/submit.
 */
if (!defined('OC_API_BASE')) {
  define('OC_API_BASE', 'https://api.opencircleapi.com');
}

class OpenCircle_Event_Submissions {
  const SHORTCODE = 'oc_event_submit';
  const SCRIPT_HANDLE = 'oc-event-submit-js';
  const STYLE_HANDLE  = 'oc-event-submit-css';

  public static function init() {
    add_shortcode(self::SHORTCODE, [__CLASS__, 'render_shortcode']);
    add_action('wp_enqueue_scripts', [__CLASS__, 'register_assets']);
    add_action('wp_ajax_oc_submit_event', [__CLASS__, 'handle_submit']);
    add_action('wp_ajax_nopriv_oc_submit_event', [__CLASS__, 'handle_submit']);
  }

  public static function register_assets() {
    wp_register_style(self::STYLE_HANDLE, false, [], '0.1.7');
    wp_register_script(self::SCRIPT_HANDLE, false, [], '0.1.7', true);
  }

  public static function render_shortcode($atts) {
    $atts = shortcode_atts([
      'api'       => (defined('OC_API_BASE') ? OC_API_BASE : 'https://api.opencircleapi.com'),
      'city'      => 'Enumclaw',
      'title'     => 'Submit an Event',
      'success'   => 'Thank you for submitting your event! An admin will review to ensure accuracy before it gets published live',
      'button'    => 'Submit Event',

      /**
       * OPTIONAL: Featured upsell (WooCommerce)
       * Use your Woo Featured product ID:
       * [oc_event_submit feature_product_id="8931"]
       */
      'feature_product_id' => '',
      'feature_label'      => 'Feature Until Event Date ($25)',
      'feature_copy'       => 'Want more visibility? Feature this event on EnumclawEvents.org until it happens.',
    ], $atts, self::SHORTCODE);

    $api     = esc_url_raw($atts['api']);
    $city    = sanitize_text_field($atts['city']);
    $title   = sanitize_text_field($atts['title']);
    $success = sanitize_text_field($atts['success']);
    $button  = sanitize_text_field($atts['button']);

    $feature_product_id = absint($atts['feature_product_id']);
    $feature_label      = sanitize_text_field($atts['feature_label']);
    $feature_copy       = sanitize_text_field($atts['feature_copy']);

    wp_enqueue_style(self::STYLE_HANDLE);
    wp_enqueue_script(self::SCRIPT_HANDLE);

    wp_add_inline_style(self::STYLE_HANDLE, self::inline_css());
    wp_add_inline_script(self::SCRIPT_HANDLE, self::inline_js());

    $uid = 'oc-submit-' . wp_generate_uuid4();

    ob_start();
    ?>
    <div id="<?php echo esc_attr($uid); ?>" class="oc-submit-wrap" data-oc-submit="1">
      <style>
        <?php echo self::inline_css(); ?>
      </style>
      <h2 class="oc-submit-title"><?php echo esc_html($title); ?></h2>

      <div class="oc-submit-disclaimer">All events are subject to admin approval.</div>

      <form class="oc-submit-form" method="POST" action="<?php echo esc_url(admin_url('admin-ajax.php')); ?>" novalidate enctype="multipart/form-data">
        <input type="hidden" name="action" value="oc_submit_event" />
        <input type="hidden" name="nonce" value="<?php echo esc_attr(wp_create_nonce('oc_submit_nonce')); ?>" />
        <input type="hidden" name="api" value="<?php echo esc_attr($api); ?>" />
        <input type="hidden" name="city" value="<?php echo esc_attr($city); ?>" />
        <input type="hidden" name="started_at" value="<?php echo esc_attr(time()); ?>" />

        <!-- Featured upsell config passed through AJAX -->
        <input type="hidden" name="feature_product_id" value="<?php echo esc_attr($feature_product_id); ?>" />

        <div class="oc-submit-hp">
          <label>Leave this field empty</label>
          <input type="text" name="website" value="" />
        </div>

        <div class="oc-field">
          <label>Event Title *</label>
          <input type="text" name="title" required />
        </div>

        <div class="oc-row">
          <div class="oc-field">
            <label>Start Date & Time *</label>
            <input type="datetime-local" name="start" required />
          </div>
          <div class="oc-field">
            <label>End Date & Time</label>
            <input type="datetime-local" name="end" />
          </div>
        </div>

        <div class="oc-field">
          <label>Location (Address) *</label>
          <input type="text" name="location" required />
        </div>

        <div class="oc-field">
          <label>Organizer</label>
          <input type="text" name="organizer" />
        </div>

        <div class="oc-field">
          <label>Description *</label>
          <textarea name="description" rows="6" required></textarea>
        </div>

        <div class="oc-field">
          <label>Event Image (Upload)</label>
          <input type="file" name="imageFile" accept="image/*" />
        </div>

        <div class="oc-field">
          <label>Event Link (Facebook / Website)</label>
          <input type="url" name="eventLink" placeholder="https://..." />
        </div>

        <div class="oc-row">
          <div class="oc-field">
            <label>Ticket URL</label>
            <input type="url" name="ticketUrl" placeholder="https://..." />
          </div>
          <div class="oc-field">
            <label>Ticket Button Label</label>
            <input type="text" name="ticketLabel" placeholder="Tickets" />
          </div>
        </div>

        <div class="oc-field">
          <label>Categories (comma separated)</label>
          <input type="text" name="categories" placeholder="Music, Family, Food" />
        </div>

        <div class="oc-field">
          <label>Notes for Approval</label>
          <textarea name="approvalNotes" rows="4" placeholder="Anything you'd like the admin to know?"></textarea>
        </div>

        <div class="oc-field">
          <label>Contact Email *</label>
          <input type="email" name="submitterEmail" required />
        </div>

        <button type="submit" class="oc-submit-btn"><?php echo esc_html($button); ?></button>
      </form>

      <div class="oc-submit-msg" data-oc-submit-msg data-success="<?php echo esc_attr($success); ?>"></div>

      <!-- Featured upsell block (hidden until submission succeeds and product id exists) -->
<div class="oc-submit-actions">
  <!-- Featured upsell block (hidden until submission succeeds and product id exists) -->
  <div class="oc-feature-upsell" data-oc-feature-upsell style="display:none;">
    <div class="oc-feature-title"><strong><?php echo esc_html('Want more visibility?'); ?></strong></div>
    <div class="oc-feature-copy"><?php echo esc_html($feature_copy); ?></div>
    <div class="oc-feature-row">
  <a class="oc-feature-btn" data-oc-feature-btn href="#"><?php echo esc_html($feature_label); ?></a>
  <button type="button" class="oc-submit-again" data-oc-submit-again>Submit Another</button>
</div>

  </div>
</div>

    </div>
    <?php
    return ob_get_clean();
  }

  public static function handle_submit() {
    check_ajax_referer('oc_submit_nonce', 'nonce');

    if (!empty($_POST['website'])) {
      wp_send_json_error(['message' => 'Spam detected.'], 400);
    }

    $started_at = intval($_POST['started_at'] ?? 0);
    if (!$started_at || (time() - $started_at) < 3) {
      wp_send_json_error(['message' => 'Please wait a moment and try again.'], 400);
    }

    $api = esc_url_raw($_POST['api'] ?? '');
    if (!$api) {
      wp_send_json_error(['message' => 'Missing API.'], 400);
    }

    $title    = sanitize_text_field($_POST['title'] ?? '');
    $start    = sanitize_text_field($_POST['start'] ?? '');
    $location = sanitize_text_field($_POST['location'] ?? '');
    $desc     = wp_kses_post($_POST['description'] ?? '');
    $email    = sanitize_email($_POST['submitterEmail'] ?? '');

    if (!$title || !$start || !$location || !$desc || !$email) {
      wp_send_json_error(['message' => 'Please fill all required fields.'], 400);
    }

    $imageUrl = '';
    if (!empty($_FILES['imageFile']) && !empty($_FILES['imageFile']['tmp_name'])) {
      require_once ABSPATH . 'wp-admin/includes/file.php';
      $upload = wp_handle_upload($_FILES['imageFile'], ['test_form' => false]);
      if (!empty($upload['url'])) {
        $imageUrl = $upload['url'];
      }
    }

    // submissionId links the event to a Woo purchase
    $submission_id = wp_generate_uuid4();

    $payload = [
      'submissionId'   => $submission_id,
      'title'          => $title,
      'startDateTime'  => self::to_local_iso($start),
      'endDateTime'    => !empty($_POST['end']) ? self::to_local_iso($_POST['end']) : '',
      'location'       => $location,
      'organizer'      => sanitize_text_field($_POST['organizer'] ?? ''),
      'description'    => $desc,
      'imageUrl'       => $imageUrl,
      'eventLink'      => esc_url_raw($_POST['eventLink'] ?? ''),
      'ticketUrl'      => esc_url_raw($_POST['ticketUrl'] ?? ''),
      'ticketLabel'    => sanitize_text_field($_POST['ticketLabel'] ?? ''),
      'categories'     => array_values(array_filter(array_map('trim', explode(',', $_POST['categories'] ?? '')))),
      'city'           => sanitize_text_field($_POST['city'] ?? ''),
      'submitterEmail' => $email,
      'approvalNotes'  => sanitize_textarea_field($_POST['approvalNotes'] ?? ''),
      'source'         => 'wp_frontend',
    ];

    $endpoint = rtrim($api, '/') . '/events/submit';

    $res = wp_remote_post($endpoint, [
      'timeout' => 20,
      'headers' => ['Content-Type' => 'application/json'],
      'body'    => wp_json_encode($payload),
    ]);

    if (is_wp_error($res)) {
      wp_send_json_error([
        'message' => 'API request failed: ' . $res->get_error_message(),
      ], 500);
    }

    $code = wp_remote_retrieve_response_code($res);
    $body = wp_remote_retrieve_body($res);

    if ($code < 200 || $code >= 300) {
      $msg = 'API error (' . $code . ').';
      $decoded = json_decode($body, true);
      if (is_array($decoded)) {
        if (!empty($decoded['message'])) $msg = $decoded['message'];
        elseif (!empty($decoded['error'])) $msg = $decoded['error'];
      } elseif (!empty($body)) {
        $msg .= ' ' . substr(trim(wp_strip_all_tags($body)), 0, 180);
      }
      wp_send_json_error(['message' => $msg], 500);
    }

    // Return submissionId + product id so the frontend can build checkout URL
    wp_send_json_success([
      'ok' => true,
      'submissionId'     => $submission_id,
      'featureProductId' => absint($_POST['feature_product_id'] ?? 0),
    ]);
  }

  private static function to_local_iso($val) {
    $tz = wp_timezone();
    try {
      $dt = new DateTimeImmutable($val, $tz);
      return $dt->format('c');
    } catch (Exception $e) {
      return $val;
    }
  }

  private static function inline_css() {
  return "
/* Layout */
.oc-submit-wrap{ padding:0 16px; margin:20px 0; text-align:left; }
.oc-submit-title{ font-size:1.6rem; margin:0 0 8px; }

.oc-submit-disclaimer{
  font-size:0.95rem;
  color:#475569;
  margin-bottom:14px;
}
.oc-submit-disclaimer a{ color:#0ea5e9; text-decoration:none; }
.oc-submit-disclaimer a:hover{ text-decoration:underline; }

/* Form */
.oc-submit-form{
  background:#fff;
  border:1px solid rgba(0,0,0,.08);
  border-radius:10px;
  padding:18px;
}
.oc-field{ margin-bottom:14px; display:flex; flex-direction:column; gap:6px; }
.oc-row{ display:flex; gap:14px; }
.oc-row .oc-field{ flex:1; }

.oc-submit-form input,
.oc-submit-form textarea{
  border:1px solid rgba(0,0,0,.15);
  border-radius:8px;
  padding:10px 12px;
  font-size:1rem;
  width:100%;
  box-sizing:border-box;
}

/* Primary submit button */
.oc-submit-btn{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  height:44px;
  padding:0 20px;
  border-radius:999px;
  background:rgb(63, 171, 209);
  border:0;
  color:#fff;
  font-weight:600;
  cursor:pointer;
}
.oc-submit-btn:hover{ filter:brightness(0.97); }

.oc-submit-msg{ margin-top:12px; font-size:.95rem; }

/* Upsell */
.oc-submit-actions{ margin-top:14px; }

.oc-feature-upsell{
  display:block;
  padding:14px;
  border:1px solid rgba(0,0,0,.08);
  border-radius:10px;
  background:#fff;
}

.oc-feature-title{ margin-bottom:6px; }
.oc-feature-copy{ color:#334155; font-size:0.98rem; }

/* Inline buttons row */
.oc-feature-row{
  margin-top:10px;
  display:flex;
  gap:12px;
  flex-wrap:wrap;
  align-items:center;
}

/* Make <a> and <button> match perfectly */
.oc-feature-btn,
.oc-submit-again{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  height:44px;
  padding:0 20px;
  border-radius:999px;
  line-height:1;
  box-sizing:border-box;
  vertical-align:middle;
}

/* Feature button */
.oc-feature-btn{
  background:#00add4;
  color:#fff;
  text-decoration:none;
  border:0;
}
.oc-feature-btn:hover{ filter:brightness(0.97); }

/* Submit another */
.oc-submit-again{
  display:none; /* hidden until success */
  background:#fff;
  color:rgb(63, 171, 209);
  border:1px solid rgb(63, 171, 209);
  font-weight:600;
  cursor:pointer;
}
.oc-submit-again:hover{ filter:brightness(0.98); }

/* Honeypot */
.oc-submit-hp{
  position:absolute;
  left:-9999px;
  top:-9999px;
  height:1px;
  width:1px;
  overflow:hidden;
}

/* Responsive */
@media (max-width: 640px){
  .oc-row{ flex-direction:column; }
}
";
}


  private static function inline_js() {
    $checkout_url = function_exists('wc_get_checkout_url') ? wc_get_checkout_url() : site_url('/checkout/');

    return "
(function(){
  function buildUrlWithParams(baseUrl, params){
    try{
      var u = new URL(baseUrl, window.location.origin);
      Object.keys(params).forEach(function(k){
        u.searchParams.set(k, params[k]);
      });
      return u.toString();
    } catch(e){
      var joiner = baseUrl.indexOf('?') === -1 ? '?' : '&';
      var q = [];
      for (var k in params){
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
      return baseUrl + joiner + q.join('&');
    }
  }

  document.querySelectorAll('[data-oc-submit=\"1\"]').forEach(function(root){
    var form = root.querySelector('form');
    var msg = root.querySelector('[data-oc-submit-msg]');
    var title = root.querySelector('.oc-submit-title');
    var disclaimer = root.querySelector('.oc-submit-disclaimer');
    var againBtn = root.querySelector('[data-oc-submit-again]');
    var upsell = root.querySelector('[data-oc-feature-upsell]');
    var upsellBtn = root.querySelector('[data-oc-feature-btn]');
    if(!form) return;

    form.addEventListener('submit', async function(e){
      e.preventDefault();
      if(msg) msg.textContent = '';
      if(upsell) upsell.style.display = 'none';

      var formData = new FormData(form);

      try{
        var res = await fetch('" . esc_js(admin_url('admin-ajax.php')) . "', {
          method:'POST',
          body: formData,
          credentials:'same-origin'
        });

        var json = await res.json();

        if(json && json.success){
          if(msg) msg.textContent = msg.getAttribute('data-success') || 'Submitted.';
          form.style.display = 'none';
          if(title) title.style.display = 'none';
          if(disclaimer) disclaimer.style.display = 'none';
          if(againBtn) againBtn.style.display = 'inline-flex';

          var data = json.data || {};
          var submissionId = data.submissionId || '';
          var productId = parseInt(data.featureProductId || 0, 10);

          if(upsell && upsellBtn && submissionId && productId){
            var checkoutUrl = '" . esc_js($checkout_url) . "';
            var featureUrl = buildUrlWithParams(checkoutUrl, {
              'add-to-cart': productId,
              'oc_submission_id': submissionId
            });
            upsellBtn.setAttribute('href', featureUrl);
            upsell.style.display = 'block';
          }
        } else {
          if(msg) msg.textContent = (json && json.data && json.data.message) ? json.data.message : 'Submission failed.';
        }
      } catch(err){
        if(msg) msg.textContent = 'Submission failed.';
      }
    });

    if(againBtn){
      againBtn.addEventListener('click', function(){
        form.reset();
        form.style.display = '';
        if(title) title.style.display = '';
        if(disclaimer) disclaimer.style.display = '';
        if(msg) msg.textContent = '';
        if(upsell) upsell.style.display = 'none';
        againBtn.style.display = 'none';
      });
    }
  });
})();
";
  }
}

OpenCircle_Event_Submissions::init();

/**
 * ============================
 * WooCommerce Linking + Fulfillment
 * ============================
 * Captures ?oc_submission_id=UUID when the Featured product is added to cart,
 * stores it on the order item, then calls the OpenCircle API to feature the
 * matching event upon payment completion.
 *
 * IMPORTANT: The API decides the featured end date based on the event's startDateTime.
 */

// Save oc_submission_id into cart item data
add_filter('woocommerce_add_cart_item_data', function($cart_item_data, $product_id){
  if (empty($_GET['oc_submission_id'])) return $cart_item_data;

  $sid = sanitize_text_field(wp_unslash($_GET['oc_submission_id']));
  if (!preg_match('/^[a-f0-9-]{20,}$/i', $sid)) return $cart_item_data;

  $cart_item_data['oc_submission_id'] = $sid;
  $cart_item_data['unique_key'] = md5($sid . '|' . microtime(true)); // prevent merge
  return $cart_item_data;
}, 10, 2);

// Store it on the order item meta
add_action('woocommerce_checkout_create_order_line_item', function($item, $cart_item_key, $values, $order){
  if (!empty($values['oc_submission_id'])) {
    $item->add_meta_data('oc_submission_id', $values['oc_submission_id'], true);
  }
}, 10, 4);

// Fulfill: call API when payment completes
add_action('woocommerce_payment_complete', function($order_id){
  if (!defined('OC_API_BASE') || !OC_API_BASE) return;

  $order = wc_get_order($order_id);
  if (!$order) return;

  foreach ($order->get_items() as $item) {
    $sid = $item->get_meta('oc_submission_id', true);
    if (!$sid) continue;

    // Prevent double fulfillment for same sid
    if ($order->get_meta('_oc_featured_done_' . $sid, true)) continue;

    $payload = [
      'submissionId' => $sid,
      'orderId'      => (string)$order_id,
      'source'       => 'woocommerce',
    ];

    $res = wp_remote_post(rtrim(OC_API_BASE, '/') . '/events/feature', [
      'timeout' => 20,
      'headers' => ['Content-Type' => 'application/json'],
      'body'    => wp_json_encode($payload),
    ]);

    // Network / WP HTTP error
    if (is_wp_error($res)) {
      $msg = 'OpenCircle feature API request failed: ' . $res->get_error_message();
      if (method_exists($order, 'add_order_note')) {
        $order->add_order_note($msg);
      }
      error_log('[OpenCircle Feature] ' . $msg . ' | submissionId=' . $sid . ' | orderId=' . $order_id);
      continue;
    }

    $code = wp_remote_retrieve_response_code($res);
    $body = wp_remote_retrieve_body($res);

    // Success
    if ($code >= 200 && $code < 300) {
      $order->update_meta_data('_oc_featured_done_' . $sid, '1');
      $order->save();

      if (method_exists($order, 'add_order_note')) {
        $order->add_order_note('OpenCircle feature activated for submissionId ' . $sid . '.');
      }

      error_log('[OpenCircle Feature] OK ' . $code . ' | submissionId=' . $sid . ' | orderId=' . $order_id);
      continue;
    }

    // Failure: surface API error content
    $apiMsg = 'OpenCircle feature API error (' . $code . ').';
    $decoded = json_decode($body, true);

    if (is_array($decoded)) {
      if (!empty($decoded['message'])) {
        $apiMsg = $decoded['message'];
      } elseif (!empty($decoded['error'])) {
        $apiMsg = $decoded['error'];
      }
    } elseif (!empty($body)) {
      $apiMsg .= ' ' . substr(trim(wp_strip_all_tags($body)), 0, 180);
    }

    if (method_exists($order, 'add_order_note')) {
      $order->add_order_note($apiMsg . ' (submissionId ' . $sid . ')');
    }
    error_log('[OpenCircle Feature] FAIL ' . $code . ' | ' . $apiMsg . ' | submissionId=' . $sid . ' | orderId=' . $order_id);
  }
});
