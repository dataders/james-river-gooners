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
  // DOM Selectors — update these if Auction Mobility changes their markup
  // ---------------------------------------------------------------------------
  // These are best-guess selectors for the Auction Mobility platform.
  // If they don't match, discovery mode kicks in and logs diagnostics.
  var SELECTORS = {
    // The grid/list container that holds all auction item cards
    itemContainer: [
      '.lot-list',
      '.auction-items',
      '#lotList',
      '#auctionItemsList',
      '[class*="lot-list"]',
      '[class*="item-list"]',
      '[class*="auction-item"]',
    ],
    // Individual item card
    itemCard: [
      '.lot-row',
      '.lot-item',
      '.auction-item',
      '.item-card',
      '[class*="lot-row"]',
      '[class*="lot-item"]',
      '[class*="lotRow"]',
    ],
    // Title text within a card
    itemTitle: [
      '.lot-title',
      '.item-title',
      '.lot-name',
      'h3',
      'h4',
      '[class*="title"]',
      '[class*="name"]',
    ],
    // Current bid amount within a card
    itemBid: [
      '.current-bid',
      '.bid-amount',
      '.lot-bid',
      '[class*="bid"]',
      '[class*="price"]',
    ],
    // Image within a card
    itemImage: ['img'],
    // Category label within a card
    itemCategory: [
      '.category',
      '.lot-category',
      '[class*="category"]',
      '[class*="cat-"]',
    ],
    // Link to item detail page
    itemLink: ['a[href*="AuctionItem"]', 'a[href*="LotDetail"]', 'a[href*="lot"]', 'a'],
  };

  // ---------------------------------------------------------------------------
  // Selector resolution
  // ---------------------------------------------------------------------------
  function findContainer() {
    for (var i = 0; i < SELECTORS.itemContainer.length; i++) {
      var el = document.querySelector(SELECTORS.itemContainer[i]);
      if (el) return el;
    }
    return null;
  }

  function findCards(container) {
    for (var i = 0; i < SELECTORS.itemCard.length; i++) {
      var cards = container.querySelectorAll(SELECTORS.itemCard[i]);
      if (cards.length > 0) return { selector: SELECTORS.itemCard[i], cards: cards };
    }
    // Fallback: direct children that look like repeated items
    var children = container.children;
    if (children.length > 3) return { selector: ':scope > *', cards: children };
    return null;
  }

  function findInCard(card, selectorList) {
    for (var i = 0; i < selectorList.length; i++) {
      var el = card.querySelector(selectorList[i]);
      if (el) return el;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Discovery mode — logs DOM structure when selectors fail
  // ---------------------------------------------------------------------------
  function runDiscovery() {
    console.group('%c[Gooners] Discovery Mode', 'color: #e74c3c; font-size: 14px;');
    console.log('Could not find the auction items container. Logging page structure to help identify selectors.');
    console.log('');

    // Log all elements with many children (likely containers)
    var allElements = document.querySelectorAll('*');
    var candidates = [];
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (el.children.length >= 5) {
        candidates.push({
          tag: el.tagName,
          id: el.id,
          className: el.className,
          childCount: el.children.length,
          firstChildTag: el.children[0] ? el.children[0].tagName : 'none',
          firstChildClass: el.children[0] ? el.children[0].className : 'none',
        });
      }
    }
    candidates.sort(function (a, b) { return b.childCount - a.childCount; });
    console.log('Elements with 5+ children (likely item containers):');
    console.table(candidates.slice(0, 20));

    // Log all classes used on the page
    var classCounts = {};
    for (var j = 0; j < allElements.length; j++) {
      var classes = allElements[j].classList;
      for (var k = 0; k < classes.length; k++) {
        classCounts[classes[k]] = (classCounts[classes[k]] || 0) + 1;
      }
    }
    var sortedClasses = Object.keys(classCounts)
      .map(function (c) { return { class: c, count: classCounts[c] }; })
      .sort(function (a, b) { return b.count - a.count; });
    console.log('Most common CSS classes on this page:');
    console.table(sortedClasses.slice(0, 40));

    console.log('');
    console.log('Next steps: identify the item container and card selectors from the data above,');
    console.log('then update the SELECTORS object at the top of gooners.js.');
    console.groupEnd();

    // Inject a visible banner so user knows it ran
    injectDiscoveryBanner();
  }

  function injectDiscoveryBanner() {
    var banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#e74c3c;color:#fff;padding:16px;font:16px/1.4 system-ui,sans-serif;text-align:center;';
    banner.innerHTML = '<strong>Gooners:</strong> Discovery mode &mdash; selectors need updating. Open browser console (F12) for details.';
    document.body.prepend(banner);
  }

  // ---------------------------------------------------------------------------
  // Parse items from the page
  // ---------------------------------------------------------------------------
  function parseItems(container, cardResult) {
    var items = [];
    var cards = cardResult.cards;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var titleEl = findInCard(card, SELECTORS.itemTitle);
      var bidEl = findInCard(card, SELECTORS.itemBid);
      var imgEl = findInCard(card, SELECTORS.itemImage);
      var catEl = findInCard(card, SELECTORS.itemCategory);
      var linkEl = findInCard(card, SELECTORS.itemLink);

      items.push({
        element: card,
        title: titleEl ? titleEl.textContent.trim() : '',
        bid: bidEl ? bidEl.textContent.trim() : '',
        image: imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || '') : '',
        category: catEl ? catEl.textContent.trim() : '',
        link: linkEl ? linkEl.href : '',
      });
    }
    return items;
  }

  // ---------------------------------------------------------------------------
  // Category extraction and matching
  // ---------------------------------------------------------------------------
  function extractCategories(items) {
    var cats = {};
    for (var i = 0; i < items.length; i++) {
      var c = items[i].category;
      if (c) cats[c] = (cats[c] || 0) + 1;
    }
    return Object.keys(cats).sort();
  }

  function matchesCategory(itemCategory, categoryList) {
    if (!itemCategory) return false;
    var lower = itemCategory.toLowerCase();
    for (var i = 0; i < categoryList.length; i++) {
      if (lower.indexOf(categoryList[i].toLowerCase()) !== -1) return true;
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

      // Search filter
      if (show && query && item.title.toLowerCase().indexOf(query) === -1) {
        show = false;
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

    // Initialize hidden categories from config
    for (var i = 0; i < categories.length; i++) {
      if (matchesCategory(categories[i], config.exclude)) {
        hiddenCategories[categories[i]] = true;
      }
    }

    var toolbarHTML = '<div class="gooners-toolbar">';
    toolbarHTML += '<div class="gooners-header">';
    toolbarHTML += '<span class="gooners-logo">Gooners</span>';
    toolbarHTML += '<span class="gooners-count"></span>';
    toolbarHTML += '</div>';
    toolbarHTML += '<input type="text" class="gooners-search" placeholder="Search items..." />';
    toolbarHTML += '<div class="gooners-chips">';
    for (var j = 0; j < categories.length; j++) {
      var cat = categories[j];
      var isHidden = !!hiddenCategories[cat];
      toolbarHTML += '<button class="gooners-chip' + (isHidden ? ' hidden' : '') + '" data-cat="' + cat.replace(/"/g, '&quot;') + '">';
      toolbarHTML += cat;
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

    countEl = shadow.querySelector('.gooners-count');

    return host;
  }

  function getToolbarCSS() {
    return [
      '.gooners-toolbar {',
      '  position: sticky; top: 0; z-index: 99998;',
      '  background: #1a1a2e; color: #eee;',
      '  padding: 12px 16px; font-family: system-ui, -apple-system, sans-serif;',
      '  box-shadow: 0 2px 12px rgba(0,0,0,0.3);',
      '}',
      '.gooners-header {',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  margin-bottom: 8px;',
      '}',
      '.gooners-logo {',
      '  font-size: 18px; font-weight: 700; color: #e94560;',
      '}',
      '.gooners-count {',
      '  font-size: 13px; color: #999;',
      '}',
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
      '}',
      '.gooners-chip:hover { border-color: #e94560; }',
      '.gooners-chip.hidden {',
      '  background: #333; color: #777; text-decoration: line-through;',
      '}',
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // UI: Mobile card layout improvements (injected into main document)
  // ---------------------------------------------------------------------------
  function injectCardStyles() {
    var style = document.createElement('style');
    style.id = 'gooners-card-styles';
    style.textContent = [
      '/* Gooners: Mobile card layout improvements */',
      '@media (max-width: 768px) {',
      '  [class*="lot-row"], [class*="lot-item"], [class*="auction-item"], .item-card {',
      '    display: flex !important;',
      '    flex-direction: row !important;',
      '    align-items: flex-start !important;',
      '    gap: 12px !important;',
      '    padding: 12px !important;',
      '    margin-bottom: 8px !important;',
      '    border-bottom: 1px solid #eee !important;',
      '  }',
      '  [class*="lot-row"] img, [class*="lot-item"] img, [class*="auction-item"] img, .item-card img {',
      '    width: 100px !important;',
      '    height: 100px !important;',
      '    object-fit: cover !important;',
      '    border-radius: 8px !important;',
      '    flex-shrink: 0 !important;',
      '  }',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------
  function main() {
    console.log('%c[Gooners] Initializing...', 'color: #e94560; font-size: 12px;');

    var container = findContainer();
    if (!container) {
      console.warn('[Gooners] Could not find item container. Running discovery mode.');
      runDiscovery();
      return;
    }

    var cardResult = findCards(container);
    if (!cardResult || cardResult.cards.length === 0) {
      console.warn('[Gooners] Found container but no item cards. Running discovery mode.');
      runDiscovery();
      return;
    }

    console.log('[Gooners] Found ' + cardResult.cards.length + ' items using selector: ' + cardResult.selector);

    var items = parseItems(container, cardResult);
    var categories = extractCategories(items);
    console.log('[Gooners] Categories found:', categories);

    // Inject toolbar
    var toolbar = createToolbar(items, categories);
    document.body.prepend(toolbar);

    // Inject card style improvements
    injectCardStyles();

    // Apply initial filters (exclude configured categories)
    applyFilters(items);

    console.log('%c[Gooners] Ready!', 'color: #27ae60; font-size: 12px;');
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
