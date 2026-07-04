const OpenAI = require('openai');
const supabase = require('./supabase');
const { GARMENT_TYPE_LIST, normalizeGarmentType } = require('./garment-vocab');

// Validate OpenAI API key
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ FATAL: OPENAI_API_KEY environment variable is not set!');
  throw new Error('OPENAI_API_KEY is required');
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY.trim(),
});

// Global safety cap on how many products ANY embedding run may describe/embed,
// across all stores and all entry points (OAuth reconnect auto-sync, /sync
// webhook, manual resync). Each product costs one GPT-4o vision call, so this
// protects the OpenAI quota while the description scheme is being iterated on.
// Set EMBEDDING_MAX_PRODUCTS in the environment (e.g. 10); unset it to lift
// the cap. An explicit per-call limit (e.g. resync body {"limit": N}) takes
// precedence over this default.
const ENV_EMBEDDING_LIMIT = parseInt(process.env.EMBEDDING_MAX_PRODUCTS || '', 10);

/**
 * Shared building blocks for the vision prompts. Symmetry is the whole point:
 * the product-indexing side and the customer-query side must produce
 * descriptions with the same structure and wording conventions so their
 * embeddings live in the same region of vector space. The two prompts below
 * differ ONLY in how many items they extract — the per-item schema and the
 * detail requirements are shared verbatim. Do not fork them separately.
 */
const DETAIL_SPEC = `Describe in EXTREME visual detail — precise enough that an image-generation tool could recreate the EXACT item from your words alone. Never write generic descriptions. Always state: every color and where it appears on the garment; the pattern's direction, width and spacing; collar/neckline construction; trims and contrast edges; buttons/zips and their count and color; any logo, text or graphic with its placement, size and color; the fabric's visible texture; the cut, fit and length.`;

const ITEM_SCHEMA_BLOCK = `{
  "type": "<one allowed type from the list below>",
  "colors": ["<each color WITH its placement, e.g. 'light blue base', 'brown horizontal stripes', 'white trim on collar'>"],
  "pattern": "<precise pattern: kind, direction, width, spacing, e.g. 'thin brown double horizontal stripes about 2cm apart on a light blue base'; 'solid' if plain>",
  "material": "<fabric and visible texture, e.g. 'ribbed knit cotton', 'washed denim', 'smooth cotton jersey'>",
  "fit": "<silhouette AND length, e.g. 'slim fit, cropped above the waist', 'oversized, hip-length', 'wide-leg, knee-length'>",
  "neckline": "<neckline/collar construction, e.g. 'ribbed polo collar with open placket', 'scoop neck with contrast binding'; empty string if not applicable>",
  "sleeves": "<e.g. 'sleeveless with contrast-trimmed armholes', 'short sleeves with ribbed cuffs'; empty string if not applicable>",
  "closures": "<buttons, zips, drawstrings with count/color/placement, e.g. 'two-button placket, tonal buttons'; empty string if none visible>",
  "graphics": "<any logo, text or graphic print: content, placement, size, color, e.g. 'large white gothic-font logo across the chest'; empty string if none>",
  "details": "<remaining distinctive features: trims, cuffs, hems, stitching, pockets, hardware, e.g. 'contrasting white trim on neckline and armholes, ribbed hem'>",
  "summary": "<A DETAILED 4-6 sentence description of the item that an image-generation tool could recreate it EXACTLY from: garment type, every color and its placement, exact pattern with direction and spacing, fabric texture, collar/neckline, sleeves, closures, graphics with placement, trims, fit and length. Do not omit any visible detail.>"
}`;

const ALLOWED_TYPES_LINE = `Allowed types: ${GARMENT_TYPE_LIST.join(', ')}. If none fits, use "other".`;

// PRODUCT-INDEXING prompt: a product photo represents ONE product — describe
// only the most prominent item.
const VISION_PROMPT_BASE = `You are describing a fashion product photo for a visual search system.

Look at the photo. If more than one garment/product is visible, describe ONLY the single most prominent item (the largest, most central, or most in-focus one). Ignore all other items, the background, any model's other clothing, tags and packaging.

${DETAIL_SPEC}

Respond with STRICT JSON only (no markdown, no extra text) using exactly these keys:
${ITEM_SCHEMA_BLOCK}

${ALLOWED_TYPES_LINE}`;

// CUSTOMER-QUERY prompt: a customer photo may show a whole outfit — extract
// EVERY distinct sellable item so each can be vector-searched separately.
const VISION_PROMPT_MULTI = `You are describing a customer's photo for a fashion visual search system.

The photo may contain ONE or SEVERAL distinct purchasable fashion items (garments, bags, shoes, accessories — anything a clothing store could sell). Identify each distinct item, up to 3, ordered from most to least prominent. Ignore the background, the model's face and body, tags and packaging, and anything that is not a sellable fashion item. Never list the same item twice.

For EACH item: ${DETAIL_SPEC}

Respond with STRICT JSON only (no markdown, no extra text) in this exact shape:
{ "items": [ <one object per item, each with exactly these keys:>
${ITEM_SCHEMA_BLOCK}
] }

${ALLOWED_TYPES_LINE}`;

/**
 * Compose the final vision prompt. When catalog context (product name /
 * store description) is available — i.e. on the product-indexing side — it is
 * appended as HINTS so the model can resolve what pixels alone cannot
 * (exact fabric, official color names, garment type). The customer-query side
 * calls this with no arguments and gets the identical base prompt.
 */
function buildVisionPrompt({ productName, productDescription } = {}) {
  if (!productName && !productDescription) return VISION_PROMPT_BASE;
  const hints = [
    productName ? `Name: ${productName}` : null,
    productDescription ? `Store description: ${String(productDescription).substring(0, 500)}` : null,
  ].filter(Boolean).join('\n');
  return `${VISION_PROMPT_BASE}

KNOWN PRODUCT INFO from the store's catalog — use it ONLY to resolve what you cannot verify visually (exact fabric, official color names, garment type). Trust the image over the text if they conflict. Never copy marketing language; describe only what is visually real:
${hints}`;
}

/**
 * Download an image from a URL and convert to base64
 * @param {string} url - The image URL to download
 * @returns {Promise<{base64: string, contentType: string}>} Base64 data and content type
 */
async function downloadImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  return { base64, contentType };
}

/**
 * Flatten structured attributes into the canonical text that gets embedded.
 * Fixed field order + fixed labels on both sides = comparable vectors.
 * @param {object} attrs - Parsed attribute JSON from the vision model
 * @returns {string}
 */
function buildEmbeddingText(attrs) {
  const colors = Array.isArray(attrs.colors) ? attrs.colors.join(', ') : (attrs.colors || '');
  return [
    `Type: ${attrs.type || 'unknown'}.`,
    colors ? `Colors: ${colors}.` : null,
    attrs.pattern ? `Pattern: ${attrs.pattern}.` : null,
    attrs.material ? `Material: ${attrs.material}.` : null,
    attrs.fit ? `Fit: ${attrs.fit}.` : null,
    attrs.neckline ? `Neckline: ${attrs.neckline}.` : null,
    attrs.sleeves ? `Sleeves: ${attrs.sleeves}.` : null,
    attrs.closures ? `Closures: ${attrs.closures}.` : null,
    attrs.graphics ? `Graphics: ${attrs.graphics}.` : null,
    attrs.details ? `Details: ${attrs.details}.` : null,
    attrs.summary ? `Summary: ${attrs.summary}` : null,
  ].filter(Boolean).join(' ');
}

/**
 * Describe an image with GPT-4o vision using the shared structured schema.
 * Used by BOTH product indexing and customer-query search.
 * Falls back gracefully to free text when the model returns unparseable JSON.
 * @param {{base64: string, contentType: string}} image
 * @param {{productName?: string, productDescription?: string}} [catalogHints]
 *        Product-indexing side only: catalog info the model may use to resolve
 *        visually ambiguous attributes. Omit entirely for customer images.
 * @returns {Promise<{attributes: object|null, garmentType: string|null, summary: string, embeddingText: string, usage: object|null}>}
 */
async function describeImageForSearch({ base64, contentType }, catalogHints = {}) {
  let raw = '';
  let usage = null;
  let attributes = null;

  // The API occasionally returns an empty or truncated body — retry once
  // before degrading, so a transient hiccup can't index a product with a
  // blank description.
  for (let attempt = 1; attempt <= 2 && !attributes; attempt++) {
    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildVisionPrompt(catalogHints) },
          {
            type: 'image_url',
            image_url: {
              url: `data:${contentType};base64,${base64}`,
              // 'auto' on both sides — symmetric inputs produce symmetric descriptions
              detail: 'auto'
            }
          }
        ]
      }]
    });

    raw = visionResponse.choices[0].message.content || '';
    usage = visionResponse.usage || null;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.summary) attributes = parsed;
    } catch (err) { /* retry below */ }

    if (!attributes && attempt < 2) {
      console.warn(`⚠️  Vision returned unusable output (attempt ${attempt}), retrying: ${raw.substring(0, 80)}...`);
    }
  }

  if (!attributes) {
    if (!raw.trim()) {
      // Nothing usable came back at all — fail loudly so the caller's error
      // path leaves the product unindexed for the next run instead of
      // storing an empty description/embedding.
      throw new Error('Vision returned empty response after retry');
    }
    console.warn(`⚠️  Vision returned non-JSON after retry, falling back to free text: ${raw.substring(0, 80)}...`);
    // Fallback: behave like the old free-text pipeline (no type gating)
    return { attributes: null, garmentType: null, summary: raw, embeddingText: raw, usage };
  }

  const garmentType = normalizeGarmentType(attributes.type);
  const summary = attributes.summary || buildEmbeddingText(attributes);
  return {
    attributes,
    garmentType,
    summary,
    embeddingText: buildEmbeddingText(attributes),
    usage
  };
}

/**
 * Describe ALL distinct sellable items in a customer's photo (up to 3), each
 * under the same structured schema as product indexing, so every item can be
 * vector-searched separately. Mirrors describeImageForSearch's retry behavior.
 * @param {{base64: string, contentType: string}} image
 * @returns {Promise<{items: Array<{attributes: object|null, garmentType: string|null, summary: string, embeddingText: string}>, usage: object|null}>}
 */
async function describeImageItemsForSearch({ base64, contentType }) {
  let raw = '';
  let usage = null;
  let rawItems = null;

  for (let attempt = 1; attempt <= 2 && !rawItems; attempt++) {
    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1500, // room for up to 3 fully detailed items
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT_MULTI },
          {
            type: 'image_url',
            image_url: {
              url: `data:${contentType};base64,${base64}`,
              detail: 'auto'
            }
          }
        ]
      }]
    });

    raw = visionResponse.choices[0].message.content || '';
    usage = visionResponse.usage || null;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.items) && parsed.items.length > 0) {
        rawItems = parsed.items;
      } else if (parsed && typeof parsed === 'object' && parsed.summary) {
        // Model ignored the wrapper and returned a single item object
        rawItems = [parsed];
      }
    } catch (err) { /* retry below */ }

    if (!rawItems && attempt < 2) {
      console.warn(`⚠️  Multi-item vision returned unusable output (attempt ${attempt}), retrying: ${raw.substring(0, 80)}...`);
    }
  }

  if (!rawItems) {
    if (!raw.trim()) throw new Error('Vision returned empty response after retry');
    console.warn(`⚠️  Multi-item vision returned non-JSON after retry, falling back to free text: ${raw.substring(0, 80)}...`);
    return { items: [{ attributes: null, garmentType: null, summary: raw, embeddingText: raw }], usage };
  }

  const items = rawItems.slice(0, 3)
    .filter(a => a && typeof a === 'object')
    .map(attrs => ({
      attributes: attrs,
      garmentType: normalizeGarmentType(attrs.type),
      summary: attrs.summary || buildEmbeddingText(attrs),
      embeddingText: buildEmbeddingText(attrs)
    }));
  return { items, usage };
}

/**
 * Embed a canonical description string with the same model on both sides.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedText(text) {
  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  return embeddingResponse.data[0].embedding;
}

/**
 * Generate structured description + embedding for a single product image.
 * Stores: image_description (detailed human-readable description),
 * image_attributes (structured JSON), garment_type (controlled vocab) and the
 * embedding. The product's name and store description are passed to the vision
 * model as hints so attributes like fabric and official color names come out
 * right even when the pixels alone are ambiguous.
 * @param {object} product - { shopify_product_id, name, image_url, product_type?, description? }
 * @returns {Promise<number[]|null>} The embedding vector or null if failed
 */
async function generateProductEmbedding(product) {
  if (!product.image_url) {
    console.log(`⚠️  Skipping ${product.name} - no image URL`);
    return null;
  }

  try {
    const image = await downloadImageAsBase64(product.image_url);
    const described = await describeImageForSearch(image, {
      productName: product.name,
      productDescription: product.description
    });

    // Garment type: prefer what vision saw (that's what the matcher compares
    // against customer photos), fall back to Shopify's product_type or title.
    const shopifyType = normalizeGarmentType(product.product_type) || normalizeGarmentType(product.name);
    const garmentType = described.garmentType || shopifyType;
    if (described.garmentType && shopifyType && described.garmentType !== shopifyType) {
      console.warn(`⚠️  Type disagreement for ${product.name}: vision="${described.garmentType}" vs shopify="${shopifyType}" — keeping vision`);
    }

    console.log(`📝 ${product.name} → type: ${garmentType || 'unknown'} | ${described.embeddingText.substring(0, 100)}...`);

    const embedding = await embedText(described.embeddingText);

    const { error } = await supabase
      .from('products')
      .update({
        image_description: described.summary,
        image_attributes: described.attributes,
        garment_type: garmentType,
        embedding: embedding
      })
      .eq('shopify_product_id', product.shopify_product_id);

    if (error) {
      console.error(`❌ Failed to save embedding for ${product.name}:`, error.message);
      return null;
    }

    console.log(`✅ Embedding generated for ${product.name}`);
    return embedding;

  } catch (err) {
    console.error(`❌ Embedding failed for ${product.name}:`, err.message);
    return null;
  }
}

/**
 * Generate embeddings for all products of a brand that need (re)indexing:
 * products with no embedding yet, plus products indexed under the old
 * free-text scheme (no garment_type) that need migrating to the structured one.
 * Pass { force: true } to re-describe and re-embed EVERY product with an image
 * regardless of state — needed whenever the description scheme changes.
 * Pass { limit: N } to cap how many products are processed (ordered by name,
 * so repeat runs hit the same products) — each product costs one GPT-4o vision
 * call + one embedding call, so use a small limit to test without burning
 * quota on the whole catalog.
 * @param {string} brandId - The brand ID to generate embeddings for
 * @param {{force?: boolean, limit?: number|null}} [options]
 * @returns {Promise<void>}
 */
async function generateEmbeddingsForBrand(brandId, { force = false, limit = null } = {}) {
  try {
    // Explicit per-call limit wins; otherwise fall back to the global
    // EMBEDDING_MAX_PRODUCTS env cap (quota protection during testing).
    let effectiveLimit = null;
    if (Number.isInteger(limit) && limit > 0) {
      effectiveLimit = limit;
      console.log(`🔢 Embedding run capped at ${effectiveLimit} products (requested limit)`);
    } else if (Number.isInteger(ENV_EMBEDDING_LIMIT) && ENV_EMBEDDING_LIMIT > 0) {
      effectiveLimit = ENV_EMBEDDING_LIMIT;
      console.log(`🔢 Embedding run capped at ${effectiveLimit} products (EMBEDDING_MAX_PRODUCTS env)`);
    }

    let query = supabase
      .from('products')
      .select('shopify_product_id, name, image_url, product_type, description')
      .eq('brand_id', brandId)
      .not('image_url', 'is', null)
      .order('name', { ascending: true });
    if (!force) {
      query = query.or('embedding.is.null,garment_type.is.null');
    }
    if (effectiveLimit) {
      query = query.limit(effectiveLimit);
    }
    const { data: products, error } = await query;

    if (error) {
      console.error('❌ Failed to fetch products:', error.message);
      return;
    }

    if (!products || products.length === 0) {
      console.log(`ℹ️  No products need embeddings for brand ${brandId}`);
      return;
    }

    console.log(`🔄 Generating embeddings for ${products.length} products...`);

    let successCount = 0;
    let failCount = 0;

    // Process sequentially to avoid rate limits
    for (const product of products) {
      const embedding = await generateProductEmbedding(product);
      if (embedding) {
        successCount++;
      } else {
        failCount++;
      }

      // Small delay to avoid OpenAI rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`✅ Embedding generation complete for brand ${brandId}`);
    console.log(`   Success: ${successCount}, Failed: ${failCount}`);

  } catch (err) {
    console.error('❌ Error in generateEmbeddingsForBrand:', err.message);
  }
}

/**
 * Search for products by image similarity using embeddings
 * (Diagnostic/utility path — Instagram DMs use findSimilarProducts in routes/instagram.js)
 * @param {string} brandId - The brand ID to search within
 * @param {string} queryImageUrl - URL of the query image
 * @param {number} limit - Maximum number of results (default 5)
 * @returns {Promise<Array>} Array of similar products with similarity scores
 */
async function searchProductsByImage(brandId, queryImageUrl, limit = 5) {
  try {
    const image = await downloadImageAsBase64(queryImageUrl);
    const described = await describeImageForSearch(image);
    const queryEmbedding = await embedText(described.embeddingText);

    // Use Supabase vector similarity search
    // Note: Requires pgvector extension and proper index setup in Supabase
    const { data: results, error } = await supabase.rpc('match_products', {
      query_embedding: queryEmbedding,
      match_threshold: 0.5,
      match_count: limit,
      p_brand_id: brandId
    });

    if (error) {
      console.error('❌ Vector search error:', error.message);
      return [];
    }

    return results || [];

  } catch (err) {
    console.error('❌ Image search failed:', err.message);
    return [];
  }
}

module.exports = {
  downloadImageAsBase64,
  describeImageForSearch,
  describeImageItemsForSearch,
  buildVisionPrompt,
  buildEmbeddingText,
  embedText,
  generateProductEmbedding,
  generateEmbeddingsForBrand,
  searchProductsByImage
};
