/**
 * Diagnostic Script: Image Search Troubleshooting
 * Identifies why vector search returns 0 matches
 */

require('dotenv').config();
const supabase = require('./lib/supabase');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

async function diagnose() {
  console.log('🔍 IMAGE SEARCH DIAGNOSTIC');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const brandId = '6fe9cfc8-21e9-442f-9b6f-4f09f6c13823';

  // Step 1: Check if function exists
  console.log('Step 1: Testing match_products_by_embedding function...\n');

  try {
    const { data: funcCheck, error: funcError } = await supabase.rpc('match_products_by_embedding', {
      query_embedding: Array(1536).fill(0),
      match_brand_id: brandId,
      match_threshold: 0,
      match_count: 1
    });

    if (funcError) {
      console.log('❌ Function error:', funcError.message);
      console.log('\n💡 Fix: Run add-product-embeddings.sql in Supabase SQL Editor\n');
      return;
    }

    console.log('✅ Function exists and is callable\n');
  } catch (err) {
    console.log('❌ Function call failed:', err.message);
    console.log('\n💡 Fix: Ensure pgvector extension is enabled and function is created\n');
    return;
  }

  // Step 2: Check specific product
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Step 2: Checking "GREY LEOPARD" product...\n');

  const { data: products, error: productError } = await supabase
    .from('products')
    .select('id, name, in_stock, image_url, image_description, embedding, brand_id')
    .eq('brand_id', brandId)
    .ilike('name', '%GREY LEOPARD%');

  if (productError) {
    console.log('❌ Product query error:', productError.message);
    return;
  }

  if (!products || products.length === 0) {
    console.log('❌ Product not found in database');
    console.log('   Search: name LIKE "%GREY LEOPARD%"');
    console.log(`   Brand: ${brandId}\n`);
    return;
  }

  const product = products[0];

  console.log(`📦 Product Found: "${product.name}"`);
  console.log(`   ID: ${product.id}`);
  console.log(`   Brand ID: ${product.brand_id}`);
  console.log(`   In Stock: ${product.in_stock ? '✅ Yes' : '❌ No'}`);
  console.log(`   Has Image URL: ${product.image_url ? '✅ Yes' : '❌ No'}`);
  console.log(`   Has Description: ${product.image_description ? '✅ Yes' : '❌ No'}`);
  console.log(`   Has Embedding: ${product.embedding ? '✅ Yes' : '❌ No'}`);

  if (product.image_description) {
    console.log(`\n   📝 Description:\n   "${product.image_description}"\n`);
  }

  // Critical issue: No embedding
  if (!product.embedding) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('❌ CRITICAL ISSUE: Product has no embedding!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('This is why vector search returns 0 matches.');
    console.log('The SQL function filters WHERE embedding IS NOT NULL.\n');
    console.log('💡 Fix Options:\n');
    console.log('   1. Generate embeddings for all products:');
    console.log('      POST http://localhost:3000/products/generate-embeddings');
    console.log('      Authorization: Bearer YOUR_JWT_TOKEN\n');
    console.log('   2. Or run manual embedding generation:');
    console.log('      node test-embeddings.js\n');

    // Check how many products need embeddings
    const { data: stats } = await supabase
      .from('products')
      .select('embedding, image_url')
      .eq('brand_id', brandId);

    const withEmbedding = stats.filter(p => p.embedding !== null).length;
    const needsEmbedding = stats.filter(p => p.embedding === null && p.image_url !== null).length;
    const total = stats.length;

    console.log(`📊 Embedding Coverage for Brand:`);
    console.log(`   Total Products: ${total}`);
    console.log(`   With Embeddings: ${withEmbedding} (${(withEmbedding / total * 100).toFixed(1)}%)`);
    console.log(`   Need Embeddings: ${needsEmbedding}`);
    console.log(`   No Image URL: ${total - withEmbedding - needsEmbedding}\n`);

    return;
  }

  // Step 3: Test actual search
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Step 3: Testing vector search with customer description...\n');

  const customerDescription = "gray zip-up hoodie with a classic casual style. The hoodie has a prominent, distressed text graphic on the front that reads 'WASTED.' A distinctive feature is its interior, lined with a contrasting leopard print pattern";

  console.log('📸 Customer Image Description:');
  console.log(`   "${customerDescription}"\n`);

  console.log('🔄 Generating embedding for customer description...');
  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: customerDescription
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;
  console.log('✅ Embedding generated\n');

  console.log('🔍 Searching with NO threshold (to see all similarities)...\n');

  const { data: matches, error: searchError } = await supabase.rpc('match_products_by_embedding', {
    query_embedding: queryEmbedding,
    match_brand_id: brandId,
    match_threshold: 0.0, // NO threshold
    match_count: 10
  });

  if (searchError) {
    console.log('❌ Search error:', searchError.message);
    return;
  }

  console.log(`🎯 Search Results: ${matches.length} products found\n`);

  if (matches.length === 0) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('❌ CRITICAL ISSUE: 0 results even with no threshold!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('This suggests one of these issues:\n');
    console.log('1. SQL function still has in_stock = true filter (OOS products excluded)');
    console.log('   Fix: Run migration from MIGRATION-IMAGE-SEARCH-OOS.md\n');
    console.log('2. Brand ID mismatch');
    console.log('   Fix: Verify integration.brand_id matches products.brand_id\n');
    console.log('3. All products missing embeddings');
    console.log('   Fix: Run POST /products/generate-embeddings\n');
    return;
  }

  // Display matches
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 MATCH RESULTS (sorted by similarity)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  matches.forEach((m, i) => {
    const similarityPercent = (m.similarity * 100).toFixed(1);
    const isAboveThreshold = m.similarity > 0.4;

    console.log(`${i + 1}. ${m.name}`);
    console.log(`   Similarity: ${similarityPercent}% ${isAboveThreshold ? '✅ Above 40%' : '⚠️  Below 40%'}`);
    console.log(`   In Stock: ${m.in_stock ? '✅ Yes' : '❌ No'}`);
    console.log(`   Price: ${m.price} EGP`);
    if (m.image_description) {
      console.log(`   Description: "${m.image_description.substring(0, 80)}..."`);
    }
    console.log('');
  });

  // Step 4: Analysis
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 ANALYSIS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const highMatches = matches.filter(m => m.similarity > 0.4);
  const mediumMatches = matches.filter(m => m.similarity > 0.3 && m.similarity <= 0.4);
  const topMatch = matches[0];

  console.log(`Matches > 40% threshold: ${highMatches.length}`);
  console.log(`Matches 30-40% (medium): ${mediumMatches.length}`);
  console.log(`Top match similarity: ${(topMatch.similarity * 100).toFixed(1)}%`);
  console.log(`Top match is target product: ${topMatch.name.includes('GREY LEOPARD') ? '✅ Yes' : '❌ No'}\n`);

  if (highMatches.length === 0) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚠️  ISSUE: No matches above 40% threshold');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('Current threshold (0.4) is too high for this query.\n');
    console.log('💡 Recommended Fixes:\n');
    console.log('   Option 1: Lower threshold to 0.3 or 0.35');
    console.log('      Edit routes/instagram.js:66');
    console.log('      Change match_threshold: 0.4 → 0.3\n');
    console.log('   Option 2: Improve product descriptions');
    console.log('      Regenerate embeddings with better image descriptions\n');

    if (mediumMatches.length > 0) {
      console.log(`   ℹ️  You have ${mediumMatches.length} match(es) in the 30-40% range.`);
      console.log('      Lowering threshold to 0.3 would catch these.\n');
    }
  } else {
    console.log('✅ SUCCESS: System is working correctly!');
    console.log(`   Found ${highMatches.length} match(es) above threshold.\n`);

    if (topMatch.name.includes('GREY LEOPARD')) {
      console.log('✅ Top match is the target product!');
      console.log('   Image search should work in production.\n');
    } else {
      console.log('⚠️  Top match is NOT the target product.');
      console.log('   Vector search prioritizes different visual features.\n');
    }
  }

  // Step 5: SQL Function Check
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Step 4: Checking SQL function configuration...\n');

  console.log('Run this query in Supabase SQL Editor to verify:\n');
  console.log('```sql');
  console.log('SELECT prosrc');
  console.log('FROM pg_proc');
  console.log("WHERE proname = 'match_products_by_embedding';");
  console.log('```\n');
  console.log('Expected: NO "AND products.in_stock = true" in WHERE clause');
  console.log('Expected: "ORDER BY products.in_stock DESC" to prioritize in-stock\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('✅ Diagnostic Complete!');
  console.log('\nSee DIAGNOSIS-IMAGE-SEARCH.md for detailed fix instructions.\n');
}

diagnose()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Diagnostic failed:', error.message);
    console.error(error);
    process.exit(1);
  });
