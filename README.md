# Shopify Product Search App

A sample Shopify app that demonstrates how to:

- Authenticate Shopify stores using OAuth.
- Ingest products from each installed store.
- Persist store and product data in MongoDB - cron job run after each 5 min.
- Provide a search API to query products by store and keyword.

> **Note:** oAuth doesn't work on localhost so you need and live redirect url here i am using https://ngrok.com/docs 
---

## Use Case

This app is designed for a centralized product search experience across multiple Shopify stores. When a merchant installs the app:

- The app completes the OAuth process with Shopify.
- It retrieves and stores the store's access token in MongoDB.
- It fetches the store's products and saves them into MongoDB.
- It exposes a search API endpoint so you can search for products by store and keyword.

---

## Setup

### Prerequisites

- **Node.js** (v18 or later recommended)
- **MongoDB** (local or cloud instance)
- A Shopify Partner account with a configured app and allowed redirect URI

### Installation Steps

1. **Create a .env File**

   Create a `.env` file in the project root with the following content:

   ```env
   SHOPIFY_API_KEY=your_api_key
   SHOPIFY_API_SECRET=your_api_secret
   SCOPES=read_products,write_products
   HOST=https://your-ngrok-domain.ngrok-free.app
   MONGODB_URI=mongodb://localhost:27017/shopify-app
   ```

   - Replace `your_api_key` and `your_api_secret` with your Shopify app credentials.
   - Ensure that `HOST` exactly matches the allowed redirect URI in your Shopify Partner Dashboard.
   - Update `MONGODB_URI` with your MongoDB connection string.

2. **Install Dependencies**

   ```bash
   npm install
   ```

3. **Start the Application**

   ```bash
   node server.js
   ```

6. **Configure Your Shopify App**

   In your Shopify Partner Dashboard, whitelist the redirect URI:

   ```
   https://your-ngrok-domain.ngrok-free.app/auth/callback
   ```

---

## How to Use It

### 1. Install the App
Mannually search app in store and click on install or 

Open your browser and navigate to: 

```plaintext
https://your-ngrok-domain.ngrok-free.app/auth?shop=your-shop-name.myshopify.com
```

- Complete the Shopify OAuth process.
- Once authenticated, the app exchanges the code for an access token, saves the store info in MongoDB, and ingests its products.

### 2. Product Ingestion

- The app immediately ingests products after installation.
- A scheduled cron job runs every 5 minutes to refresh product data for all installed stores.

### 3. Search Products

You can search for products by visiting the search endpoint:

```plaintext
https://your-ngrok-domain.ngrok-free.app/search?shop=your-shop-name.myshopify.com&q=YourSearchQuery
```

- Replace `your-shop-name.myshopify.com` with the store domain.
- Replace `YourSearchQuery` with the term you want to search in product titles or descriptions.

### 4. Home Page

Navigating to:

```plaintext
https://your-ngrok-domain.ngrok-free.app/?shop=your-shop-name.myshopify.com
```

displays the number of products ingested for that store and search instructions.

---

## Endpoints Overview

### `GET /auth`

- Initiates the OAuth process.
- Generates a random state value, stores it in the session, and redirects the browser to Shopify's OAuth URL.

### `GET /auth/callback`

- Handles Shopify's OAuth callback.
- Validates the state, exchanges the code for an access token, upserts the store info in MongoDB, and ingests products.

### `GET /`

- Displays a homepage showing the product count for the given store and search instructions.

### `GET /search`

- Accepts `shop` and `q` (query) parameters to perform a text search on stored products using MongoDB’s text search.

---

## Cron Job

- Every 5 minutes, a cron job updates product data for all installed stores.

---

## Final Notes

### **Session Management**

- This demo uses `express-session` for managing OAuth state.
- For production, consider using a persistent session store.

### **Data Persistence**

- Store data in MongoDB using Mongoose.
- The product schema includes a text index for searching on `title` and `body_html`.

### **Environment Consistency**

- Ensure your app's `HOST` and allowed redirect URIs are consistent across your Shopify Partner Dashboard and your environment variables.

