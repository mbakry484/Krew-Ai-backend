const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { generateReply } = require('../lib/claude');

/**
 * GET /luna/global-status
 * Returns the global Luna enabled/disabled state for the authenticated user's brand.
 */
router.get('/global-status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .select('luna_global_enabled')
      .eq('id', user.brand_id)
      .single();

    if (brandError || !brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    return res.json({ luna_global_enabled: brand.luna_global_enabled ?? true });
  } catch (err) {
    console.error('Error fetching Luna global status:', err);
    return res.status(500).json({ error: 'Failed to fetch Luna global status' });
  }
});

/**
 * PUT /luna/global-status
 * Updates the global Luna enabled/disabled state for the authenticated user's brand.
 * Body: { luna_global_enabled: boolean }
 */
router.put('/global-status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { luna_global_enabled } = req.body;

    if (typeof luna_global_enabled !== 'boolean') {
      return res.status(400).json({ error: 'luna_global_enabled must be a boolean' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { error: updateError } = await supabase
      .from('brands')
      .update({ luna_global_enabled })
      .eq('id', user.brand_id);

    if (updateError) {
      console.error('Error updating Luna global status:', updateError);
      return res.status(500).json({ error: 'Failed to update Luna global status' });
    }

    return res.json({ success: true, luna_global_enabled });
  } catch (err) {
    console.error('Error updating Luna global status:', err);
    return res.status(500).json({ error: 'Failed to update Luna global status' });
  }
});

/**
 * POST /luna/test-chat
 * Let the user test Luna directly. The user's message is treated as a customer
 * message and Luna responds using the brand's full configuration (knowledge base,
 * products, settings). No escalation, no handover — Luna always replies.
 * Body: { message: string, history?: Array<{ role: 'user'|'assistant', content: string }> }
 */
router.post('/test-chat', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { message, history = [] } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Get brand_id + business name for this user. The business name lives on the
    // `users` table (the `brands` table has no `business_name` column), matching
    // how the live Instagram flow resolves it.
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id, business_name')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brandId = user.brand_id;

    // Gather all brand data in parallel. Product fetching + storefront lookup
    // mirror the live Instagram flow (routes/instagram.js) so the test chat
    // behaves exactly like the real Luna.
    const [brandResult, kbResult, productsResult, integrationResult] = await Promise.all([
      supabase
        .from('brands')
        .select('business_type, brand_description')
        .eq('id', brandId)
        .single(),
      supabase
        .from('knowledge_base')
        .select('faqs, situations_enabled, situations, size_guides_enabled, size_guides')
        .eq('brand_id', brandId),
      supabase
        .from('products')
        .select('name, price, variants, image_url, shopify_product_id, in_stock, handle, online_store_url')
        .eq('brand_id', brandId)
        .not('price', 'is', null)
        .gt('price', 0)
        .order('name', { ascending: true }),
      supabase
        .from('integrations')
        .select('storefront_url')
        .eq('brand_id', brandId)
        .eq('platform', 'shopify')
        .maybeSingle(),
    ]);

    const brand = brandResult.data || {};
    const businessName = user.business_name || 'our business';
    const businessType = brand.business_type || null;
    const brandDescription = brand.brand_description || null;

    const knowledgeBaseRows = kbResult.data || [];
    const kb = knowledgeBaseRows[0] || {};

    // Availability lives on the `in_stock` boolean column (populated by the
    // Shopify sync), NOT a `status` column — same split the Instagram flow uses.
    const allProducts = productsResult.data || [];
    const inStockProducts = allProducts.filter(p => p.in_stock);
    const outOfStockProducts = allProducts.filter(p => !p.in_stock);

    // Storefront URL lets Luna share clickable product/website links instead of
    // dumping the whole catalog into the chat.
    const storefrontUrl = integrationResult.data?.storefront_url || null;

    // Convert frontend history format to OpenAI format
    const conversationHistory = history.map(h => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.content,
    }));

    // Generate Luna's reply using the same pipeline as real conversations
    const reply = await generateReply(
      message.trim(),
      knowledgeBaseRows,
      inStockProducts,
      outOfStockProducts,
      brandId,
      conversationHistory,
      null, // no metadata (no order state tracking in test mode)
      businessName,
      null, // no image
      '',   // no story context
      businessType,
      brandDescription,
      kb.situations_enabled || false,
      kb.situations || [],
      kb.size_guides_enabled || false,
      kb.size_guides || [],
      null,          // conversationId — no persisted conversation in test mode
      storefrontUrl  // let Luna share website/product links like she does live
    );

    // Strip any escalation keywords from the response for test mode
    let cleanReply = reply;
    const escalationKeywords = ['ESCALATE_REFUND', 'ESCALATE_EXCHANGE', 'ESCALATE_DELIVERY', 'ESCALATE_GENERAL'];
    escalationKeywords.forEach(keyword => {
      cleanReply = cleanReply.replace(new RegExp(keyword, 'gi'), '').trim();
    });

    res.json({ reply: cleanReply });
  } catch (err) {
    console.error('❌ Luna test-chat error:', err.message);
    res.status(500).json({ error: 'Failed to generate Luna response' });
  }
});

module.exports = router;
