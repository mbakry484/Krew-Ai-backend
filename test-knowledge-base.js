/**
 * Test Knowledge Base Integration
 * Run this to verify that knowledge base data is being fetched correctly
 */

const supabase = require('./lib/supabase');

async function testKnowledgeBase() {
  console.log('🧪 Testing Knowledge Base Integration\n');

  // Test 1: Fetch all knowledge base entries
  console.log('1️⃣ Fetching knowledge base entries...');
  const { data: kbRows, error: kbError } = await supabase
    .from('knowledge_base')
    .select('*');

  if (kbError) {
    console.error('❌ Error fetching knowledge base:', kbError.message);
    return;
  }

  console.log(`✅ Found ${kbRows.length} knowledge base row(s)\n`);

  // Test 2: Show structure of each row
  kbRows.forEach((row, index) => {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Row ${index + 1}:`);
    console.log(`  Brand ID: ${row.brand_id}`);
    console.log(`  Brand Name: ${row.brand_name || 'N/A'}`);
    console.log(`  FAQs Count: ${row.faqs?.length || 0}`);

    if (row.faqs && Array.isArray(row.faqs) && row.faqs.length > 0) {
      console.log(`  FAQs:`);
      row.faqs.forEach((faq, faqIndex) => {
        console.log(`    ${faqIndex + 1}. Q: ${faq.question}`);
        console.log(`       A: ${faq.answer.substring(0, 100)}${faq.answer.length > 100 ? '...' : ''}`);
      });
    } else {
      console.log(`  ⚠️  No FAQs found in this row`);
    }
    console.log('');
  });

  // Test 3: Simulate AI prompt building (like in lib/claude.js)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('3️⃣ Testing FAQ extraction (like AI prompt building)...\n');

  const allFaqs = [];
  kbRows.forEach((kb) => {
    if (kb.faqs && Array.isArray(kb.faqs)) {
      allFaqs.push(...kb.faqs);
    }
  });

  console.log(`📚 Total FAQs extracted: ${allFaqs.length}`);

  if (allFaqs.length > 0) {
    console.log('\nSample AI Prompt (Knowledge Base Section):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📚 KNOWLEDGE BASE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    allFaqs.forEach((faq) => {
      console.log(`Q: ${faq.question}`);
      console.log(`A: ${faq.answer}\n`);
    });
  } else {
    console.log('\n⚠️  No FAQs would be added to the AI prompt!');
    console.log('   Make sure you have added FAQs to your knowledge base.');
  }
}

// Run the test
testKnowledgeBase()
  .then(() => {
    console.log('✅ Test complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
