const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

/**
 * GET /knowledge-base
 * Get knowledge base for the authenticated user's brand
 * Returns FAQs as array of Q&A pairs
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Get the user's brand_id from users table
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brandId = userData.brand_id;

    // Get knowledge base for this brand
    const { data: kb, error: kbError } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('brand_id', brandId)
      .single();

    if (kbError) {
      // If no knowledge base exists, return empty structure
      if (kbError.code === 'PGRST116') {
        return res.status(200).json({
          faqs: []
        });
      }
      console.error('Error fetching knowledge base:', kbError);
      return res.status(500).json({ error: 'Failed to fetch knowledge base' });
    }

    // Return FAQs as array
    res.status(200).json({
      id: kb.id,
      brand_id: kb.brand_id,
      faqs: kb.faqs || []
    });
  } catch (error) {
    console.error('Get knowledge base error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /knowledge-base
 * Save/update knowledge base FAQs for the authenticated user's brand
 * Body: { faqs: [{ question: string, answer: string }, ...] }
 */
router.post('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { faqs } = req.body;

    // Validate input
    if (!Array.isArray(faqs)) {
      return res.status(400).json({ error: 'faqs must be an array' });
    }

    // Validate each FAQ item
    for (const faq of faqs) {
      if (!faq.question || typeof faq.question !== 'string') {
        return res.status(400).json({ error: 'Each FAQ must have a question string' });
      }
      if (!faq.answer || typeof faq.answer !== 'string') {
        return res.status(400).json({ error: 'Each FAQ must have an answer string' });
      }
    }

    // Get the user's brand_id from users table
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('brand_id, business_name')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brandId = userData.brand_id;
    const businessName = userData.business_name;

    // Check if knowledge base already exists
    const { data: existingKb } = await supabase
      .from('knowledge_base')
      .select('id')
      .eq('brand_id', brandId)
      .single();

    let result;

    if (existingKb) {
      // Update existing knowledge base
      const { data, error } = await supabase
        .from('knowledge_base')
        .update({
          faqs,
          updated_at: new Date().toISOString()
        })
        .eq('brand_id', brandId)
        .select()
        .single();

      if (error) {
        console.error('Error updating knowledge base:', error);
        return res.status(500).json({ error: 'Failed to update knowledge base' });
      }

      result = data;
    } else {
      // Create new knowledge base
      const { data, error } = await supabase
        .from('knowledge_base')
        .insert([
          {
            brand_id: brandId,
            brand_name: businessName,
            faqs,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      if (error) {
        console.error('Error creating knowledge base:', error);
        return res.status(500).json({ error: 'Failed to create knowledge base' });
      }

      result = data;
    }

    res.status(200).json({
      message: 'Knowledge base saved successfully',
      id: result.id,
      brand_id: result.brand_id,
      faqs: result.faqs
    });
  } catch (error) {
    console.error('Save knowledge base error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /knowledge-base/:index
 * Delete a specific FAQ item from knowledge base by index
 * Query param: ?index=0
 */
router.delete('/:index', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const faqIndex = parseInt(req.params.index);

    // Validate index is a number
    if (isNaN(faqIndex) || faqIndex < 0) {
      return res.status(400).json({ error: 'Invalid FAQ index' });
    }

    // Get the user's brand_id from users table
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brandId = userData.brand_id;

    // Get current knowledge base
    const { data: kb, error: kbError } = await supabase
      .from('knowledge_base')
      .select('faqs')
      .eq('brand_id', brandId)
      .single();

    if (kbError || !kb) {
      return res.status(404).json({ error: 'Knowledge base not found' });
    }

    const faqs = kb.faqs || [];

    // Check if index exists
    if (faqIndex >= faqs.length) {
      return res.status(400).json({ error: 'FAQ index out of range' });
    }

    // Remove the FAQ at the specified index
    const updatedFaqs = faqs.filter((_, index) => index !== faqIndex);

    // Update knowledge base with new FAQs
    const { data, error } = await supabase
      .from('knowledge_base')
      .update({
        faqs: updatedFaqs,
        updated_at: new Date().toISOString()
      })
      .eq('brand_id', brandId)
      .select()
      .single();

    if (error) {
      console.error('Error deleting FAQ:', error);
      return res.status(500).json({ error: 'Failed to delete FAQ' });
    }

    res.status(200).json({
      message: 'FAQ deleted successfully',
      faqs: data.faqs
    });
  } catch (error) {
    console.error('Delete FAQ error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
