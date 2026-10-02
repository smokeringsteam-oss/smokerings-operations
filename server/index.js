import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { fileURLToPath } from 'url';
import {
  extractWeekendOrders,
  readOrderTimePreferences,
  suggestTaskPlacement,
  transcribeVoiceNote,
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
  carryOverOpenItems,
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
import {
  fetchWhatsappThreads,
  fetchWhatsappConversation,
  sendWhatsappReply,
} from './integrations/odooWhatsapp.js';
import {
  createTask as createScheduledTask,
  deleteTask as deleteScheduledTask,
  getRecurringSchedule,
  moveTask as moveScheduledTask,
  updateTask as updateScheduledTask,
} from './sprint/recurringSchedule.js';
import { getWeekStatus, setTaskStatus } from './sprint/weeklyScheduleStatusLog.js';
import { getTodayTasks, setTodayTaskDone, reassignTodayTask } from './sprint/todayTasks.js';
import {
  getConfig as getPurchasingConfig,
  getVendors,
  addVendor,
  getRawMaterials,
  getInventory,
  getLowStock,
  getPurchases,
  recordPurchases,
  recordExpense,
  catalogPurchaseItem,
  linkPurchaseToMaterial,
  linkPurchasesToOdoo,
  deletePurchase,
  getInventoryAdjustments,
  addInventoryAdjustment,
} from './ops/shared/purchasing.js';
import { MAX_IMAGE_BYTES as MAX_BILL_BYTES, scanPurchaseBill } from './ops/shared/purchaseScan.js';
import { suggestMatchesForPurchase } from './ops/shared/materialMatch.js';
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
  updateSessionWeights,
  completeResting,
  completeShredding,
  setFedOrders,
  getRealizedLossStats,
  deleteSession,
} from './ops/shared/smoking.js';
import { getStageLog } from './ops/shared/smokingStageLog.js';
import {
  deleteSubscription as deletePushSubscription,
  getPublicKey as getPushPublicKey,
  isConfigured as isPushConfigured,
  listSubscriptions as listPushSubscriptions,
  pruneDeliveries as prunePushDeliveries,
  saveSubscription as savePushSubscription,
} from './core/pushNotify.js';
import { listNotes, addNote, setNoteDone, assignNote, deleteNote } from './core/sharedNotes.js';
import { fileUnfiledNotes } from './integrations/noteIssues.js';
import {
  getTodayPending,
  runReminderTick,
  sendPendingDigestNow,
  DEFAULT_DIGEST_MINUTES,
} from './sprint/taskReminders.js';
import { runWhatsappAlertTick, sendAlarmTest } from './integrations/whatsappAlerts.js';
import { localAlarmState, stopLocalAlarm } from './integrations/localAlarm.js';
import { getMenu, computeSwiggyPlan, computeMeatPlan, computePrepPlan, getPackableSidesByItem, getMeatByItem } from './ops/b2c/recipes.js';
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
import { getPackingStatuses, setPackingStatus, setTrackingLink, retryInvoice } from './ops/shared/orderPackingStatus.js';
import { attachDistances, locateBoardAddresses } from './ops/shared/deliveryDistance.js';
import {
  backfillWatches,
  checkWatchNow,
  getDeliveryWatches,
  openWatchCount,
  runDeliveryWatchTick,
} from './ops/shared/deliveryWatch.js';
import { readPorterOrderWithEta } from './ops/shared/porterTracking.js';
import {
  listClients as listB2BClients,
  addClient as addB2BClient,
  updateClient as updateB2BClient,
  setStage as setB2BClientStage,
  setDemands as setB2BClientDemands,
  deleteClient as deleteB2BClient,
} from './ops/b2b/b2bClients.js';
import {
  listSales as listB2BSales,
  addSale as addB2BSale,
  updateSale as updateB2BSale,
  setLines as setB2BSaleLines,
  recordPayment as recordB2BPayment,
  deleteSale as deleteB2BSale,
  raiseInvoice as raiseB2BInvoice,
  invoicePdf as b2bInvoicePdf,
  invoiceCatalogue as b2bInvoiceCatalogue,
} from './ops/b2b/b2bSales.js';
import {
  CATEGORIES as SPEND_CATEGORIES,
  listBudgets,
  addBudget,
  updateBudget,
  deleteBudget,
} from './marketing/marketingBudget.js';
import {
  fetchAttributedOrders,
  fetchChannelOptions,
  setOrderAttribution,
  backfillUtmFromChannel,
} from './marketing/orderAttribution.js';
import { buildRoiReport } from './marketing/marketingRoi.js';
import { buildEngagementReport } from './marketing/siteEngagement.js';
import {
  MEDIUMS as LINK_MEDIUMS,
  listPresets as listLinkPresets,
  listSourceDetails as listLinkSourceDetails,
  listLinks,
  listCampaigns as listLinkCampaigns,
  saveLinks,
  deleteLink,
} from './marketing/trackedLinks.js';
import {
  MAX_AUDIO_BYTES,
  MAX_CLIP_BYTES,
  MEDIA_MAX_AGE_DAYS,
  CLIPS_DIR,
  RENDERS_DIR,
  buildRenderPlan,
  describeToolchain as describeReelToolchain,
  DEFAULT_TARGET as DEFAULT_REEL_TARGET,
  DEFAULT_LOOK as DEFAULT_REEL_LOOK,
  ensureMediaDirs,
  getRenderJob,
  recoverRenderJob,
  probeMedia,
  pruneOldMedia,
  startRender,
} from './marketing/reelStudio.js';
import {
  checkInstagramAccount,
  describeInstagramConfig,
  getPublishJob,
  startPublish,
} from './marketing/instagramGraph.js';
// The two destinations that take the bytes from here rather than fetching
// them: YouTube over OAuth, Drive over the GA4 service account.
import {
  describeYouTubeConfig,
  getUploadJob as getYouTubeJob,
  startUpload as startYouTubeUpload,
} from './marketing/youtubeUpload.js';
import {
  checkDriveFolder,
  forgetImportedSources,
  importDriveFile,
  listDriveLibrary,
  listDriveReels,
  describeDriveConfig,
  getDriveJob,
  startDriveUpload,
} from './integrations/googleDrive.js';
import { buildWeeklyReport, DEFAULT_WEEKS } from './finance/weeklyLedger.js';
import { buildItemSalesReport } from './finance/itemSales.js';
import { buildUnitEconomicsReport } from './finance/unitEconomics.js';
import { buildMaterialPriceSheet, saveMaterialPrice } from './finance/materialPrices.js';
import {
  listExpenseCategories,
  logSpend,
  getSpendLog,
  categorisePurchases,
} from './finance/purchaseLog.js';
import { describeConfig as describeGaConfig } from './integrations/googleAnalytics.js';
import { buildCustomerMapReport, pendingAddresses } from './marketing/customerGeography.js';
import { buildCompetitorReport, pendingCompetitorAddresses } from './marketing/competitors.js';
import { getAutoReelJob, startAutoReel } from './marketing/autoReel.js';
import { locateAddresses, pinAddress, forgetAddress } from './core/geocode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bill photos are read once by Gemini and thrown away, so they never touch
// the uploads folder — memory storage, and a hard
// size cap here as well as in scanPurchaseBill so an oversized file is
// rejected before it is fully buffered rather than after.
const billUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BILL_BYTES } });

// multer reports its own failures by calling next(err), which would skip the
// route's try/catch entirely and land the size limit as a bare 500 naming a
// code. Answered here instead, in the words the screen shows.
const readBillUpload = (req, res, next) =>
  billUpload.single('bill')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That file is over 10 MB — take the photo again at a smaller size.' });
    }
    console.error('Error uploading a bill scan:', err);
    return res.status(400).json({ error: err.message || String(err) });
  });

// Voice notes for the notes board, recorded in the browser and read once by
// Gemini. Kept in memory and dropped after the read, like bill photos. Ten
// megabytes is several minutes of compressed speech — far past any to-do.
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VOICE_BYTES } });
const readVoiceUpload = (req, res, next) =>
  voiceUpload.single('audio')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That recording is too long — keep voice notes under a couple of minutes.' });
    }
    console.error('Error uploading a voice note:', err);
    return res.status(400).json({ error: err.message || String(err) });
  });

// Reel clips are large and are the one thing here that genuinely has to land
// on disk rather than in memory — a 400MB buffer per clip would end the
// process. The stored name keeps a sanitised trace of the original so the
// uploads folder stays readable to a human, but it is the timestamp and the
// random suffix that make it unique; two clips named VID_0001.mp4 from two
// phones must not collide.
const reelStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { clipsDir } = ensureMediaDirs();
    cb(null, clipsDir);
  },
  filename: (req, file, cb) => {
    const parsed = path.parse(file.originalname || 'clip.mp4');
    const safeBase = parsed.name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clip';
    const safeExt = /^\.[A-Za-z0-9]{1,5}$/.test(parsed.ext) ? parsed.ext.toLowerCase() : '.mp4';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}${safeExt}`);
  },
});

// Same reason as readBillUpload above: multer's own errors bypass the route's
// try/catch, so the size limit is answered here in words rather than arriving
// as a bare 500. Clips and the music track share the storage but not the cap.
const readReelUpload = (field, maxBytes) => {
  const handler = multer({ storage: reelStorage, limits: { fileSize: maxBytes } }).array(field);
  return (req, res, next) =>
    handler(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(413)
          .json({ error: `That file is over ${Math.round(maxBytes / (1024 * 1024))} MB — trim it down first.` });
      }
      console.error('Error uploading reel media:', err);
      return res.status(400).json({ error: err.message || String(err) });
    });
};

const app = express();
// 16mb rather than the 100kb default: menu item pictures are posted as base64
// data URIs (see POST /api/ops/menu-items/image), and base64 inflates a file
// by about a third, so a phone photo would otherwise be rejected as a 413
// before any of our own size checks could give a useful message.
app.use(express.json({ limit: '16mb' }));
app.use(cors());

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
    res.json(attachDistances(result));
  } catch (err) {
    console.error('Error in GET /api/odoo/order-packing:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Geocodes the board's never-looked-up delivery addresses, then answers with
// the board again, distances filled in. Same range/channel as the GET; the
// addresses come off the Odoo fetch here, never from the client — see
// server/ops/shared/deliveryDistance.js.
app.post('/api/odoo/order-packing/locate', async (req, res) => {
  try {
    const { from, to, channel } = req.body || {};
    const result = await fetchOrderPackingList({ fromDate: from, toDate: to, channel });
    const located = await locateBoardAddresses(result);
    res.json({ ...attachDistances(result), located });
  } catch (err) {
    console.error('Error in POST /api/odoo/order-packing/locate:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// WhatsApp inbox — the customer conversations still waiting on us, for the
// Ops Dashboard view and the sidebar notification badge behind it. Both poll
// this same endpoint; it is read-only and cheap (four search_reads), and it
// answers 200 with available:false rather than erroring when Odoo or the
// WhatsApp module isn't set up, so a badge polling on a timer can't fill the
// console with failures. See server/integrations/odooWhatsapp.js for what
// counts as needing attention.
app.get('/api/odoo/whatsapp/threads', async (req, res) => {
  try {
    const result = await fetchWhatsappThreads({ limit: req.query.limit });
    res.json(result);
  } catch (err) {
    console.error('Error in GET /api/odoo/whatsapp/threads:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// One conversation's longer scroll-back, for the chat pane once a thread is
// opened — kept off the polled list endpoint so that stays cheap.
app.get('/api/odoo/whatsapp/threads/:channelId/messages', async (req, res) => {
  try {
    res.json(await fetchWhatsappConversation({ channelId: req.params.channelId, limit: req.query.limit }));
  } catch (err) {
    console.error('Error in GET /api/odoo/whatsapp/threads/:channelId/messages:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Sends a free-form reply to the customer through Odoo's WhatsApp module —
// the same post Odoo Discuss makes. Refused with 409 once the 24h window has
// shut (template-only territory, still done in Odoo).
app.post('/api/odoo/whatsapp/threads/:channelId/reply', async (req, res) => {
  try {
    res.json(await sendWhatsappReply({ channelId: req.params.channelId, text: req.body?.text }));
  } catch (err) {
    console.error('Error in POST /api/odoo/whatsapp/threads/:channelId/reply:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Backfills/re-syncs odoo_product_id on the materials catalogue against Odoo — see
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
// packaging go into one order of it, straight out of the bill of materials. Keyed
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

// Picker options for one relational field on that record (?field=categ_id&q=food).
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
// of any order counts. Order Management fetches this once and uses it to work
// out, per individual order, which sides can share one container.
app.get('/api/recipes/sides-by-item', (req, res) => {
  try {
    res.json({ sidesByItem: getPackableSidesByItem() });
  } catch (err) {
    console.error('Error in GET /api/recipes/sides-by-item:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Static reference — which smoked meats each menu item contains, no order
// counts involved. Order Management's Step 3 fetches this once to work out
// which orders the "pork in the smoker" / "chicken in the smoker" switches
// should move to IN_SMOKER.
app.get('/api/recipes/meat-by-item', (req, res) => {
  try {
    res.json({ meatByItem: getMeatByItem() });
  } catch (err) {
    console.error('Error in GET /api/recipes/meat-by-item:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Weekend Prep Planner's "Meat needed" tiles — per-order finished weight
// (the bill of materials) converted to a raw buy weight via each
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

// Order Management's "what to toast/warm before packing" table — buns, taco
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

// Order Management's In Smoker -> Prepping -> Packed -> Finding Partner ->
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

// Saves the order's Porter tracking link. `advance` (set by the board when
// the order is not yet out) also moves it to Out for Delivery — a live
// tracking link means a rider has the box.
app.post('/api/order-packing/tracking', async (req, res) => {
  try {
    const { orderId, orderName, trackingUrl, channel, advance } = req.body || {};
    res.json(await setTrackingLink({ orderId, orderName, trackingUrl, channel, advance: Boolean(advance) }));
  } catch (err) {
    console.error('Error in POST /api/order-packing/tracking:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The Porter delivery watch, per order — the ETA, what Porter last said, and
// whether the watch is still running (see server/ops/shared/deliveryWatch.js).
// ?orderIds=1,2,3 scopes it the same way the status lookup does.
app.get('/api/order-packing/delivery-watch', (req, res) => {
  try {
    const orderIds = req.query.orderIds ? String(req.query.orderIds).split(',').filter(Boolean) : undefined;
    res.json(getDeliveryWatches({ orderIds }));
  } catch (err) {
    console.error('Error in GET /api/order-packing/delivery-watch:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Checks one watched order against Porter right now rather than at its next
// due time — the card's "check now", and what to reach for when an order is
// known to have landed and nobody wants to wait for the poll.
app.post('/api/order-packing/delivery-watch/check', async (req, res) => {
  try {
    const { orderId } = req.body || {};
    res.json(await checkWatchNow(orderId));
  } catch (err) {
    console.error('Error in POST /api/order-packing/delivery-watch/check:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Reads a Porter link without touching any order — for pasting a link to see
// where the rider is, and for checking that a link is readable before it is
// saved. Nothing here writes.
app.get('/api/porter-tracking', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!url) {
      res.status(400).json({ error: 'url is required.' });
      return;
    }
    res.json(await readPorterOrderWithEta(url));
  } catch (err) {
    console.error('Error in GET /api/porter-tracking:', err);
    res.status(err.status || 502).json({ error: err.message || String(err), code: err.code || null });
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

// Weekend Prep Planner's "mark this weekend as done" flag — shared through
// the database (see server/ops/b2c/weekendStatus.js) rather than localStorage,
// keyed by the weekend_start (YYYY-MM-DD) the Step 1 Odoo date-range picker
// already uses.
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

    // The database first (the source of truth), Odoo second and best-effort —
    // same pattern as logging a purchase: a failed Odoo call doesn't undo the
    // vendor row, it's just reported back.
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
    const { vendorName, purchaseDate, channel, expenseCategory, lines } = req.body;
    // Client names are resolved from the B2B account book here rather than
    // taken from the body, so a renamed account can't leave two spellings of
    // itself in the purchase log. Same reason POST .../marinate resolves it,
    // and the same reason purchasing.js doesn't do the lookup itself: that
    // module has no business reading the B2B tables.
    const taggedLines =
      channel === 'B2B' && Array.isArray(lines) && lines.some((l) => l?.clientId)
        ? (() => {
            const byId = new Map(listB2BClients().clients.map((c) => [c.id, c.name]));
            return lines.map((line) =>
              line?.clientId ? { ...line, clientName: byId.get(line.clientId) || '' } : line,
            );
          })()
        : lines;
    const result = recordPurchases({ vendorName, purchaseDate, channel, expenseCategory, lines: taggedLines });
    res.status(201).json(result);
  } catch (err) {
    console.error('Error in POST /api/purchasing/purchases:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Finishes an ad hoc purchase line: creates the material it was bought as,
// links the buy to it, and applies the quantity to stock.
//
// This is the second half of POST .../purchases for a line typed in by name.
// That endpoint deliberately accepts an item the catalogue has never heard of
// — refusing it would mean nobody can log what they actually bought at the
// counter — and reports it back in `inventorySkipped` as a buy whose money
// landed but whose stock did not. This is what the screen calls to close
// that gap.
//
// Not exposed as a generic "create a material" endpoint. It is anchored to a
// purchase on purpose: the row it creates starts at zero and is moved by a
// buy that actually happened, so the count is always explained by something.
app.post('/api/purchasing/purchases/:purchaseId/catalog', (req, res) => {
  try {
    const { category, reorderLevel, standardCostInr } = req.body || {};
    const result = catalogPurchaseItem({
      purchaseId: req.params.purchaseId,
      category,
      reorderLevel,
      standardCostInr,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('Error in POST /api/purchasing/purchases/:purchaseId/catalog:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Which catalogue item this ad hoc line probably was — string similarity
// narrowed to a shortlist, then Gemini choosing from it. See
// server/ops/shared/materialMatch.js for why it is split that way.
//
// A GET because it is a read: nothing is written, no stock moves, and the
// same request twice is the same question twice. The screen asks it when the
// pitmaster opens the mapping panel on a line, and every answer is a
// suggestion they still have to click.
app.get('/api/purchasing/purchases/:purchaseId/match-suggestions', async (req, res) => {
  try {
    res.json(await suggestMatchesForPurchase(req.params.purchaseId));
  } catch (err) {
    console.error('Error in GET /api/purchasing/purchases/:purchaseId/match-suggestions:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The other way to finish an ad hoc line: link it to a catalogue item that
// already exists, rather than creating a new one for it (the endpoint above
// this one). Separate from .../catalog because they are different decisions
// with different consequences — this one moves stock onto an existing count,
// that one starts a new count — and because a wrong guess between them is
// what splits an ingredient across two rows.
app.post('/api/purchasing/purchases/:purchaseId/link', (req, res) => {
  try {
    const { materialId } = req.body || {};
    res.status(200).json(linkPurchaseToMaterial({ purchaseId: req.params.purchaseId, materialId }));
  } catch (err) {
    console.error('Error in POST /api/purchasing/purchases/:purchaseId/link:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Reads a photo of a vendor bill into draft purchase lines. Deliberately a
// read-only endpoint: it writes nothing, logs nothing and moves no stock —
// the screen loads what comes back into the cart, the pitmaster checks it
// against the paper, and POST /api/purchasing/purchases above is still the
// only thing that records a buy.
app.post('/api/purchasing/scan-bill', readBillUpload, async (req, res) => {
  try {
    const file = req.file;
    const result = await scanPurchaseBill({
      buffer: file?.buffer,
      mimeType: file?.mimetype,
      size: file?.size,
    });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/purchasing/scan-bill:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/purchasing/send-po', async (req, res) => {
  try {
    const { vendorName, lines, purchaseIds } = req.body;
    const result = await createPurchaseOrder({ vendorName, lines });
    // Link each purchase row to its matching Odoo PO line so a later
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

// Labour, logistics and miscellaneous spend — a purchase line like any other
// (see recordExpense), so it lists, deletes and mirrors through the purchase
// routes above. Saved to the database (and purchase_log.csv) first, then sent
// to Odoo as a draft PO against a "Labour" / "Logistics" / "Miscellaneous" service product,
// best-effort: a failed Odoo call keeps the entry and comes back as odoo.error.
app.post('/api/purchasing/expenses', async (req, res) => {
  try {
    const { kind, purchaseDate, channel, description, amount, quantity, unitPrice, notes } = req.body || {};
    const result = recordExpense({ kind, purchaseDate, channel, description, amount, quantity, unitPrice, notes });
    let odoo;
    try {
      const [line] = result.purchases;
      const po = await createPurchaseOrder({
        vendorName: line.vendor_name,
        lines: [
          {
            serviceProduct: kind,
            itemName: line.item_name,
            quantity: line.quantity_purchased,
            unitPrice: line.unit_price,
          },
        ],
      });
      linkPurchasesToOdoo({ purchaseIds: [line.purchase_id], poId: po.id, lineIds: po.lineIds });
      odoo = { name: po.name, url: po.url };
    } catch (odooErr) {
      console.error('Odoo PO for expense failed:', odooErr);
      odoo = { error: odooErr.message || String(odooErr) };
    }
    res.status(201).json({ ...result, odoo });
  } catch (err) {
    console.error('Error in POST /api/purchasing/expenses:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Manual inventory addition — stock that didn't come through a vendor
// purchase (opening stock, a correction found while counting, a return).
// Separate from POST /api/purchasing/purchases because there's no
// vendor/price attached; logs to inventory_adjustment instead of purchase but
// bumps quantity_on_hand the same way.
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

    // The database first (the source of truth), Odoo second and best-effort —
    // same pattern as logging a purchase / adding a vendor: a failed Odoo call
    // doesn't undo the write here, it's just reported back.
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

// Recipe dropdown options — the recipe table, filterable by category
// (Brine, Rub, ...).
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
    // doesn't know about the B2B tables (see the note on sessionClientId in
    // startBrining). Storing the name alongside the id keeps the session row
    // readable on its own; an id that no longer resolves just leaves the name
    // blank rather than failing the cook.
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
// the specific purchase lot it came from — see getAvailablePurchasesForMaterial.
// taggedPurchaseIds is the separate cost attribution: which buys were made
// for this cook, stamped onto the purchases' smoking_session_id.
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

// Corrects a session's raw / finished weights after the fact, from the "All
// sessions" table — see updateSessionWeights() in server/ops/shared/smoking.js.
app.post('/api/smoking/sessions/:sessionId/weights', (req, res) => {
  try {
    const { rawWeightKg, finishedWeightWithBoneKg, finishedWeightWithoutBoneKg } = req.body;
    const result = updateSessionWeights({
      sessionId: req.params.sessionId,
      rawWeightKg,
      finishedWeightWithBoneKg,
      finishedWeightWithoutBoneKg,
    });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/smoking/sessions/:sessionId/weights:', err);
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

// Deletes a smoking session entirely and reverses any inventory it had
// already consumed (mirrors DELETE /api/purchasing/purchases).
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

// Weekly recurring cadence (all 7 days), read live from the scheduled_task
// table — see server/sprint/recurringSchedule.js.
app.get('/api/recurring-schedule', (req, res) => {
  try {
    const schedule = getRecurringSchedule();
    res.json({ schedule });
  } catch (err) {
    console.error('Error in GET /api/recurring-schedule:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Editing that cadence, from Daily View's edit mode. Each of these answers
// with the whole schedule as it now stands rather than with just the row it
// touched: a move renumbers a day, an add lands at the bottom of one, and the
// page would otherwise have to reproduce that ordering itself and hope it
// matched. One round trip, one source of truth for the order.
app.post('/api/recurring-schedule/tasks', (req, res) => {
  try {
    const { day, label, time, assignedTo, category } = req.body;
    const created = createScheduledTask({ day, label, time, assignedTo, category });
    res.json({ ...created, schedule: getRecurringSchedule() });
  } catch (err) {
    console.error('Error in POST /api/recurring-schedule/tasks:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.patch('/api/recurring-schedule/tasks/:taskId', (req, res) => {
  try {
    const { label, time, assignedTo, category } = req.body;
    const updated = updateScheduledTask({ taskId: req.params.taskId, label, time, assignedTo, category });
    res.json({ ...updated, schedule: getRecurringSchedule() });
  } catch (err) {
    console.error('Error in PATCH /api/recurring-schedule/tasks:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/recurring-schedule/tasks/:taskId', (req, res) => {
  try {
    const removed = deleteScheduledTask({ taskId: req.params.taskId });
    res.json({ ...removed, schedule: getRecurringSchedule() });
  } catch (err) {
    console.error('Error in DELETE /api/recurring-schedule/tasks:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Both kinds of drag: within a day (day omitted) and across to another one.
app.post('/api/recurring-schedule/tasks/:taskId/move', (req, res) => {
  try {
    const { day, index } = req.body;
    const moved = moveScheduledTask({ taskId: req.params.taskId, day, index });
    res.json({ ...moved, schedule: getRecurringSchedule() });
  } catch (err) {
    console.error('Error in POST /api/recurring-schedule/tasks/move:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Per-week completion log for the recurring cadence — shared through the
// database (see server/sprint/weeklyScheduleStatusLog.js) rather than
// localStorage, keyed by the ISO week (e.g. "2026-W33"). A new week has no
// rows yet, so it starts fresh; past weeks' rows stay behind as a log.
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

// Where a newly typed task should be filed: which epic, what status, who is on
// it. A suggestion only — the answer lands in the add form's own dropdowns and
// the person adding the task can change any of it before anything is created.
// See suggestTaskPlacement in server/integrations/geminiContent.js.
//
// The epics, the logins and the statuses come from the caller rather than from
// here. They are the sprint board's own idea of what a top-level issue is (see
// EPIC_ISSUE_NUMBERS in SprintDashboard.tsx), and a second copy on this side
// would be a list to keep in step for no gain — the model is only ever allowed
// to pick from what it was handed, and the pick is checked against that list
// again before it comes back.
app.post('/api/github/sprint-board/suggest-placement', async (req, res) => {
  try {
    const { title, epics = [], assignees = [], statuses = [] } = req.body || {};
    res.json(await suggestTaskPlacement({ title, epics, assignees, statuses }));
  } catch (err) {
    console.error('Error in POST /api/github/sprint-board/suggest-placement:', err);
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

app.post('/api/github/migrate-backlog', async (req, res) => {
  try {
    const results = await migrateDraftsToIssues();
    res.json({ results });
  } catch (err) {
    console.error('Error in POST /api/github/migrate-backlog:', err);
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

// ---- B2B sales & payments (Ops > B2B Dashboard > Sales & Payments) --------
// Revenue is scoped by ?from/?to; the receivables block in the response is
// not, and neither ?clientId nor ?status narrows the totals — see the note in
// b2bSales.js listSales.

app.get('/api/b2b/sales', (req, res) => {
  try {
    const { from, to, clientId, status } = req.query || {};
    res.json(listB2BSales({ from, to, clientId, status }));
  } catch (err) {
    console.error('Error in GET /api/b2b/sales:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/b2b/sales', (req, res) => {
  try {
    res.status(201).json(addB2BSale(req.body || {}));
  } catch (err) {
    console.error('Error in POST /api/b2b/sales:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/b2b/sales/update', (req, res) => {
  try {
    res.json(updateB2BSale(req.body || {}));
  } catch (err) {
    console.error('Error in POST /api/b2b/sales/update:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/b2b/sales/payment', (req, res) => {
  try {
    const { id, amountPaid, paidOn } = req.body || {};
    res.json(recordB2BPayment({ id, amountPaid, paidOn }));
  } catch (err) {
    console.error('Error in POST /api/b2b/sales/payment:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/b2b/sales/:saleId', (req, res) => {
  try {
    res.json(deleteB2BSale({ id: req.params.saleId }));
  } catch (err) {
    console.error('Error in DELETE /api/b2b/sales/:saleId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The line-item picker: Odoo's sellable catalogue with the rate this client
// last paid folded in. ?clientId is optional — without it the rates are Odoo's
// list prices.
app.get('/api/b2b/sales/catalogue', async (req, res) => {
  try {
    res.json(await b2bInvoiceCatalogue({ clientId: req.query.clientId }));
  } catch (err) {
    console.error('Error in GET /api/b2b/sales/catalogue:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/b2b/sales/lines', (req, res) => {
  try {
    const { id, lines } = req.body || {};
    res.json(setB2BSaleLines({ id, lines }));
  } catch (err) {
    console.error('Error in POST /api/b2b/sales/lines:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Creates AND posts the invoice in Odoo — an entry in the books, not a draft.
// The store refuses a second run against the same sale, so a double-clicked
// button cannot bill a client twice.
app.post('/api/b2b/sales/invoice', async (req, res) => {
  try {
    res.json(await raiseB2BInvoice({ id: (req.body || {}).id }));
  } catch (err) {
    console.error('Error in POST /api/b2b/sales/invoice:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The PDF itself rather than a link to it. Odoo's portal URL carries the
// invoice's access token, which is a bearer credential for that document —
// handing it to the browser would put it in history, and in the address bar of
// whoever is looking over the shoulder. So the server fetches the file and
// streams the bytes.
app.get('/api/b2b/sales/:saleId/invoice.pdf', async (req, res) => {
  try {
    const { pdf, filename } = await b2bInvoicePdf({ id: req.params.saleId });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    console.error('Error in GET /api/b2b/sales/:saleId/invoice.pdf:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ---- Marketing ROI (Marketing > Marketing ROI) ----------------------------
// Invested vs generated: the spend ledger out of SQLite, the revenue out of
// Odoo, the traffic out of GA4 when it is set up. See
// server/marketing/marketingRoi.js for why unattributed revenue is reported
// as its own figure rather than spread across the channels.

app.get('/api/marketing/status', (req, res) => {
  // Both halves, so the screen can say which one is missing rather than
  // failing as a whole. Neither getter's secret-bearing fields are forwarded:
  // getOdooConfig carries the API key and describeGaConfig is already the
  // safe projection of the service account (see googleAnalytics.js).
  const { url, db, configured } = getOdooConfig();
  res.json({
    odoo: { url, db, configured },
    ga: describeGaConfig(),
    spendCategories: SPEND_CATEGORIES,
  });
});

app.get('/api/marketing/roi', async (req, res) => {
  try {
    const { from, to } = req.query || {};
    res.json(await buildRoiReport({ fromDate: from, toDate: to }));
  } catch (err) {
    console.error('Error in GET /api/marketing/roi:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The Site funnel tab: pages, scroll depth and the path to an order, all out
// of GA4. Its own route rather than another block on /roi, because it is six
// more GA round trips for a tab most loads never open — and because it fails
// differently. /roi survives GA being down (the money half is Odoo's); this
// cannot, so it returns the error and the screen says GA is the problem.
app.get('/api/marketing/engagement', async (req, res) => {
  try {
    const { from, to } = req.query || {};
    res.json(await buildEngagementReport({ fromDate: from, toDate: to }));
  } catch (err) {
    console.error('Error in GET /api/marketing/engagement:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ?from/?to are optional here, unlike on /roi: the spend screen also wants
// the whole ledger, and a row's `amountInRange` is its full amount when no
// window is given.
app.get('/api/marketing/budget', (req, res) => {
  try {
    const { from, to } = req.query || {};
    res.json({ spend: listBudgets({ fromDate: from, toDate: to }), categories: SPEND_CATEGORIES });
  } catch (err) {
    console.error('Error in GET /api/marketing/budget:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/marketing/budget', (req, res) => {
  try {
    res.status(201).json(addBudget(req.body || {}));
  } catch (err) {
    console.error('Error in POST /api/marketing/budget:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/marketing/budget/update', (req, res) => {
  try {
    res.json(updateBudget(req.body || {}));
  } catch (err) {
    console.error('Error in POST /api/marketing/budget/update:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/marketing/budget/:budgetId', (req, res) => {
  try {
    res.json(deleteBudget(req.params.budgetId));
  } catch (err) {
    console.error('Error in DELETE /api/marketing/budget/:budgetId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The tagging list: every order in the window with whatever attribution it
// carries, so the orders with none can be given one. `channels` comes from
// Odoo's own Order Source selection rather than a list in our code — see
// fetchChannelOptions.
app.get('/api/marketing/attribution/orders', async (req, res) => {
  try {
    const { from, to } = req.query || {};
    const [orders, options] = await Promise.all([
      fetchAttributedOrders({ fromDate: from, toDate: to }),
      fetchChannelOptions(),
    ]);
    res.json({ ...orders, channels: options.channels });
  } catch (err) {
    console.error('Error in GET /api/marketing/attribution/orders:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Writes the channel and campaign onto the Odoo order — the Studio selection
// AND Odoo's native campaign_id/source_id/medium_id, so Odoo's own reporting
// sees the same attribution this screen does.
app.post('/api/marketing/attribution', async (req, res) => {
  try {
    const { orderId, channel, campaign } = req.body || {};
    res.json(await setOrderAttribution({ orderId, channel, campaign }));
  } catch (err) {
    console.error('Error in POST /api/marketing/attribution:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Fills Odoo's native UTM fields in for orders that already have a channel
// but nothing Odoo can group by. Idempotent, and never invents a campaign —
// see backfillUtmFromChannel.
app.post('/api/marketing/attribution/backfill', async (req, res) => {
  try {
    const { from, to } = req.body || {};
    res.json(await backfillUtmFromChannel({ fromDate: from, toDate: to }));
  } catch (err) {
    console.error('Error in POST /api/marketing/attribution/backfill:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ---- Customer Map (Marketing > Customer Map) ------------------------------
// Where the orders come from, on a map. The report is a read of Odoo joined
// to the local geocode cache and is safe to build on every page load; putting
// a new address ON the map is a separate POST, because that is the call that
// sends an address to a third party. See the note at the top of
// server/core/geocode.js.

app.get('/api/marketing/customer-map', async (req, res) => {
  try {
    // Both optional: nothing at all gives the last twelve weeks.
    const { from, to } = req.query || {};
    res.json(await buildCustomerMapReport({ fromDate: from, toDate: to }));
  } catch (err) {
    console.error('Error in GET /api/marketing/customer-map:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Looks up the addresses in the range that have never been looked up, a
// batch at a time. The client says how many and over what range; it does NOT
// say which addresses — that list is derived here, so nothing but a customer
// address already in Odoo can be sent to the geocoder through this endpoint.
app.post('/api/marketing/customer-map/locate', async (req, res) => {
  try {
    const { from, to, limit } = req.body || {};
    const pending = await pendingAddresses({ fromDate: from, toDate: to });
    const result = await locateAddresses(pending, { limit });
    res.json(result);
  } catch (err) {
    console.error('Error in POST /api/marketing/customer-map/locate:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// A pin dropped by hand, for an address no geocoder is going to find — an
// apartment name, a landmark, a gate number. Overwrites whatever the lookup
// decided, and is never overwritten by a later one.
app.post('/api/marketing/customer-map/pin', (req, res) => {
  try {
    const { address, latitude, longitude, locality, postcode } = req.body || {};
    res.json({ pin: pinAddress({ address, latitude, longitude, locality, postcode }) });
  } catch (err) {
    console.error('Error in POST /api/marketing/customer-map/pin:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Forgets what we know about an address so it can be looked up again — the
// one thing this is for is an address that was wrong in Odoo and has since
// been fixed there.
app.post('/api/marketing/customer-map/forget', (req, res) => {
  try {
    const { address } = req.body || {};
    res.json({ forgotten: forgetAddress(address) });
  } catch (err) {
    console.error('Error in POST /api/marketing/customer-map/forget:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ---- Competitors (Marketing > Customer Map, Competitors view) -------------
// The other half of the same map: who else is selling smoked meat, and how
// close they are to the neighbourhoods our orders come from. The roster is
// hand-kept in server/marketing/competitors.js; the points come from the same
// geocode cache the customer side uses, so a competitor address is looked up
// once and never again, and a pin dropped on one is the same pin endpoint.

app.get('/api/marketing/competitors', async (req, res) => {
  try {
    // radius is how far from a competitor counts as "in their reach"; the
    // screen's slider sends it, and nothing sends it means three kilometres.
    const { from, to, radius } = req.query || {};
    res.json(await buildCompetitorReport({ fromDate: from, toDate: to, radiusKm: radius }));
  } catch (err) {
    console.error('Error in GET /api/marketing/competitors:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Looks up the competitor addresses nothing has ever looked up. The client
// says how many at most; the list itself comes from the roster on this
// machine, never from the request body.
app.post('/api/marketing/competitors/locate', async (req, res) => {
  try {
    const { limit } = req.body || {};
    res.json(await locateAddresses(pendingCompetitorAddresses(), { limit }));
  } catch (err) {
    console.error('Error in POST /api/marketing/competitors/locate:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ---- Tracked links & QR codes (Marketing > QR & Link Builder) -------------
// The other end of attribution from the tagging list above: instead of
// working out afterwards where an order came from, publish a link that says
// so. The QR code itself is drawn in the browser (src/pages/marketing/
// qrcode.ts) — nothing about a QR needs a server, and a code that only
// renders while the API is up would be a poor thing to send to a printer.

app.get('/api/marketing/links', (req, res) => {
  try {
    const { campaign } = req.query || {};
    res.json({
      links: listLinks({ campaign }),
      presets: listLinkPresets(),
      // What to offer for utm_content once a source is picked — 'Link in bio'
      // under Instagram, a subreddit under Reddit, a name under Referral.
      details: listLinkSourceDetails(),
      mediums: LINK_MEDIUMS,
      campaigns: listLinkCampaigns(),
      // Every link this screen builds points at the order page; the screen
      // shows it rather than asking for it, because it has never once been
      // anything else and a destination box was a field to skip past. Still
      // overridable by env for a landing page that isn't /order.
      defaultDestination: (process.env.MARKETING_SITE_URL || 'https://smokerings.in/order').trim(),
    });
  } catch (err) {
    console.error('Error in GET /api/marketing/links:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Takes one link or a batch of them, because the screen's whole point is
// building the same campaign for several sources at once — saving those one
// request at a time would leave a half-saved batch behind on the first bad
// row. Each is an upsert on its placement, so re-saving a corrected batch
// updates rather than duplicates.
app.post('/api/marketing/links', (req, res) => {
  try {
    const body = req.body || {};
    res.status(201).json({ links: saveLinks(Array.isArray(body.links) ? body.links : [body]) });
  } catch (err) {
    console.error('Error in POST /api/marketing/links:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/marketing/links/:linkId', (req, res) => {
  try {
    res.json(deleteLink(req.params.linkId));
  } catch (err) {
    console.error('Error in DELETE /api/marketing/links/:linkId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ---- Insta Reel Generator (Marketing > Insta Reel Generator) --------------
// Upload clips, arrange and trim them on a timeline, burn captions, render one
// vertical 1080x1920 file, then hand it to Instagram. server/marketing/
// reelStudio.js does the ffmpeg work and instagramGraph.js does the publish;
// the routes below are the thin layer between them and the screen.
//
// Two ideas run through all of them:
//
//   * A clip id IS its filename inside server/uploads/reels/clips. There is no
//     database table and no in-memory registry of uploads, so a server restart
//     mid-edit does not orphan a timeline that still references real files on
//     disk. That makes every id in a request body a path fragment supplied by
//     a client, which is why resolveMediaFile below is the only way any of
//     these routes turn one into a path.
//
//   * Rendering and publishing both take longer than a browser will hold a
//     request open, so both answer 202 with a job id and are polled.

// The whole defence against a request body reaching outside the media folder.
// A name is accepted only if it is a bare filename of safe characters *and*
// resolves back inside the directory it is supposed to be in — the second
// check catching anything the first did not think of.
function resolveMediaFile(dir, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
    const err = new Error('That file name is not one of ours.');
    err.status = 400;
    throw err;
  }
  const resolved = path.resolve(dir, name);
  if (path.dirname(resolved) !== path.resolve(dir)) {
    const err = new Error('That file name is not one of ours.');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(resolved)) {
    const err = new Error(`${name} is no longer on the server — re-upload it.`);
    err.status = 404;
    throw err;
  }
  return resolved;
}

// ffprobe costs a process spawn, and a ten-clip timeline is re-planned on
// every render. Keyed by name and mtime so a replaced file is never served
// from a stale probe.
const probeCache = new Map();
async function probeCached(filePath) {
  const { mtimeMs, size } = fs.statSync(filePath);
  const key = `${filePath}:${mtimeMs}:${size}`;
  if (!probeCache.has(key)) probeCache.set(key, await probeMedia(filePath));
  return probeCache.get(key);
}

// Everything the Share step needs to decide which destinations it can offer,
// in one call: what can be rendered, and which of the three places it can be
// sent to are actually wired up. A destination that is not configured is
// still shown — greyed, with the reason — rather than hidden, because a
// missing tile reads as a missing feature.
app.get('/api/marketing/reel/status', (req, res) => {
  res.json({
    toolchain: describeReelToolchain(),
    instagram: describeInstagramConfig(),
    youtube: describeYouTubeConfig(),
    drive: describeDriveConfig(),
  });
});

// Confirms the Drive folder is real and reachable before a 40MB upload is
// aimed at it, and says whether it is in a Shared Drive — which is the thing
// that decides whether uploads will work at all. See googleDrive.js.
app.get('/api/marketing/reel/drive-folder', async (req, res) => {
  try {
    res.json(await checkDriveFolder());
  } catch (err) {
    console.error('Error in GET /api/marketing/reel/drive-folder:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Confirms the token actually works and says whose account it is, so nobody
// posts to the wrong Instagram because two tokens looked alike in a .env file.
app.get('/api/marketing/reel/account', async (req, res) => {
  try {
    res.json(await checkInstagramAccount());
  } catch (err) {
    console.error('Error in GET /api/marketing/reel/account:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The stored name is `<timestamp>-<random>-<sanitised original>`; this gives
// the last part back so a listing reads like the file somebody dropped in
// rather than like a database key.
function displayNameOf(storedName) {
  return storedName.replace(/^\d+-[a-z0-9]{1,8}-/, '') || storedName;
}

// What is still on disk. The editor's draft lives in the browser but the media
// it points at does not, and the two go out of step on their own: clips are
// swept after a week (pruneOldMedia). So a restored timeline is reconciled
// against this rather than trusted — a clip that has been swept has to be
// dropped at load, with the operator told, instead of turning into a black
// block that fails the export twenty minutes later.
//
// Video and audio are separated by what ffprobe found in them rather than by
// where they were uploaded, because they were uploaded to the same folder.
app.get('/api/marketing/reel/clips', async (req, res) => {
  try {
    ensureMediaDirs();
    const clips = [];
    const audio = [];

    const names = fs.readdirSync(CLIPS_DIR);
    // Probed a batch at a time rather than one after another. Every probe is a
    // process spawn, and a week of clips is dozens of them: done serially this
    // route takes long enough that clips get dropped onto the page before it
    // answers. Batched rather than all at once because "all at once" on a full
    // folder means fifty ffprobes competing for the same disk.
    const PROBE_BATCH = 8;
    for (let start = 0; start < names.length; start += PROBE_BATCH) {
      const batch = names.slice(start, start + PROBE_BATCH);
      const probed = await Promise.all(
        batch.map(async (name) => {
          const filePath = path.join(CLIPS_DIR, name);
          try {
            if (!fs.statSync(filePath).isFile()) return null;
            return { name, probe: await probeCached(filePath) };
          } catch {
            // Unreadable is indistinguishable from gone as far as the editor
            // is concerned, and neither is worth an error here.
            return null;
          }
        }),
      );

      for (const result of probed) {
        if (!result) continue;
        const { name, probe } = result;
        const entry = {
          id: name,
          name: displayNameOf(name),
          url: `/api/marketing/reel/clip-file/${encodeURIComponent(name)}`,
          ...probe,
        };
        if (probe.hasVideo && probe.duration > 0) clips.push(entry);
        else if (probe.hasAudio && probe.duration > 0) audio.push(entry);
      }
    }

    // Newest first: the clips from the cook that just finished are the ones
    // being looked for.
    const byNewest = (a, b) => Number(b.id.split('-')[0] || 0) - Number(a.id.split('-')[0] || 0);
    res.json({ clips: clips.sort(byNewest), audio: audio.sort(byNewest), keptForDays: MEDIA_MAX_AGE_DAYS });
  } catch (err) {
    console.error('Error in GET /api/marketing/reel/clips:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Every upload is probed before it is answered for. The screen needs the real
// duration to draw a timeline and the real dimensions to warn about a
// landscape clip, and a file ffprobe cannot read is not a clip at all — better
// to say so at the moment it is dropped than at the moment it is rendered.
app.post('/api/marketing/reel/clips', readReelUpload('clips', MAX_CLIP_BYTES), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files were uploaded.' });

    const clips = [];
    for (const file of files) {
      let probe;
      try {
        probe = await probeCached(file.path);
      } catch {
        fs.rmSync(file.path, { force: true });
        return res
          .status(400)
          .json({ error: `${file.originalname} is not a video file we can read — try an .mp4 or .mov.` });
      }

      if (!probe.hasVideo || probe.duration <= 0) {
        fs.rmSync(file.path, { force: true });
        return res.status(400).json({ error: `${file.originalname} has no video track in it.` });
      }

      clips.push({
        id: file.filename,
        name: file.originalname,
        url: `/api/marketing/reel/clip-file/${encodeURIComponent(file.filename)}`,
        ...probe,
      });
    }

    res.json({ clips });
  } catch (err) {
    console.error('Error in POST /api/marketing/reel/clips:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/marketing/reel/music', readReelUpload('clips', MAX_AUDIO_BYTES), async (req, res) => {
  try {
    const file = (req.files || [])[0];
    if (!file) return res.status(400).json({ error: 'No audio file was uploaded.' });

    let probe;
    try {
      probe = await probeCached(file.path);
    } catch {
      fs.rmSync(file.path, { force: true });
      return res.status(400).json({ error: `${file.originalname} is not an audio file we can read.` });
    }

    if (!probe.hasAudio) {
      fs.rmSync(file.path, { force: true });
      return res.status(400).json({ error: `${file.originalname} has no audio track in it.` });
    }

    res.json({
      music: {
        id: file.filename,
        name: file.originalname,
        url: `/api/marketing/reel/clip-file/${encodeURIComponent(file.filename)}`,
        duration: probe.duration,
      },
    });
  } catch (err) {
    console.error('Error in POST /api/marketing/reel/music:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Serves an uploaded clip back for preview. sendFile answers Range requests,
// which is not a detail — without them the <video> element on the editor
// screen can play a clip but cannot seek within it, and seeking is the whole
// point of a trim control.
app.get('/api/marketing/reel/clip-file/:name', (req, res) => {
  try {
    res.sendFile(resolveMediaFile(CLIPS_DIR, req.params.name));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.delete('/api/marketing/reel/clips/:name', (req, res) => {
  try {
    fs.rmSync(resolveMediaFile(CLIPS_DIR, req.params.name), { force: true });
    res.json({ removed: req.params.name });
  } catch (err) {
    console.error('Error in DELETE /api/marketing/reel/clips/:name:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Rough cut — the first pass at an edit, made by measuring the footage.
//
// One ffmpeg decode per clip finds the scene changes, the black frames, the
// THE SOURCE LIBRARY, and the automatic build that runs off it.
//
// Everything a reel is made from lives in one Google Drive folder: the clips
// shot during the cook, dropped in from a phone, and the songs to lay under
// them. This lists that folder, and the route below turns a selection from it
// into a finished video without anybody opening an editor.
//
// The folder is pinned server-side in googleDrive.js and there is deliberately
// no way to ask these routes for a different one. drive.readonly can reach the
// whole account — Google sells no folder-scoped Drive scope — so the pin is
// what makes "only that folder" true, and a folder parameter here would undo
// it. Import re-checks membership per file for the same reason.
app.get('/api/marketing/reel/drive/library', async (req, res) => {
  try {
    res.json(await listDriveLibrary());
  } catch (err) {
    console.error('Error in GET /api/marketing/reel/drive/library:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Pick the clips, pick a song, get a reel.
//
// Answers 202 with a build id and nothing else useful: fetching several
// hundred megabytes out of Drive, decoding every clip, and asking a model for
// captions is minutes of work, well past any sensible request timeout. The
// five stages are in server/marketing/autoReel.js and the screen polls the
// route below for which one is running.
app.post('/api/marketing/reel/auto', (req, res) => {
  try {
    const {
      clipFileIds = [],
      songFileId = '',
      target = DEFAULT_REEL_TARGET,
      look = DEFAULT_REEL_LOOK,
      targetSeconds,
      maxShotSeconds,
      musicMode,
      sessionHint,
    } = req.body || {};

    const job = startAutoReel({
      clipFileIds,
      songFileId,
      target,
      look,
      targetSeconds,
      maxShotSeconds,
      musicMode,
      sessionHint,
    });
    res.status(202).json(job);
  } catch (err) {
    console.error('Error in POST /api/marketing/reel/auto:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Where the build has got to.
//
// Once it reaches `rendering` the job carries a renderId and the screen
// switches to polling the render route, which is the same one every other way
// of making a reel ends at — so the review and share steps below needed no
// changes to work with an automatic build.
app.get('/api/marketing/reel/auto/:buildId', (req, res) => {
  const job = getAutoReelJob(req.params.buildId);
  if (!job) return res.status(404).json({ error: 'That build is not on this server. It may have restarted.' });
  res.json(job);
});

app.post('/api/marketing/reel/render', async (req, res) => {
  try {
    const { clips = [], music = null, target = DEFAULT_REEL_TARGET, look = DEFAULT_REEL_LOOK } = req.body || {};
    if (!Array.isArray(clips) || !clips.length) {
      return res.status(400).json({ error: 'Add at least one clip before rendering.' });
    }

    // Resolve every id the timeline names into a real file plus its probe, and
    // hand that to the planner. The planner never sees a client-supplied path.
    const sources = {};
    for (const clip of clips) {
      const filePath = resolveMediaFile(CLIPS_DIR, clip.id);
      const probe = await probeCached(filePath);
      sources[clip.id] = { path: filePath, name: clip.name || clip.id, duration: probe.duration, hasAudio: probe.hasAudio };
    }

    let plannedMusic = null;
    if (music && music.id) {
      const musicPath = resolveMediaFile(CLIPS_DIR, music.id);
      plannedMusic = {
        path: musicPath,
        name: music.name || music.id,
        mode: music.mode,
        volume: music.volume,
        originalVolume: music.originalVolume,
      };
    }

    const plan = buildRenderPlan({ clips, sources, music: plannedMusic, target, look });

    // Sweep before starting rather than after finishing: a render that fails
    // still leaves its inputs behind, and this is the moment we know nothing
    // older is in use.
    pruneOldMedia();
    // The sweep can delete a Drive import that autoReel is caching a path to,
    // so the cache is reconciled against the disk in the same breath.
    forgetImportedSources();

    const job = startRender(plan);
    res.status(202).json({
      renderId: job.renderId,
      status: job.status,
      totalDuration: job.totalDuration,
      warnings: job.warnings,
    });
  } catch (err) {
    console.error('Error in POST /api/marketing/reel/render:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/marketing/reel/render/:renderId', async (req, res) => {
  // A miss here usually means this process is not the one that started the
  // render — `node --watch` restarts on any server edit, and the job table is
  // in memory. If the encode had already finished, the file is still on disk
  // and can be matched back to the id, so look before saying no.
  let job = getRenderJob(req.params.renderId);
  if (!job) job = await recoverRenderJob(req.params.renderId).catch(() => null);
  if (!job) {
    return res.status(404).json({
      error:
        'This server has no record of that export. It restarts whenever a server file is saved, which loses an encode that was still running — start the export again.',
    });
  }

  res.json({
    renderId: job.renderId,
    status: job.status,
    percent: job.percent,
    error: job.error,
    warnings: job.warnings,
    totalDuration: job.totalDuration,
    sizeBytes: job.sizeBytes,
    // What was actually made, not what the screen currently has selected: the
    // Share step offers destinations against the file on disk, and the target
    // dropdown can be changed after an export without re-running it.
    target: job.target,
    width: job.width,
    height: job.height,
    // Only offered once the file is actually complete; a URL to a half-written
    // mp4 is worse than no URL.
    url: job.status === 'ready' ? `/api/marketing/reel/render-file/${encodeURIComponent(job.fileName)}` : null,
    fileName: job.status === 'ready' ? job.fileName : null,
  });
});

// The finished reel. This route is also the one Instagram's own servers fetch
// during a publish (see instagramGraph.js — the Graph API pulls the video from
// a public URL rather than accepting an upload), so it must stay reachable
// without a session and must keep answering Range requests.
app.get('/api/marketing/reel/render-file/:name', (req, res) => {
  try {
    const filePath = resolveMediaFile(RENDERS_DIR, req.params.name);
    if (req.query.download) res.attachment(req.params.name);
    res.sendFile(filePath);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/marketing/reel/publish', (req, res) => {
  try {
    const { fileName, target = 'story', caption = '', shareToFeed = false } = req.body || {};
    // Confirms the render exists before Instagram is told to come and get it.
    resolveMediaFile(RENDERS_DIR, fileName);

    const job = startPublish({
      fileName,
      target: target === 'reel' ? 'reel' : 'story',
      caption: String(caption || '').slice(0, 2200),
      shareToFeed: Boolean(shareToFeed),
    });
    res.status(202).json({ publishId: job.publishId, status: job.status, stage: job.stage });
  } catch (err) {
    console.error('Error in POST /api/marketing/reel/publish:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/marketing/reel/publish/:publishId', (req, res) => {
  const job = getPublishJob(req.params.publishId);
  if (!job) return res.status(404).json({ error: 'That publish is not one this server knows about.' });
  res.json(job);
});

// YouTube, unlike Instagram, takes the bytes from here — so this one works
// without PUBLIC_BASE_URL or a tunnel. See server/marketing/youtubeUpload.js,
// including why an unaudited API project forces every upload to private.
app.post('/api/marketing/reel/youtube', (req, res) => {
  try {
    const { fileName, title = '', description = '', privacyStatus = 'public', tags = [] } = req.body || {};
    resolveMediaFile(RENDERS_DIR, fileName);

    const job = startYouTubeUpload({ fileName, title, description, privacyStatus, tags });
    res.status(202).json({ uploadId: job.uploadId, status: job.status, stage: job.stage });
  } catch (err) {
    console.error('Error in POST /api/marketing/reel/youtube:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/marketing/reel/youtube/:uploadId', (req, res) => {
  const job = getYouTubeJob(req.params.uploadId);
  if (!job) return res.status(404).json({ error: 'That upload is not one this server knows about.' });
  res.json(job);
});

// The master copy. Not a publish — nothing transcodes it and nothing decides
// when it goes live — which is exactly why it is worth having alongside the
// two destinations that re-encode.
// Past reels, for reposting. See the "Coming back the other way" section of
// googleDrive.js — this lists only what this app itself uploaded, because the
// drive.file scope cannot see anything else in the account.
app.get('/api/marketing/reel/drive/files', async (req, res) => {
  try {
    res.json({ files: await listDriveReels({ limit: req.query.limit }) });
  } catch (err) {
    console.error('Error in GET /api/marketing/reel/drive/files:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Pulls one back down and hands it over in exactly the shape a finished
// export has, so the review screen and every destination take it without
// knowing it came from Drive rather than out of ffmpeg.
//
// The probe is not decoration. The Share step greys out destinations whose
// shape does not match the file — posting a landscape video as a Story
// letterboxes it into something nobody meant to publish — and an imported
// file has no target recorded anywhere. Its dimensions are the honest
// substitute: upright means the three vertical targets, landscape means the
// YouTube video, and that is precisely the distinction the Share step makes.
app.post('/api/marketing/reel/drive/import', async (req, res) => {
  try {
    const { fileId } = req.body || {};
    const { renderId, fileName, outputPath, driveName } = await importDriveFile(fileId);

    let probe;
    try {
      probe = await probeMedia(outputPath);
    } catch {
      fs.rmSync(outputPath, { force: true });
      const err = new Error(
        `"${driveName}" came down from Drive but could not be read as a video. It may have been damaged in the upload.`,
      );
      err.status = 422;
      throw err;
    }

    const upright = probe.height >= probe.width;
    res.json({
      renderId,
      status: 'ready',
      percent: 100,
      error: null,
      warnings: [`Imported from Drive: ${driveName}`],
      totalDuration: probe.duration,
      sizeBytes: fs.statSync(outputPath).size,
      target: upright ? 'ig-reel' : 'yt-video',
      width: probe.width,
      height: probe.height,
      url: `/api/marketing/reel/render-file/${encodeURIComponent(fileName)}`,
      fileName,
    });
  } catch (err) {
    console.error('Error in POST /api/marketing/reel/drive/import:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/marketing/reel/drive', (req, res) => {
  try {
    const { fileName, name = '' } = req.body || {};
    resolveMediaFile(RENDERS_DIR, fileName);

    const job = startDriveUpload({ fileName, name: String(name || '').trim() });
    res.status(202).json({ uploadId: job.uploadId, status: job.status, stage: job.stage });
  } catch (err) {
    console.error('Error in POST /api/marketing/reel/drive:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/marketing/reel/drive/:uploadId', (req, res) => {
  const job = getDriveJob(req.params.uploadId);
  if (!job) return res.status(404).json({ error: 'That upload is not one this server knows about.' });
  res.json(job);
});

// ---- Finance (Finance > Spending vs Sales) --------------------------------
// Money out against money in, one row per Monday-to-Sunday week. Purchases and
// wholesale invoices come out of SQLite, so this answers with or without Odoo;
// the B2C half needs Odoo and says so when it is missing. See
// server/finance/weeklyLedger.js for why the week runs Monday to Sunday and
// why Odoo orders tagged B2B are held out of the totals.

app.get('/api/finance/weekly', async (req, res) => {
  try {
    // All three are optional: `weeks` alone walks back from today, `from`/`to`
    // pin an explicit window, and nothing at all gives the last quarter.
    const { from, to, weeks } = req.query || {};
    res.json(await buildWeeklyReport({ fromDate: from, toDate: to, weeks }));
  } catch (err) {
    console.error('Error in GET /api/finance/weekly:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Sales by Item — units and revenue per dish over time, plus what is rising
// and falling between the two halves of the range. See
// server/finance/itemSales.js for why the B2C and B2B unit counts are kept
// apart rather than added together.
app.get('/api/finance/item-sales', async (req, res) => {
  try {
    // All three optional: nothing at all gives the last twelve weeks.
    const { from, to, granularity } = req.query || {};
    res.json(await buildItemSalesReport({ fromDate: from, toDate: to, granularity }));
  } catch (err) {
    console.error('Error in GET /api/finance/item-sales:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Per-unit economics — what a dish costs to make, and what a week of them
// costs. The costs are walked out of the bill of materials by
// server/finance/unitCost.js and are UNDERSTATED wherever an ingredient has
// no price on file; every item carries the coverage figure that says by how
// much, and the report's `gaps` list names what is missing. Weekly buckets
// always — see the note at the top of server/finance/unitEconomics.js.
app.get('/api/finance/unit-economics', async (req, res) => {
  try {
    // Both optional: nothing at all gives the same default window Sales by
    // Item opens on.
    const { from, to } = req.query || {};
    res.json(await buildUnitEconomicsReport({ fromDate: from, toDate: to }));
  } catch (err) {
    console.error('Error in GET /api/finance/unit-economics:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The price sheet under the Cost to Make report — every raw material, what
// the purchase log already says about its price and pack size, and the gaps
// still to fill. Separate from the report because it needs no Odoo read, so
// saving a row and re-reading the sheet is instant. See
// server/finance/materialPrices.js.
app.get('/api/finance/material-prices', (req, res) => {
  try {
    res.json(buildMaterialPriceSheet());
  } catch (err) {
    console.error('Error in GET /api/finance/material-prices:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// One row saved: a pack size (required) and a standard price (optional — a
// material the purchase log prices only needs the pack). Answers with the
// whole sheet rebuilt.
app.put('/api/finance/material-prices/:materialId', (req, res) => {
  try {
    const { priceInr, packSize, packUnit } = req.body || {};
    res.json(saveMaterialPrice({ materialId: req.params.materialId, priceInr, packSize, packUnit }));
  } catch (err) {
    console.error('Error in PUT /api/finance/material-prices/:materialId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Purchase Logger — the spend ledger with a category on it. See
// server/finance/purchaseLog.js for why this writes the same `purchase`
// table Weekly Purchasing does rather than a book of its own, and
// server/core/expenseCategories.js for the twelve categories and why ad spend
// is not one of them.

// The vocabulary, served rather than duplicated in the frontend: one list, so
// the dropdown cannot offer a category the writer will reject.
app.get('/api/finance/expense-categories', (req, res) => {
  res.json(listExpenseCategories());
});

// The log plus its rollups. Every filter is optional; nothing at all gives the
// last 90 days. The category and channel totals are always computed over the
// whole range, not over the filter — see getSpendLog.
app.get('/api/finance/purchase-log', (req, res) => {
  try {
    const { from, to, channel, category, vendor, uncategorisedOnly } = req.query || {};
    res.json(
      getSpendLog({
        from,
        to,
        channel,
        category,
        vendor,
        // Query strings have no booleans; anything but the literal 'true' is
        // off, so a stray '0' or 'false' cannot read as on.
        uncategorisedOnly: uncategorisedOnly === 'true',
      }),
    );
  } catch (err) {
    console.error('Error in GET /api/finance/purchase-log:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Records spend. Same body as POST /api/purchasing/purchases plus a required
// expenseCategory, and it goes through the same writer — the difference is
// that this one refuses a cart with no category on it.
//
// The B2B client name is resolved from the account book here for the same
// reason it is on the ops endpoint: a renamed account must not leave two
// spellings of itself in the purchase log.
app.post('/api/finance/purchase-log', (req, res) => {
  try {
    const { vendorName, purchaseDate, channel, expenseCategory, lines, notes } = req.body || {};
    const taggedLines =
      channel === 'B2B' && Array.isArray(lines) && lines.some((l) => l?.clientId)
        ? (() => {
            const byId = new Map(listB2BClients().clients.map((c) => [c.id, c.name]));
            return lines.map((line) =>
              line?.clientId ? { ...line, clientName: byId.get(line.clientId) || '' } : line,
            );
          })()
        : lines;
    res.status(201).json(
      logSpend({ vendorName, purchaseDate, channel, expenseCategory, lines: taggedLines, notes }),
    );
  } catch (err) {
    console.error('Error in POST /api/finance/purchase-log:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Puts a category on lines already logged — the backfill, and the standing
// queue of ad hoc lines Weekly Purchasing leaves blank on purpose. PATCH
// rather than POST because it edits rows that already exist, and it takes a
// list because doing forty of them one request at a time is how a backfill
// gets abandoned halfway.
app.patch('/api/finance/purchase-log/categories', (req, res) => {
  try {
    const { purchaseIds, expenseCategory } = req.body || {};
    res.json(categorisePurchases({ purchaseIds, expenseCategory }));
  } catch (err) {
    console.error('Error in PATCH /api/finance/purchase-log/categories:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/finance/status', (req, res) => {
  const { url, db, configured } = getOdooConfig();
  res.json({ odoo: { url, db, configured }, defaultWeeks: DEFAULT_WEEKS });
});

// ---- Shared notes -------------------------------------------------------
//
// The note bubble in the top bar. Its endpoints carry no business rules of
// their own — see server/core/sharedNotes.js for what a note is and why the
// table is append-only, and server/sprint/todayTasks.js for the strip of
// today's cadence the same panel pins above the board.

// Today's cadence, pinned above the board in the same panel — see
// server/sprint/todayTasks.js for why the two live together. Deliberately a
// separate endpoint rather than a field on the notes payload: the panel only
// asks for this while it is open, whereas the notes poll runs all session
// behind the bubble's unread count.
app.get('/api/today-tasks', (req, res) => {
  try {
    res.json(getTodayTasks());
  } catch (err) {
    console.error('Error in GET /api/today-tasks:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Ticks one of them. The same write Daily View makes — same table, same CSV
// mirror — so the two screens can never disagree about what is done.
app.post('/api/today-tasks/:taskId', (req, res) => {
  try {
    const { done } = req.body || {};
    res.json(setTodayTaskDone({ taskId: req.params.taskId, done }));
  } catch (err) {
    console.error('Error in POST /api/today-tasks/:taskId:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Hands one to someone else for this week — the override Daily View's
// assignee box writes, so the two screens agree on whose it is.
app.post('/api/today-tasks/:taskId/assignee', (req, res) => {
  try {
    const { assignedTo } = req.body || {};
    res.json(reassignTodayTask({ taskId: req.params.taskId, assignedTo }));
  } catch (err) {
    console.error('Error in POST /api/today-tasks/:taskId/assignee:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});


// The panel's whole payload: the newest notes oldest-first, the board counts,
// and the names that have posted. Polled by every open dashboard, so it stays
// a couple of cheap reads of a small table.
//
// ?q= filters on the note text and the poster's name; ?author= narrows to one
// person by whole name, and the two stack. Server-side because the browser
// only ever holds the most recent page of notes — see listNotes.
// Turns a recorded voice note into text for the composer. Writes nothing:
// the words go back into the box, and the person still presses Add.
app.post('/api/notes/transcribe', readVoiceUpload, async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ error: 'No recording was uploaded.' });
    res.json(await transcribeVoiceNote({ audioBase64: file.buffer.toString('base64'), mimeType: file.mimetype }));
  } catch (err) {
    console.error('Error in POST /api/notes/transcribe:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.get('/api/notes', (req, res) => {
  try {
    res.json(listNotes({ q: req.query?.q, author: req.query?.author }));
  } catch (err) {
    console.error('Error in GET /api/notes:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Posts one. 201 with the stored note, so the device that wrote it gets the
// server's id and timestamp back and can drop its optimistic copy rather than
// wait for the next poll to reconcile them.
app.post('/api/notes', (req, res) => {
  try {
    const { body, author } = req.body || {};
    res.status(201).json(addNote({ body, author }));
    // Filed to GitHub after the reply, never before it — see
    // server/integrations/noteIssues.js. Also retries any earlier note that
    // did not get filed.
    void fileUnfiledNotes().then((results) => {
      results.forEach((r) =>
        r.error
          ? console.error(`Note ${r.noteId} not filed to GitHub: ${r.error}`)
          : console.log(`Note ${r.noteId} filed as issue #${r.issue} under #${r.category}`),
      );
    });
  } catch (err) {
    console.error('Error in POST /api/notes:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Ticks or unticks one. PATCH rather than POST because it edits a row that
// already exists, and the tick lives on the server rather than in the browser
// so that one person marking a job done is visible to everyone else.
app.patch('/api/notes/:id', (req, res) => {
  try {
    const { done, by } = req.body || {};
    res.json(setNoteDone({ id: req.params.id, done, by }));
  } catch (err) {
    console.error('Error in PATCH /api/notes/:id:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Hands a note to someone else, or back to nobody with a blank name.
app.patch('/api/notes/:id/assignee', (req, res) => {
  try {
    const { assignedTo } = req.body || {};
    res.json(assignNote({ id: req.params.id, assignedTo }));
  } catch (err) {
    console.error('Error in PATCH /api/notes/:id/assignee:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Deletes one. Deliberately 200 rather than 404 for a note that has already
// gone — two devices tapping the same X is ordinary, and both of them wanted
// the same end state.
app.delete('/api/notes/:id', (req, res) => {
  try {
    res.json(deleteNote({ id: req.params.id }));
  } catch (err) {
    console.error('Error in DELETE /api/notes/:id:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// ---- Push notifications -------------------------------------------------
//
// Reminders for whatever is still pending today, delivered to the phone rather
// than waiting on the dashboard for someone to open it. See
// server/core/pushNotify.js for the path a notification takes and why legion
// has to be awake for any of it to happen.

// What the toggle in Daily View needs to render itself: whether this server can
// send at all, the public key a browser needs to subscribe, and who is
// currently subscribed.
app.get('/api/push/status', (req, res) => {
  try {
    res.json({
      configured: isPushConfigured(),
      publicKey: getPushPublicKey(),
      subscriptions: listPushSubscriptions(),
      digestTime: pushDigestLabel(),
      // Whether legion can shout on its own, and whether it is doing so right
      // now. Reported alongside the subscriptions because the two answer the
      // same question from opposite ends — a server with no subscribers is
      // not necessarily a server that cannot reach anybody.
      localAlarm: localAlarmState(),
    });
  } catch (err) {
    console.error('Error in GET /api/push/status:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/push/subscribe', (req, res) => {
  try {
    const { subscription, label } = req.body || {};
    if (!isPushConfigured()) {
      return res
        .status(503)
        .json({ error: 'Push is not configured on the server — no VAPID keys in .env.' });
    }
    res.status(201).json(savePushSubscription({ ...(subscription || {}), label }));
  } catch (err) {
    console.error('Error in POST /api/push/subscribe:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/push/unsubscribe', (req, res) => {
  try {
    res.json(deletePushSubscription((req.body || {}).endpoint));
  } catch (err) {
    console.error('Error in POST /api/push/unsubscribe:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The "send it now" button. Deliberately the real digest rather than a canned
// "hello" — proving the pipeline works means seeing what a reminder will
// actually look like, including the case where there is nothing left to do.
app.post('/api/push/test', async (req, res) => {
  try {
    const result = await sendPendingDigestNow();
    res.json({
      ...result,
      message:
        result.message ||
        (result.sent
          ? `Sent to ${result.sent} device${result.sent === 1 ? '' : 's'}.`
          : 'Nothing was sent — no device has notifications turned on yet.'),
    });
  } catch (err) {
    console.error('Error in POST /api/push/test:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// The alarm's own test button, separate from the digest's.
//
// It has to be separate: the digest test proves delivery, this one proves the
// noisy half — the Android channel sound, the vibrate pattern, and the audio
// loop on whatever page is open. Those fail independently of delivery and of
// each other, and a single button would leave you guessing which.
app.post('/api/push/alarm-test', async (req, res) => {
  try {
    res.json(await sendAlarmTest());
  } catch (err) {
    console.error('Error in POST /api/push/alarm-test:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// Silence legion's own speakers.
//
// The page's Stop button stops the page. This is how it stops the OTHER noise
// — the one coming out of the machine in the corner, which the page has no
// other way to reach. Called by whatsappAlarm.ts's stop(), so one press
// silences both, which is what anybody pressing Stop means.
//
// Unauthenticated like the rest of this server, and safe to be: the worst it
// can do is make a noise stop, and everything here is already behind the
// tailnet.
app.post('/api/push/alarm-stop', (req, res) => {
  try {
    res.json(stopLocalAlarm('stopped from the dashboard'));
  } catch (err) {
    console.error('Error in POST /api/push/alarm-stop:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// What the reminder would consider pending right now. Exists for the times the
// question is "why didn't it tell me?", which is otherwise unanswerable
// without a database prompt.
app.get('/api/push/pending', (req, res) => {
  try {
    res.json(getTodayPending());
  } catch (err) {
    console.error('Error in GET /api/push/pending:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

// PUSH_DIGEST_TIME as "HH:MM", the hour the morning digest goes out. Parsed
// once here rather than per tick, and falling back to the module's default if
// it is set to something that isn't a time.
function pushDigestMinutes() {
  const raw = (process.env.PUSH_DIGEST_TIME || '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return DEFAULT_DIGEST_MINUTES;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return DEFAULT_DIGEST_MINUTES;
  return hours * 60 + minutes;
}

function pushDigestLabel() {
  const total = pushDigestMinutes();
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// The timer.
//
// Once a minute, which is as coarse as it can be while still hitting a task
// scheduled at a specific minute. It is cheap — two indexed reads against a
// table of a few dozen rows — and it sends nothing unless something is both
// due and unclaimed, so the overwhelming majority of ticks do no work at all.
//
// unref() so this never holds the process open: with it referenced, Ctrl-C on
// a dev server would hang for up to a minute waiting on a timer that has
// nothing to say.
const PUSH_TICK_MS = 60 * 1000;
if (process.env.PUSH_REMINDERS !== 'off') {
  const tick = () => {
    runReminderTick(new Date(), { digestMinutes: pushDigestMinutes() }).then((result) => {
      if (result?.sent) console.log(`[push] sent ${result.sent} notification(s)`);
    });
  };
  setInterval(tick, PUSH_TICK_MS).unref();
  // A first pass on startup rather than a minute from now: the server is
  // restarted often enough (every backend edit) that always waiting a minute
  // would make a reminder due in that window quietly disappear.
  tick();
  // Old delivery claims, cleared once per boot — see pushNotify.js for why
  // this is a startup job rather than a scheduled one.
  try {
    const pruned = prunePushDeliveries();
    if (pruned) console.log(`[push] pruned ${pruned} old delivery record(s)`);
  } catch (err) {
    console.error('[push] could not prune delivery records —', err.message);
  }
}

// The WhatsApp alarm.
//
// Its own timer rather than a line inside the reminder tick, because the two
// have nothing in common but the word "push": this one calls out to Odoo over
// the network every pass, and the reminder tick is two indexed reads that must
// stay cheap enough to run every minute forever. Keeping them apart also means
// an Odoo that is down or slow cannot delay a task nudge.
//
// One minute matches the inbox poll the dashboard already does
// (useWhatsappAttention.ts), so the badge and the alarm learn about a message
// on the same beat and can never disagree about whether it exists.
//
// No startup pass, unlike the reminders. A reminder missed during a restart is
// still worth delivering late; an alarm is not — see the grace window in
// whatsappAlerts.js — and firing one the instant the server comes up would
// make every backend edit set the laugh off. WHATSAPP_ALERTS=off disables it.
const WHATSAPP_ALERT_MS = 60 * 1000;
if (process.env.WHATSAPP_ALERTS !== 'off') {
  const graceMinutes = Number(process.env.WHATSAPP_ALERT_GRACE_MINUTES) || undefined;
  setInterval(() => {
    runWhatsappAlertTick(new Date(), graceMinutes ? { graceMinutes } : {}).then((result) => {
      if (result?.sent) console.log(`[whatsapp-alert] sounded ${result.announced} conversation(s), ${result.sent} device(s)`);
    });
    // unref() for the same reason the reminder timer has it: Ctrl-C on a dev
    // server should not hang for a minute waiting on a timer with nothing to
    // say.
  }, WHATSAPP_ALERT_MS).unref();
}

// Sprint rollover: open items left in a sprint that has ended move into the
// current one. Hourly is plenty — the move only matters once a week, and each
// pass is a handful of GitHub reads when there is nothing to carry. Also run at
// startup so a server that was asleep over the boundary catches up right away.
// SPRINT_CARRYOVER=off disables it.
const SPRINT_CARRYOVER_MS = 60 * 60 * 1000;
if (process.env.SPRINT_CARRYOVER !== 'off' && getGithubConfig().configured) {
  const carryOver = () => {
    carryOverOpenItems()
      .then(({ sprint, moved }) => {
        if (moved.length) {
          console.log(`[sprint] carried ${moved.length} open item(s) into ${sprint}:`, moved.map((m) => m.number ?? m.title).join(', '));
        }
      })
      .catch((err) => console.error('[sprint] carry-over failed —', err.message));
  };
  setInterval(carryOver, SPRINT_CARRYOVER_MS).unref();
  carryOver();
}

// The Porter delivery watch: orders out with a rider get checked against
// Porter's own tracking page, and marked Delivered in Odoo when Porter says
// the trip ended. See server/ops/shared/deliveryWatch.js for why the queue is
// a table rather than a timer per order.
//
// Every minute, because the row itself carries when it is next due — the tick
// is only asking "is anything due yet?", which with nothing out is one indexed
// read that returns no rows. The floor on how often a single order is polled
// is POLL_FLOOR_MIN over there, not this interval.
//
// Run at startup too, and this is the part that matters most: the server
// restarts on every backend edit, and an order that came due while it was
// down is due the moment it is back. DELIVERY_WATCH=off disables it.
const DELIVERY_WATCH_TICK_MS = 60 * 1000;
if (process.env.DELIVERY_WATCH !== 'off') {
  const watchTick = () => {
    runDeliveryWatchTick(new Date())
      .then((result) => {
        if (!result.checked) return;
        const parts = [`checked ${result.checked}`];
        if (result.delivered) parts.push(`${result.delivered} delivered`);
        if (result.cancelled) parts.push(`${result.cancelled} cancelled`);
        if (result.gaveUp) parts.push(`${result.gaveUp} gave up`);
        if (result.errors) parts.push(`${result.errors} to retry`);
        console.log(`[delivery-watch] ${parts.join(', ')}`);
      })
      .catch((err) => console.error('[delivery-watch] tick failed —', err.message || err));
  };
  setInterval(watchTick, DELIVERY_WATCH_TICK_MS).unref();
  try {
    const open = openWatchCount();
    if (open) console.log(`[delivery-watch] ${open} order(s) still out — resuming.`);
    // Orders that went out with a Porter link but no watch on them: the link
    // was saved before this existed, or a restart landed in the middle of
    // saving it. Scoped to what is still in flight — see backfillWatches.
    const queued = backfillWatches(new Date());
    if (queued.length) console.log(`[delivery-watch] picked up ${queued.length} order(s) already out: ${queued.join(', ')}`);
  } catch (err) {
    console.error('[delivery-watch] could not take stock of open watches —', err.message);
  }
  watchTick();
}

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Smoke Rings server listening on http://localhost:${port}`));
