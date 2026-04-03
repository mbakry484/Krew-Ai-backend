// Load environment variables first, before any other modules
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const instagramRoutes = require('./routes/instagram');
const shopifyRoutes = require('./routes/shopify');
const productsRoutes = require('./routes/products');
const knowledgeBaseRoutes = require('./routes/knowledge-base');
const conversationsRoutes = require('./routes/conversations');
const aiRoutes = require('./routes/ai');
const integrationsRoutes = require('./routes/integrations');
const ordersRoutes = require('./routes/orders');
const escalationsRoutes = require('./routes/escalations');
const refundsRoutes = require('./routes/refunds');
const exchangesRoutes = require('./routes/exchanges');
const exchangesRefundsRoutes = require('./routes/exchanges-refunds');
const metaTokenRoutes = require('./routes/meta-token');
const { startTokenRefreshCron } = require('./cron/tokenRefresh');

const app = express();

// Parse ALLOWED_ORIGINS from environment variable
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(origin => origin.trim());

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }

    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow any localhost origin (for development)
    const localhostPattern = /^http:\/\/localhost:\d+$/;
    const localhostIPPattern = /^http:\/\/127\.0\.0\.1:\d+$/;
    if (localhostPattern.test(origin) || localhostIPPattern.test(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Krew Backend API' });
});

// Routes
app.use('/auth', authRoutes);
app.use('/webhook/instagram', instagramRoutes);
app.use('/webhook/shopify', shopifyRoutes);
app.use('/products', shopifyRoutes); // Mount shopify routes at /products for /products/sync endpoint
app.use('/products', productsRoutes); // Mount products routes for /products/generate-embeddings and other product endpoints
app.use('/knowledge-base', knowledgeBaseRoutes);
app.use('/conversations', conversationsRoutes);
app.use('/ai', aiRoutes);
app.use('/integrations', integrationsRoutes);
app.use('/orders', ordersRoutes);
app.use('/escalations', escalationsRoutes);
app.use('/refunds', refundsRoutes);
app.use('/exchanges', exchangesRoutes);
app.use('/exchanges-refunds', exchangesRefundsRoutes);
app.use('/api/meta', metaTokenRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Krew Backend API listening on port ${PORT}`);

  // Start daily token refresh cron job
  startTokenRefreshCron();
});
