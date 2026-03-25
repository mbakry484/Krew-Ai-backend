/**
 * Test Instagram Image Search with Vector Similarity
 * Simulates a customer sending an image and tests the vector search flow
 */

require('dotenv').config();
const supabase = require('./lib/supabase');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

async function findSimilarProducts(imageUrl, brandId) {
  try {
    console.log('📸 Downloading and analyzing image...');
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    console.log('🤖 Generating image description with GPT-4o vision...');
    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this clothing/product image in 2-3 sentences focusing on: type of item, colors, style, distinctive visual features.'
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

    const queryDescription = visionResponse.choices[0].message.content;
    console.log(`🔍 Image description: "${queryDescription}"\n`);

    console.log('🧮 Generating embedding...');
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: queryDescription
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;
    console.log(`✅ Embedding generated (${queryEmbedding.length} dimensions)\n`);

    console.log('🔎 Searching for similar products in database...');
    const { data: matches, error } = await supabase.rpc('match_products_by_embedding', {
      query_embedding: queryEmbedding,
      match_brand_id: brandId,
      match_threshold: 0.4,
      match_count: 3
    });

    if (error) {
      console.error('❌ Vector search error:', error.message);
      return { matches: [], queryDescription };
    }

    console.log(`🎯 Found ${matches?.length || 0} similar products\n`);
    return { matches: matches || [], queryDescription };

  } catch (err) {
    console.error('❌ Image similarity search failed:', err.message);
    return { matches: [], queryDescription: null };
  }
}

async function testImageSearch() {
  console.log('🧪 Testing Instagram Image Search\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Step 1: Get a brand with products that have embeddings
  const { data: productsWithEmbeddings } = await supabase
    .from('products')
    .select('brand_id, name, image_url, image_description')
    .not('embedding', 'is', null)
    .not('image_url', 'is', null)
    .eq('in_stock', true)
    .limit(1);

  if (!productsWithEmbeddings || productsWithEmbeddings.length === 0) {
    console.log('❌ No products with embeddings found!');
    console.log('   Run this first: node test-embeddings.js');
    console.log('   Or trigger: POST /products/generate-embeddings');
    return;
  }

  const testProduct = productsWithEmbeddings[0];
  const brandId = testProduct.brand_id;

  console.log('📦 Using product as test image:');
  console.log(`   Name: ${testProduct.name}`);
  console.log(`   Description: ${testProduct.image_description}`);
  console.log(`   Image URL: ${testProduct.image_url}\n`);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Step 2: Test image search using this product's image
  const { matches, queryDescription } = await findSimilarProducts(testProduct.image_url, brandId);

  // Step 3: Display results
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 SEARCH RESULTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (matches.length === 0) {
    console.log('❌ No matches found!');
    console.log('   This might mean:');
    console.log('   - Similarity threshold (0.4) is too high');
    console.log('   - Not enough products have embeddings');
    console.log('   - Vector search function not installed');
    return;
  }

  matches.forEach((match, index) => {
    console.log(`${index + 1}. ${match.name}`);
    console.log(`   Price: ${match.price} EGP`);
    console.log(`   Stock: ${match.in_stock ? '✅ In Stock' : '❌ Out of Stock'}`);
    console.log(`   Similarity: ${(match.similarity * 100).toFixed(1)}%`);
    console.log(`   Description: ${match.image_description || 'N/A'}`);
    console.log('');
  });

  // Step 4: Simulate Luna's response
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💬 SIMULATED LUNA RESPONSE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const bestMatch = matches[0];
  const similarityPercent = (bestMatch.similarity * 100).toFixed(0);

  if (bestMatch.similarity > 0.7) {
    console.log(`Yes! I found it! That looks like our "${bestMatch.name}" 😊`);
    console.log(`\nPrice: ${bestMatch.price} EGP`);
    console.log(`Availability: ${bestMatch.in_stock ? '✅ In stock and ready to ship!' : '❌ Currently out of stock'}`);
    console.log(`\nWould you like to order this?`);
  } else if (bestMatch.similarity > 0.5) {
    console.log(`I found something similar! Check out our "${bestMatch.name}"`);
    console.log(`\nIt matches your image by about ${similarityPercent}%`);
    console.log(`Price: ${bestMatch.price} EGP`);
    console.log(`\nIs this what you're looking for? 🤔`);
  } else {
    console.log(`Hmm, I found "${bestMatch.name}" which might be similar (${similarityPercent}% match)`);
    console.log(`\nBut I'm not 100% sure it's what you want.`);
    console.log(`Could you describe what you're looking for? For example:`);
    console.log(`- Color?`);
    console.log(`- Style?`);
    console.log(`- Type of product?`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('✅ Test complete!');
}

// Run test
testImageSearch()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
