require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const cron = require('node-cron');
const mongoose = require('mongoose');


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
}, { timestamps: true });

productSchema.index({ shop: 1, title: 'text', body_html: 'text' });

const Store = mongoose.model('Store', storeSchema);
const Product = mongoose.model('Product', productSchema);


const app = express();
app.use(express.json());

// Setup express-session (for OAuth state management)
app.use(session({
  secret: process.env.SHOPIFY_API_SECRET,
  resave: false,
  saveUninitialized: true,
}));


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

app.get('/auth', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter.');
  
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


app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;
  if (state !== req.session.oauthState) {
    return res.status(400).send('Invalid state parameter.');
  }
  
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

    await fetchAndSaveProducts(shop, tokenData.access_token);

    res.redirect(`/?shop=${shop}`);
  } catch (error) {
    console.error('Error during OAuth callback:', error);
    res.status(500).send('Authentication failed.');
  }
});

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


app.get('/search', async (req, res) => {
  const { shop, q } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter.');
  if (!q) return res.status(400).send('Missing query parameter (q).');

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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
  console.log(`Visit ${process.env.HOST}/auth?shop=your-shop-name.myshopify.com to install the app`);
});
