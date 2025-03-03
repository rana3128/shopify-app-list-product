require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const cron = require('node-cron');
const mongoose = require('mongoose');

// For Node 18+ fetch is global; if not, you can import node-fetch
// const fetch = require('node-fetch');

// ------------------
// MongoDB Setup
// ------------------
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error", err));

const storeSchema = new mongoose.Schema({
  shop: { type: String, unique: true, required: true },
  accessToken: { type: String, required: true },
  installedAt: { type: Date, default: Date.now },
});
const productSchema = new mongoose.Schema({
  shop: { type: String, required: true },
  productId: { type: Number, required: true },
  title: String,
  body_html: String,
  // Add additional fields as needed
}, { timestamps: true });

// Create a text index for searching by title and body_html.
productSchema.index({ shop: 1, title: 'text', body_html: 'text' });

const Store = mongoose.model('Store', storeSchema);
const Product = mongoose.model('Product', productSchema);

// ------------------
// Express App Setup
// ------------------
const app = express();
app.use(express.json());

// Setup express-session (for OAuth state management)
app.use(session({
  secret: process.env.SHOPIFY_API_SECRET,
  resave: false,
  saveUninitialized: true,
}));

// ------------------
// Helper Functions
// ------------------

/**
 * Fetch products from Shopify using the given shop and accessToken,
 * then upsert them into MongoDB.
 */
async function fetchAndSaveProducts(shop, accessToken) {
  try {
    // Shopify REST API endpoint to fetch products (adjust API version as needed)
    const productsUrl = `https://${shop}/admin/api/2023-07/products.json?limit=250`;
    const response = await fetch(productsUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });
    const data = await response.json();
    const products = data.products || [];
    console.log(`[${new Date().toISOString()}] Fetched ${products.length} products from ${shop}`);

    // Upsert each product (if exists, update; if not, create)
    for (const prod of products) {
      await Product.findOneAndUpdate(
        { shop, productId: prod.id },
        {
          shop,
          productId: prod.id,
          title: prod.title,
          body_html: prod.body_html,
        },
        { upsert: true, new: true }
      );
    }
  } catch (error) {
    console.error(`Error fetching products for ${shop}:`, error);
  }
}

// ------------------
// Routes
// ------------------

/**
 * GET /auth
 * Initiates the Shopify OAuth process.
 * Generates a random state, stores it in session, and redirects the browser to Shopify's OAuth URL.
 */
app.get('/auth', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter.');
  
  // Generate a random state value and store in session
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const redirectUri = `${process.env.HOST}/auth/callback`;
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}` +
    `&scope=${encodeURIComponent(process.env.SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  console.log(`Redirecting to Shopify OAuth URL: ${authUrl}`);
  res.redirect(authUrl);
});

/**
 * GET /auth/callback
 * Handles Shopify's OAuth callback.
 * Verifies the state, exchanges the temporary code for an access token,
 * and saves the store information into MongoDB. Then fetches and saves products.
 */
app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;
  if (state !== req.session.oauthState) {
    return res.status(400).send('Invalid state parameter.');
  }
  
  // Exchange code for access token
  const tokenRequestUrl = `https://${shop}/admin/oauth/access_token`;
  const tokenPayload = {
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET,
    code,
  };

  try {
    const tokenResponse = await fetch(tokenRequestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenPayload),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      return res.status(400).send('Failed to retrieve access token.');
    }
    // Upsert the store info in MongoDB
    const store = await Store.findOneAndUpdate(
      { shop },
      { accessToken: tokenData.access_token },
      { upsert: true, new: true }
    );
    console.log(`Store ${shop} installed/updated successfully.`);

    // Fetch and save products for this store
    await fetchAndSaveProducts(shop, tokenData.access_token);

    res.redirect(`/?shop=${shop}`);
  } catch (error) {
    console.error('Error during OAuth callback:', error);
    res.status(500).send('Authentication failed.');
  }
});

/**
 * GET /
 * Home page that shows the number of products for the shop (if provided)
 * or a welcome message.
 */
app.get('/', async (req, res) => {
  const { shop } = req.query;
  if (shop) {
    const count = await Product.countDocuments({ shop });
    res.send(`
      <h1>Shopify Search App</h1>
      <p>Store: ${shop}</p>
      <p>Products in DB: ${count}</p>
      <p>To search, try: <code>/search?shop=${shop}&q=YourQuery</code></p>
    `);
  } else {
    res.send(`
      <h1>Welcome to the Shopify Search App</h1>
      <p>Please install the app by visiting: <code>/auth?shop=your-shop-name.myshopify.com</code></p>
    `);
  }
});

/**
 * GET /search
 * Searches for products for a specific shop.
 * Query parameters:
 *  - shop: the store domain
 *  - q: the search query string (searches title and body_html)
 */
app.get('/search', async (req, res) => {
  const { shop, q } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter.');
  if (!q) return res.status(400).send('Missing query parameter (q).');

  // Perform a text search on products for the given shop
  const results = await Product.find({ 
    shop, 
    title: { $regex: q, $options: 'i' }
  });
  
  res.json({
    shop,
    query: q,
    count: results.length,
    products: results,
  });
});

// ------------------
// Cron Job for Periodic Ingestion
// ------------------
/**
 * Every 5 minutes, iterate over all installed stores and refresh their products.
 */
cron.schedule('*/5 * * * *', async () => {
  const stores = await Store.find({});
  if (!stores.length) {
    console.log('No installed stores found for scheduled ingestion.');
    return;
  }
  console.log('Running scheduled product ingestion for all stores...');
  for (const store of stores) {
    await fetchAndSaveProducts(store.shop, store.accessToken);
  }
});

// ------------------
// Start the Server
// ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
  console.log(`Visit ${process.env.HOST}/auth?shop=your-shop-name.myshopify.com to install the app`);
});
