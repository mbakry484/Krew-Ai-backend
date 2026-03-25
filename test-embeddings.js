/**
 * Test Product Embeddings Generation
 * Run this to manually test embedding generation for a single product
 */

require('dotenv').config();
const { generateProductEmbedding, generateEmbeddingsForBrand } = require('./lib/embeddings');
const supabase = require('./lib/supabase');

async function testSingleProduct() {
  console.log('🧪 Testing Single Product Embedding Generation\n');

  // Fetch a product with an image
  const { data: products, error } = await supabase
    .from('products')
    .select('shopify_product_id, name, image_url, brand_id')
    .not('image_url', 'is', null)
    .limit(1);

  if (error) {
    console.error('❌ Error fetching product:', error.message);
    return;
  }

  if (!products || products.length === 0) {
    console.log('⚠️  No products with images found in database');
    return;
  }

  const product = products[0];
  console.log(`Testing with product: ${product.name}`);
  console.log(`Image URL: ${product.image_url}\n`);

  // Generate embedding
  const embedding = await generateProductEmbedding(product);

  if (embedding) {
    console.log('\n✅ Embedding generated successfully!');
    console.log(`   Vector dimensions: ${embedding.length}`);
    console.log(`   First 5 values: [${embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);

    // Verify it was saved to database
    const { data: updated } = await supabase
      .from('products')
      .select('image_description, embedding')
      .eq('shopify_product_id', product.shopify_product_id)
      .single();

    if (updated) {
      console.log('\n📝 Saved to database:');
      console.log(`   Description: ${updated.image_description}`);
      console.log(`   Has embedding: ${updated.embedding ? 'Yes' : 'No'}`);
    }
  } else {
    console.log('\n❌ Embedding generation failed');
  }
}

async function testBrandEmbeddings() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 Testing Brand-wide Embedding Generation\n');

  // Get a brand ID
  const { data: products } = await supabase
    .from('products')
    .select('brand_id')
    .not('brand_id', 'is', null)
    .limit(1);

  if (!products || products.length === 0) {
    console.log('⚠️  No products found');
    return;
  }

  const brandId = products[0].brand_id;
  console.log(`Brand ID: ${brandId}\n`);

  // Count products needing embeddings
  const { data: needsEmbedding } = await supabase
    .from('products')
    .select('shopify_product_id, name, image_url')
    .eq('brand_id', brandId)
    .not('image_url', 'is', null)
    .is('embedding', null);

  console.log(`Products needing embeddings: ${needsEmbedding?.length || 0}\n`);

  if (!needsEmbedding || needsEmbedding.length === 0) {
    console.log('✅ All products already have embeddings!');
    return;
  }

  // Generate embeddings for all products
  await generateEmbeddingsForBrand(brandId);
}

// Run tests
async function runTests() {
  try {
    await testSingleProduct();

    // Uncomment to test brand-wide generation
    // await testBrandEmbeddings();

    console.log('\n✅ Test complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

runTests();
