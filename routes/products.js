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
      // Calculate in_stock based on variants inventory
      const inStock = product.variants?.some(v => v.inventory_quantity > 0) ?? (product.in_stock ?? true);

      const { data, error } = await supabase
        .from('products')
        .upsert({
          shopify_product_id: product.shopify_product_id,
          brand_id: brandId,
          user_id: brandId,
          name: product.name,
          description: product.description,
          price: product.price,
          currency: product.currency || 'EGP',
          variants: product.variants || [],
          in_stock: inStock,
          availability: inStock ? 'in_stock' : 'out_of_stock',
          sku: product.sku || null,
          image_url: product.image_url || null,
          images: product.images || [],
          synced_at: new Date().toISOString(),
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
router.get('/', async (req, res) => {
  try {
    const { brand_id } = req.query;

    if (!brand_id) {
      return res.status(400).json({
        error: 'Missing required parameter: brand_id'
      });
    }

    const { data: products, error } = await supabase
      .from('products')
      .select('id, shopify_product_id, brand_id, name, description, price, currency, variants, in_stock, availability, sku, image_url, synced_at, created_at, updated_at')
      .eq('brand_id', brand_id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      count: products.length,
      products
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      error: 'Failed to fetch products',
      details: error.message
    });
  }
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
