/**
 * target_proxy.js  —  Local proxy for live Target sale data
 *
 * Usage:
 *   npm install        (one-time)
 *   node target_proxy.js
 *
 * Open tracker.html — it automatically switches to live data.
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
// Static files are served by Vercel in production.
// For local development, serve them from this folder.
if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname)));
}

// ── Cache ────────────────────────────────────────────────────
let CACHE    = null;
let CACHE_AT = 0;
const CACHE_MS = 30 * 60 * 1000;

// ── Session ──────────────────────────────────────────────────
let VISITOR_ID = null;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Get a real Target visitor ID by hitting their homepage ────
async function getVisitorId() {
  try {
    const resp = await axios.get('https://www.target.com/', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      timeout: 10000,
    });
    // Extract visitorId from Set-Cookie headers
    const setCookies = resp.headers['set-cookie'] || [];
    for (const c of setCookies) {
      const m = c.match(/visitorId=([A-F0-9]+)/i);
      if (m) { VISITOR_ID = m[1]; return; }
    }
  } catch (e) {
    console.warn('[proxy] Could not fetch visitor ID, using random fallback.', e.message);
  }
  // Fallback: random hex string (16 chars)
  VISITOR_ID = [...Array(16)].map(() => Math.floor(Math.random()*16).toString(16).toUpperCase()).join('');
}

// ── Category config ──────────────────────────────────────────
// We query several keywords per category and filter to items
// where sale_price < regular_price.
const SEARCH_TERMS = [
  { cat: 'electronics', terms: ['tv television',    'laptop computer',  'headphones',   'bluetooth speaker', 'tablet ipad'] },
  { cat: 'clothing',    terms: ['women dress',      'men shirt',        'kids clothing','women shoes',       'men pants']   },
  { cat: 'home',        terms: ['vacuum cleaner',   'cookware pots',    'bedding sheets','storage organizer','coffee maker'] },
  { cat: 'food',        terms: ['coffee k-cups',    'protein bar',      'vitamins',     'snacks',            'tea']          },
  { cat: 'toys',        terms: ['lego building',    'action figure',    'board game',   'doll',              'craft kit']    },
  { cat: 'beauty',      terms: ['moisturizer skin', 'makeup foundation','shampoo',      'lipstick',          'face wash']    },
  { cat: 'sports',      terms: ['yoga mat',         'dumbbells weights','running shoes','bicycle bike',      'camping']      },
  { cat: 'pet',         terms: ['dog food',         'cat food',         'pet bed',      'cat litter',        'dog treats']   },
];

const CAT_ICON = {
  electronics: '📱', clothing: '👕', home: '🏠',
  food: '🛒', toys: '🎮', beauty: '💄', sports: '🏃', pet: '🐾',
};

// ── Fetch one search term ────────────────────────────────────
async function fetchTerm(keyword, catLabel) {
  const params = {
    key:                           '9f36aeafbe60771e321a7cc95a78140772ab3e96',
    channel:                       'WEB',
    count:                         24,
    default_purchasability_filter: false,
    include_sponsored:             false,
    keyword,
    offset:                        0,
    page:                          `/s?searchTerm=${encodeURIComponent(keyword)}`,
    platform:                      'desktop',
    visitor_id:                    VISITOR_ID,
    pricing_store_id:              '3991',
    zip:                           '10001',
    state:                         'NY',
    country:                       'USA',
  };

  const resp = await axios.get(
    'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2',
    {
      params,
      headers: {
        'User-Agent': UA,
        'Accept':     'application/json',
        'Referer':    `https://www.target.com/s?searchTerm=${encodeURIComponent(keyword)}`,
        'Origin':     'https://www.target.com',
      },
      timeout: 10000,
    }
  );

  const products = resp.data?.data?.search?.products || [];

  return products
    .filter(p => {
      const pr = p.price;
      return pr && pr.current_retail && pr.reg_retail &&
             parseFloat(pr.current_retail) < parseFloat(pr.reg_retail);
    })
    .map(p => normalise(p, catLabel));
}

// ── Normalise product into our schema ────────────────────────
function normalise(p, catLabel) {
  const item   = p.item || {};
  const desc   = item.product_description || {};
  const enr    = item.enrichment          || {};
  const price  = p.price                  || {};
  const rnr    = item.ratings_and_reviews?.statistics?.rating || {};
  const tcin   = p.tcin || String(Math.random());
  const brand  = item.primary_brand?.name || '';
  let   title  = (desc.title || 'Unknown Product')
                   .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  if (brand && !title.toLowerCase().includes(brand.toLowerCase())) {
    title = `${brand} ${title}`;
  }

  // Image URL — Target serves images via scene7 CDN
  const imgRaw = enr.image_info?.primary_image?.url || '';
  // Append scene7 resize params for a compact card thumbnail (300×300)
  const img = imgRaw ? `${imgRaw}?wid=300&hei=300&qlt=80&fmt=webp` : '';

  return {
    id:      `live-${tcin}`,
    cat:     catLabel,
    icon:    CAT_ICON[catLabel] || '🏷️',
    title:   title.slice(0, 90),
    orig:    parseFloat(price.reg_retail)     || 0,
    sale:    parseFloat(price.current_retail) || 0,
    rating:  Math.round((parseFloat(rnr.average) || 4.0) * 10) / 10,
    reviews: parseInt(rnr.count)              || 0,
    isNew:   false,
    url:     enr.buy_url || `https://www.target.com/p/-/A-${tcin}`,
    img,
  };
}

// ── Fetch all deals: one term per category in parallel ────────
async function fetchAllDeals() {
  if (!VISITOR_ID) await getVisitorId();
  console.log(`[proxy] visitor_id=${VISITOR_ID}`);
  console.log('[proxy] Fetching live Target sale data…');

  // Pick first two terms per category, run all in parallel
  const tasks = SEARCH_TERMS.flatMap(({ cat, terms }) =>
    terms.slice(0, 2).map(term => fetchTerm(term, cat).catch(e => {
      console.warn(`[proxy] ${cat}/"${term}" failed:`, e.message);
      return [];
    }))
  );

  const batches = await Promise.all(tasks);
  const raw = batches.flat();

  // Deduplicate by TCIN
  const seen  = new Set();
  const deals = raw.filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id); return true;
  });

  console.log(`[proxy] Got ${deals.length} live sale deals.`);
  return deals;
}

// ── Routes ───────────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  try {
    if (CACHE && Date.now() - CACHE_AT < CACHE_MS) {
      console.log(`[proxy] Cache hit (${CACHE.length} deals)`);
      return res.json({ source: 'cache', deals: CACHE });
    }

    const deals = await fetchAllDeals();
    if (deals.length === 0) {
      return res.status(502).json({ error: 'No sale items returned from Target.' });
    }

    CACHE = deals; CACHE_AT = Date.now();
    res.json({ source: 'live', deals });
  } catch (err) {
    console.error('[proxy] Fatal error:', err.message);
    res.status(502).json({ error: err.message });
  }
});


app.get('/health', (_, res) =>
  res.json({ status: 'ok', visitor_id: VISITOR_ID, cached: !!CACHE, deals: CACHE?.length || 0 })
);

// ── Start (local) / Export (Vercel) ──────────────────────────
if (require.main === module) {
  app.listen(PORT, async () => {
    await getVisitorId();
    console.log(`\n  Target Sale Proxy  →  http://localhost:${PORT}`);
    console.log(`  visitor_id: ${VISITOR_ID}`);
    console.log(`  /api/deals  — live sale items`);
    console.log(`  /health     — status\n`);
  });
}

module.exports = app;
