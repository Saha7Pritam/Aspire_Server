// src/parsers/fgtech.js

const cheerio = require('cheerio');

function clean(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/* =========================================================
   LISTING PAGE
========================================================= */

function parseProductLinks(html) {
  const $ = cheerio.load(html);

  const links = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');

    if (
      href &&
      href.includes('/product/') &&
      !href.includes('/product-category/')
    ) {
      links.add(href.split('?')[0]);
    }
  });

  console.log(
    '\n[FGTECH] Product URLs Found:',
    links.size
  );

  console.log(
    [...links].slice(0, 20)
  );

  return [...links];
}

/* =========================================================
   PAGINATION
========================================================= */

function getNextPageUrl(html) {
  const $ = cheerio.load(html);

  return (
    $('a.next.page-numbers').attr('href') ||
    $('link[rel="next"]').attr('href') ||
    null
  );
}

/* =========================================================
   PRODUCT PAGE
========================================================= */

function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  const pageText = $.html();

  const name =
    clean($('.product_title').first().text()) ||
    clean($('h1').first().text()) ||
    null;

  const salePrice =
    clean(
      $('p.price ins .woocommerce-Price-amount')
        .first()
        .text()
    ) ||
    clean(
      $('p.price .woocommerce-Price-amount')
        .first()
        .text()
    ) ||
    null;

  const originalPrice =
    clean(
      $('p.price del .woocommerce-Price-amount')
        .first()
        .text()
    ) ||
    null;

  let brand = null;

  const brandMatch =
    pageText.match(
      /"name":"pa_brand","value":"([^"]+)"/i
    );

  if (brandMatch) {
    brand = clean(brandMatch[1]);
  }

  let sku = null;

  const modelMatch =
    pageText.match(
      /"name":"pa_model","value":"([^"]+)"/i
    );

  if (modelMatch) {
    sku = clean(modelMatch[1]);
  }

  if (!sku) {
    const skuMatch =
      pageText.match(
        /"sku":"([^"]+)"/i
      );

    if (skuMatch) {
      sku = clean(skuMatch[1]);
    }
  }

  let stockStatus = 'In Stock';

  if (
    /out[\s-]*of[\s-]*stock/i.test(pageText)
  ) {
    stockStatus = 'Out of Stock';
  }

  const shortDescription =
    clean(
      $('meta[name="description"]').attr(
        'content'
      )
    ) ||
    clean(
      $('meta[property="og:description"]').attr(
        'content'
      )
    ) ||
    '';

  const tags = [];

  $('.tagged_as a').each((_, el) => {
    const tag = clean($(el).text());

    if (tag) {
      tags.push(tag);
    }
  });

  return {
    url,

    store: 'fgtech',

    name,

    sku,
    model: sku,
    modelNumber: sku,
    productCode: sku,

    brand,

    category: 'RAM',

    stockStatus,

    salePrice,
    originalPrice,

    shortDescription,

    tags,

    images: [],

    specs: {},

    scrapedAt: new Date().toISOString(),

    scrapedVia: 'web_unlocker',
  };
}

module.exports = {
  parseProductLinks,
  getNextPageUrl,
  parseProductDetails,
};