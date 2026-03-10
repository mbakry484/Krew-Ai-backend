# Knowledge Base API Documentation

## Overview

The Knowledge Base API allows brands to manage FAQ entries that Luna uses to respond to customer inquiries on Instagram and WhatsApp. The API provides full CRUD operations with JWT authentication and per-brand data isolation.

## Base URL

```
https://krew-ai-backend-production.up.railway.app/knowledge-base
```

## Authentication

All endpoints require a valid JWT token in the `Authorization` header:

```
Authorization: Bearer <JWT_TOKEN>
```

The token is obtained via the login endpoint at `/auth/login`.

## Endpoints

### 1. GET /knowledge-base

Retrieve the knowledge base FAQs for the authenticated user's brand.

**Method**: GET

**Authentication**: Required

**Headers**:
```
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

**Query Parameters**: None

**Request Body**: None

**Response** (200 OK):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "brand_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "faqs": [
    {
      "question": "What is your return policy?",
      "answer": "We accept returns within 30 days of purchase..."
    },
    {
      "question": "How long does shipping take?",
      "answer": "Standard shipping takes 5-7 business days..."
    }
  ]
}
```

**Response** (200 OK - No KB exists):
```json
{
  "faqs": []
}
```

**Error Responses**:
- `404 Not Found`: User not found in database
- `500 Internal Server Error`: Database query failed

**Example cURL**:
```bash
curl -X GET https://krew-ai-backend-production.up.railway.app/knowledge-base \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

### 2. POST /knowledge-base

Create a new knowledge base or update an existing one for the authenticated user's brand.

**Method**: POST

**Authentication**: Required

**Headers**:
```
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

**Request Body**:
```json
{
  "faqs": [
    {
      "question": "What is your return policy?",
      "answer": "We accept returns within 30 days of purchase with original receipt."
    },
    {
      "question": "Do you offer international shipping?",
      "answer": "Yes, we ship to all countries. International shipping takes 10-14 business days."
    }
  ]
}
```

**Validation Rules**:
- `faqs` must be an array
- Each FAQ must have a `question` property (non-empty string)
- Each FAQ must have an `answer` property (non-empty string)

**Response** (200 OK):
```json
{
  "message": "Knowledge base saved successfully",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "brand_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "faqs": [
    {
      "question": "What is your return policy?",
      "answer": "We accept returns within 30 days of purchase with original receipt."
    },
    {
      "question": "Do you offer international shipping?",
      "answer": "Yes, we ship to all countries. International shipping takes 10-14 business days."
    }
  ]
}
```

**Error Responses**:
- `400 Bad Request`: Invalid request body
  ```json
  { "error": "faqs must be an array" }
  ```
- `400 Bad Request`: Missing question or answer
  ```json
  { "error": "Each FAQ must have a question string" }
  ```
- `404 Not Found`: User not found
- `500 Internal Server Error`: Database operation failed

**Behavior**:
- If knowledge base exists: Updates the FAQs
- If knowledge base doesn't exist: Creates a new one
- Updates the `updated_at` timestamp

**Example cURL**:
```bash
curl -X POST https://krew-ai-backend-production.up.railway.app/knowledge-base \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{
    "faqs": [
      {"question": "What is your return policy?", "answer": "30 days."},
      {"question": "How long does shipping take?", "answer": "5-7 days."}
    ]
  }'
```

---

### 3. DELETE /knowledge-base/:index

Delete a specific FAQ item by its array index.

**Method**: DELETE

**Authentication**: Required

**Headers**:
```
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

**URL Parameters**:
- `index` (number): Zero-based index of the FAQ to delete

**Request Body**: None

**Response** (200 OK):
```json
{
  "message": "FAQ deleted successfully",
  "faqs": [
    {
      "question": "How long does shipping take?",
      "answer": "Standard shipping takes 5-7 business days..."
    }
  ]
}
```

**Error Responses**:
- `400 Bad Request`: Invalid index
  ```json
  { "error": "Invalid FAQ index" }
  ```
- `400 Bad Request`: Index out of range
  ```json
  { "error": "FAQ index out of range" }
  ```
- `404 Not Found`: Knowledge base not found
- `500 Internal Server Error`: Database operation failed

**Example cURL**:
```bash
curl -X DELETE https://krew-ai-backend-production.up.railway.app/knowledge-base/0 \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## Data Model

### Knowledge Base Record

```typescript
{
  id: string;              // UUID primary key
  brand_id: string;        // Foreign key to brands table
  brand_name: string;      // Stored copy of business name
  tone: string | null;     // (Optional) Luna's response tone
  guidelines: string | null; // (Optional) Response guidelines
  faqs: FAQ[];            // Array of FAQ objects
  created_at: datetime;   // Creation timestamp
  updated_at: datetime;   // Last update timestamp
}
```

### FAQ Object

```typescript
{
  question: string;       // The customer question
  answer: string;         // Luna's response
}
```

## Usage Examples

### Complete Example: User Onboarding Flow

```javascript
// 1. User logs in
const loginResponse = await fetch('https://krew-ai-backend-production.up.railway.app/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'brand@example.com',
    password: 'securePassword123'
  })
});

const { token } = await loginResponse.json();
const authHeader = `Bearer ${token}`;

// 2. Check if knowledge base exists
const getKbResponse = await fetch('https://krew-ai-backend-production.up.railway.app/knowledge-base', {
  method: 'GET',
  headers: { 'Authorization': authHeader }
});

const kbData = await getKbResponse.json();
console.log('Current FAQs:', kbData.faqs); // Empty array if new user

// 3. User adds initial FAQs
const saveKbResponse = await fetch('https://krew-ai-backend-production.up.railway.app/knowledge-base', {
  method: 'POST',
  headers: {
    'Authorization': authHeader,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    faqs: [
      {
        question: 'What is your return policy?',
        answer: 'We accept returns within 30 days of purchase with original receipt.'
      },
      {
        question: 'Do you ship internationally?',
        answer: 'Yes, we ship to over 100 countries with standard delivery taking 10-14 days.'
      }
    ]
  })
});

const savedData = await saveKbResponse.json();
console.log('Saved FAQs:', savedData.faqs);

// 4. Later, user wants to delete first FAQ
const deleteFaqResponse = await fetch('https://krew-ai-backend-production.up.railway.app/knowledge-base/0', {
  method: 'DELETE',
  headers: { 'Authorization': authHeader }
});

const updatedData = await deleteFaqResponse.json();
console.log('Remaining FAQs:', updatedData.faqs);
```

## Best Practices

### For Frontend Developers

1. **Always Include Authorization Header**
   ```typescript
   const headers = {
     'Authorization': `Bearer ${token}`,
     'Content-Type': 'application/json'
   };
   ```

2. **Validate Input Before Sending**
   ```typescript
   const validateFaq = (faq) => {
     return faq.question?.trim().length > 0 &&
            faq.answer?.trim().length > 0;
   };
   ```

3. **Handle Empty Knowledge Base**
   ```typescript
   const response = await getKnowledgeBase();
   const faqs = response.faqs || []; // Default to empty array
   ```

4. **Implement Optimistic UI Updates**
   - Update UI immediately with changes
   - Send to server in background
   - Revert on error with user notification

5. **Add Error Boundaries**
   ```typescript
   try {
     await saveKnowledgeBase(faqs);
     showSuccessMessage();
   } catch (error) {
     showErrorMessage(error.message);
     // Revert UI changes
   }
   ```

### For Backend Developers

1. **Index User Queries**
   ```sql
   CREATE INDEX idx_knowledge_base_brand_id ON knowledge_base(brand_id);
   CREATE INDEX idx_users_brand_id ON users(brand_id);
   ```

2. **Validate Token Before DB Query**
   - Middleware checks token validity
   - Extract user_id from decoded token
   - Only return data for that user's brand

3. **Log Operations for Audit Trail**
   ```javascript
   console.log(`User ${userId} updated KB for brand ${brandId}`);
   ```

4. **Monitor FAQ Size**
   - Large JSONB arrays can impact performance
   - Consider pagination if needed in future
   - Monitor database growth

## Limitations

### Current

- JSONB array has no explicit size limit (depends on database configuration)
- No soft delete - deletion is permanent
- No versioning/history of changes
- No bulk operations (must update entire FAQ list)

### Recommended Future Additions

- FAQ categories/tagging
- Search/filter endpoints
- Bulk import from CSV
- FAQ usage analytics
- A/B testing different answers
- Multi-language support
- Version history with rollback

## Performance Considerations

### Response Times (Typical)

- GET /knowledge-base: ~50-100ms
- POST /knowledge-base (create): ~100-150ms
- POST /knowledge-base (update): ~50-100ms
- DELETE /knowledge-base/:index: ~50-100ms

### Database Queries

Each endpoint performs:
- 1-2 SELECT queries (user lookup, KB query)
- 0-1 INSERT/UPDATE/DELETE query

### Scaling

- Database indexes on `brand_id` ensure O(1) lookups
- JSONB storage efficient for FAQ arrays up to ~10,000 items
- Connection pooling handles concurrent requests

## Troubleshooting

### Common Issues

**Issue: 401 Unauthorized**
- Solution: Verify token is valid and not expired
- Check token is included in Authorization header
- Token format must be: `Bearer <token>`

**Issue: 404 User not found**
- Solution: Ensure user exists in database
- Check user_id in token matches database record
- May occur if user was deleted between login and API call

**Issue: Empty faqs array after save**
- Solution: Verify FAQs were included in request body
- Check for validation errors in response
- Ensure request body has `faqs` field (not `items`)

**Issue: Previous FAQs disappear after save**
- Solution: This is expected - POST replaces entire FAQ list
- Frontend must fetch latest before showing
- Implement optimistic updates to avoid this perception

## Support

For questions or issues with the Knowledge Base API:
1. Check this documentation
2. Review error messages in response
3. Check server logs on backend
4. Contact backend team with request/response logs

---

**Last Updated**: March 10, 2025
**Status**: Production Ready
**Version**: 1.0.0
