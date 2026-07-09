// src/services/shopifyService.js
const axios = require('axios');

const SHOPIFY_STORE_URL     = process.env.shopify_store_url;      // e.g. tpstech.myshopify.com — used for OAuth token exchange
const SHOPIFY_GRAPHQL_URL   = process.env.Shopify_graph_URL;      // full graphql.json endpoint
const SHOPIFY_CLIENT_ID     = process.env.shopify_prod_clientid;
const SHOPIFY_CLIENT_SECRET = process.env.shopify_prod_secret;

const TOKEN_MAX_AGE_MS = 20 * 60 * 60 * 1000; // hard refresh every 20h regardless of Shopify's expires_in (UTC vs IST safety)

let cachedToken = null;
let tokenFetchedAt = 0;

// ── Get (or refresh) the OAuth access token ───────────────────
async function getAccessToken() {
  if (cachedToken && (Date.now() - tokenFetchedAt) < TOKEN_MAX_AGE_MS) {
    return cachedToken;
  }

  try {
    const params = new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    });

    const response = await axios.post(
      `https://${SHOPIFY_STORE_URL}/admin/oauth/access_token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    cachedToken = response.data.access_token;
    tokenFetchedAt = Date.now();
    return cachedToken;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Token exchange failed: ${detail}`);
  }
}

// ── Generic GraphQL call helper ───────────────────────────────
async function shopifyGraphQL(query, variables) {
  const accessToken = await getAccessToken();
  try {
    const response = await axios.post(
      SHOPIFY_GRAPHQL_URL,
      { query, variables },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken } }
    );
    if (response.data.errors) {
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(response.data.errors)}`);
    }
    return response.data.data;
  } catch (err) {
    if (err.response?.data) {
      throw new Error(`Shopify request failed: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// ── Step 1: look up variant + product ID by SKU (with duplicate-safety) ──
async function getShopifyVariantBySku(sku) {
  const query = `
    query getVariantBySku($query: String!) {
      productVariants(first: 5, query: $query) {
        edges { node { id price sku product { id } } }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { query: `sku:${sku}` });
  const matches = data.productVariants.edges.filter(e => e.node.sku === sku); // exact match only

  if (matches.length === 0) throw new Error(`No Shopify variant found for SKU: ${sku}`);
  if (matches.length > 1) throw new Error(`Ambiguous SKU: ${sku} matched ${matches.length} variants — refusing to guess`);

  const node = matches[0].node;
  return { variantId: node.id, productId: node.product.id };
}

// ── Step 2: update the price ──────────────────────────────────
async function updateVariantPrice(productId, variantId, price) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, {
    productId,
    variants: [{ id: variantId, price: String(price) }],
  });
  const errors = data.productVariantsBulkUpdate.userErrors;
  if (errors?.length) throw new Error(`Shopify userErrors: ${JSON.stringify(errors)}`);
  return data.productVariantsBulkUpdate.productVariants[0];
}

async function pushPriceToShopify(skuId, price) {
  const { variantId, productId } = await getShopifyVariantBySku(skuId);
  const updated = await updateVariantPrice(productId, variantId, price);
  return { variantId, productId, price: updated.price };
}

module.exports = { pushPriceToShopify };















/*

Did we already do the "2 API calls" thing?
Yes — you already built exactly what Krishna described. Look at the code from before:

Call 1 = getShopifyVariantBySku(sku) — looks up the product by SKU, gets back the variantId + productId.
Call 2 = updateVariantPrice(productId, variantId, price) — the actual productVariantsBulkUpdate mutation that changes the price.

That matches his "first API retrieves product details via SKU, second API updates the price" description exactly.
The variance check is a different thing entirely — that's not a Shopify API call at all. It's your own SQL check (comparing the entered price against RecommendedSP in your own database) that happens before you even talk to Shopify.
"2 API calls" comment was purely about the Shopify integration; the variance check is a safety feature you added on your side, unrelated to that count.
So you're not missing a call — you just have three separate steps total: 
  (1) variance check against your DB, 
  (2) SKU lookup on Shopify, 
  (3) price mutation on Shopify.

*/