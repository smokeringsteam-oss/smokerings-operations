import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { fileURLToPath } from 'url';
import {
  brainstormReply,
  generatePostFromConversation,
  extractWeekendOrders,
  readOrderTimePreferences,
} from './integrations/geminiContent.js';
import {
  getConfig as getGithubConfig,
  getSprintBoard,
  getCurrentSprintBoard,
  setItemStatus,
  setItemAssignedTo,
  setItemDay,
  setItemAssignees,
  getAssignableUsers,
  addDraftItem,
  createSubIssueTask,
  migrateDraftsToIssues,
  getRecentActivity,
  formatActivityForPrompt,
} from './integrations/githubProjects.js';
import {
  getConfig as getOdooConfig,
  fetchWeekendOrders,
  confirmSaleOrder,
  fetchOrderPackingList,
  fetchRecentOrders,
  createPurchaseOrder,
  removePurchaseOrderLine,
  createVendorInOdoo,
  syncRawMaterialsToOdoo,
  addStockOnHand,
} from './integrations/odoo.js';
import { getRecurringScheduleFromCsv } from './sprint/recurringScheduleCsv.js';
import { getWeekStatus, setTaskStatus } from './sprint/weeklyScheduleStatusLog.js';
import {
  getConfig as getPurchasingConfig,
  getVendors,
  addVendor,
  getRawMaterials,
  getInventory,
  getLowStock,
  getPurchases,
  recordPurchases,
  linkPurchasesToOdoo,
  deletePurchase,
  getInventoryAdjustments,
  addInventoryAdjustment,
} from './ops/shared/purchasing.js';
import {
  getMeatItems,
  getRecipes,
  getSessions,
  startBrining,
  completeRub,
  getAvailablePurchasesForMaterial,
  getTaggablePurchases,
  startSmoking,
  finishSmoking,
  completeResting,
  completeShredding,
  setFedOrders,
  getRealizedLossStats,
  deleteSession,
} from './ops/shared/smoking.js';
import { getStageLog } from './ops/shared/smokingStageLog.js';
import { getMenu, computeSwiggyPlan, computeMeatPlan, computePrepPlan, getPackableSidesByItem } from './ops/b2c/recipes.js';
import { getMenuItemRecipe, updateMenuItemRecipe } from './ops/menu/menuRecipe.js';
import { getWeekendStatus, setWeekendStatus } from './ops/b2c/weekendStatus.js';
import { getSidePrepStatuses, setSidePrepStatus } from './ops/b2c/sidePrepStatus.js';
import {
  fetchServiceWeeks,
  setServiceWeekOpen,
  createServiceWeek,
  setServiceWeekMenu,
  fetchMenuOptions,
  describeServiceWeekSchema,
} from './ops/b2c/serviceWeeks.js';
import {
  fetchMenuItems,
  updateMenuItem,
  setMenuItemImage,
  setMenuItemArchived,
  fetchMenuItemDetails,
  updateMenuItemDetails,
  fetchMenuItemFieldOptions,
} from './ops/menu/menuItems.js';
import { getPackingStatuses, setPackingStatus, retryInvoice } from './ops/shared/orderPackingStatus.js';
import {
  listClients as listB2BClients,
  addClient as addB2BClient,
  updateClient as updateB2BClient,
  setStage as setB2BClientStage,
  setDemands as setB2BClientDemands,
  deleteClient as deleteB2BClient,
} from './ops/b2b/b2bClients.js';
import {
  getStatus as getAiSeoStatus,
  listPrompts as listAiSeoPrompts,
  addPrompt as addAiSeoPrompt,
  seedPrompts as seedAiSeoPrompts,
  updatePrompt as updateAiSeoPrompt,
  deletePrompt as deleteAiSeoPrompt,
  listRuns as listAiSeoRuns,
  deleteRun as deleteAiSeoRun,
  runCheck as runAiSeoCheck,
  logManualRun as logAiSeoManualRun,
} from './marketing/aiSeo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

const app = express();
// 16mb rather than the 100kb default: menu item pictures are posted as base64
// data URIs (see POST /api/ops/menu-items/image), and base64 inflates a file
// by about a third, so a phone photo would otherwise be rejected as a 413
// before any of our own size checks could give a useful message.
app.use(express.json({ limit: '16mb' }));
app.use(cors());

app.post('/api/post-reddit', upload.array('images'), async (req, res) => {
  try {
    const { title = '', text = '', subreddits = '[]', profilePath, flairs = '{}' } = req.body;
    const subs = Array.isArray(subreddits) ? subreddits : JSON.parse(subreddits || '[]');
    const normalizedSubs = Array.isArray(subs) ? subs.filter(Boolean) : [];
    if (!normalizedSubs.length) {
      return res.status(400).json({ error: 'No subreddits provided. Select at least one subreddit.' });
    }
    // Optional per-subreddit flair override (JSON object, e.g. {"test":"Discussion"}).
    // Falls back to server/marketing/redditFlairs.js for any subreddit not listed here.
    const flairOverrides = typeof flairs === 'string' ? JSON.parse(flairs || '{}') : flairs;
    const files = (req.files || []).map((f) => f.path);
    // Allow specifying an images folder path (e.g., C:\Users\you\Downloads\Reddit)
    if (req.body.imagesFolder) {
      files.push(req.body.imagesFolder);
    }
    console.log('Received Reddit post request:', {
      title: title.slice(0, 60),
      subreddits: normalizedSubs,
      files,
      profilePath,
    });

    // start posting in background
    import('./marketing/redditPoster.js').then(({ postToSubreddits }) => {
      postToSubreddits({ subreddits: normalizedSubs, title, text, files, profilePath, flairs: flairOverrides }).catch(
        (err) => console.error('Error posting to reddit:', err),
      );
    });

    res.status(202).json({ status: 'queued', queuedFor: normalizedSubs.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/gemini/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const result = await brainstormReply({ messages });
    res.json(result);
  } catch (err) {
    console.error('Error in /api/gemini/chat:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Agent 2: a multi-step pipeline (brief -> insights -> draft -> refine-if-
// needed, see generatePostFromConversation) that turns the Step 1 chat
// conversation into one finished, on-voice, ≤400-character post. GitHub
// activity is optional context the founder can pull into the chat itself
// (see /api/github/recent-activity) rather than something this endpoint
// fetches automatically.
app.post('/api/gemini/generate-post', async (req, res) => {
  try {
    const { messages } = req.body;
    const result = await generatePostFromConversation({ messages });
    res.json(result);
  } catch (err) {
    console.error('Error in /api/gemini/generate-post:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/gemini/extract-orders', async (req, res) => {
  try {
    const { text } = req.body;
    const result = await extractWeekendOrders({ text });
    res.json(result);
  } catch (err) {
    console.error('Error in /api/gemini/extract-orders:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Reads the free-text customer notes that came back with an order fetch and
// picks out any delivery-time preference in them — see
// server/integrations/geminiContent.js readOrderTimePreferences for what does and does not
// count as one. Its own endpoint rather than part of GET /api/odoo/order-packing
// because it is optional and slower: the boards render their orders first and
// fill the preferences in when this answers, so a missing GEMINI_API_KEY or a
// quota 503 costs the highlight, never the board.
app.post('/api/orders/time-preferences', async (req, res) => {
  try {
    const { orders } = req.body;
    const result = await readOrderTimePreferences({ orders });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/orders/time-preferences:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/odoo/status', (req, res) => {
  // Pick only the safe fields — getOdooConfig() also carries the raw apiKey
  // for internal use, which must never reach the client.
  const { url, db, username, hasApiKey, configured } = getOdooConfig();
  res.json({ url, db, username, hasApiKey, configured });
});

// Confirmed orders come back tallied in `orders`; unconfirmed quotations
// (draft/sent) come back per-order in `quotations` so the Weekend Prep
// Planner can show them and confirm them. ?quotations=false drops them.
app.get('/api/odoo/orders', async (req, res) => {
  try {
    const { from, to, quotations } = req.query;
    const result = await fetchWeekendOrders({
      fromDate: from,
      toDate: to,
      includeQuotations: quotations !== 'false',
    });
    res.json(result);
  } catch (err) {
    console.error('Error in GET /api/odoo/orders:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Confirms one quotation in Odoo (its own "Confirm" button) — from the
// planner's pending-quotations list, so a weekend order can be committed to
// without leaving the dashboard.
app.post('/api/odoo/orders/:orderId/confirm', async (req, res) => {
  try {
    const result = await confirmSaleOrder({ orderId: req.params.orderId });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/odoo/orders/:orderId/confirm:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ?channel=b2c (default) | b2b — which side's orders to pack. B2C comes back
// grouped into the weekend's four services, B2B into delivery days (see
// fetchOrderPackingList); both arrive as the same `groups` array so one board
// renders either.
app.get('/api/odoo/order-packing', async (req, res) => {
  try {
    const { from, to, channel } = req.query;
    const result = await fetchOrderPackingList({ fromDate: from, toDate: to, channel });
    res.json(result);
  } catch (err) {
    console.error('Error in GET /api/odoo/order-packing:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Backfills/re-syncs odoo_product_id on materials.csv against Odoo — see
// server/integrations/odoo.js syncRawMaterialsToOdoo. Re-run whenever new raw materials
// get added to the catalog without one yet; already-synced rows are skipped.
app.post('/api/odoo/sync-products', async (req, res) => {
  try {
    const result = await syncRawMaterialsToOdoo();
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/odoo/sync-products:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Ops Dashboard "Service Weeks" strip — which weeks the kitchen is open for.
// Odoo owns this flag (the custom Service Weeks model's OPEN/CLOSED Kitchen
// field), so both routes go straight there with no local copy kept; see
// server/ops/b2c/serviceWeeks.js for why the model's schema is discovered rather
// than hardcoded.
app.get('/api/ops/service-weeks', async (req, res) => {
  try {
    // ?from=&to= scopes the read to one month for the weekend grid; without
    // them it falls back to the latest `limit` weeks.
    res.json(await fetchServiceWeeks({ limit: req.query.limit, from: req.query.from, to: req.query.to }));
  } catch (err) {
    console.error('Error in GET /api/ops/service-weeks:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/ops/service-weeks/status', async (req, res) => {
  try {
    const { id, from, to, isOpen } = req.body;
    if (typeof isOpen !== 'boolean') {
      const err = new Error('isOpen must be true or false.');
      err.status = 400;
      throw err;
    }
    // No id means "this weekend, whatever record backs it" — the store
    // creates one if nothing covers that range yet.
    res.json(await setServiceWeekOpen({ id, from, to, isOpen }));
  } catch (err) {
    console.error('Error in POST /api/ops/service-weeks/status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Creates a new Service Week record in Odoo. `menuIds` is optional — a week
// can be created empty and have its menu filled in afterwards via the route
// below.
app.post('/api/ops/service-weeks', async (req, res) => {
  try {
    const { name, from, to, isOpen, menuIds } = req.body;
    res.json(
      await createServiceWeek({
        name,
        from,
        to,
        // Default to open: a week you're bothering to create is normally one
        // you intend to trade on.
        isOpen: typeof isOpen === 'boolean' ? isOpen : true,
        menuIds,
      }),
    );
  } catch (err) {
    console.error('Error in POST /api/ops/service-weeks:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Replaces a week's "Menu This Week" with exactly `productIds` (an empty array
// clears it).
app.post('/api/ops/service-weeks/menu', async (req, res) => {
  try {
    const { id, productIds } = req.body;
    res.json(await setServiceWeekMenu({ id, productIds }));
  } catch (err) {
    console.error('Error in POST /api/ops/service-weeks/menu:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The pickable menu items (Odoo finished products) behind both routes above.
app.get('/api/ops/service-weeks/menu-options', async (req, res) => {
  try {
    res.json(await fetchMenuOptions());
  } catch (err) {
    console.error('Error in GET /api/ops/service-weeks/menu-options:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Menu items — the dishes themselves (Odoo products under Finished Products),
// as opposed to which of them a given week sells. See server/ops/menu/menuItems.js.
// ?channel=b2c (default) | b2b | all — which sales channel's items to list.
// Anything unrecognised falls back to b2c rather than quietly widening the
// list to include wholesale products.
app.get('/api/ops/menu-items', async (req, res) => {
  try {
    const requested = String(req.query.channel || 'b2c').toLowerCase();
    const channel = ['b2c', 'b2b', 'all'].includes(requested) ? requested : 'b2c';
    res.json(await fetchMenuItems({ includeArchived: req.query.includeArchived === '1', channel }));
  } catch (err) {
    console.error('Error in GET /api/ops/menu-items:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Partial update — only the fields present in the body are written.
app.post('/api/ops/menu-items/update', async (req, res) => {
  try {
    const { id, name, price, description, isAvailable } = req.body;
    res.json(await updateMenuItem({ id, name, price, description, isAvailable }));
  } catch (err) {
    console.error('Error in POST /api/ops/menu-items/update:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Replaces a menu item's picture. `image` is a data: URI or bare base64;
// null/empty removes the picture entirely.
app.post('/api/ops/menu-items/image', async (req, res) => {
  try {
    const { id, image } = req.body;
    res.json(await setMenuItemImage({ id, image }));
  } catch (err) {
    console.error('Error in POST /api/ops/menu-items/image:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The rest of the Odoo product record for one menu item — every field Odoo
// says is writable, with its label, help text and options, so the detail
// panel renders the real product form rather than a hardcoded subset. See
// server/ops/menu/menuItems.js. Fenced to Finished Products like every other write
// here: an id outside that subtree is a 404, not an edit.
app.get('/api/ops/menu-items/:id/details', async (req, res) => {
  try {
    res.json(await fetchMenuItemDetails({ id: req.params.id }));
  } catch (err) {
    console.error('Error in GET /api/ops/menu-items/:id/details:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Partial write of those fields — { id, values: { field: value, ... } }.
// Only the fields named in values are touched.
app.post('/api/ops/menu-items/details', async (req, res) => {
  try {
    const { id, values } = req.body;
    res.json(await updateMenuItemDetails({ id, values }));
  } catch (err) {
    console.error('Error in POST /api/ops/menu-items/details:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The kitchen half of a menu item: how much meat, which sides and what
// packaging go into one order of it, straight out of recipe_lines.csv. Keyed
// by the knowledge-base menu_id (which GET /api/ops/menu-items hands back on
// each item), not the Odoo id — Odoo has no model for a recipe.
app.get('/api/ops/menu-items/recipe', (req, res) => {
  try {
    res.json(getMenuItemRecipe({ menuId: req.query.menuId }));
  } catch (err) {
    console.error('Error in GET /api/ops/menu-items/recipe:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Saves changed quantities on that recipe — { menuId, edits: [{ lineId,
// quantity, baseQuantity? }] }. All-or-nothing: one bad number rejects the
// whole save rather than writing half a recipe. See server/ops/menu/menuRecipe.js for
// why a save writes both the quantity and base_quantity columns.
app.post('/api/ops/menu-items/recipe', (req, res) => {
  try {
    const { menuId, edits } = req.body;
    res.json(updateMenuItemRecipe({ menuId, edits }));
  } catch (err) {
    console.error('Error in POST /api/ops/menu-items/recipe:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Picker options for one relational field on that record (?field=uom_id&q=kg).
// The model searched comes from the field's own Odoo metadata, so this stays
// a product-record helper rather than a general model reader.
app.get('/api/ops/menu-items/field-options', async (req, res) => {
  try {
    res.json(await fetchMenuItemFieldOptions({ field: req.query.field, query: req.query.q }));
  } catch (err) {
    console.error('Error in GET /api/ops/menu-items/field-options:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/ops/menu-items/archive', async (req, res) => {
  try {
    const { id, archived } = req.body;
    if (typeof archived !== 'boolean') {
      const err = new Error('archived must be true or false.');
      err.status = 400;
      throw err;
    }
    res.json(await setMenuItemArchived({ id, archived }));
  } catch (err) {
    console.error('Error in POST /api/ops/menu-items/archive:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Reports which Odoo model/fields the Service Weeks schema discovery landed
// on — the quickest way to check it against a real database, and what to
// look at before pinning any ODOO_SERVICE_WEEK_* override in .env.
app.get('/api/ops/service-weeks/schema', async (req, res) => {
  try {
    res.json(await describeServiceWeekSchema());
  } catch (err) {
    console.error('Error in GET /api/ops/service-weeks/schema:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/recipes/menu', (req, res) => {
  try {
    res.json({ menu: getMenu() });
  } catch (err) {
    console.error('Error in GET /api/recipes/menu:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/recipes/swiggy-plan', (req, res) => {
  try {
    const { orderCounts } = req.body;
    res.json(computeSwiggyPlan({ orderCounts }));
  } catch (err) {
    console.error('Error in POST /api/recipes/swiggy-plan:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Static reference — which packable sides each menu item needs, independent
// of any order counts. Order Packing fetches this once and uses it to work
// out, per individual order, which sides can share one container.
app.get('/api/recipes/sides-by-item', (req, res) => {
  try {
    res.json({ sidesByItem: getPackableSidesByItem() });
  } catch (err) {
    console.error('Error in GET /api/recipes/sides-by-item:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Weekend Prep Planner's "Meat needed" tiles — per-order finished weight
// (recipe_lines.csv) converted to a raw buy weight via each
// category's loss % and the cut it's bought as, both from
// server/core/meatConfig.js.
app.post('/api/recipes/meat-plan', (req, res) => {
  try {
    const { orderCounts } = req.body;
    res.json(computeMeatPlan({ orderCounts }));
  } catch (err) {
    console.error('Error in POST /api/recipes/meat-plan:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Order Packing's "what to toast/warm before packing" table — buns, taco
// shells, tortillas, garlic bread — scoped to one slot's order counts, same
// shape/spirit as /api/recipes/swiggy-plan but for Bakery-category prep
// instead of Swiggy-bought sides.
app.post('/api/recipes/prep-plan', (req, res) => {
  try {
    const { orderCounts } = req.body;
    res.json(computePrepPlan({ orderCounts }));
  } catch (err) {
    console.error('Error in POST /api/recipes/prep-plan:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Order Packing's In Smoker -> Prepping -> Packed -> Finding Partner ->
// Partner Assigned -> Out for Delivery -> Delivered state per order (see
// server/ops/shared/orderPackingStatus.js). ?orderIds=1,2,3 scopes the lookup to the
// active slot's orders; omit to get every order that has a status on file.
app.get('/api/order-packing/status', (req, res) => {
  try {
    const orderIds = req.query.orderIds ? String(req.query.orderIds).split(',').filter(Boolean) : undefined;
    res.json(getPackingStatuses({ orderIds }));
  } catch (err) {
    console.error('Error in GET /api/order-packing/status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/order-packing/status', async (req, res) => {
  try {
    const { orderId, orderName, status, deliveryPerson, channel } = req.body;
    const result = await setPackingStatus({ orderId, orderName, status, deliveryPerson, channel });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/order-packing/status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Retries just the Odoo invoice create+post step for an already-Delivered
// order — for when that step failed (Odoo unreachable, nothing marked "To
// Invoice" yet, etc.) without re-sending the order through earlier stages.
app.post('/api/order-packing/retry-invoice', async (req, res) => {
  try {
    const { orderId, orderName } = req.body;
    const result = await retryInvoice({ orderId, orderName });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/order-packing/retry-invoice:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Weekend Prep Planner's "mark this weekend as done" flag — shared via a
// knowledge-base CSV (see server/ops/b2c/weekendStatus.js) rather than localStorage,
// keyed by the same weekend_start/weekend_end (YYYY-MM-DD) the Step 1 Odoo
// date-range picker already uses.
app.get('/api/weekend-status', (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(getWeekendStatus({ weekendStart: from, weekendEnd: to }));
  } catch (err) {
    console.error('Error in GET /api/weekend-status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/weekend-status', (req, res) => {
  try {
    const { from, to, status } = req.body;
    if (status !== 'done' && status !== 'planned') {
      const err = new Error('status must be "done" or "planned".');
      err.status = 400;
      throw err;
    }
    res.json(setWeekendStatus({ weekendStart: from, weekendEnd: to, status }));
  } catch (err) {
    console.error('Error in POST /api/weekend-status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Per-side prep state for the Weekend Prep Planner's batch-detail table
// (see server/ops/b2c/sidePrepStatus.js) — pending / making / done, keyed by the same
// weekend date range plus the side key computeSwiggyPlan groups by.
app.get('/api/side-prep-status', (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(getSidePrepStatuses({ weekendStart: from, weekendEnd: to }));
  } catch (err) {
    console.error('Error in GET /api/side-prep-status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/side-prep-status', (req, res) => {
  try {
    const { from, to, sideKey, sideName, status } = req.body;
    res.json(setSidePrepStatus({ weekendStart: from, weekendEnd: to, sideKey, sideName, status }));
  } catch (err) {
    console.error('Error in POST /api/side-prep-status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/purchasing/status', (req, res) => {
  res.json(getPurchasingConfig());
});

app.get('/api/purchasing/vendors', (req, res) => {
  try {
    res.json({ vendors: getVendors() });
  } catch (err) {
    console.error('Error in GET /api/purchasing/vendors:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/purchasing/vendors', async (req, res) => {
  try {
    const { vendorName, vendorType, suppliesCategory, contactPerson, phone, email, address, notes } = req.body;
    const result = addVendor({ vendorName, vendorType, suppliesCategory, contactPerson, phone, email, address, notes });

    // CSV first (the source of truth), Odoo second and best-effort — same
    // pattern as "Log purchase to CSV and Odoo": a failed Odoo call doesn't
    // undo the vendors.csv row, it's just reported back.
    let odoo = null;
    try {
      odoo = await createVendorInOdoo({ vendorName, phone, email, address });
    } catch (err) {
      odoo = { created: false, error: err.message || String(err) };
    }

    res.status(201).json({ ...result, odoo });
  } catch (err) {
    console.error('Error in POST /api/purchasing/vendors:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/purchasing/materials', (req, res) => {
  try {
    res.json({ materials: getRawMaterials() });
  } catch (err) {
    console.error('Error in GET /api/purchasing/materials:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/purchasing/inventory', (req, res) => {
  try {
    res.json({ inventory: getInventory(), lowStock: getLowStock() });
  } catch (err) {
    console.error('Error in GET /api/purchasing/inventory:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/purchasing/purchases', (req, res) => {
  try {
    const { from, to, channel } = req.query;
    res.json({ purchases: getPurchases({ from, to, channel }) });
  } catch (err) {
    console.error('Error in GET /api/purchasing/purchases:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/purchasing/purchases', (req, res) => {
  try {
    const { vendorName, purchaseDate, channel, lines } = req.body;
    // Client names are resolved from b2b_clients.csv here rather than taken
    // from the body, so a renamed account can't leave two spellings of itself
    // in the purchase log. Same reason POST .../marinate resolves it, and the
    // same reason purchasing.js doesn't do the lookup itself: that module has
    // no business importing the B2B files.
    const taggedLines =
      channel === 'B2B' && Array.isArray(lines) && lines.some((l) => l?.clientId)
        ? (() => {
            const byId = new Map(listB2BClients().clients.map((c) => [c.id, c.name]));
            return lines.map((line) =>
              line?.clientId ? { ...line, clientName: byId.get(line.clientId) || '' } : line,
            );
          })()
        : lines;
    const result = recordPurchases({ vendorName, purchaseDate, channel, lines: taggedLines });
    res.status(201).json(result);
  } catch (err) {
    console.error('Error in POST /api/purchasing/purchases:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/purchasing/send-po', async (req, res) => {
  try {
    const { vendorName, lines, purchaseIds } = req.body;
    const result = await createPurchaseOrder({ vendorName, lines });
    // Link each purchase_log.csv row to its matching Odoo PO line so a later
    // delete can remove just that line — best-effort, doesn't fail the PO
    // creation if the ids don't line up cleanly.
    if (Array.isArray(purchaseIds) && purchaseIds.length === lines.length) {
      linkPurchasesToOdoo({ purchaseIds, poId: result.id, lineIds: result.lineIds });
    }
    res.status(201).json(result);
  } catch (err) {
    console.error('Error in POST /api/purchasing/send-po:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/purchasing/purchases/:purchaseId', async (req, res) => {
  try {
    const result = deletePurchase(req.params.purchaseId);
    let odoo = null;
    if (result.deleted.odoo_po_id && result.deleted.odoo_po_line_id) {
      try {
        odoo = await removePurchaseOrderLine({ poId: result.deleted.odoo_po_id, lineId: result.deleted.odoo_po_line_id });
      } catch (err) {
        odoo = { removed: false, error: err.message || String(err) };
      }
    }
    res.json({ ...result, odoo });
  } catch (err) {
    console.error('Error in DELETE /api/purchasing/purchases/:purchaseId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Manual inventory addition — stock that didn't come through a vendor
// purchase (opening stock, a correction found while counting, a return).
// Separate from POST /api/purchasing/purchases because there's no
// vendor/price attached; logs to inventory_adjustments.csv instead of
// purchase_log.csv but bumps quantity_on_hand the same way.
app.get('/api/purchasing/inventory/adjustments', (req, res) => {
  try {
    res.json({ adjustments: getInventoryAdjustments() });
  } catch (err) {
    console.error('Error in GET /api/purchasing/inventory/adjustments:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/purchasing/inventory/adjustments', async (req, res) => {
  try {
    const { materialId, quantity, reason, date } = req.body;
    const result = addInventoryAdjustment({ materialId, quantity, reason, date });

    // CSV first (the source of truth), Odoo second and best-effort — same
    // pattern as "Log purchase to CSV and Odoo" / "Add vendor": a failed
    // Odoo call doesn't undo the CSV write, it's just reported back.
    let odoo = null;
    try {
      odoo = await addStockOnHand({ materialId, itemName: result.adjustment.item_name, quantity });
    } catch (err) {
      odoo = { applied: false, error: err.message || String(err) };
    }

    res.status(201).json({ ...result, odoo });
  } catch (err) {
    console.error('Error in POST /api/purchasing/inventory/adjustments:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/smoking/meat-items', (req, res) => {
  try {
    res.json({ items: getMeatItems() });
  } catch (err) {
    console.error('Error in GET /api/smoking/meat-items:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Recipe dropdown options — rub_recipes.csv, filterable by category (Brine, Rub, ...).
app.get('/api/smoking/recipes', (req, res) => {
  try {
    const { category } = req.query;
    res.json({ recipes: getRecipes({ category }) });
  } catch (err) {
    console.error('Error in GET /api/smoking/recipes:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/smoking/sessions', (req, res) => {
  try {
    const { stage, status } = req.query;
    res.json({ sessions: getSessions({ stage, status }) });
  } catch (err) {
    console.error('Error in GET /api/smoking/sessions:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Every stage change ever logged, newest first (see
// server/ops/shared/smokingStageLog.js). ?sessionId= one session's timeline,
// ?channel=B2B / ?purpose=Sample to see just one side of the book,
// ?limit=50 to cap it.
app.get('/api/smoking/stage-log', (req, res) => {
  try {
    const { sessionId, channel, purpose } = req.query;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(getStageLog({ sessionId, channel, purpose, limit: Number.isFinite(limit) ? limit : undefined }));
  } catch (err) {
    console.error('Error in GET /api/smoking/stage-log:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Stage 1 — Brining: creates the session(s). `lines` (an array of
// { materialId, outputType }) lets one batch cover several meats brined
// together at once; a bare materialId/outputType still works as a one-item
// batch. Every line becomes its own session, sharing the rest of the body
// (pitmaster/brine recipe/timing/channel+purpose).
app.post('/api/smoking/sessions/marinate', (req, res) => {
  try {
    const { materialId, pitmaster, brineRecipe, brineStart, brineEnd, channel, purpose, clientId, orderType, outputType, lines } =
      req.body;
    // The client's name is resolved here rather than trusted from the body,
    // and rather than looked up inside smoking.js — that module deliberately
    // doesn't know about the B2B files (see the note on sessionClientId in
    // startBrining). Storing the name alongside the id keeps smoking_log.csv
    // readable on its own in Excel; an id that no longer resolves just leaves
    // the name blank rather than failing the cook.
    const clientName = clientId ? listB2BClients().clients.find((c) => c.id === clientId)?.name || '' : '';
    const result = startBrining({
      materialId,
      pitmaster,
      brineRecipe,
      brineStart,
      brineEnd,
      channel,
      purpose,
      clientId,
      clientName,
      orderType,
      outputType,
      lines,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('Error in POST /api/smoking/sessions/marinate:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Stage 2 — Rub.
app.post('/api/smoking/sessions/:sessionId/rub', (req, res) => {
  try {
    const { rubRecipe, rubStart, rubEnd } = req.body;
    const result = completeRub({ sessionId: req.params.sessionId, rubRecipe, rubStart, rubEnd });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/smoking/sessions/:sessionId/rub:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Purchases on file for a meat item, with remaining (unclaimed) quantity —
// feeds the "Sourced from purchase" dropdown in the Smoking step.
app.get('/api/smoking/purchases-for-material', (req, res) => {
  try {
    const { materialId, excludeSessionId } = req.query;
    res.json({ purchases: getAvailablePurchasesForMaterial(materialId, { excludeSessionId }) });
  } catch (err) {
    console.error('Error in GET /api/smoking/purchases-for-material:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Every purchase this cook could be charged with — the wider "what did it
// cost" list behind the tagging checklist, as opposed to
// purchases-for-material's "where did the raw weight come from". See
// getTaggablePurchases in server/ops/shared/smoking.js.
app.get('/api/smoking/sessions/:sessionId/taggable-purchases', (req, res) => {
  try {
    res.json({ purchases: getTaggablePurchases(req.params.sessionId) });
  } catch (err) {
    console.error('Error in GET /api/smoking/sessions/:sessionId/taggable-purchases:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Stage 3a — Smoking start. sourcePurchaseId links the raw weight back to
// the specific purchase_log.csv lot it came from — see getAvailablePurchasesForMaterial.
// taggedPurchaseIds is the separate cost attribution: which buys were made
// for this cook, stamped onto purchase_log.csv's smoking_session_id.
app.post('/api/smoking/sessions/:sessionId/smoke-start', (req, res) => {
  try {
    const { rawWeightKg, smokingStart, sourcePurchaseId, taggedPurchaseIds } = req.body;
    const result = startSmoking({
      sessionId: req.params.sessionId,
      rawWeightKg,
      smokingStart,
      sourcePurchaseId,
      taggedPurchaseIds,
    });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/smoking/sessions/:sessionId/smoke-start:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Stage 3b — Smoking finish.
app.post('/api/smoking/sessions/:sessionId/smoke-finish', (req, res) => {
  try {
    const { smokingEnd, finishedWeightWithBoneKg, finishedWeightWithoutBoneKg } = req.body;
    const result = finishSmoking({
      sessionId: req.params.sessionId,
      smokingEnd,
      finishedWeightWithBoneKg,
      finishedWeightWithoutBoneKg,
    });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/smoking/sessions/:sessionId/smoke-finish:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Stage 4 — Resting. For non-"Pulled" outputs this also completes the
// session — see completeResting() in server/ops/shared/smoking.js.
app.post('/api/smoking/sessions/:sessionId/rest', (req, res) => {
  try {
    const { restStart, restEnd, tendernessNotes, smokeRingsFormed, barkNotes, juiciness } = req.body;
    const result = completeResting({
      sessionId: req.params.sessionId,
      restStart,
      restEnd,
      tendernessNotes,
      smokeRingsFormed,
      barkNotes,
      juiciness,
    });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/smoking/sessions/:sessionId/rest:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Stage 5 — Shredding: marks the session completed.
app.post('/api/smoking/sessions/:sessionId/shred', (req, res) => {
  try {
    const { shredStart, shredEnd, tendernessNotes, smokeRingsFormed, barkNotes, juiciness } = req.body;
    const result = completeShredding({
      sessionId: req.params.sessionId,
      shredStart,
      shredEnd,
      tendernessNotes,
      smokeRingsFormed,
      barkNotes,
      juiciness,
    });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/smoking/sessions/:sessionId/shred:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Links a session to the confirmed order(s) it fed — see setFedOrders() in
// server/ops/shared/smoking.js. Not tied to a stage; callable any time, including well
// after the session completed (packing usually happens later than cooking).
app.post('/api/smoking/sessions/:sessionId/fed-orders', (req, res) => {
  try {
    const { orders } = req.body;
    const result = setFedOrders({ sessionId: req.params.sessionId, orders });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/smoking/sessions/:sessionId/fed-orders:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Realized smoking-loss %s per meat category, from completed sessions' raw
// vs finished weight — the Weekend Prep Planner uses this in place of its
// static default guesses once real data exists. See getRealizedLossStats().
app.get('/api/smoking/yield-stats', (req, res) => {
  try {
    res.json(getRealizedLossStats());
  } catch (err) {
    console.error('Error in GET /api/smoking/yield-stats:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Deletes a smoking_log.csv row entirely and reverses any
// inventory it had already consumed (mirrors DELETE /api/purchasing/purchases).
app.delete('/api/smoking/sessions/:sessionId', (req, res) => {
  try {
    const result = deleteSession(req.params.sessionId);
    res.json(result);
  } catch (err) {
    console.error('Error in DELETE /api/smoking/sessions/:sessionId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Confirmed orders in a date range, for the Smoking Session module's "Fed to
// these orders" picker — isCompany selects B2B vs B2C (mirrors a session's
// channel). See fetchRecentOrders() in server/integrations/odoo.js.
app.get('/api/odoo/recent-orders', async (req, res) => {
  try {
    const { from, to, isCompany } = req.query;
    const result = await fetchRecentOrders({ fromDate: from, toDate: to, isCompany: isCompany === 'true' });
    res.json(result);
  } catch (err) {
    console.error('Error in GET /api/odoo/recent-orders:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/github/status', (req, res) => {
  res.json(getGithubConfig());
});

// Weekly recurring cadence (all 7 days), read live from schedule.csv in the
// knowledge-base repo — edit the sheet, reload Daily View, see it there.
app.get('/api/recurring-schedule', (req, res) => {
  try {
    const schedule = getRecurringScheduleFromCsv();
    res.json({ schedule });
  } catch (err) {
    console.error('Error in GET /api/recurring-schedule:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Per-week completion log for the recurring cadence — shared via a knowledge-base
// CSV (see server/sprint/weeklyScheduleStatusLog.js) rather than localStorage, keyed by the
// ISO week (e.g. "2026-W33"). A new week has no rows yet, so it starts fresh; past
// weeks' rows stay behind as a log.
app.get('/api/recurring-schedule/status', (req, res) => {
  try {
    const { week } = req.query;
    res.json(getWeekStatus({ weekKey: week }));
  } catch (err) {
    console.error('Error in GET /api/recurring-schedule/status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/recurring-schedule/status', (req, res) => {
  try {
    const { week, taskId, done, assignedTo, time } = req.body;
    res.json(setTaskStatus({ weekKey: week, taskId, done, assignedTo, time }));
  } catch (err) {
    console.error('Error in POST /api/recurring-schedule/status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/github/sprint-board', async (req, res) => {
  try {
    const { sprint, items } = await getCurrentSprintBoard();
    res.json({ sprint, items });
  } catch (err) {
    console.error('Error in GET /api/github/sprint-board:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Unfiltered board (unlike /sprint-board, which only shows the current Sprint iteration) —
// used to list the top-level items a new task can be filed under as a sub-issue.
app.get('/api/github/board-items', async (req, res) => {
  try {
    const items = await getSprintBoard();
    res.json({ items });
  } catch (err) {
    console.error('Error in GET /api/github/board-items:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/github/assignable-users', async (req, res) => {
  try {
    const users = await getAssignableUsers();
    res.json({ users });
  } catch (err) {
    console.error('Error in GET /api/github/assignable-users:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/github/sprint-board', async (req, res) => {
  try {
    const { title, body = '', status, assignedTo } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const item = await addDraftItem({ title: title.trim(), body, status, assignedTo });
    res.status(201).json({ item });
  } catch (err) {
    console.error('Error in POST /api/github/sprint-board:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/github/sprint-board/:itemId/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    await setItemStatus(req.params.itemId, status);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in POST /api/github/sprint-board/:itemId/status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/github/sprint-board/:itemId/day', async (req, res) => {
  try {
    const { day = '' } = req.body;
    await setItemDay(req.params.itemId, day);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in POST /api/github/sprint-board/:itemId/day:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/github/sprint-board/:itemId/assignee', async (req, res) => {
  try {
    const { assignedTo = '' } = req.body;
    await setItemAssignedTo(req.params.itemId, assignedTo);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in POST /api/github/sprint-board/:itemId/assignee:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/github/sprint-board/:itemId/assignees', async (req, res) => {
  try {
    const { number, assignees = [] } = req.body;
    if (!number) return res.status(400).json({ error: 'number (the issue number) is required' });
    await setItemAssignees(number, assignees);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in POST /api/github/sprint-board/:itemId/assignees:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/github/sprint-board/sub-issues', async (req, res) => {
  try {
    const { parentIssueId, title, body = '', status, assignee } = req.body;
    if (!parentIssueId) return res.status(400).json({ error: 'parentIssueId is required' });
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const item = await createSubIssueTask({ parentIssueId, title: title.trim(), body, status, assignee });
    res.status(201).json({ item });
  } catch (err) {
    console.error('Error in POST /api/github/sprint-board/sub-issues:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/github/recent-activity', async (req, res) => {
  try {
    const days = Number(req.query.days) || 7;
    const activity = await getRecentActivity({ days });
    res.json({ activity, summaryText: formatActivityForPrompt(activity) });
  } catch (err) {
    console.error('Error in GET /api/github/recent-activity:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/github/migrate-backlog', async (req, res) => {
  try {
    const results = await migrateDraftsToIssues();
    res.json({ results });
  } catch (err) {
    console.error('Error in POST /api/github/migrate-backlog:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// AI SEO tracker — see server/marketing/aiSeo.js. Prompts and their run history live in
// the knowledge-base repo as aiseo_prompts.csv / aiseo_runs.csv.
app.get('/api/aiseo/status', (req, res) => {
  try {
    res.json(getAiSeoStatus());
  } catch (err) {
    console.error('Error in GET /api/aiseo/status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/aiseo/prompts', (req, res) => {
  try {
    res.json(listAiSeoPrompts());
  } catch (err) {
    console.error('Error in GET /api/aiseo/prompts:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/aiseo/prompts', (req, res) => {
  try {
    const { text, intent } = req.body;
    res.status(201).json(addAiSeoPrompt({ text, intent }));
  } catch (err) {
    console.error('Error in POST /api/aiseo/prompts:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/aiseo/prompts/seed', (req, res) => {
  try {
    res.json(seedAiSeoPrompts());
  } catch (err) {
    console.error('Error in POST /api/aiseo/prompts/seed:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/aiseo/prompts/update', (req, res) => {
  try {
    const { id, text, intent, isActive } = req.body;
    res.json(updateAiSeoPrompt({ id, text, intent, isActive }));
  } catch (err) {
    console.error('Error in POST /api/aiseo/prompts/update:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/aiseo/prompts/:promptId', (req, res) => {
  try {
    res.json(deleteAiSeoPrompt({ id: req.params.promptId }));
  } catch (err) {
    console.error('Error in DELETE /api/aiseo/prompts/:promptId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/aiseo/runs', (req, res) => {
  try {
    res.json(listAiSeoRuns({ days: req.query.days }));
  } catch (err) {
    console.error('Error in GET /api/aiseo/runs:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// One prompt per request — two Gemini round trips each, so the dashboard
// walks its list one at a time rather than holding a request open for a
// whole sweep.
app.post('/api/aiseo/runs/check', async (req, res) => {
  try {
    const { promptId, promptText } = req.body;
    res.status(201).json(await runAiSeoCheck({ promptId, promptText }));
  } catch (err) {
    console.error('Error in POST /api/aiseo/runs/check:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/aiseo/runs/manual', async (req, res) => {
  try {
    const { promptId, promptText, engine, answerText, citationUrls } = req.body;
    res.status(201).json(await logAiSeoManualRun({ promptId, promptText, engine, answerText, citationUrls }));
  } catch (err) {
    console.error('Error in POST /api/aiseo/runs/manual:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/aiseo/runs/:runId', (req, res) => {
  try {
    res.json(deleteAiSeoRun({ id: req.params.runId }));
  } catch (err) {
    console.error('Error in DELETE /api/aiseo/runs/:runId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ---- B2B clients (Ops > B2B Dashboard > Clients) ---------------------------

app.get('/api/b2b/clients', (req, res) => {
  try {
    res.json(listB2BClients());
  } catch (err) {
    console.error('Error in GET /api/b2b/clients:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/b2b/clients', (req, res) => {
  try {
    res.status(201).json(addB2BClient(req.body || {}));
  } catch (err) {
    console.error('Error in POST /api/b2b/clients:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/b2b/clients/update', (req, res) => {
  try {
    res.json(updateB2BClient(req.body || {}));
  } catch (err) {
    console.error('Error in POST /api/b2b/clients/update:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/b2b/clients/stage', (req, res) => {
  try {
    const { id, stage, lostReason } = req.body || {};
    res.json(setB2BClientStage({ id, stage, lostReason }));
  } catch (err) {
    console.error('Error in POST /api/b2b/clients/stage:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/b2b/clients/demands', (req, res) => {
  try {
    const { id, demands } = req.body || {};
    res.json(setB2BClientDemands({ id, demands }));
  } catch (err) {
    console.error('Error in POST /api/b2b/clients/demands:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/b2b/clients/:clientId', (req, res) => {
  try {
    res.json(deleteB2BClient({ id: req.params.clientId }));
  } catch (err) {
    console.error('Error in DELETE /api/b2b/clients/:clientId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Reddit poster server listening on http://localhost:${port}`));
