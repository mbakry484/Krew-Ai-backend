# Image Matching Pipeline — Complete Implementation Reference

_Last updated: 2026-07-04. Covers the structured garment-matching system (v3)._

This document explains **every step** of what happens between "a customer DMs a
photo" and "Luna replies", including the product-indexing side, all knobs, and
a case study of the black-tank-top incident with DB evidence.

---

## 1. The two sides of the system

Matching works by comparing **text embeddings of structured image descriptions**.
There are two sides, and they intentionally share the exact same description
pipeline so their vectors live in the same space:

| | Product side (indexing) | Customer side (query) |
|---|---|---|
| Trigger | Shopify sync / resync / product-update webhook | Customer sends image in DM |
| Code | `lib/embeddings.js` → `generateProductEmbedding()` | `routes/instagram.js` → `findSimilarProducts()` |
| Vision call | `describeImageForSearch()` **with** name+description hints | `describeImageForSearch()` **without** hints |
| Output stored | `products.image_description`, `image_attributes`, `garment_type`, `embedding` | used in-memory only |

Both sides call the **same** `describeImageForSearch()` in `lib/embeddings.js`
with the **same** base prompt (`VISION_PROMPT_BASE`).

---

## 2. The shared description step (GPT-4o vision)

File: `lib/embeddings.js`

1. Image is downloaded and base64-encoded (`downloadImageAsBase64`).
2. One GPT-4o call (`detail: 'auto'`, `max_tokens: 700`, JSON mode) with a
   prompt that demands **image-generation-grade detail** and returns strict JSON:

   ```json
   {
     "type":      "one of ~50 allowed garment types (lib/garment-vocab.js)",
     "colors":    ["each color WITH placement"],
     "pattern":   "kind + direction + width + spacing",
     "material":  "fabric + texture",
     "fit":       "silhouette + length",
     "neckline":  "construction detail",
     "sleeves":   "...",
     "closures":  "buttons/zips with count/color",
     "graphics":  "logos/prints with placement/size/color",
     "details":   "trims, hems, stitching, pockets...",
     "summary":   "4-6 sentence recreation-grade description"
   }
   ```

3. **Multi-item handling** (differs per side):
   - **Product side**: a product photo represents ONE product → describe only
     the most prominent item (`VISION_PROMPT_BASE`). Side effect: if a
     product's marketing photo makes a *different* item look most prominent,
     the product gets described as the wrong thing — see BEACH BAG BEIGE in §8.
   - **Customer side**: an outfit photo may contain several sellable items →
     `describeImageItemsForSearch()` (`VISION_PROMPT_MULTI`) extracts up to 3
     distinct items, EACH under the same per-item schema, and each is
     embedded + searched separately (§4). A "tank top + shorts" photo produces
     matches for both garments.
4. **Product-side hints**: `buildVisionPrompt({productName, productDescription})`
   appends a "KNOWN PRODUCT INFO" block. Vision may use it to resolve fabric /
   official color names / type — but is told to trust the image over the text.
5. `type` is normalized against the controlled vocabulary
   (`normalizeGarmentType`, `lib/garment-vocab.js`) → `garment_type`.
   If vision's type is unusable, fallback: Shopify `product_type`, then the
   product name. Disagreements are logged:
   `⚠️ Type disagreement for <name>: vision="X" vs shopify="Y" — keeping vision`.
6. The attributes are flattened into a **canonical fixed-order string**
   (`buildEmbeddingText`): `Type: … Colors: … Pattern: … Summary: …`
   That string — not the raw summary — is what gets embedded
   (`text-embedding-3-small`, 1536 dims).
7. If GPT returns unparseable JSON, everything falls back to raw free text with
   `garment_type = null` (no type gating, old-style behavior).

**What gets written to `products`:** `image_description` (the summary),
`image_attributes` (the JSON), `garment_type`, `embedding`.

---

## 3. When products get (re)indexed

File: `lib/embeddings.js` → `generateEmbeddingsForBrand(brandId, {force, limit})`

Selection query: products of the brand with `image_url IS NOT NULL`, **ordered
by name ascending**, and (unless `force`) filtered to
`embedding IS NULL OR garment_type IS NULL`.

| Entry point | force | limit |
|---|---|---|
| OAuth reconnect auto-sync (`routes/integrations.js` → `autoSyncProducts`) | no | env cap |
| `POST /webhook/shopify/sync` (bulk) | no | env cap |
| `POST /integrations/shopify/resync` | body `{"force": true}` | body `{"limit": N}`, else env cap |
| `product-update` webhook (single product) | re-embeds if: no embedding, image changed, or no garment_type | n/a |

**⚠️ THE CAP (important):** `EMBEDDING_MAX_PRODUCTS` env var caps EVERY run.
Because selection is ordered by name and already-indexed products drop out of
the non-force filter, **each capped run indexes the NEXT alphabetical batch**.
Run it three times with cap 10 → products A→C are indexed, everything after
is **invisible to image search** (embedding NULL → excluded by the SQL
function's `WHERE embedding IS NOT NULL`).

This is a deliberate quota-protection mode for testing. It MUST be removed
(delete the env var, then `{"force": true}` full resync) before judging match
quality — see §8 for what it does to results.

---

## 4. The customer query flow, step by step

File: `routes/instagram.js`, image branch of the webhook handler (~line 852).

1. Messages are **batched** per sender for 10s (`BATCH_WAIT_MS`) — that's why
   "[Image]" + "How much are these?" processed together.
2. Up to 3 image attachments are processed (`searchImageUrls.slice(0, 3)`).
3. For each image → `findSimilarProducts(url, brandId, conversationId)`:
   a. `describeImageItemsForSearch()` → up to 3 distinct items, each with
      structured attrs + `garment_type` (one vision call per image).
   b. For EACH detected item:
      - canonical string embedded → per-item `queryEmbedding`
      - RPC `match_products_by_embedding(queryEmbedding, brandId, 0.3, 10)`:
        pgvector cosine over products `WHERE embedding IS NOT NULL AND
        brand_id = X AND similarity > 0.3`, best 10, with garment_type.
      - **Re-ranking** (client-side):
        `adjusted = cosine − garmentTypePenalty(itemType, productType)`
        - same type or either unknown → −0
        - different type, same category (polo vs tank top) → −0.10 (`IMAGE_MATCH_TYPE_PENALTY`)
        - different category (top vs trousers) → −0.30 (`IMAGE_MATCH_CATEGORY_PENALTY`)
      - Filter `adjusted ≥ IMAGE_MATCH_THRESHOLD` (default 0.60), keep **top 2
        per item**.
4. Items from all images are capped at 4 total; if the same product matched
   several items, it's kept only under the item where it scored highest.
5. Each match gets its **own product URL** attached (DB lookup by id →
   `buildProductUrl`) so the reply model never hunts for links in the catalog.
6. The prompt section groups matches **per item** (`ITEM 1 — black tank top: …`)
   and instructs Luna to address EVERY matched item (names + prices + links for
   in-stock) unless the customer asked about specific item(s), and to speak
   with confidence on 75%+ matches (no "seems like" / "looks like" hedging).

The log lines map 1:1:

```
🔍 Customer image described as: <canonical embedding string>
👕 Query garment type: <normalized type>
🎯 Found N confident matches above <threshold> (best: X)
   • <name> | similarity: adj% (raw: raw%, type mismatch: X vs Y) | type: T | in_stock: B
```

---

## 5. The reply layer (Luna) — and why it can override the matches

This is the part that answers "how did Luna get it right when the matches were
wrong": **the vector matches are advisory context, not Luna's only source.**

Luna's `generateReply` call receives:

1. **System prompt** built by `buildOptimizedPrompt` (`lib/prompts/prompt-manager.js`):
   - Core identity, flow modules, and the **PRODUCT CATALOG section**
     (`lib/prompts/product-catalog.js`): top **30 in-stock** products (name,
     price, `link:`, variants) + top **30 out-of-stock** (name, price). A
     236-product store does NOT fit — most products are simply absent.
   - When vector matches exist: the **IMAGE SEARCH RESULTS — AUTHORITATIVE**
     section (built inline in `routes/instagram.js`) with the match list,
     per-match links, the reply templates, and the rule
     _"If none of the matches feels visually right, say so honestly — do not
     force a bad match."_
   - When NO vector matches: a generic fallback image-handling script instead.
2. **The customer's actual image(s)**, attached to the user message as
   base64 `image_url` content at `detail: 'low'`.

So **Luna is multimodal and sees the photo with her own eyes.** In the incident,
the escape-hatch rule let her (correctly) reject the three bad matches, and the
catalog section happened to contain "Black Tank top — 650 EGP ✅ In Stock ↳
link" — she recognized it in the photo herself and answered from there.

Two caveats worth knowing:
- She used a **catalog** link and markdown formatting, which the image-section
  rules discourage. It was the RIGHT link this time, but it shows prompt-rule
  adherence is probabilistic — the structural fix (links printed next to each
  match) reduces the odds of a wrong link, it doesn't make them zero.
- If the true product hadn't been in the top-30 in-stock list, Luna could NOT
  have named it — the catalog rules forbid naming products not listed.

---

## 6. Storage & SQL

- Migration: `add-garment-type-matching.sql` (columns `product_type`,
  `garment_type`, `image_attributes`; recreated `match_products_by_embedding`
  returning `garment_type`).
- Vector index: HNSW on `products.embedding` (`add-product-embeddings.sql`).
- The RPC hard-filters `embedding IS NOT NULL` — **an unindexed product can
  never be found by image search, no matter how perfect the match would be.**

## 7. All the knobs (env vars)

| Var | Default | Meaning |
|---|---|---|
| `EMBEDDING_MAX_PRODUCTS` | unset (no cap) | Max products described/embedded per indexing run — testing quota guard |
| `IMAGE_MATCH_THRESHOLD` | 0.45 | Min ADJUSTED similarity to show a match (currently 0.6 in env) |
| `IMAGE_MATCH_TYPE_PENALTY` | 0.10 | Penalty: same category, different type |
| `IMAGE_MATCH_CATEGORY_PENALTY` | 0.30 | Penalty: different category |
| `MESSAGE_BATCH_WAIT_MS` | 10000 | DM batching window |

---

## 8. Case study: the black tank top (2026-07-04)

Customer photo: black ribbed tank with white trim + black shorts, on a model.

**What went right:** query description was exact and complete; query type
`tank top`; the shorts and model were correctly ignored (most-prominent rule).

**What the matches were and why (DB evidence):**

- Catalog state at the time: **236 products, only 25 indexed** (all under the
  v3 detailed scheme), strictly alphabetical `32 Black Crewneck` →
  `I May Have Issues Black Baby Tee`. The other 210 products had
  `embedding = NULL` → **invisible to the RPC**.
- Both true candidates — `Black Tank top` and `Black tanktop` (in stock!) —
  were among the 210 unindexed. Verified: `embedding IS NULL` for both.
- So the engine returned the best of the 25 it could see:
  - `Baby Blue Unfinished Tank` (73%) — genuinely the closest indexed item:
    tank top, same cut, wrong color. Correct behavior on a crippled index.
  - `BEACH BAG BEIGE` (71%) — its DB row says `garment_type: 'tank top'`,
    description: _"beige open-knit tank top … cropped length"_. GPT-4o read the
    bag's product photo as a knit tank top (the sibling `Beach bag in offwhite`
    was correctly typed `bag`). A product-side data-quality bug to sweep for
    after the full re-index (the indexer logs `⚠️ Type disagreement` lines
    exactly for this).
  - `32 White Crewneck` (60.5 adj / 70.5 raw) — the −0.10 same-category type
    penalty (sweatshirt vs tank top) did its job pushing it down.

**Why Luna still answered correctly:** §5 — she saw the image herself, used the
escape-hatch rule to reject the matches, and found "Black Tank top" in the
top-30 in-stock catalog list. Luck was involved: the product happened to be in
that top-30 slice.

**Remediation checklist (ops, no code):**
1. Delete `EMBEDDING_MAX_PRODUCTS` from Railway (or raise it past 236).
2. `POST /integrations/shopify/resync` with body `{"force": true}` → full
   catalog re-index (~235 GPT-4o vision calls).
3. After it finishes, sweep for type mistakes:
   ```sql
   SELECT name, product_type, garment_type
   FROM products
   WHERE garment_type IS NOT NULL
   ORDER BY name;
   ```
   Eyeball rows where `garment_type` obviously contradicts the name
   (the BEACH BAG BEIGE pattern).
4. Re-evaluate `IMAGE_MATCH_THRESHOLD=0.6` against a fully-indexed catalog —
   thresholds measured on a 25-product index are meaningless.
