// testShopify.js — one-off manual test, not part of the server
require('dotenv').config();


console.log('URL:', process.env.SHOPIFY_STAGING_GRAPHQL_URL);
console.log('TOKEN (first 8 chars):', process.env.SHOPIFY_STAGING_TOKEN?.slice(0, 8));

const { pushPriceToShopify } = require('./src/services/shopifyService');

(async () => {
  try {
    const result = await pushPriceToShopify('TEST-SKU-001', 150);
    console.log('✅ Success:', result);
  } catch (err) {
    console.error('❌ Failed:', err.message);
  }
})();