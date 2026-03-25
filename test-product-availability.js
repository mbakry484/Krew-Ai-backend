/**
 * Test Product Availability Handling
 * Verifies that in-stock and out-of-stock products are properly separated and displayed
 */

require('dotenv').config();
const { buildSystemPrompt } = require('./lib/claude');
const supabase = require('./lib/supabase');

async function testProductAvailability() {
  console.log('🧪 Testing Product Availability Handling\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Fetch all products
  const { data: products, error } = await supabase
    .from('products')
    .select('name, price, in_stock, brand_id')
    .not('price', 'is', null)
    .gt('price', 0)
    .limit(50);

  if (error) {
    console.error('❌ Error fetching products:', error.message);
    return;
  }

  if (!products || products.length === 0) {
    console.log('⚠️  No products found in database');
    return;
  }

  console.log(`📦 Total products found: ${products.length}\n`);

  // Separate by availability
  const inStockProducts = products.filter(p => p.in_stock);
  const outOfStockProducts = products.filter(p => !p.in_stock);

  console.log('📊 Product Breakdown:');
  console.log(`   ✅ In Stock: ${inStockProducts.length}`);
  console.log(`   ❌ Out of Stock: ${outOfStockProducts.length}\n`);

  // Display sample products
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 SAMPLE IN-STOCK PRODUCTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (inStockProducts.length > 0) {
    inStockProducts.slice(0, 5).forEach((p, i) => {
      console.log(`${i + 1}. ${p.name} - ${p.price} EGP ✅`);
    });
  } else {
    console.log('(None)');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 SAMPLE OUT-OF-STOCK PRODUCTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (outOfStockProducts.length > 0) {
    outOfStockProducts.slice(0, 5).forEach((p, i) => {
      console.log(`${i + 1}. ${p.name} - ${p.price} EGP ❌`);
    });
  } else {
    console.log('(None)');
  }

  // Test system prompt generation
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 TESTING SYSTEM PROMPT GENERATION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const businessName = 'Test Store';
  const knowledgeBase = [];
  const metadata = {
    discussed_products: [],
    current_order: null,
    collected_info: { name: null, phone: null, address: null },
    awaiting: null
  };

  const systemPrompt = buildSystemPrompt(
    businessName,
    knowledgeBase,
    inStockProducts,
    outOfStockProducts,
    metadata
  );

  // Extract and display the product catalog section
  const catalogStart = systemPrompt.indexOf('🛒 PRODUCT CATALOG');
  const catalogSection = systemPrompt.substring(catalogStart, catalogStart + 1500);

  console.log(catalogSection);

  // Verify rules are included
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ VERIFICATION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const checks = {
    'Contains "AVAILABLE PRODUCTS" section': systemPrompt.includes('AVAILABLE PRODUCTS'),
    'Contains "OUT OF STOCK PRODUCTS" section': systemPrompt.includes('OUT OF STOCK PRODUCTS'),
    'Contains "RULES FOR PRODUCT AVAILABILITY"': systemPrompt.includes('RULES FOR PRODUCT AVAILABILITY'),
    'Contains in-stock checkmark (✅)': systemPrompt.includes('✅'),
    'Contains out-of-stock mark (❌)': systemPrompt.includes('❌'),
    'Mentions "Only offer to take orders for IN STOCK"': systemPrompt.includes('Only offer to take orders for IN STOCK'),
    'Mentions alternatives for OOS products': systemPrompt.includes('suggest similar in-stock alternatives'),
  };

  Object.entries(checks).forEach(([check, passed]) => {
    console.log(`${passed ? '✅' : '❌'} ${check}`);
  });

  // Test scenarios
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💬 EXPECTED AI BEHAVIOR SCENARIOS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('Scenario 1: Customer asks "What products do you have?"');
  console.log('Expected: Luna lists ONLY in-stock products\n');

  console.log('Scenario 2: Customer asks about an out-of-stock product');
  console.log('Expected: Luna acknowledges it exists, says it\'s unavailable,');
  console.log('         suggests similar in-stock alternatives\n');

  console.log('Scenario 3: Customer tries to order an out-of-stock product');
  console.log('Expected: Luna politely declines, explains it\'s OOS,');
  console.log('         offers alternatives or waitlist option\n');

  console.log('Scenario 4: Customer asks "Show me everything"');
  console.log('Expected: Luna shows only in-stock products for ordering\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Summary
  console.log('📈 SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const allChecksPassed = Object.values(checks).every(v => v);

  if (allChecksPassed) {
    console.log('✅ All checks passed!');
    console.log('   Product availability handling is working correctly.');
    console.log('   Luna should now:');
    console.log('   - Differentiate between in-stock and out-of-stock products');
    console.log('   - Only offer to sell in-stock products');
    console.log('   - Acknowledge OOS products but suggest alternatives');
    console.log('   - Never pretend OOS products are available');
  } else {
    console.log('❌ Some checks failed!');
    console.log('   Review the system prompt generation logic.');
  }

  console.log('\n✅ Test complete!');
}

// Run test
testProductAvailability()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
