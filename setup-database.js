// Run this script locally to set up your Supabase database
// Usage: node setup-database.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function setupDatabase() {
  console.log('🚀 Setting up Krew database...\n');

  try {
    // Note: You'll need to run the SQL schema first in Supabase SQL Editor
    // This script just helps add test data

    // 1. Create a test brand
    console.log('1. Creating test brand...');
    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .insert({ name: 'Luna Test User' })
      .select()
      .single();

    if (brandError) {
      console.error('Error creating brand:', brandError.message);
      console.log('\n⚠️  You need to create the tables first!');
      console.log('👉 Go to Supabase SQL Editor and run supabase-schema.sql\n');
      return;
    }

    console.log('✅ Brand created:', brand.id);

    // 2. Add Instagram integration (placeholder - you'll need to add real values)
    console.log('\n2. Adding Instagram integration...');
    console.log('⚠️  You need to provide:');
    console.log('   - Instagram Page ID for lunatestuser');
    console.log('   - Page Access Token from Meta Graph API Explorer');
    console.log('\nTo add the integration, run this in Supabase SQL Editor:\n');
    console.log(`INSERT INTO integrations (brand_id, platform, instagram_page_id, access_token)
VALUES (
  '${brand.id}',
  'instagram',
  'YOUR_INSTAGRAM_PAGE_ID',
  'YOUR_PAGE_ACCESS_TOKEN'
);\n`);

    // 3. Add knowledge base
    console.log('3. Adding knowledge base...');
    const { data: kb, error: kbError } = await supabase
      .from('knowledge_base')
      .insert({
        brand_id: brand.id,
        brand_name: 'Luna Test User',
        tone: 'Friendly, helpful, and professional',
        guidelines: 'Always greet customers warmly. Answer questions clearly. If unsure, offer to connect them with support.',
        faqs: [
          {
            question: 'What are your business hours?',
            answer: 'We are available 24/7 through our AI assistant!'
          },
          {
            question: 'How can I contact support?',
            answer: 'Just send us a message here on Instagram and we will help you!'
          }
        ]
      })
      .select()
      .single();

    if (kbError) {
      console.error('Error creating knowledge base:', kbError.message);
      return;
    }

    console.log('✅ Knowledge base created:', kb.id);

    // 4. Add sample products
    console.log('\n4. Adding sample products...');
    const { data: products, error: productsError } = await supabase
      .from('products')
      .insert([
        {
          brand_id: brand.id,
          name: 'Test Product 1',
          description: 'This is a sample product for testing',
          price: 29.99,
          availability: 'in_stock',
          sku: 'TEST-001'
        },
        {
          brand_id: brand.id,
          name: 'Test Product 2',
          description: 'Another sample product',
          price: 49.99,
          availability: 'in_stock',
          sku: 'TEST-002'
        }
      ])
      .select();

    if (productsError) {
      console.error('Error creating products:', productsError.message);
      return;
    }

    console.log('✅ Products created:', products.length);

    console.log('\n🎉 Database setup complete!');
    console.log('\n📋 Next steps:');
    console.log('1. Go to https://developers.facebook.com/tools/explorer/');
    console.log('2. Generate a Page Access Token for lunatestuser');
    console.log('3. Get the Instagram Page ID');
    console.log('4. Add the integration using the SQL command printed above');
    console.log('5. Subscribe the page to your webhook');
    console.log('6. Send a test DM to lunatestuser\n');

  } catch (error) {
    console.error('Unexpected error:', error);
  }
}

setupDatabase();
