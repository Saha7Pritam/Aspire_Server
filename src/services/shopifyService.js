// src/services/shopifyService.js
const axios = require('axios');

const SHOPIFY_GRAPHQL_URL   = process.env.SHOPIFY_STAGING_GRAPHQL_URL;
const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_STAGING_TOKEN;

async function shopifyGraphQL(query, variables) {
  const response = await axios.post(
    SHOPIFY_GRAPHQL_URL,
    { query, variables },
    { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
  );
  if (response.data.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(response.data.errors)}`);
  }
  return response.data.data;
}

// Step 1: look up variant + product ID by SKU
async function getShopifyVariantBySku(sku) {
  const query = `
    query getVariantBySku($query: String!) {
      productVariants(first: 1, query: $query) {
        edges { node { id price product { id } } }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { query: `sku:${sku}` });
  const edge = data.productVariants.edges[0];
  if (!edge) throw new Error(`No Shopify variant found for SKU: ${sku}`);
  return { variantId: edge.node.id, productId: edge.node.product.id };
}

// Step 2: update the price
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