const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// POST /products/sync - Bulk sync products from Shopify
router.post('/sync', async (req, res) => {
  try {
    const { shop_domain, products } = req.body;

    // Validate request body
    if (!shop_domain || !Array.isArray(products)) {
      return res.status(400).json({
        error: 'Invalid request body. Expected { shop_domain, products: [] }'
      });
    }

    if (products.length === 0) {
      return res.json({ success: true, count: 0, message: 'No products to sync' });
    }

    // Look up brand_id from integrations table using shopify_shop_domain
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (integrationError || !integration || !integration.brand_id) {
      return res.status(404).json({
        error: 'Store not linked. Please link the Shopify store to a brand first.'
      });
    }

    const brandId = integration.brand_id;
    const syncedAt = new Date().toISOString();

    // Prepare products for upsert
    const productsToUpsert = products.map(product => ({
      user_id: brandId,
      shopify_product_id: product.shopify_product_id,
      brand_id: brandId,
      name: product.name,
      description: product.description || null,
      price: product.price || null,
      currency: product.currency || 'EGP',
      variants: product.variants || [],
      in_stock: product.in_stock !== undefined ? product.in_stock : true,
      availability: product.in_stock ? 'in_stock' : 'out_of_stock', // For backwards compatibility
      sku: product.sku || null,
      image_url: product.image_url || null,
      synced_at: syncedAt,
      updated_at: syncedAt,
    }));

    // Upsert all products using shopify_product_id as unique key
    const { data, error } = await supabase
      .from('products')
      .upsert(productsToUpsert, {
        onConflict: 'shopify_product_id',
        ignoreDuplicates: false, // Update existing records
      })
      .select();

    if (error) {
      console.error('Error syncing products:', error);
      throw error;
    }

    console.log(`✅ Synced ${products.length} products for brand ${brandId} from shop ${shop_domain}`);

    res.json({
      success: true,
      count: products.length,
      synced_at: syncedAt,
      products: data
    });

  } catch (error) {
    console.error('Error in /sync endpoint:', error);
    res.status(500).json({
      error: 'Failed to sync products',
      details: error.message
    });
  }
});

// POST /webhook/shopify/product-update - Handle product create/update from Shopify
router.post('/product-update', async (req, res) => {
  try {
    const { shop_domain, product } = req.body;

    if (!shop_domain || !product) {
      return res.status(400).json({
        error: 'Invalid request body. Expected { shop_domain, product }'
      });
    }

    // Look up brand_id from integrations table using shopify_shop_domain
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (integrationError || !integration || !integration.brand_id) {
      return res.status(404).json({
        error: 'Store not linked. Please link the Shopify store to a brand first.'
      });
    }

    const brandId = integration.brand_id;

    const { data, error } = await supabase
      .from('products')
      .upsert({
        shopify_product_id: product.shopify_product_id,
        user_id: brandId,
        brand_id: brandId,
        name: product.name,
        description: product.description,
        price: product.price,
        image_url: product.image_url || null,
        availability: product.in_stock ? 'in_stock' : 'out_of_stock',
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'shopify_product_id',
      });

    if (error) throw error;

    console.log(`Product upserted: ${product.name} (${product.shopify_product_id}) for brand ${brandId}`);

    res.json({
      success: true,
      message: 'Product synced successfully',
      data
    });
  } catch (error) {
    console.error('Error upserting product:', error);
    res.status(500).json({ error: 'Failed to upsert product', details: error.message });
  }
});

// POST /webhook/shopify/product-delete - Handle product deletion from Shopify
router.post('/product-delete', async (req, res) => {
  try {
    const { shop_domain, shopify_product_id } = req.body;

    if (!shop_domain || !shopify_product_id) {
      return res.status(400).json({
        error: 'Invalid request body. Expected { shop_domain, shopify_product_id }'
      });
    }

    // Look up brand_id from integrations table using shopify_shop_domain
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (integrationError || !integration || !integration.brand_id) {
      return res.status(404).json({
        error: 'Store not linked. Please link the Shopify store to a brand first.'
      });
    }

    const brandId = integration.brand_id;

    // Delete product belonging to this brand
    const { data, error } = await supabase
      .from('products')
      .delete()
      .eq('shopify_product_id', shopify_product_id)
      .eq('brand_id', brandId);

    if (error) throw error;

    console.log(`Product deleted: ${shopify_product_id} for brand ${brandId}`);

    res.json({
      success: true,
      message: 'Product deleted successfully',
      data
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product', details: error.message });
  }
});

// Legacy webhook endpoints (not yet implemented)
router.post('/orders/create', (req, res) => {
  res.status(501).json({ message: 'Shopify order creation webhook not yet implemented' });
});

router.post('/orders/updated', (req, res) => {
  res.status(501).json({ message: 'Shopify order update webhook not yet implemented' });
});

router.post('/products/create', (req, res) => {
  res.status(501).json({ message: 'Shopify product creation webhook not yet implemented' });
});

router.post('/products/update', (req, res) => {
  res.status(501).json({ message: 'Shopify product update webhook not yet implemented' });
});

module.exports = router;
