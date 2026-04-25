const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

// Use memory storage so we can upload the buffer to Supabase Storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * GET /knowledge-base
 * Get knowledge base for the authenticated user's brand
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brandId = userData.brand_id;

    const { data: kb, error: kbError } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('brand_id', brandId)
      .single();

    if (kbError) {
      if (kbError.code === 'PGRST116') {
        return res.status(200).json({
          faqs: [],
          situations_enabled: false,
          situations: [],
          size_guides_enabled: false,
          size_guides: []
        });
      }
      console.error('Error fetching knowledge base:', kbError);
      return res.status(500).json({ error: 'Failed to fetch knowledge base' });
    }

    res.status(200).json({
      id: kb.id,
      brand_id: kb.brand_id,
      faqs: kb.faqs || [],
      situations_enabled: kb.situations_enabled || false,
      situations: kb.situations || [],
      size_guides_enabled: kb.size_guides_enabled || false,
      size_guides: kb.size_guides || []
    });
  } catch (error) {
    console.error('Get knowledge base error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /knowledge-base
 * Save/update knowledge base for the authenticated user's brand
 * Body: { faqs, situations_enabled, situations, size_guides_enabled, size_guides }
 */
router.post('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const {
      faqs,
      situations_enabled = false,
      situations = [],
      size_guides_enabled = false,
      size_guides = []
    } = req.body;

    if (!Array.isArray(faqs)) {
      return res.status(400).json({ error: 'faqs must be an array' });
    }

    for (const faq of faqs) {
      if (!faq.question || typeof faq.question !== 'string') {
        return res.status(400).json({ error: 'Each FAQ must have a question string' });
      }
      if (!faq.answer || typeof faq.answer !== 'string') {
        return res.status(400).json({ error: 'Each FAQ must have an answer string' });
      }
    }

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

    const { data: existingKb } = await supabase
      .from('knowledge_base')
      .select('id')
      .eq('brand_id', brandId)
      .single();

    const payload = {
      faqs,
      situations_enabled: !!situations_enabled,
      situations: Array.isArray(situations) ? situations : [],
      size_guides_enabled: !!size_guides_enabled,
      size_guides: Array.isArray(size_guides) ? size_guides : [],
      updated_at: new Date().toISOString()
    };

    let result;

    if (existingKb) {
      const { data, error } = await supabase
        .from('knowledge_base')
        .update(payload)
        .eq('brand_id', brandId)
        .select()
        .single();

      if (error) {
        console.error('Error updating knowledge base:', error);
        return res.status(500).json({ error: 'Failed to update knowledge base' });
      }
      result = data;
    } else {
      const { data, error } = await supabase
        .from('knowledge_base')
        .insert([{ brand_id: brandId, brand_name: businessName, ...payload, created_at: new Date().toISOString() }])
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
      faqs: result.faqs,
      situations_enabled: result.situations_enabled,
      situations: result.situations,
      size_guides_enabled: result.size_guides_enabled,
      size_guides: result.size_guides
    });
  } catch (error) {
    console.error('Save knowledge base error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /knowledge-base/upload-image
 * Upload a size guide image to Supabase Storage
 * Returns: { url: string }
 */
router.post('/upload-image', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = req.user.user_id;
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brandId = userData.brand_id;
    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `size-guides/${brandId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('knowledge-base')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload image' });
    }

    const { data: publicUrlData } = supabase.storage
      .from('knowledge-base')
      .getPublicUrl(fileName);

    res.status(200).json({ url: publicUrlData.publicUrl });
  } catch (error) {
    console.error('Upload image error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /knowledge-base/:index
 * Delete a specific FAQ item by index
 */
router.delete('/:index', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const faqIndex = parseInt(req.params.index);

    if (isNaN(faqIndex) || faqIndex < 0) {
      return res.status(400).json({ error: 'Invalid FAQ index' });
    }

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brandId = userData.brand_id;

    const { data: kb, error: kbError } = await supabase
      .from('knowledge_base')
      .select('faqs')
      .eq('brand_id', brandId)
      .single();

    if (kbError || !kb) {
      return res.status(404).json({ error: 'Knowledge base not found' });
    }

    const faqs = kb.faqs || [];

    if (faqIndex >= faqs.length) {
      return res.status(400).json({ error: 'FAQ index out of range' });
    }

    const updatedFaqs = faqs.filter((_, index) => index !== faqIndex);

    const { data, error } = await supabase
      .from('knowledge_base')
      .update({ faqs: updatedFaqs, updated_at: new Date().toISOString() })
      .eq('brand_id', brandId)
      .select()
      .single();

    if (error) {
      console.error('Error deleting FAQ:', error);
      return res.status(500).json({ error: 'Failed to delete FAQ' });
    }

    res.status(200).json({ message: 'FAQ deleted successfully', faqs: data.faqs });
  } catch (error) {
    console.error('Delete FAQ error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
