# Krew Backend API

AI-powered Instagram DM automation platform with intelligent order-taking capabilities. Built with Express.js, OpenAI GPT-4, and Supabase.

## Features

### Core Capabilities
- 🤖 **AI-Powered Conversations** - Luna AI agent handles customer inquiries via Instagram DMs
- 📦 **Smart Order Taking** - Deterministic state machine for reliable order collection
- 🛍️ **Shopify Integration** - Automatic order creation in Shopify via Admin API
- 💬 **Multi-Language Support** - English, Arabic, and Franco Arabic
- 🔐 **JWT Authentication** - Secure API endpoints for brand management
- 📊 **Order Analytics** - Track orders, revenue, and statistics

### Technical Highlights
- **Deterministic State Machine** - Reliable order flow (name → phone → address → confirmation)
- **Input Validation** - Phone and address validation before saving
- **Metadata Persistence** - JSONB storage for order state across messages
- **Instagram Webhook** - Real-time message processing via Meta Graph API
- **Knowledge Base** - Vector-based product and FAQ management

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Express.js 4.21
- **AI**: OpenAI GPT-4o
- **Database**: Supabase (PostgreSQL + Auth + Storage)
- **Integrations**: Meta Graph API, Shopify Admin API 2024-01
- **Authentication**: JWT with bcrypt

## Project Structure

```
krew-backend/
├── routes/
│   ├── instagram.js      # Instagram webhook + order flow
│   ├── orders.js          # Order management API
│   ├── auth.js            # Login & brand authentication
│   ├── shopify.js         # Shopify webhook integration
│   ├── products.js        # Product catalog management
│   ├── knowledge-base.js  # Knowledge base CRUD
│   └── conversations.js   # Conversation history API
├── lib/
│   ├── claude.js          # OpenAI GPT-4 integration
│   ├── supabase.js        # Supabase client
│   └── instagram.js       # Instagram API helpers
├── middleware/
│   └── auth.js            # JWT verification middleware
├── server.js              # Express app entry point
└── package.json
```

## Installation

### Prerequisites
- Node.js 20 or higher
- Supabase account
- OpenAI API key
- Meta App with Instagram API access
- Shopify store (optional)

### Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd krew-backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

   Fill in the following variables:
   ```env
   # Server
   PORT=3000

   # Supabase
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

   # OpenAI
   OPENAI_API_KEY=sk-...

   # JWT
   JWT_SECRET=your-random-secret-key

   # Instagram (Meta Graph API)
   META_APP_SECRET=your-meta-app-secret
   META_VERIFY_TOKEN=your-webhook-verify-token
   ```

4. **Set up database**

   Run the SQL schemas in Supabase:
   ```bash
   # Execute in Supabase SQL Editor
   cat supabase-schema-simple.sql | # Copy & paste to Supabase
   cat add-order-tracking.sql      | # Add orders table
   ```

5. **Start the server**
   ```bash
   # Development mode (with auto-reload)
   npm run dev

   # Production mode
   npm start
   ```

## API Documentation

### Authentication

All protected routes require a JWT token in the `Authorization` header:
```
Authorization: Bearer <jwt-token>
```

Get a token by logging in:
```bash
POST /auth/login
Content-Type: application/json

{
  "email": "brand@example.com",
  "password": "your-password"
}
```

### Endpoints

#### Instagram Webhook
```bash
# Webhook verification (Meta requirement)
GET /instagram/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>

# Message processing (Instagram DMs)
POST /instagram/webhook
```

#### Orders
```bash
# Get all orders for authenticated brand
GET /orders
Authorization: Bearer <token>

# Get order statistics
GET /orders/stats
Authorization: Bearer <token>

Response:
{
  "total_orders": 42,
  "total_revenue": 12500.00,
  "pending_orders": 5,
  "completed_orders": 37
}
```

#### Products
```bash
# Get all products for brand
GET /products
Authorization: Bearer <token>

# Add new product
POST /products
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Premium T-Shirt",
  "description": "High quality cotton t-shirt",
  "price": 299.99,
  "currency": "EGP",
  "shopify_product_id": "7234567890",
  "in_stock": true,
  "image_url": "https://..."
}
```

#### Knowledge Base
```bash
# Get all knowledge base entries
GET /knowledge-base
Authorization: Bearer <token>

# Add knowledge base entry
POST /knowledge-base
Authorization: Bearer <token>
Content-Type: application/json

{
  "question": "What is your return policy?",
  "answer": "We offer 30-day returns...",
  "category": "policy"
}
```

#### Conversations
```bash
# Get all conversations for brand
GET /conversations
Authorization: Bearer <token>

# Get conversation by ID
GET /conversations/:id
Authorization: Bearer <token>

# Reset order metadata (testing)
POST /conversations/:id/reset-metadata
Authorization: Bearer <token>
```

## Order Flow

The order-taking system uses a **deterministic state machine** to reliably collect customer information:

### State Transitions

```
null → name → phone → address → confirmation → order_ready
```

### How It Works

1. **Customer initiates order** (e.g., "I want to buy the blue hoodie")
2. **Luna asks for name** → `awaiting = 'name'`
3. **Customer provides name** → Auto-saved, `awaiting = 'phone'`
4. **Luna asks for phone** → Input validated (must contain 5+ digits)
5. **Customer provides phone** → Auto-saved, `awaiting = 'address'`
6. **Luna asks for address** → Input validated (must be 10+ characters)
7. **Customer provides address** → Auto-saved, `awaiting = 'confirmation'`
8. **Luna shows order summary** → "Do you want to confirm this order?"
9. **Customer confirms** → Order placed in Shopify + saved to database

### Validation Rules

| Field | Validation | Example Valid | Example Invalid |
|-------|-----------|---------------|-----------------|
| **Phone** | Must contain 5+ digits | `+20 123 456 7890` | `no thanks` |
| **Address** | Must be 10+ characters | `123 Main St, Cairo` | `Street 5` |
| **Name** | Any non-empty string | `Ahmed Hassan` | *(empty)* |

### Metadata Structure

```json
{
  "discussed_products": [
    {"name": "Blue Hoodie", "price": "499 EGP"}
  ],
  "current_order": {
    "product_name": "Blue Hoodie",
    "price": "499",
    "currency": "EGP"
  },
  "collected_info": {
    "name": "Ahmed Hassan",
    "phone": "+20 123 456 7890",
    "address": "123 Main St, Cairo"
  },
  "awaiting": "confirmation"
}
```

## Shopify Integration

When a customer confirms an order:

1. **Fetch Shopify credentials** from `integrations` table
2. **Create order** via Shopify Admin API 2024-01:
   ```javascript
   POST https://{shop}/admin/api/2024-01/orders.json
   X-Shopify-Access-Token: {access_token}

   {
     "order": {
       "line_items": [{"title": "...", "quantity": 1, "price": "..."}],
       "customer": {"first_name": "..."},
       "shipping_address": {...},
       "phone": "...",
       "financial_status": "pending"
     }
   }
   ```
3. **Save to database** (`orders` table) with Shopify order ID
4. **Send confirmation** to customer via Instagram DM

If Shopify integration is not configured, the order is still saved locally and a message is sent to the customer.

## Logging

The application uses simplified, emoji-based logging for easy monitoring:

```
📨 [sender_id]: "message content"
🔍 Brand found: [brand_id]
💾 Metadata: {"awaiting":"phone",...}
🤖 Luna reply: "What's your phone number?"
✅ Sent to [sender_id]
❌ Error: [error_message]
🎉 Order confirmed! Creating Shopify order...
```

## Database Schema

### Tables

- **brands** - Brand accounts with authentication
- **conversations** - Customer conversations with metadata (JSONB)
- **messages** - Message history (customer + AI)
- **products** - Product catalog per brand
- **knowledge_base** - FAQs and custom knowledge
- **integrations** - Shopify & Instagram credentials
- **orders** - Order records with Shopify IDs

See [supabase-schema-simple.sql](supabase-schema-simple.sql) and [add-order-tracking.sql](add-order-tracking.sql) for full schema.

## Development

### Run in Development Mode
```bash
npm run dev
```

### Environment Variables
See [.env.example](.env.example) for all required variables.

### Testing Instagram Webhook

1. Use ngrok to expose local server:
   ```bash
   ngrok http 3000
   ```

2. Configure webhook in Meta Developer Console:
   - Callback URL: `https://your-ngrok-url.ngrok.io/instagram/webhook`
   - Verify Token: (same as `META_VERIFY_TOKEN` in `.env`)
   - Subscribe to: `messages`, `messaging_postbacks`

3. Test with Instagram DMs to your connected page

## Documentation

- [LOGGING_SIMPLIFIED.md](LOGGING_SIMPLIFIED.md) - Logging cleanup guide
- [STATE_MACHINE_FIXED.md](STATE_MACHINE_FIXED.md) - State machine implementation
- [STATE_MACHINE_VALIDATION.md](STATE_MACHINE_VALIDATION.md) - Validation & guards
- [CONFIRMATION_FIXED.md](CONFIRMATION_FIXED.md) - Confirmation flow details
- [SHOPIFY_ORDER_COMPLETE.md](SHOPIFY_ORDER_COMPLETE.md) - Shopify integration guide
- [ORDERS_API.md](ORDERS_API.md) - Orders API documentation
- [ORDER_TAKING_GUIDE.md](ORDER_TAKING_GUIDE.md) - Complete order-taking guide

## Deployment

### Railway (Recommended)

1. Install Railway CLI:
   ```bash
   npm install -g @railway/cli
   ```

2. Login and deploy:
   ```bash
   railway login
   railway init
   railway up
   ```

3. Add environment variables in Railway dashboard

Configuration files are already included:
- [railway.json](railway.json)
- [railway.toml](railway.toml)

### Manual Deployment

1. Set environment variables on your hosting platform
2. Ensure Node.js 20+ is available
3. Run `npm install` and `npm start`

## Security

- ✅ JWT authentication for all protected routes
- ✅ Password hashing with bcrypt
- ✅ Instagram webhook signature verification
- ✅ Environment variable configuration
- ✅ Input validation and sanitation
- ✅ Supabase Row Level Security (RLS)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

ISC

## Support

For issues or questions, please open an issue in the GitHub repository.

---

**Built with ❤️ using Claude Code**
