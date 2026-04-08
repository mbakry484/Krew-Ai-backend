-- Migration: Move onboarding fields to brands table (they belong to the brand, not the user)
-- Also add unique constraints to prevent duplicate Shopify/Meta connections

-- 1. Add onboarding + description columns to brands table
ALTER TABLE brands ADD COLUMN IF NOT EXISTS business_type TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS revenue_range TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS dm_volume TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS pain_point TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS brand_description TEXT;

-- 2. Migrate existing data from users to brands
UPDATE brands b
SET
  business_type = u.business_type,
  revenue_range = u.revenue_range,
  dm_volume = u.dm_volume,
  pain_point = u.pain_point,
  brand_description = u.brand_description
FROM users u
WHERE u.brand_id = b.id
  AND (u.business_type IS NOT NULL OR u.revenue_range IS NOT NULL OR u.dm_volume IS NOT NULL OR u.pain_point IS NOT NULL OR u.brand_description IS NOT NULL);

-- 3. Add unique constraint on integrations to prevent two brands connecting the same Shopify store
-- (shopify_shop_domain is already used in onConflict upsert, but let's make it explicit)
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_shopify_domain_unique
  ON integrations (shopify_shop_domain) WHERE shopify_shop_domain IS NOT NULL;

-- 4. Add unique constraint to prevent two brands connecting the same Instagram account
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_instagram_page_unique
  ON integrations (instagram_page_id) WHERE instagram_page_id IS NOT NULL;

-- 5. Clean up duplicate fb_page_id values (keep only the most recently updated brand for each fb_page_id)
UPDATE brands
SET fb_page_id = NULL,
    page_access_token = NULL,
    long_lived_user_token = NULL,
    token_expires_at = NULL,
    instagram_page_id = NULL,
    instagram_business_account_id = NULL
WHERE fb_page_id IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (fb_page_id) id
    FROM brands
    WHERE fb_page_id IS NOT NULL
    ORDER BY fb_page_id, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
  );

-- 6. Now add unique constraint to prevent two brands connecting the same Facebook page
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_fb_page_unique
  ON brands (fb_page_id) WHERE fb_page_id IS NOT NULL;
