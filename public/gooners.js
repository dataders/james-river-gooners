/**
 * James River Gooners — Bookmarklet Payload
 *
 * Injected onto bid.cannonsauctions.com auction item pages.
 * Adds search, category filtering, and mobile layout improvements.
 *
 * Config is passed via window.__gooners_config before this script loads:
 *   { exclude: ["Coins", "Jewelry", ...], include: ["Furniture", ...] }
 */
(function () {
  'use strict';

  // Prevent double-injection
  if (window.__gooners_loaded) return;
  window.__gooners_loaded = true;

  var config = window.__gooners_config || { exclude: [], include: [] };

  // ---------------------------------------------------------------------------
  // DOM Selectors — based on Auction Mobility / Maxanet markup as of 2026-03
  // ---------------------------------------------------------------------------
  var SELECTORS = {
    // Container: Bootstrap row holding all item grid columns
    itemContainer: '.row.px-2',
    // Each item card is a Bootstrap column
    itemCard: ':scope > .col-lg-4',
    // Category stored in hidden input named Types{index}
    itemCategory: 'input[name^="Types"]',
    // Item name (e.g. "C4491")
    itemTitle: 'h4.auction-ItemGrid-Title a',
    // Full description
    itemDescription: '.catelog-desc',
    // Lot number text
    itemLot: 'span.public-item-font-color',
    // Current bid display
    itemBid: 'span[id^="CurrentBidAmount_"]',
    // Current bid amount from hidden input
    itemBidValue: 'input[name^="CurrentAmount_"]',
    // First (active) carousel image
    itemImage: '.carousel-item.active img',
    // Link to detail page
    itemLink: 'a[href*="AuctionItemDetail"]',
    // Time remaining countdown
    itemTimer: '.remain-time',
    // Total bids hidden input
    itemTotalBids: 'input[name^="TotalBids"]',
    // Category filter dropdown on the original page
    categoryDropdown: '#CategoryFilter',
  };

  // ---------------------------------------------------------------------------
  // Parse items from the page
  // ---------------------------------------------------------------------------
  function parseItems() {
    var container = document.querySelector(SELECTORS.itemContainer);
    if (!container) {
      console.warn('[Gooners] Could not find item container (.row.px-2)');
      return [];
    }

    var cards = container.querySelectorAll(SELECTORS.itemCard);
    if (!cards.length) {
      console.warn('[Gooners] No item cards found');
      return [];
    }

    var items = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];

      var catInput = card.querySelector(SELECTORS.itemCategory);
      var titleEl = card.querySelector(SELECTORS.itemTitle);
      var descEl = card.querySelector(SELECTORS.itemDescription);
      var lotEl = card.querySelector(SELECTORS.itemLot);
      var bidEl = card.querySelector(SELECTORS.itemBid);
      var bidValEl = card.querySelector(SELECTORS.itemBidValue);
      var imgEl = card.querySelector(SELECTORS.itemImage);
      var linkEl = card.querySelector(SELECTORS.itemLink);
      var timerEl = card.querySelector(SELECTORS.itemTimer);
      var bidsEl = card.querySelector(SELECTORS.itemTotalBids);

      items.push({
        element: card,
        category: catInput ? catInput.value : '',
        title: titleEl ? titleEl.textContent.trim() : '',
        description: descEl ? descEl.textContent.trim() : '',
        lot: lotEl ? lotEl.textContent.trim() : '',
        bid: bidEl ? bidEl.textContent.trim() : '',
        bidValue: bidValEl ? parseFloat(bidValEl.value) || 0 : 0,
        image: imgEl ? (imgEl.src || '') : '',
        link: linkEl ? linkEl.href : '',
        timeLeft: timerEl ? timerEl.textContent.trim() : '',
        totalBids: bidsEl ? parseInt(bidsEl.value) || 0 : 0,
      });
    }

    return items;
  }

  // ---------------------------------------------------------------------------
  // Get all categories from the page's own category dropdown
  // ---------------------------------------------------------------------------
  function getSiteCategories() {
    var select = document.querySelector(SELECTORS.categoryDropdown);
    if (!select) return [];
    var cats = [];
    for (var i = 0; i < select.options.length; i++) {
      var val = select.options[i].value;
      var text = select.options[i].textContent.trim();
      if (val && text) cats.push(text);
    }
    return cats;
  }

  // ---------------------------------------------------------------------------
  // Category extraction from items and matching logic
  // ---------------------------------------------------------------------------
  function extractCategories(items) {
    var cats = {};
    for (var i = 0; i < items.length; i++) {
      var c = items[i].category;
      if (c) cats[c] = (cats[c] || 0) + 1;
    }
    return Object.keys(cats).sort();
  }

  function matchesAnyTerm(text, terms) {
    if (!text) return false;
    var lower = text.toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      if (lower.indexOf(terms[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Filtering logic
  // ---------------------------------------------------------------------------
  var searchQuery = '';
  var hiddenCategories = {};

  function applyFilters(items) {
    var query = searchQuery.toLowerCase();
    var visibleCount = 0;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var show = true;

      // Category filter
      if (item.category && hiddenCategories[item.category]) {
        show = false;
      }

      // Search filter — matches against title, description, and lot
      if (show && query) {
        var searchable = (item.title + ' ' + item.description + ' ' + item.lot).toLowerCase();
        if (searchable.indexOf(query) === -1) {
          show = false;
        }
      }

      item.element.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    }

    updateCount(visibleCount, items.length);
  }

  var countEl = null;
  function updateCount(visible, total) {
    if (countEl) {
      countEl.textContent = visible + ' of ' + total + ' items';
    }
  }

  // ---------------------------------------------------------------------------
  // UI: Shadow DOM toolbar
  // ---------------------------------------------------------------------------
  function createToolbar(items, categories) {
    var host = document.createElement('div');
    host.id = 'gooners-root';
    var shadow = host.attachShadow({ mode: 'open' });

    // Initialize hidden categories from config exclusion list
    for (var i = 0; i < categories.length; i++) {
      if (matchesAnyTerm(categories[i], config.exclude)) {
        hiddenCategories[categories[i]] = true;
      }
    }

    var toolbarHTML = '<div class="gooners-toolbar">';
    toolbarHTML += '<div class="gooners-header">';
    toolbarHTML += '<span class="gooners-logo">Gooners</span>';
    toolbarHTML += '<span class="gooners-count"></span>';
    toolbarHTML += '<button class="gooners-close" title="Close Gooners">&times;</button>';
    toolbarHTML += '</div>';
    toolbarHTML += '<input type="text" class="gooners-search" placeholder="Search items by name, description, lot..." />';
    toolbarHTML += '<div class="gooners-chips">';
    for (var j = 0; j < categories.length; j++) {
      var cat = categories[j];
      var isHidden = !!hiddenCategories[cat];
      toolbarHTML += '<button class="gooners-chip' + (isHidden ? ' hidden' : '') + '" data-cat="' + escapeAttr(cat) + '">';
      toolbarHTML += escapeHTML(cat);
      toolbarHTML += '</button>';
    }
    toolbarHTML += '</div>';
    toolbarHTML += '</div>';

    shadow.innerHTML = '<style>' + getToolbarCSS() + '</style>' + toolbarHTML;

    // Wire up search
    var searchInput = shadow.querySelector('.gooners-search');
    var searchTimeout;
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(function () {
        searchQuery = searchInput.value;
        applyFilters(items);
      }, 150);
    });

    // Wire up category chips
    var chips = shadow.querySelectorAll('.gooners-chip');
    for (var k = 0; k < chips.length; k++) {
      chips[k].addEventListener('click', function () {
        var cat = this.getAttribute('data-cat');
        hiddenCategories[cat] = !hiddenCategories[cat];
        this.classList.toggle('hidden');
        applyFilters(items);
      });
    }

    // Wire up close button
    shadow.querySelector('.gooners-close').addEventListener('click', function () {
      // Show all items again
      for (var i = 0; i < items.length; i++) {
        items[i].element.style.display = '';
      }
      host.remove();
      window.__gooners_loaded = false;
    });

    countEl = shadow.querySelector('.gooners-count');

    return host;
  }

  function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getToolbarCSS() {
    return [
      '*, *::before, *::after { box-sizing: border-box; }',
      '.gooners-toolbar {',
      '  position: fixed; top: 0; left: 0; right: 0; z-index: 99998;',
      '  background: #1a1a2e; color: #eee;',
      '  padding: 12px 16px; font-family: system-ui, -apple-system, sans-serif;',
      '  box-shadow: 0 2px 12px rgba(0,0,0,0.3);',
      '  max-height: 50vh; overflow-y: auto;',
      '}',
      '.gooners-header {',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  margin-bottom: 8px;',
      '}',
      '.gooners-logo {',
      '  font-size: 18px; font-weight: 700; color: #e94560;',
      '}',
      '.gooners-count {',
      '  font-size: 13px; color: #999; flex: 1; text-align: center;',
      '}',
      '.gooners-close {',
      '  background: none; border: none; color: #999; font-size: 22px;',
      '  cursor: pointer; padding: 0 4px; line-height: 1;',
      '}',
      '.gooners-close:hover { color: #e94560; }',
      '.gooners-search {',
      '  width: 100%; box-sizing: border-box;',
      '  padding: 10px 14px; border: 1px solid #333; border-radius: 8px;',
      '  background: #16213e; color: #eee; font-size: 16px;',
      '  outline: none; margin-bottom: 10px;',
      '}',
      '.gooners-search:focus { border-color: #e94560; }',
      '.gooners-search::placeholder { color: #666; }',
      '.gooners-chips {',
      '  display: flex; flex-wrap: wrap; gap: 6px;',
      '}',
      '.gooners-chip {',
      '  padding: 6px 12px; border-radius: 16px; border: 1px solid #333;',
      '  background: #0f3460; color: #eee; font-size: 13px;',
      '  cursor: pointer; transition: all 0.15s;',
      '  white-space: nowrap;',
      '}',
      '.gooners-chip:hover { border-color: #e94560; }',
      '.gooners-chip.hidden {',
      '  background: #333; color: #777; text-decoration: line-through;',
      '}',
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // Push page content down so the toolbar doesn't overlap
  // ---------------------------------------------------------------------------
  function addBodyPadding() {
    var toolbar = document.querySelector('#gooners-root');
    if (!toolbar || !toolbar.shadowRoot) return;
    var tb = toolbar.shadowRoot.querySelector('.gooners-toolbar');
    if (!tb) return;
    // Give time for render
    setTimeout(function () {
      document.body.style.paddingTop = tb.offsetHeight + 'px';
    }, 50);
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------
  function main() {
    console.log('%c[Gooners] Initializing...', 'color: #e94560; font-size: 12px;');

    var items = parseItems();
    if (!items.length) {
      console.warn('[Gooners] No items found on this page. Make sure you are on an auction items page.');
      var banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#e74c3c;color:#fff;padding:16px;font:16px/1.4 system-ui,sans-serif;text-align:center;';
      banner.innerHTML = '<strong>Gooners:</strong> No auction items found on this page. Navigate to an auction items listing page first.';
      document.body.prepend(banner);
      setTimeout(function () { banner.remove(); }, 5000);
      window.__gooners_loaded = false;
      return;
    }

    console.log('[Gooners] Found ' + items.length + ' items');

    // Get categories from items themselves
    var categories = extractCategories(items);
    console.log('[Gooners] Categories found:', categories);

    // Inject toolbar
    var toolbar = createToolbar(items, categories);
    document.body.prepend(toolbar);
    addBodyPadding();

    // Apply initial filters (exclude configured categories)
    applyFilters(items);

    console.log('%c[Gooners] Ready! ' + items.length + ' items loaded.', 'color: #27ae60; font-size: 12px;');
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
