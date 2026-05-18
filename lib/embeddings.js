const OpenAI = require('openai');
const supabase = require('./supabase');

// Validate OpenAI API key
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ FATAL: OPENAI_API_KEY environment variable is not set!');
  throw new Error('OPENAI_API_KEY is required');
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY.trim(),
});

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
 * Generate image description and embedding for a single product
 * @param {object} product - Product object with shopify_product_id, name, image_url
 * @returns {Promise<number[]|null>} The embedding vector or null if failed
 */
async function generateProductEmbedding(product) {
  if (!product.image_url) {
    console.log(`⚠️  Skipping ${product.name} - no image URL`);
    return null;
  }

  try {
    // Step 1: Download image as base64
    const { base64, contentType } = await downloadImageAsBase64(product.image_url);

    // Step 2: Generate description using GPT-4o vision
    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Describe this product image in 2-3 sentences focusing on: type of item, colors, style, distinctive visual features. Be specific and factual. Product name: ${product.name}`
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${contentType};base64,${base64}`,
              detail: 'low'
            }
          }
        ]
      }]
    });

    const description = visionResponse.choices[0].message.content;
    console.log(`📝 Description for ${product.name}: ${description.substring(0, 100)}...`);

    // Step 3: Generate embedding from description only
    // The product name already influences the description via the vision prompt,
    // but we embed only the description so that customer query embeddings
    // (which don't have a product name) live in the same vector space.
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: description
    });

    const embedding = embeddingResponse.data[0].embedding;

    // Step 4: Save to Supabase
    const { error } = await supabase
      .from('products')
      .update({
        image_description: description,
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
 * Generate embeddings for all products of a brand that have images but no embeddings
 * @param {string} brandId - The brand ID to generate embeddings for
 * @returns {Promise<void>}
 */
async function generateEmbeddingsForBrand(brandId) {
  try {
    // Fetch all products with images but no embedding yet
    const { data: products, error } = await supabase
      .from('products')
      .select('shopify_product_id, name, image_url')
      .eq('brand_id', brandId)
      .not('image_url', 'is', null)
      .is('embedding', null);

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
 * @param {string} brandId - The brand ID to search within
 * @param {string} queryImageUrl - URL of the query image
 * @param {number} limit - Maximum number of results (default 5)
 * @returns {Promise<Array>} Array of similar products with similarity scores
 */
async function searchProductsByImage(brandId, queryImageUrl, limit = 5) {
  try {
    // Generate embedding for query image
    const { base64, contentType } = await downloadImageAsBase64(queryImageUrl);

    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this product image in 2-3 sentences focusing on: type of item, colors, style, distinctive visual features. Be specific and factual.'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${contentType};base64,${base64}`,
              detail: 'low'
            }
          }
        ]
      }]
    });

    const description = visionResponse.choices[0].message.content;

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: description
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

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
  generateProductEmbedding,
  generateEmbeddingsForBrand,
  searchProductsByImage
};
