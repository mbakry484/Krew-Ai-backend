-- Add brand_description column to users table
-- This stores the brand owner's description entered during onboarding (Step 5)
ALTER TABLE users ADD COLUMN IF NOT EXISTS brand_description TEXT;
