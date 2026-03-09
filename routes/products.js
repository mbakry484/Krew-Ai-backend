const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
// const { verifyToken } = require('../middleware/auth');

// POST /products/sync - Bulk sync products from Shopify
router.post('/sync', async (req, res) => {
  try {
    const { user_id, products } = req.body;

    if (!user_id || !Array.isArray(products)) {
      return res.status(400).json({
        error: 'Invalid request body. Expected { user_id, products: [] }'
      });
    }

    // TODO: Map user_id (shop) to brand_id in your database
    // For now, we'll need to fetch or create a brand record
    // This is a placeholder - adjust based on your brand mapping logic
    const brandId = user_id; // Replace with actual brand_id lookup

    const upsertPromises = products.map(async (product) => {
      const { data, error } = await supabase
        .from('products')
        .upsert({
          shopify_product_id: product.shopify_product_id,
          brand_id: brandId,
          name: product.name,
          description: product.description,
          price: product.price,
          availability: product.in_stock ? 'in_stock' : 'out_of_stock',
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'shopify_product_id',
        });

      if (error) throw error;
      return data;
    });

    await Promise.all(upsertPromises);

    res.json({
      success: true,
      message: `Successfully synced ${products.length} products`,
      synced_count: products.length
    });
  } catch (error) {
    console.error('Error syncing products:', error);
    res.status(500).json({ error: 'Failed to sync products', details: error.message });
  }
});

// GET /products - List all products for a brand
router.get('/', (req, res) => {
  res.status(501).json({ message: 'List products endpoint not yet implemented' });
});

// GET /products/:id - Get single product details
router.get('/:id', (req, res) => {
  res.status(501).json({ message: 'Get product endpoint not yet implemented' });
});

// POST /products - Create new product (protected)
router.post('/', (req, res) => {
  res.status(501).json({ message: 'Create product endpoint not yet implemented' });
});

// PUT /products/:id - Update product (protected)
router.put('/:id', (req, res) => {
  res.status(501).json({ message: 'Update product endpoint not yet implemented' });
});

// DELETE /products/:id - Delete product (protected)
router.delete('/:id', (req, res) => {
  res.status(501).json({ message: 'Delete product endpoint not yet implemented' });
});

module.exports = router;
