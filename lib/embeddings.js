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

/**
 * ONE shared vision prompt used for BOTH product indexing and customer query
 * images. Symmetry is the whole point: both sides must produce descriptions
 * with the same structure and wording conventions so their embeddings live in
 * the same region of vector space. Do not fork this prompt per side.
 */
const VISION_PROMPT = `You are describing a fashion product photo for a visual search system.

Look at the photo. If more than one garment/product is visible, describe ONLY the single most prominent item (the largest, most central, or most in-focus one). Ignore all other items, the background, any model's other clothing, tags and packaging.

Respond with STRICT JSON only (no markdown, no extra text) using exactly these keys:
{
  "type": "<one allowed type from the list below>",
  "colors": ["<1-3 dominant colors of the item itself>"],
  "pattern": "<e.g. solid, striped, floral, plaid, graphic print>",
  "material": "<visible fabric or texture, e.g. ribbed knit, denim, cotton jersey, leather>",
  "fit": "<silhouette, e.g. slim, regular, oversized, cropped, wide-leg>",
  "neckline": "<neckline or collar, e.g. crew neck, v-neck, polo collar, scoop neck; empty string if not applicable>",
  "sleeves": "<e.g. sleeveless, short sleeves, long sleeves; empty string if not applicable>",
  "details": "<short phrase of distinctive features, e.g. contrast trim, front buttons>",
  "summary": "<1-2 sentence natural description of the item>"
}

Allowed types: ${GARMENT_TYPE_LIST.join(', ')}. If none fits, use "other".`;

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
    attrs.details ? `Details: ${attrs.details}.` : null,
    attrs.summary ? `Summary: ${attrs.summary}` : null,
  ].filter(Boolean).join(' ');
}

/**
 * Describe an image with GPT-4o vision using the shared structured schema.
 * Used by BOTH product indexing and customer-query search.
 * Falls back gracefully to free text when the model returns unparseable JSON.
 * @param {{base64: string, contentType: string}} image
 * @returns {Promise<{attributes: object|null, garmentType: string|null, summary: string, embeddingText: string, usage: object|null}>}
 */
async function describeImageForSearch({ base64, contentType }) {
  const visionResponse = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 350,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: VISION_PROMPT },
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

  const raw = visionResponse.choices[0].message.content || '';
  const usage = visionResponse.usage || null;

  let attributes = null;
  try {
    attributes = JSON.parse(raw);
  } catch (err) {
    console.warn(`⚠️  Vision returned non-JSON, falling back to free text: ${raw.substring(0, 80)}...`);
  }

  if (!attributes || typeof attributes !== 'object') {
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
 * Stores: image_description (human-readable summary), image_attributes
 * (structured JSON), garment_type (controlled vocab) and the embedding.
 * @param {object} product - { shopify_product_id, name, image_url, product_type? }
 * @returns {Promise<number[]|null>} The embedding vector or null if failed
 */
async function generateProductEmbedding(product) {
  if (!product.image_url) {
    console.log(`⚠️  Skipping ${product.name} - no image URL`);
    return null;
  }

  try {
    const image = await downloadImageAsBase64(product.image_url);
    const described = await describeImageForSearch(image);

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
 * @param {string} brandId - The brand ID to generate embeddings for
 * @returns {Promise<void>}
 */
async function generateEmbeddingsForBrand(brandId) {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('shopify_product_id, name, image_url, product_type')
      .eq('brand_id', brandId)
      .not('image_url', 'is', null)
      .or('embedding.is.null,garment_type.is.null');

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
  buildEmbeddingText,
  embedText,
  generateProductEmbedding,
  generateEmbeddingsForBrand,
  searchProductsByImage
};
