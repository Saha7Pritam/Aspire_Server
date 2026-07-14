// src/internal_db_sync.js
// CHANGE: TVP + MERGE now includes LastBillDate column.
// ManualPP_UpdatedAt / ManualPP_UpdatedBy are NEVER touched here —
// those are owned exclusively by the manual PP update API.
//
// NEW:
//   - syncInternalProducts() is now exported (was previously only
//     ever self-invoked). It NO LONGER calls process.exit() itself —
//     that only happens in the require.main guard at the bottom, so
//     it's safe to `require()` this file from api_server.js or an
//     Azure Function without risking a crash of the whole process.
//   - syncCategoryFlags(category) — targeted isActive/isInStock-only
//     sync for one category, used by the on-demand category-filter
//     sync from the UI. Deliberately does NOT use a TVP (that would
//     require a new SQL Server table type + a DB migration) — it
//     batches parameterized UPDATE statements in one round trip
//     instead, which is plenty for category-sized row counts.

require('dotenv/config');
const sql = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');
const { connectWithRetry } = require('./utils/connectWithRetry');
const {
  fetchCombinedData,
  fetchShopifyFlagsByCategory,
  sanitizeSKU,
  clearTokenTimers,
} = require('./services/azureSqlService.js');

// ─────────────────────────────────────────────────────────────
async function getTargetPool() {
  const credential = process.env.AZURE_ENV === 'production'
    ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
    : new AzureCliCredential();

  const tokenResponse = await credential.getToken('https://database.windows.net/.default');

  return await connectWithRetry({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenResponse.token } },
    options : { encrypt: true, trustServerCertificate: false, requestTimeout: 120_000 },
  }, { label: 'db_tpstechautomata' });
}

// ── TVP — now includes LastBillDate ───────────────────────────
function buildTVP(rows) {
  const table = new sql.Table('InternalProductsType');
  table.columns.add('SKU_ID',       sql.NVarChar(100));
  table.columns.add('Title',        sql.NVarChar(500));
  table.columns.add('Brand',        sql.NVarChar(200));
  table.columns.add('Category',     sql.NVarChar(200));
  table.columns.add('PP',           sql.Decimal(10, 2));
  table.columns.add('SP',           sql.Decimal(10, 2));
  table.columns.add('isActive',     sql.Bit);
  table.columns.add('isInStock',    sql.Bit);
  table.columns.add('LastBillDate', sql.Date);   // NEW

  rows.forEach((row) => {
    table.rows.add(
      row.SKU_ID       ?? null,
      row.Title        ?? null,
      row.Brand        ?? null,
      row.Category     ?? null,
      row.PP           ?? null,
      row.SP           ?? null,
      row.isActive     ?? 0,
      row.isInStock    ?? 0,
      row.LastBillDate ?? null,  // NEW — may be null if no bill in last 30 days
    );
  });

  return table;
}

async function syncInternalProducts() {
  const startTime = Date.now();

  const { combined } = await fetchCombinedData();
  console.log(`\n📦 Products to sync: ${combined.length}`);

  const valid   = combined.filter(r => r.SKU_ID);
  const skipped = combined.length - valid.length;
  console.log(`   Valid  : ${valid.length}`);
  console.log(`   Skipped: ${skipped} (null SKU)`);

  const dedupMap = new Map();
  for (const row of valid) dedupMap.set(row.SKU_ID, row);
  const deduped = [...dedupMap.values()];
  console.log(`   Deduped: ${deduped.length} unique SKUs (removed ${valid.length - deduped.length} duplicates)`);

  const activeCount  = deduped.filter(r => r.isActive   === 1).length;
  const inStockCount = deduped.filter(r => r.isInStock  === 1).length;
  const bothCount    = deduped.filter(r => r.isActive === 1 && r.isInStock === 1).length;
  console.log(`\n   📊 Shopify flags:`);
  console.log(`      isActive=1  : ${activeCount}`);
  console.log(`      isInStock=1 : ${inStockCount}`);
  console.log(`      both=1      : ${bothCount}  (eligible for recommendation engine)`);

  console.log('\n🔌 Connecting to db_tpstechautomata...');
  const pool = await getTargetPool();
  console.log('   Connected');

  console.log('\n🏗️  Building TVP...');
  const tvp = buildTVP(deduped);
  console.log(`   TVP ready — ${deduped.length} rows packed`);

  console.log('\n📤 Running bulk MERGE into InternalProducts...');
  const mergeStart = Date.now();

  const result = await pool.request()
    .input('tvp', tvp)
    .query(`
      MERGE InternalProducts AS target
      USING (
        SELECT
          SKU_ID,
          MAX(Title)              AS Title,
          MAX(Brand)              AS Brand,
          MAX(Category)           AS Category,
          MAX(PP)                 AS PP,
          MAX(SP)                 AS SP,
          CAST(MAX(CAST(isActive  AS INT)) AS BIT) AS isActive,
          CAST(MAX(CAST(isInStock AS INT)) AS BIT) AS isInStock,
          MAX(LastBillDate)       AS LastBillDate
        FROM @tvp
        GROUP BY SKU_ID
      ) AS source
        ON target.SKU_ID = source.SKU_ID

      WHEN MATCHED THEN
        UPDATE SET
          Title        = source.Title,
          Brand        = source.Brand,
          Category     = source.Category,
          PP           = source.PP,
          SP           = source.SP,
          isActive     = source.isActive,
          isInStock    = source.isInStock,
          LastBillDate = source.LastBillDate,
          UpdatedAt    = GETDATE()
          -- NOTE: ManualPP_UpdatedAt and ManualPP_UpdatedBy are deliberately
          -- NOT updated here. They are owned by the manual PP update API only.

      WHEN NOT MATCHED THEN
        INSERT (SKU_ID, Title, Brand, Category, PP, SP, isActive, isInStock, LastBillDate, UpdatedAt)
        VALUES (source.SKU_ID, source.Title, source.Brand, source.Category,
                source.PP, source.SP, source.isActive, source.isInStock,
                source.LastBillDate, GETDATE());
    `);

  const mergeSec = ((Date.now() - mergeStart) / 1000).toFixed(1);
  const totalSec = ((Date.now() - startTime)  / 1000).toFixed(1);

  console.log(`\n🎉 Done!`);
  console.log(`   Rows touched : ${result.rowsAffected[0]}`);
  console.log(`   Merge time   : ${mergeSec}s`);
  console.log(`   Total time   : ${totalSec}s`);

  clearTokenTimers();
  await pool.close();

  return { rowsTouched: result.rowsAffected[0], mergeSec, totalSec };
}

// ── NEW: targeted isActive/isInStock-only sync for ONE category ──
async function syncCategoryFlags(category) {
  if (!category) throw new Error('syncCategoryFlags: category is required');

  const startTime = Date.now();
  const rows = await fetchShopifyFlagsByCategory(category);

  if (rows.length === 0) {
    console.log(`   ⚠️  No Shopify rows found for category "${category}"`);
    return { category, matched: 0, updated: 0 };
  }

  const pool = await getTargetPool();
  try {
    const request = pool.request();
    const statements = [];
    let bound = 0;

    rows.forEach((row) => {
      const sku = sanitizeSKU(row.sku);
      if (!sku) return;

      request.input(`sku${bound}`,       sql.NVarChar(100), sku);
      request.input(`isActive${bound}`,  sql.Bit, row.is_enabled ? 1 : 0);
      request.input(`isInStock${bound}`, sql.Bit, row.in_stock   ? 1 : 0);

      statements.push(`
        UPDATE InternalProducts
        SET isActive = @isActive${bound}, isInStock = @isInStock${bound}, UpdatedAt = GETDATE()
        WHERE SKU_ID = @sku${bound};
      `);
      bound++;
    });

    if (statements.length === 0) {
      return { category, matched: rows.length, updated: 0 };
    }

    const result = await request.query(statements.join('\n'));
    const updated = Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((a, b) => a + b, 0)
      : 0;

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   🔄 Category "${category}" — matched ${rows.length}, updated ${updated} rows (${totalSec}s)`);

    return { category, matched: rows.length, updated };
  } finally {
    await pool.close();
  }
}

module.exports = { syncInternalProducts, syncCategoryFlags };

// ── Only run automatically when executed directly ─────────────
// (`node src/internal_db_sync.js`), NOT when required by
// api_server.js or the Azure Function timer trigger.
if (require.main === module) {
  syncInternalProducts()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ Fatal error:', err.message);
      console.error(err.stack);
      process.exit(1);
    });
}































// // src/internal_db_sync.js
// // CHANGE: TVP + MERGE now includes LastBillDate column.
// // ManualPP_UpdatedAt / ManualPP_UpdatedBy are NEVER touched here —
// // those are owned exclusively by the manual PP update API.

// require('dotenv/config');
// const sql = require('mssql');
// const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');
// const { connectWithRetry } = require('./utils/connectWithRetry'); // add near top requires
// const { fetchCombinedData, clearTokenTimers } = require('./services/azureSqlService.js');

// // ─────────────────────────────────────────────────────────────
// async function getTargetPool() {
//   const credential = process.env.AZURE_ENV === 'production'
//     ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
//     : new AzureCliCredential();

//   const tokenResponse = await credential.getToken('https://database.windows.net/.default');

//   return await connectWithRetry({
//     server  : process.env.db_serverendpoint,
//     database: 'db_tpstechautomata',
//     authentication: { type: 'azure-active-directory-access-token', options: { token: tokenResponse.token } },
//     options : { encrypt: true, trustServerCertificate: false, requestTimeout: 120_000 },
//   }, { label: 'db_tpstechautomata' });
// }

// // ── TVP — now includes LastBillDate ───────────────────────────
// function buildTVP(rows) {
//   const table = new sql.Table('InternalProductsType');
//   table.columns.add('SKU_ID',       sql.NVarChar(100));
//   table.columns.add('Title',        sql.NVarChar(500));
//   table.columns.add('Brand',        sql.NVarChar(200));
//   table.columns.add('Category',     sql.NVarChar(200));
//   table.columns.add('PP',           sql.Decimal(10, 2));
//   table.columns.add('SP',           sql.Decimal(10, 2));
//   table.columns.add('isActive',     sql.Bit);
//   table.columns.add('isInStock',    sql.Bit);
//   table.columns.add('LastBillDate', sql.Date);   // NEW

//   rows.forEach((row) => {
//     table.rows.add(
//       row.SKU_ID       ?? null,
//       row.Title        ?? null,
//       row.Brand        ?? null,
//       row.Category     ?? null,
//       row.PP           ?? null,
//       row.SP           ?? null,
//       row.isActive     ?? 0,
//       row.isInStock    ?? 0,
//       row.LastBillDate ?? null,  // NEW — may be null if no bill in last 30 days
//     );
//   });

//   return table;
// }

// async function syncInternalProducts() {
//   const startTime = Date.now();

//   try {
//     const { combined } = await fetchCombinedData();
//     console.log(`\n📦 Products to sync: ${combined.length}`);

//     const valid   = combined.filter(r => r.SKU_ID);
//     const skipped = combined.length - valid.length;
//     console.log(`   Valid  : ${valid.length}`);
//     console.log(`   Skipped: ${skipped} (null SKU)`);

//     const dedupMap = new Map();
//     for (const row of valid) dedupMap.set(row.SKU_ID, row);
//     const deduped = [...dedupMap.values()];
//     console.log(`   Deduped: ${deduped.length} unique SKUs (removed ${valid.length - deduped.length} duplicates)`);

//     const activeCount  = deduped.filter(r => r.isActive   === 1).length;
//     const inStockCount = deduped.filter(r => r.isInStock  === 1).length;
//     const bothCount    = deduped.filter(r => r.isActive === 1 && r.isInStock === 1).length;
//     console.log(`\n   📊 Shopify flags:`);
//     console.log(`      isActive=1  : ${activeCount}`);
//     console.log(`      isInStock=1 : ${inStockCount}`);
//     console.log(`      both=1      : ${bothCount}  (eligible for recommendation engine)`);

//     console.log('\n🔌 Connecting to db_tpstechautomata...');
//     const pool = await getTargetPool();
//     console.log('   Connected');

//     console.log('\n🏗️  Building TVP...');
//     const tvp = buildTVP(deduped);
//     console.log(`   TVP ready — ${deduped.length} rows packed`);

//     console.log('\n📤 Running bulk MERGE into InternalProducts...');
//     const mergeStart = Date.now();

//     const result = await pool.request()
//       .input('tvp', tvp)
//       .query(`
//         MERGE InternalProducts AS target
//         USING (
//           SELECT
//             SKU_ID,
//             MAX(Title)              AS Title,
//             MAX(Brand)              AS Brand,
//             MAX(Category)           AS Category,
//             MAX(PP)                 AS PP,
//             MAX(SP)                 AS SP,
//             CAST(MAX(CAST(isActive  AS INT)) AS BIT) AS isActive,
//             CAST(MAX(CAST(isInStock AS INT)) AS BIT) AS isInStock,
//             MAX(LastBillDate)       AS LastBillDate
//           FROM @tvp
//           GROUP BY SKU_ID
//         ) AS source
//           ON target.SKU_ID = source.SKU_ID

//         WHEN MATCHED THEN
//           UPDATE SET
//             Title        = source.Title,
//             Brand        = source.Brand,
//             Category     = source.Category,
//             PP           = source.PP,
//             SP           = source.SP,
//             isActive     = source.isActive,
//             isInStock    = source.isInStock,
//             LastBillDate = source.LastBillDate,
//             UpdatedAt    = GETDATE()
//             -- NOTE: ManualPP_UpdatedAt and ManualPP_UpdatedBy are deliberately
//             -- NOT updated here. They are owned by the manual PP update API only.

//         WHEN NOT MATCHED THEN
//           INSERT (SKU_ID, Title, Brand, Category, PP, SP, isActive, isInStock, LastBillDate, UpdatedAt)
//           VALUES (source.SKU_ID, source.Title, source.Brand, source.Category,
//                   source.PP, source.SP, source.isActive, source.isInStock,
//                   source.LastBillDate, GETDATE());
//       `);

//     const mergeSec = ((Date.now() - mergeStart) / 1000).toFixed(1);
//     const totalSec = ((Date.now() - startTime)  / 1000).toFixed(1);

//     console.log(`\n🎉 Done!`);
//     console.log(`   Rows touched : ${result.rowsAffected[0]}`);
//     console.log(`   Merge time   : ${mergeSec}s`);
//     console.log(`   Total time   : ${totalSec}s`);

//     clearTokenTimers();
//     await pool.close();

//   } catch (err) {
//   console.error('\n❌ Fatal error:', err.message);
//   console.error(err.stack);
//   process.exit(1);
// }
// }

// syncInternalProducts();

