const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { generateEmbeddingsForBrand } = require('../lib/embeddings');
const { getValidAccessToken, getStorefrontUrl } = require('../lib/shopify');
const { verifyKrewAppAuth } = require('../middleware/krewAppAuth');

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
    const productsToUpsert = products.map(product => {
      // Calculate in_stock based on variants inventory
      const inStock = product.variants?.some(v => v.inventory_quantity > 0) ?? true;

      return {
        user_id: brandId,
        shopify_product_id: product.shopify_product_id,
        brand_id: brandId,
        name: product.name,
        handle: product.handle || null,
        online_store_url: product.online_store_url || null,
        product_type: product.product_type || null,
        description: product.description || null,
        price: product.price || null,
        currency: product.currency || 'EGP',
        variants: product.variants || [],
        in_stock: inStock,
        availability: inStock ? 'in_stock' : 'out_of_stock', // For backwards compatibility
        sku: product.sku || null,
        image_url: product.image_url || null,
        images: product.images || [],
        synced_at: syncedAt,
        updated_at: syncedAt,
      };
    });

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

    // Log each product with image count
    products.forEach(product => {
      console.log(`Saved ${product.name} - images: ${product.images?.length || 0}`);
    });

    console.log(`✅ Synced ${products.length} products for brand ${brandId} from shop ${shop_domain}`);

    res.json({
      success: true,
      count: products.length,
      synced_at: syncedAt,
      products: data
    });

    // Run embedding generation in background (don't await)
    // This generates AI descriptions and embeddings for product images
    generateEmbeddingsForBrand(brandId).catch(err =>
      console.error('❌ Background embedding error:', err.message)
    );

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

    // Calculate in_stock based on variants inventory
    const inStock = product.variants?.some(v => v.inventory_quantity > 0) ?? true;

    const { data, error } = await supabase
      .from('products')
      .upsert({
        shopify_product_id: product.shopify_product_id,
        user_id: brandId,
        brand_id: brandId,
        name: product.name,
        handle: product.handle || null,
        online_store_url: product.online_store_url || null,
        product_type: product.product_type || null,
        description: product.description,
        price: product.price,
        currency: product.currency || 'EGP',
        image_url: product.image_url || null,
        images: product.images || [],
        variants: product.variants || [],
        in_stock: inStock,
        availability: inStock ? 'in_stock' : 'out_of_stock',
        sku: product.sku || null,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'shopify_product_id',
      });

    if (error) throw error;

    console.log(`Saved ${product.name} - images: ${product.images?.length || 0}`);
    console.log(`Product upserted: ${product.name} (${product.shopify_product_id}) for brand ${brandId}`);

    res.json({
      success: true,
      message: 'Product synced successfully',
      data
    });

    // Only regenerate embedding if the product has an image and either:
    // 1. No embedding exists yet, or
    // 2. The image_url changed (meaning the actual image was updated), or
    // 3. It was indexed under the old free-text scheme (no garment_type yet)
    if (product.image_url) {
      const { generateProductEmbedding } = require('../lib/embeddings');

      // Check if this product already has an embedding and what image_url was used
      const { data: existing } = await supabase
        .from('products')
        .select('image_url, embedding, garment_type')
        .eq('shopify_product_id', product.shopify_product_id)
        .single();

      const needsEmbedding = !existing?.embedding
        || existing?.image_url !== product.image_url
        || !existing?.garment_type;

      if (needsEmbedding) {
        const reason = !existing?.embedding ? 'no embedding'
          : existing?.image_url !== product.image_url ? 'image changed'
          : 'old-format embedding';
        console.log(`🔄 Regenerating embedding for ${product.name} (${reason})`);
        generateProductEmbedding({
          shopify_product_id: product.shopify_product_id,
          name: product.name,
          image_url: product.image_url,
          product_type: product.product_type || null,
          description: product.description || null
        }).catch(err =>
          console.error('❌ Background embedding error:', err.message)
        );
      } else {
        console.log(`⏭️  Skipping embedding for ${product.name} — image unchanged, embedding exists`);
      }
    }
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

// POST /webhook/shopify/shop-update
// Shopify fires shop/update when shop settings change (including the primary
// domain). Re-fetch the storefront URL so product links stay on the brand's
// published custom domain instead of the .myshopify.com fallback.
router.post('/shop-update', async (req, res) => {
  try {
    const { shop_domain } = req.body;

    if (!shop_domain) {
      return res.status(400).json({ error: 'Invalid request body. Expected { shop_domain }' });
    }

    // Look up the integration so we can refresh its access token if needed
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('brand_id, shopify_shop_domain, access_token, refresh_token, token_expires_at')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (integrationError || !integration || !integration.brand_id) {
      return res.status(404).json({
        error: 'Store not linked. Please link the Shopify store to a brand first.'
      });
    }

    const accessToken = await getValidAccessToken(integration);
    const storefrontUrl = await getStorefrontUrl(shop_domain, accessToken);

    if (storefrontUrl) {
      const { error } = await supabase
        .from('integrations')
        .update({ storefront_url: storefrontUrl })
        .eq('shopify_shop_domain', shop_domain)
        .eq('platform', 'shopify');

      if (error) throw error;
      console.log(`✅ Refreshed storefront URL for ${shop_domain}: ${storefrontUrl}`);
    }

    res.json({ success: true, storefront_url: storefrontUrl || null });
  } catch (error) {
    console.error('Error handling shop-update:', error);
    res.status(500).json({ error: 'Failed to handle shop update', details: error.message });
  }
});

// POST /webhook/shopify/customers/data-request
// Shopify fires this when a customer requests their stored data (GDPR)
router.post('/customers/data-request', async (req, res) => {
  try {
    const { shop_domain, payload } = req.body;
    console.log(`customers/data_request received for shop: ${shop_domain}`);

    // Look up brand tied to this shop
    const { data: integration } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (!integration) {
      // Store not linked — nothing stored, respond 200
      return res.status(200).json({ success: true });
    }

    // This app stores no direct customer PII beyond conversations/messages.
    // Log the request for audit purposes.
    console.log(`Data request for customer ${payload?.customer?.id} from shop ${shop_domain} (brand ${integration.brand_id})`);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error handling customers/data_request:', error);
    res.status(200).json({ success: true }); // Always return 200 to Shopify
  }
});

// POST /webhook/shopify/customers/redact
// Shopify fires this when a customer requests deletion of their data (GDPR)
router.post('/customers/redact', async (req, res) => {
  try {
    const { shop_domain, payload } = req.body;
    const customerId = payload?.customer?.id?.toString();
    console.log(`customers/redact received for customer ${customerId} from shop: ${shop_domain}`);

    const { data: integration } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (!integration) {
      return res.status(200).json({ success: true });
    }

    const brandId = integration.brand_id;

    // Delete conversations and messages for this customer
    const { data: convs } = await supabase
      .from('conversations')
      .select('id')
      .eq('brand_id', brandId)
      .eq('customer_id', customerId);

    if (convs && convs.length > 0) {
      const convIds = convs.map(c => c.id);

      await supabase
        .from('messages')
        .delete()
        .in('conversation_id', convIds);

      await supabase
        .from('conversations')
        .delete()
        .in('id', convIds);

      console.log(`Deleted ${convIds.length} conversation(s) for customer ${customerId}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error handling customers/redact:', error);
    res.status(200).json({ success: true }); // Always return 200 to Shopify
  }
});

// POST /webhook/shopify/shop/redact
// Shopify fires this 48h after a shop uninstalls the app — delete all shop data (GDPR)
router.post('/shop/redact', async (req, res) => {
  try {
    const { shop_domain, payload } = req.body;
    console.log(`shop/redact received for shop: ${shop_domain}`);

    const { data: integration } = await supabase
      .from('integrations')
      .select('brand_id, id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (!integration) {
      return res.status(200).json({ success: true });
    }

    const brandId = integration.brand_id;

    // Delete all conversations and their messages for this brand
    const { data: convs } = await supabase
      .from('conversations')
      .select('id')
      .eq('brand_id', brandId);

    if (convs && convs.length > 0) {
      const convIds = convs.map(c => c.id);
      await supabase.from('messages').delete().in('conversation_id', convIds);
      await supabase.from('conversations').delete().in('id', convIds);
    }

    // Delete all products for this brand
    await supabase.from('products').delete().eq('brand_id', brandId);

    // Delete orders, refunds, exchanges
    await supabase.from('orders').delete().eq('brand_id', brandId);
    await supabase.from('refunds').delete().eq('brand_id', brandId);
    await supabase.from('exchanges').delete().eq('brand_id', brandId);

    // Remove the Shopify integration record
    await supabase.from('integrations').delete().eq('id', integration.id);

    console.log(`✅ shop/redact complete — all data deleted for shop ${shop_domain} (brand ${brandId})`);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error handling shop/redact:', error);
    res.status(200).json({ success: true }); // Always return 200 to Shopify
  }
});

// GET /webhook/shopify/sync-status?shop_domain=x — poll sync state from embedded app
router.get('/sync-status', verifyKrewAppAuth, async (req, res) => {
  try {
    const shop_domain = req.shopDomain;

    const { data: integration } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (!integration?.brand_id) return res.json({ synced: false, count: 0, last_synced: null });

    const { data: products, error } = await supabase
      .from('products')
      .select('synced_at')
      .eq('brand_id', integration.brand_id)
      .order('synced_at', { ascending: false })
      .limit(1);

    if (error || !products || products.length === 0) {
      return res.json({ synced: false, count: 0, last_synced: null });
    }

    const { count } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('brand_id', integration.brand_id);

    res.json({ synced: true, count: count || 0, last_synced: products[0].synced_at });
  } catch (error) {
    console.error('Error fetching sync status:', error);
    res.status(500).json({ error: 'Failed to fetch sync status' });
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
