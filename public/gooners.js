/**
 * James River Gooners — Bookmarklet Payload
 *
 * Injected onto bid.cannonsauctions.com auction item pages.
 * Fetches ALL pages of items (same-origin), then renders a single
 * filterable/searchable view with category chips.
 *
 * Config via window.__gooners_config:
 *   { exclude: ["Coins", "Jewelry", ...], include: ["Furniture", ...] }
 */
(function () {
  'use strict';

  if (window.__gooners_loaded) return;
  window.__gooners_loaded = true;

  var config = window.__gooners_config || { exclude: [], include: [] };

  // ---------------------------------------------------------------------------
  // DOM Selectors for Auction Mobility / Maxanet (as of 2026-03)
  // ---------------------------------------------------------------------------
  var SEL = {
    itemContainer: '.row.px-2',
    itemCard: ':scope > .col-lg-4',
    category: 'input[name^="Types"]',
    title: 'h4.auction-ItemGrid-Title a',
    description: '.catelog-desc',
    lot: 'span.public-item-font-color',
    bid: 'span[id^="CurrentBidAmount_"]',
    bidValue: 'input[name^="CurrentAmount_"]',
    image: '.carousel-item.active img',
    link: 'a[href*="AuctionItemDetail"]',
    timer: '.remain-time',
    totalBids: 'input[name^="TotalBids"]',
    originalName: 'input[name^="OriginalName"]',
  };

  // ---------------------------------------------------------------------------
  // Extract items from a document (current page or fetched page)
  // ---------------------------------------------------------------------------
  function extractItemsFromDoc(doc) {
    var container = doc.querySelector(SEL.itemContainer);
    if (!container) return [];

    var cards = container.querySelectorAll(SEL.itemCard);
    var items = [];

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var q = function (sel) { return card.querySelector(sel); };

      var catEl = q(SEL.category);
      var titleEl = q(SEL.title);
      var descEl = q(SEL.description);
      var lotEl = q(SEL.lot);
      var bidEl = q(SEL.bid);
      var bidValEl = q(SEL.bidValue);
      var imgEl = q(SEL.image);
      var linkEl = q(SEL.link);
      var timerEl = q(SEL.timer);
      var bidsEl = q(SEL.totalBids);
      var nameEl = q(SEL.originalName);

      items.push({
        category: catEl ? catEl.value : '',
        title: nameEl ? nameEl.value : (titleEl ? titleEl.textContent.trim() : ''),
        description: descEl ? descEl.textContent.trim() : '',
        lot: lotEl ? lotEl.textContent.trim() : '',
        bid: bidEl ? bidEl.textContent.trim() : '',
        bidValue: bidValEl ? parseFloat(bidValEl.value) || 0 : 0,
        image: imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || '') : '',
        link: linkEl ? linkEl.href : '',
        timeLeft: timerEl ? timerEl.textContent.trim() : '',
        totalBids: bidsEl ? parseInt(bidsEl.value) || 0 : 0,
      });
    }

    return items;
  }

  // ---------------------------------------------------------------------------
  // Discover pagination URLs from the current page
  // ---------------------------------------------------------------------------
  function getPageUrls() {
    // Find all pagination links (the numbered page links)
    var pageLinks = document.querySelectorAll('.pagination a[href], a[onclick*="pageNumber"], a[href*="pageNumber"]');
    var urls = {};

    // Also try the simpler pagination structure
    var allLinks = document.querySelectorAll('a');
    for (var i = 0; i < allLinks.length; i++) {
      var a = allLinks[i];
      var href = a.getAttribute('href');
      var text = a.textContent.trim();

      // Look for numbered page links (1, 2, 3, etc.)
      if (href && /^\d+$/.test(text) && href.indexOf('pageNumber') !== -1) {
        urls[text] = href;
      }
      // Also grab "Last" link to know total pages
      if (href && text === 'Last' && href.indexOf('pageNumber') !== -1) {
        urls['Last'] = href;
      }
    }

    return urls;
  }

  // ---------------------------------------------------------------------------
  // Fetch a page and extract items from it
  // ---------------------------------------------------------------------------
  async function fetchPageItems(url) {
    try {
      // Make the URL absolute if relative
      if (url.startsWith('/')) {
        url = window.location.origin + url;
      }
      var resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) {
        console.warn('[Gooners] Failed to fetch page:', url, resp.status);
        return [];
      }
      var html = await resp.text();
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, 'text/html');
      return extractItemsFromDoc(doc);
    } catch (e) {
      console.warn('[Gooners] Error fetching page:', url, e);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Load all pages
  // ---------------------------------------------------------------------------
  async function loadAllItems(statusCallback) {
    // Get items from current page
    var currentItems = extractItemsFromDoc(document);
    statusCallback('Loaded page 1 (' + currentItems.length + ' items)');

    // Discover other page URLs
    var pageUrls = getPageUrls();
    var pageNums = Object.keys(pageUrls)
      .filter(function (k) { return /^\d+$/.test(k); })
      .map(Number)
      .sort(function (a, b) { return a - b; });

    console.log('[Gooners] Found page links:', pageNums);

    // We're on page 1 (or whichever page), fetch the rest
    var currentPage = 1;
    // Try to detect current page from the active pagination element
    var activePage = document.querySelector('.pagination .active, .page-item.active');
    if (activePage) {
      var num = parseInt(activePage.textContent.trim());
      if (!isNaN(num)) currentPage = num;
    }

    var allItems = currentItems.slice();

    // Fetch remaining pages concurrently (but limit concurrency to 3)
    var pagesToFetch = pageNums.filter(function (n) { return n !== currentPage; });
    var batchSize = 3;

    for (var i = 0; i < pagesToFetch.length; i += batchSize) {
      var batch = pagesToFetch.slice(i, i + batchSize);
      var promises = batch.map(function (pageNum) {
        var url = pageUrls[String(pageNum)];
        return fetchPageItems(url).then(function (items) {
          statusCallback('Loaded page ' + pageNum + ' (' + items.length + ' items)');
          return items;
        });
      });

      var results = await Promise.all(promises);
      for (var j = 0; j < results.length; j++) {
        allItems = allItems.concat(results[j]);
      }
    }

    return allItems;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function matchesAnyTerm(text, terms) {
    if (!text) return false;
    var lower = text.toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      if (lower.indexOf(terms[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function extractCategories(items) {
    var cats = {};
    for (var i = 0; i < items.length; i++) {
      var c = items[i].category;
      if (c) cats[c] = (cats[c] || 0) + 1;
    }
    return Object.keys(cats).sort();
  }

  // ---------------------------------------------------------------------------
  // Render the Gooners UI — replaces original page content
  // ---------------------------------------------------------------------------
  function renderUI(allItems) {
    var categories = extractCategories(allItems);
    var hiddenCategories = {};
    var searchQuery = '';

    // Initialize hidden categories from config
    for (var i = 0; i < categories.length; i++) {
      if (matchesAnyTerm(categories[i], config.exclude)) {
        hiddenCategories[categories[i]] = true;
      }
    }

    // Hide the original page content
    var originalContent = document.querySelector('.container-fluid') || document.querySelector('.container') || document.querySelector('main') || document.body.children[0];

    // Create our root container
    var root = document.createElement('div');
    root.id = 'gooners-app';

    // Build the toolbar
    var toolbar = document.createElement('div');
    toolbar.id = 'gooners-toolbar';

    toolbar.innerHTML = [
      '<div class="g-header">',
      '  <span class="g-logo">Gooners</span>',
      '  <span class="g-count" id="g-count"></span>',
      '  <button class="g-close" id="g-close">&times; Close</button>',
      '</div>',
      '<input type="text" class="g-search" id="g-search" placeholder="Search items by name, description, lot..." />',
      '<div class="g-chips" id="g-chips">',
      categories.map(function (cat) {
        var isHidden = !!hiddenCategories[cat];
        return '<button class="g-chip' + (isHidden ? ' g-chip-off' : '') + '" data-cat="' + escapeHTML(cat) + '">' + escapeHTML(cat) + ' <span class="g-chip-count">(' + extractCategories(allItems)[categories.indexOf(cat)] + ')</span></button>';
      }).join(''),
      '</div>',
    ].join('\n');

    // Rebuild chip counts properly
    var catCounts = {};
    for (var ci = 0; ci < allItems.length; ci++) {
      var cc = allItems[ci].category;
      if (cc) catCounts[cc] = (catCounts[cc] || 0) + 1;
    }

    toolbar.querySelector('#g-chips').innerHTML = categories.map(function (cat) {
      var isHidden = !!hiddenCategories[cat];
      var count = catCounts[cat] || 0;
      return '<button class="g-chip' + (isHidden ? ' g-chip-off' : '') + '" data-cat="' + escapeHTML(cat) + '">' + escapeHTML(cat) + ' (' + count + ')</button>';
    }).join('');

    // Build the items grid
    var grid = document.createElement('div');
    grid.id = 'gooners-grid';

    var cardElements = [];

    for (var j = 0; j < allItems.length; j++) {
      var item = allItems[j];
      var card = document.createElement('div');
      card.className = 'g-card';
      card.setAttribute('data-category', item.category);
      card.setAttribute('data-index', j);

      var detailUrl = item.link || '#';

      card.innerHTML = [
        '<a href="' + escapeHTML(detailUrl) + '" class="g-card-link" target="_blank" rel="noopener">',
        item.image ? '  <img class="g-card-img" src="' + escapeHTML(item.image) + '" alt="" loading="lazy" />' : '  <div class="g-card-img g-no-img">No image</div>',
        '</a>',
        '<div class="g-card-body">',
        '  <a href="' + escapeHTML(detailUrl) + '" class="g-card-title-link" target="_blank" rel="noopener">',
        '    <div class="g-card-lot">' + escapeHTML(item.lot) + '</div>',
        '    <div class="g-card-title">' + escapeHTML(item.title) + '</div>',
        '  </a>',
        '  <div class="g-card-desc">' + escapeHTML(item.description.substring(0, 120)) + (item.description.length > 120 ? '...' : '') + '</div>',
        '  <div class="g-card-meta">',
        '    <span class="g-card-bid">' + escapeHTML(item.bid) + '</span>',
        item.totalBids > 0 ? '    <span class="g-card-bids">' + item.totalBids + ' bid' + (item.totalBids !== 1 ? 's' : '') + '</span>' : '',
        '  </div>',
        '  <div class="g-card-footer">',
        '    <span class="g-card-cat">' + escapeHTML(item.category) + '</span>',
        item.timeLeft ? '    <span class="g-card-time">' + escapeHTML(item.timeLeft) + '</span>' : '',
        '  </div>',
        '</div>',
      ].join('\n');

      cardElements.push({ el: card, item: item });
      grid.appendChild(card);
    }

    // Inject styles
    var style = document.createElement('style');
    style.id = 'gooners-styles';
    style.textContent = getCSS();

    // Assemble
    root.appendChild(toolbar);
    root.appendChild(grid);

    // Hide everything on the page and inject our UI
    var bodyChildren = Array.prototype.slice.call(document.body.children);
    for (var bc = 0; bc < bodyChildren.length; bc++) {
      if (bodyChildren[bc].id !== 'gooners-app' && bodyChildren[bc].tagName !== 'SCRIPT' && bodyChildren[bc].tagName !== 'STYLE' && bodyChildren[bc].tagName !== 'LINK') {
        bodyChildren[bc].style.display = 'none';
        bodyChildren[bc].setAttribute('data-gooners-hidden', 'true');
      }
    }

    document.head.appendChild(style);
    document.body.prepend(root);

    // ----- Event wiring -----

    function applyFilters() {
      var query = searchQuery.toLowerCase();
      var visibleCount = 0;

      for (var i = 0; i < cardElements.length; i++) {
        var ce = cardElements[i];
        var show = true;

        if (ce.item.category && hiddenCategories[ce.item.category]) {
          show = false;
        }

        if (show && query) {
          var searchable = (ce.item.title + ' ' + ce.item.description + ' ' + ce.item.lot + ' ' + ce.item.category).toLowerCase();
          if (searchable.indexOf(query) === -1) show = false;
        }

        ce.el.style.display = show ? '' : 'none';
        if (show) visibleCount++;
      }

      document.getElementById('g-count').textContent = visibleCount + ' of ' + allItems.length + ' items';
    }

    // Search
    var searchInput = document.getElementById('g-search');
    var searchTimeout;
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(function () {
        searchQuery = searchInput.value;
        applyFilters();
      }, 150);
    });

    // Category chips
    var chips = document.querySelectorAll('#g-chips .g-chip');
    for (var k = 0; k < chips.length; k++) {
      chips[k].addEventListener('click', function () {
        var cat = this.getAttribute('data-cat');
        hiddenCategories[cat] = !hiddenCategories[cat];
        this.classList.toggle('g-chip-off');
        applyFilters();
      });
    }

    // Close button — restore original page
    document.getElementById('g-close').addEventListener('click', function () {
      root.remove();
      style.remove();
      var hidden = document.querySelectorAll('[data-gooners-hidden]');
      for (var i = 0; i < hidden.length; i++) {
        hidden[i].style.display = '';
        hidden[i].removeAttribute('data-gooners-hidden');
      }
      window.__gooners_loaded = false;
    });

    // Initial filter
    applyFilters();
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function getCSS() {
    return [
      '#gooners-app { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; min-height: 100vh; }',
      '#gooners-toolbar { position: sticky; top: 0; z-index: 9999; background: #1a1a2e; color: #eee; padding: 12px 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.3); }',
      '.g-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }',
      '.g-logo { font-size: 20px; font-weight: 800; color: #e94560; }',
      '.g-count { font-size: 13px; color: #aaa; }',
      '.g-close { background: none; border: 1px solid #555; color: #ccc; font-size: 13px; padding: 4px 12px; border-radius: 6px; cursor: pointer; }',
      '.g-close:hover { border-color: #e94560; color: #e94560; }',
      '.g-search { width: 100%; box-sizing: border-box; padding: 10px 14px; border: 1px solid #333; border-radius: 8px; background: #16213e; color: #eee; font-size: 16px; outline: none; margin-bottom: 10px; }',
      '.g-search:focus { border-color: #e94560; }',
      '.g-search::placeholder { color: #666; }',
      '.g-chips { display: flex; flex-wrap: wrap; gap: 6px; }',
      '.g-chip { padding: 5px 10px; border-radius: 14px; border: 1px solid #333; background: #0f3460; color: #eee; font-size: 12px; cursor: pointer; transition: all 0.15s; white-space: nowrap; }',
      '.g-chip:hover { border-color: #e94560; }',
      '.g-chip-off { background: #333; color: #666; text-decoration: line-through; }',

      '#gooners-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; padding: 16px; max-width: 1400px; margin: 0 auto; }',
      '@media (max-width: 640px) { #gooners-grid { grid-template-columns: 1fr; padding: 8px; gap: 8px; } }',

      '.g-card { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.1); display: flex; flex-direction: column; transition: box-shadow 0.15s; }',
      '.g-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.15); }',
      '.g-card-link { display: block; }',
      '.g-card-img { width: 100%; height: 200px; object-fit: contain; background: #f9f9f9; display: block; }',
      '.g-no-img { display: flex; align-items: center; justify-content: center; color: #ccc; font-size: 14px; }',
      '.g-card-body { padding: 12px; flex: 1; display: flex; flex-direction: column; }',
      '.g-card-title-link { text-decoration: none; color: inherit; }',
      '.g-card-title-link:hover { color: #e94560; }',
      '.g-card-lot { font-size: 12px; color: #888; font-weight: 600; }',
      '.g-card-title { font-size: 15px; font-weight: 700; margin: 2px 0 6px; color: #222; }',
      '.g-card-desc { font-size: 13px; color: #666; line-height: 1.4; margin-bottom: 8px; flex: 1; }',
      '.g-card-meta { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }',
      '.g-card-bid { font-size: 16px; font-weight: 700; color: #1a8a1a; }',
      '.g-card-bids { font-size: 12px; color: #888; }',
      '.g-card-footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #eee; padding-top: 6px; margin-top: auto; }',
      '.g-card-cat { font-size: 11px; color: #999; background: #f0f0f0; padding: 2px 8px; border-radius: 10px; }',
      '.g-card-time { font-size: 11px; color: #e94560; font-weight: 600; }',

      '.g-loading { text-align: center; padding: 40px; font-size: 16px; color: #666; }',
      '.g-loading-status { font-size: 13px; color: #999; margin-top: 8px; }',
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------
  async function main() {
    console.log('%c[Gooners] Initializing...', 'color: #e94560; font-size: 14px;');

    // Inject a loading screen
    var style = document.createElement('style');
    style.id = 'gooners-styles';
    style.textContent = getCSS();
    document.head.appendChild(style);

    var loadingDiv = document.createElement('div');
    loadingDiv.id = 'gooners-app';
    loadingDiv.innerHTML = '<div class="g-loading"><div class="g-logo" style="font-size:28px;color:#e94560;margin-bottom:12px;">Gooners</div><div>Loading all auction items...</div><div class="g-loading-status" id="g-loading-status">Scanning page 1...</div></div>';

    // Hide original content
    var bodyChildren = Array.prototype.slice.call(document.body.children);
    for (var i = 0; i < bodyChildren.length; i++) {
      if (bodyChildren[i].tagName !== 'SCRIPT' && bodyChildren[i].tagName !== 'STYLE' && bodyChildren[i].tagName !== 'LINK') {
        bodyChildren[i].style.display = 'none';
        bodyChildren[i].setAttribute('data-gooners-hidden', 'true');
      }
    }
    document.body.prepend(loadingDiv);

    var statusEl = document.getElementById('g-loading-status');

    // Load all items
    var allItems = await loadAllItems(function (msg) {
      console.log('[Gooners] ' + msg);
      if (statusEl) statusEl.textContent = msg;
    });

    console.log('%c[Gooners] Loaded ' + allItems.length + ' total items', 'color: #27ae60; font-size: 14px;');

    // Remove loading screen and render full UI
    loadingDiv.remove();
    style.remove();

    renderUI(allItems);
  }

  main();
})();
