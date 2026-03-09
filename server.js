const express = require('express');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const instagramRoutes = require('./routes/instagram');
const shopifyRoutes = require('./routes/shopify');
const productsRoutes = require('./routes/products');
const knowledgeBaseRoutes = require('./routes/knowledge-base');
const conversationsRoutes = require('./routes/conversations');
const aiRoutes = require('./routes/ai');

const app = express();

// Middleware
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Krew Backend API' });
});

// Routes
app.use('/auth', authRoutes);
app.use('/webhook/instagram', instagramRoutes);
app.use('/webhook/shopify', shopifyRoutes);
app.use('/products', productsRoutes);
app.use('/knowledge-base', knowledgeBaseRoutes);
app.use('/conversations', conversationsRoutes);
app.use('/ai', aiRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Krew Backend API listening on port ${PORT}`);
});
