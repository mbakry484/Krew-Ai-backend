# Shared Instagram Post Support

Luna now supports **shared Instagram posts**! When customers share a post from Instagram (e.g., a product photo from your brand's feed), Luna extracts the image and processes it using the same vector similarity search as directly uploaded images.

## How It Works

### 1. Meta's Template Attachment Format

When a customer shares an Instagram post via DM, Meta sends it as a `template` type attachment instead of a direct `image` attachment:

```json
{
  "messaging": [{
    "message": {
      "attachments": [{
        "type": "template",
        "payload": {
          "elements": [{
            "image_url": "https://scontent.cdninstagram.com/...",
            "url": "https://www.instagram.com/p/ABC123/"
          }]
        }
      }]
    }
  }]
}
```

### 2. Image Extraction

Luna extracts the image URL from the template structure:

```javascript
// Detect shared Instagram posts (template type)
const templateAttachment = attachments.find(a => a.type === 'template');
const sharedPostImageUrl = templateAttachment?.payload?.elements?.[0]?.image_url
  || templateAttachment?.payload?.elements?.[0]?.url
  || null;
```

The code checks both:
- `elements[0].image_url` - Direct image URL
- `elements[0].url` - Fallback to post URL

### 3. Unified Image Processing

Both direct images and shared post images are handled identically:

```javascript
// Use shared post image if no direct image was sent
const effectiveImageUrl = imageUrl || sharedPostImageUrl;

if (effectiveImageUrl) {
  // Same vector search flow for both types
  const { matches, queryDescription } = await findSimilarProducts(effectiveImageUrl, brand_id);
}
```

**Priority:**
1. Direct image upload (if customer sends photo from camera)
2. Shared post image (if customer shares Instagram post)

### 4. Logging

When a shared post is detected:

```javascript
if (sharedPostImageUrl) {
  console.log('📤 Customer shared a post, extracting image for vector search...');
}
```

This helps distinguish between direct uploads and shared posts in logs.

## Example Flows

### Flow 1: Customer Shares Your Brand's Product Post

**Customer action:**
- Opens your Instagram brand page
- Finds product post with image
- Clicks "Share" → Sends to Luna via DM

**Luna processing:**
```
📤 Customer shared a post, extracting image for vector search...
📨 867797979570471: "[Image]"
🔍 Brand found: 6fe9cfc8-21e9-442f-9b6f-4f09f6c13823
📸 Processing customer image with vector search...
🔍 Customer image described as: grey zip-up hoodie with leopard print lining
🎯 Found 3 similar products
🤖 Luna reply: "This is our 'WSTDPTNL GREY LEOPARD HOODED ZIP-UP' (1150 EGP)..."
```

**Result:**
Luna identifies the exact product and provides price/availability just like a direct image upload.

---

### Flow 2: Customer Shares Competitor's Post

**Customer action:**
- Finds similar product on competitor's Instagram
- Shares their post to Luna

**Luna processing:**
```
📤 Customer shared a post, extracting image for vector search...
📨 867797979570471: "[Image]"
📸 Processing customer image with vector search...
🔍 Customer image described as: black leather jacket with zipper details
🎯 Found 2 similar products
🤖 Luna reply: "This looks similar to our 'Classic Black Leather Jacket' (2500 EGP)..."
```

**Result:**
Luna finds visually similar products from your catalog, even if the shared post is from a competitor.

---

### Flow 3: Customer Shares Random Fashion Post

**Customer action:**
- Sees trending outfit on influencer's page
- Shares it to Luna asking "Do you have this?"

**Luna processing:**
```
📤 Customer shared a post, extracting image for vector search...
📸 Processing customer image with vector search...
🎯 Found 0 similar products
🤖 Luna reply: "Sorry, I couldn't find an exact match for this item..."
```

**Result:**
Luna gracefully handles no matches, offering to help find similar items or answer questions about your catalog.

## Technical Details

### Code Location

All changes are in [routes/instagram.js](routes/instagram.js):

#### Webhook Level (Lines 189-203)
```javascript
// Detect shared posts in webhook
const templateAttachment = attachments.find(a => a.type === 'template');
const sharedPostImageUrl = templateAttachment?.payload?.elements?.[0]?.image_url
  || templateAttachment?.payload?.elements?.[0]?.url
  || null;

const effectiveImageUrl = imageUrl || sharedPostImageUrl;

// Updated null check
if (!customerMessage && !effectiveImageUrl && !audioUrl) continue;

// Logging
if (sharedPostImageUrl) console.log('📤 Customer shared a post, extracting image...');
```

#### Message Handler Level (Lines 233-244)
```javascript
// Same detection in handleIncomingMessage
const templateAttachment = attachments.find(a => a.type === 'template');
const sharedPostImageUrl = templateAttachment?.payload?.elements?.[0]?.image_url
  || templateAttachment?.payload?.elements?.[0]?.url
  || null;

const effectiveImageUrl = imageUrl || sharedPostImageUrl;

if (sharedPostImageUrl) {
  console.log('📤 Customer shared a post, extracting image for vector search...');
}
```

#### Image Processing (Line 575-578)
```javascript
if (effectiveImageUrl) {
  // Same flow for direct images and shared posts
  console.log('📸 Processing customer image with vector search...');
  const { matches, queryDescription } = await findSimilarProducts(effectiveImageUrl, brand_id);
}
```

#### Database Storage (Lines 426, 473, 555)
```javascript
// All message inserts use effectiveImageUrl
await supabase.from('messages').insert({
  conversation_id: conversation.id,
  sender: 'customer',
  content: finalMessage || '[Image]',
  platform_message_id: messageId,
  image_url: effectiveImageUrl || null, // Stores shared post URL
});
```

### Null Safety

Updated to accept text, direct image, shared post, OR voice:

```javascript
if (!customerMessage && !effectiveImageUrl && !audioUrl) {
  console.log(`ℹ️  Ignoring event with no content from ${senderId}`);
  return;
}
```

## Image URL Priority Logic

```javascript
const effectiveImageUrl = imageUrl || sharedPostImageUrl;
```

**Priority:**
1. **Direct image** (`imageUrl`): Customer uploaded photo from camera/gallery
2. **Shared post** (`sharedPostImageUrl`): Customer shared Instagram post

**Why this order?**
- If a customer sends both (unlikely), the direct upload is more intentional
- Shared posts are fallback for when no direct image is sent

## Use Cases

### 1. Customer Asks "Do You Have This?"
Customer shares competitor's product post → Luna finds similar items from your catalog

### 2. Customer Shares Your Own Product Post
Customer shares your brand's post → Luna identifies exact product and provides ordering details

### 3. Re-ordering Previous Purchase
Customer shares old order screenshot or product post → Luna recognizes product and facilitates re-order

### 4. Influencer/Trendjacking
Customer shares viral fashion trend → Luna suggests visually similar products you carry

### 5. Gift Shopping
Customer shares post saying "I want to buy this for my friend" → Luna helps place order

## Benefits

### For Customers
- ✅ **Easier communication**: Share post instead of typing product name
- ✅ **Visual shopping**: Show what you want instead of describing it
- ✅ **Faster searches**: Share competitor's post, get your alternatives instantly

### For Business
- ✅ **Capture competitor traffic**: Convert customers looking at competitor posts
- ✅ **Reduce friction**: No need to ask "What product are you looking for?"
- ✅ **Trend tracking**: See what customers are sharing (analytics potential)
- ✅ **Cross-selling**: Customer shares one item, Luna suggests similar items from your catalog

## Limitations

### 1. Post Must Have Image
If the shared post is text-only or video, Luna won't extract an image:

```javascript
const sharedPostImageUrl = templateAttachment?.payload?.elements?.[0]?.image_url
  || templateAttachment?.payload?.elements?.[0]?.url
  || null;

// If null, no image processing occurs
```

### 2. Instagram CDN Access
Shared post images are hosted on Instagram's CDN. They should be accessible, but if Instagram blocks the URL (rare), image download will fail:

```javascript
// In findSimilarProducts
const response = await fetch(imageUrl);
if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
```

### 3. Carousel Posts
If customer shares a carousel post (multiple images), only the **first image** is extracted:

```javascript
elements?.[0]?.image_url // Only first element
```

To support multiple images, you'd need to loop through all elements (future enhancement).

## Testing

### Manual Test Steps

1. **Open Luna's Instagram DM**
2. **Go to your brand's Instagram feed** (or any post with product image)
3. **Click "Share" on any product post**
4. **Select Luna's DM** as share destination
5. **Send**

**Expected logs:**
```
📤 Customer shared a post, extracting image for vector search...
📨 867797979570471: "[Image]"
📸 Processing customer image with vector search...
🔍 Customer image described as: [GPT-4o description]
🎯 Found X similar products
🤖 Luna reply: "This looks like our [Product Name]..."
```

### Verify Database Storage

Check Supabase `messages` table:
```sql
SELECT content, image_url
FROM messages
WHERE sender = 'customer'
  AND image_url IS NOT NULL
ORDER BY created_at DESC
LIMIT 5;
```

The `image_url` should contain the Instagram CDN URL from the shared post.

## Future Enhancements

### 1. Carousel Support
Extract all images from multi-image posts:
```javascript
const images = templateAttachment?.payload?.elements?.map(el => el.image_url) || [];
// Process each image separately or combine descriptions
```

### 2. Post Metadata Extraction
Extract caption, author, likes from shared post:
```javascript
const caption = templateAttachment?.payload?.elements?.[0]?.subtitle;
const author = templateAttachment?.payload?.elements?.[0]?.default_action?.url;
```

Use this to understand context (e.g., "This influencer loves it!").

### 3. Video Support
Extract thumbnail from shared video posts:
```javascript
const videoThumbnail = templateAttachment?.payload?.elements?.[0]?.video_thumbnail;
```

### 4. Analytics Dashboard
Track what posts customers are sharing:
- Competitor analysis: Which brands are customers comparing you to?
- Trend detection: What styles are being shared most?
- Content gaps: What products are customers asking for that you don't have?

## Comparison: Direct Upload vs Shared Post

| Feature | Direct Image Upload | Shared Instagram Post |
|---------|-------------------|---------------------|
| **Detection** | `type === 'image'` | `type === 'template'` |
| **URL Extraction** | `payload.url` | `payload.elements[0].image_url` |
| **Image Quality** | Original resolution | Instagram compressed |
| **Processing** | Vector search | Vector search (identical) |
| **Use Case** | Customer's own photo | Sharing existing post |
| **Source** | Camera/gallery | Instagram feed |

**Both are treated identically** after URL extraction - same GPT-4o vision, same vector search, same product matching!

## Conclusion

Shared post support makes Luna **more versatile** and **easier to use**:

- ✅ Customers can share posts instead of typing product names
- ✅ Works with your own posts and competitor posts
- ✅ Same vector search accuracy as direct uploads
- ✅ No additional API cost (uses same GPT-4o vision)
- ✅ Seamlessly integrated with existing image processing flow

**The feature is live and ready to use!** 📤✨
