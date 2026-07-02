/**
 * Controlled garment-type vocabulary for image search.
 *
 * Both the product-indexing side and the customer-query side describe images
 * against this SAME fixed vocabulary, so "tank top" on one side can never come
 * out as "sleeveless top" on the other. The category grouping powers the
 * soft type-penalty in matching: a polo shirt should not beat a tank top for a
 * tank-top query, and a pair of pants should never beat either.
 */

// canonical type -> category
const GARMENT_TYPES = {
  // tops
  't-shirt': 'top',
  'tank top': 'top',
  'polo shirt': 'top',
  'shirt': 'top',
  'blouse': 'top',
  'crop top': 'top',
  'bodysuit': 'top',
  'sweatshirt': 'top',
  'hoodie': 'top',
  'sweater': 'top',
  'cardigan': 'top',
  'top': 'top', // generic fallback within tops
  // bottoms
  'jeans': 'bottom',
  'trousers': 'bottom',
  'cargo pants': 'bottom',
  'sweatpants': 'bottom',
  'leggings': 'bottom',
  'shorts': 'bottom',
  'skirt': 'bottom',
  // one-piece
  'dress': 'dress',
  'jumpsuit': 'dress',
  'abaya': 'dress',
  'kaftan': 'dress',
  // outerwear
  'jacket': 'outerwear',
  'coat': 'outerwear',
  'blazer': 'outerwear',
  'vest': 'outerwear',
  // sets
  'set': 'set',
  'pajamas': 'set',
  'tracksuit': 'set',
  // swimwear
  'swimsuit': 'swimwear',
  'bikini': 'swimwear',
  // footwear
  'sneakers': 'footwear',
  'shoes': 'footwear',
  'sandals': 'footwear',
  'boots': 'footwear',
  'heels': 'footwear',
  'slippers': 'footwear',
  // bags
  'handbag': 'bag',
  'tote bag': 'bag',
  'backpack': 'bag',
  'bag': 'bag',
  // accessories
  'cap': 'accessory',
  'hat': 'accessory',
  'scarf': 'accessory',
  'hijab': 'accessory',
  'belt': 'accessory',
  'sunglasses': 'accessory',
  'jewelry': 'accessory',
  'watch': 'accessory',
  'socks': 'accessory',
  'wallet': 'accessory',
  // underwear
  'underwear': 'underwear',
  'bra': 'underwear',
  'lingerie': 'underwear',
};

// Common variants -> canonical type. Checked before scanning the raw string.
const TYPE_ALIASES = {
  'tee': 't-shirt',
  'tshirt': 't-shirt',
  't shirt': 't-shirt',
  'polo': 'polo shirt',
  'polo tee': 'polo shirt',
  'tank': 'tank top',
  'camisole': 'tank top',
  'singlet': 'tank top',
  'pants': 'trousers',
  'pant': 'trousers',
  'joggers': 'sweatpants',
  'denim': 'jeans',
  'pullover': 'sweater',
  'jumper': 'sweater',
  'knit top': 'sweater',
  'gown': 'dress',
  'overalls': 'jumpsuit',
  'romper': 'jumpsuit',
  'parka': 'coat',
  'trench coat': 'coat',
  'windbreaker': 'jacket',
  'bomber': 'jacket',
  'gilet': 'vest',
  'co-ord': 'set',
  'coord': 'set',
  'two-piece': 'set',
  'pyjamas': 'pajamas',
  'trainers': 'sneakers',
  'sliders': 'slippers',
  'flip flops': 'sandals',
  'purse': 'handbag',
  'crossbody': 'handbag',
  'tote': 'tote bag',
  'beanie': 'hat',
  'bucket hat': 'hat',
  'necklace': 'jewelry',
  'bracelet': 'jewelry',
  'ring': 'jewelry',
  'earrings': 'jewelry',
};

// The list given to GPT-4o vision as the allowed "type" values.
// Longest first so the model sees the most specific options.
const GARMENT_TYPE_LIST = Object.keys(GARMENT_TYPES);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalize a free-text type (from GPT-4o vision or Shopify product_type/title)
 * to the controlled vocabulary. Returns null when nothing matches — matching
 * then falls back to pure embedding similarity with no type penalty.
 * @param {string|null|undefined} raw
 * @returns {string|null} canonical garment type or null
 */
function normalizeGarmentType(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.toLowerCase().trim();
  if (!text || text === 'other') return null;

  // Exact hits first
  if (GARMENT_TYPES[text]) return text;
  if (TYPE_ALIASES[text]) return TYPE_ALIASES[text];

  // Scan the string for the longest known type/alias, as a whole word
  // (with optional plural), so "Women's Tank Tops" -> "tank top" and
  // "Knitted Polo Tee" -> "polo shirt" (polo beats tee by length).
  const candidates = [...Object.keys(GARMENT_TYPES), ...Object.keys(TYPE_ALIASES)]
    .sort((a, b) => b.length - a.length);

  for (const key of candidates) {
    const re = new RegExp(`(^|[^a-z])${escapeRegex(key)}(s|es)?($|[^a-z])`, 'i');
    if (re.test(text)) {
      return GARMENT_TYPES[key] ? key : TYPE_ALIASES[key];
    }
  }
  return null;
}

// Soft penalties subtracted from cosine similarity during re-ranking.
// Soft (not a hard filter) so a vision mislabel can't zero out a great match.
const SAME_CATEGORY_PENALTY = parseFloat(process.env.IMAGE_MATCH_TYPE_PENALTY || '0.10');
const CROSS_CATEGORY_PENALTY = parseFloat(process.env.IMAGE_MATCH_CATEGORY_PENALTY || '0.30');

/**
 * Penalty to subtract from similarity when the query garment type and the
 * product garment type disagree.
 * @param {string|null} queryType - normalized type from the customer's image
 * @param {string|null} productType - normalized type stored on the product
 * @returns {number} 0 when equal or either side is unknown
 */
function garmentTypePenalty(queryType, productType) {
  if (!queryType || !productType) return 0; // can't judge → no penalty
  if (queryType === productType) return 0;
  const sameCategory = GARMENT_TYPES[queryType] === GARMENT_TYPES[productType];
  return sameCategory ? SAME_CATEGORY_PENALTY : CROSS_CATEGORY_PENALTY;
}

module.exports = {
  GARMENT_TYPES,
  GARMENT_TYPE_LIST,
  normalizeGarmentType,
  garmentTypePenalty,
};
