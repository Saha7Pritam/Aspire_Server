
| Column | What it tracks |
|---|---|
| `ManualPP_UpdatedAt` / `ManualPP_UpdatedBy` | Last manual edit to **PP** (bill price) — from the older Bulk PP Update feature, unrelated to Shopify pushes |
| `ManualRecommendedSP` | The overridden SP value someone typed via **Modify & Push** |
| `ManualRecommendedSP_UpdatedAt` / `_UpdatedBy` | When/who made that override |
| `ShopifyPushedSP` | The **last price value actually sent to Shopify successfully** (could be the system's `RecommendedSP` or the manual override — whichever was pushed) |
| `ShopifyPushedAt` / `ShopifyPushedBy` | When/who triggered that last successful push |
| `ShopifyPushStatus` | `success` or `failed` for the most recent push attempt |







---

#### Competitor Based Recommendation should show only products when SkU matches with scrape data + in Compete store product is not out of stock + In our store that matched product should have PP available + also active +also have to be inStock. For the Basic Recommendations table eligibility  product PP have to be there+ isInStock+ isActive for our internal products only.  Now tell me do i needs to have a separate table for basic recommendation or any extra column Because It shouldn't overlap any product which is eligible for Competitor Based Recommendation table that should never came into inside Basic Recommendations table.  Competitor Based Recommendation table have the higher priority here.
- Since Basic Recommendations now never touches a SKU that the competitor engine owns, the two writers can no longer collide on the same RecommendedSP value for the same SKU. Competitor Based keeps its column value intact (only recommendation_engine.js writes it), and Basic Recommendations only ever writes for the SKUs that are exclusively its own. No new column needed — the exclusion query does the whole job.