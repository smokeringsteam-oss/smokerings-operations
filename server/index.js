import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { brainstormReply, generatePostFromConversation, extractWeekendOrders } from './geminiContent.js';
import {
  getConfig as getGithubConfig,
  getCurrentSprintBoard,
  setItemStatus,
  setItemAssignedTo,
  setItemDay,
  setItemAssignees,
  getAssignableUsers,
  addDraftItem,
  migrateDraftsToIssues,
  getRecentActivity,
  formatActivityForPrompt,
} from './githubProjects.js';
import {
  getConfig as getOdooConfig,
  fetchWeekendOrders,
  createPurchaseOrder,
  removePurchaseOrderLine,
  createVendorInOdoo,
} from './odoo.js';
import { getRecurringScheduleFromCsv } from './recurringScheduleCsv.js';
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
} from './purchasing.js';
import {
  getMeatItems,
  getRecipes,
  getSessions,
  startBrining,
  completeRub,
  startSmoking,
  finishSmoking,
  completeResting,
  completeShredding,
} from './smoking.js';
import { getMenu, computeSwiggyPlan } from './recipes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

const app = express();
app.use(express.json());
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
    // Falls back to server/redditFlairs.js for any subreddit not listed here.
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
    import('./redditPoster.js').then(({ postToSubreddits }) => {
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

app.get('/api/odoo/status', (req, res) => {
  // Pick only the safe fields — getOdooConfig() also carries the raw apiKey
  // for internal use, which must never reach the client.
  const { url, db, username, hasApiKey, configured } = getOdooConfig();
  res.json({ url, db, username, hasApiKey, configured });
});

app.get('/api/odoo/orders', async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await fetchWeekendOrders({ fromDate: from, toDate: to });
    res.json(result);
  } catch (err) {
    console.error('Error in GET /api/odoo/orders:', err);
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
    const { from, to } = req.query;
    res.json({ purchases: getPurchases({ from, to }) });
  } catch (err) {
    console.error('Error in GET /api/purchasing/purchases:', err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post('/api/purchasing/purchases', (req, res) => {
  try {
    const { vendorName, purchaseDate, lines } = req.body;
    const result = recordPurchases({ vendorName, purchaseDate, lines });
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
    // Link each purchases.csv row to its matching Odoo PO line so a later
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

// Stage 1 — Brining: creates the session.
app.post('/api/smoking/sessions/marinate', (req, res) => {
  try {
    const { materialId, pitmaster, brineRecipe, brineStart, brineEnd } = req.body;
    const result = startBrining({ materialId, pitmaster, brineRecipe, brineStart, brineEnd });
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

// Stage 3a — Smoking start.
app.post('/api/smoking/sessions/:sessionId/smoke-start', (req, res) => {
  try {
    const { rawWeightKg, smokingStart } = req.body;
    const result = startSmoking({ sessionId: req.params.sessionId, rawWeightKg, smokingStart });
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

// Stage 4 — Resting.
app.post('/api/smoking/sessions/:sessionId/rest', (req, res) => {
  try {
    const { restStart, restEnd } = req.body;
    const result = completeResting({ sessionId: req.params.sessionId, restStart, restEnd });
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

app.get('/api/github/status', (req, res) => {
  res.json(getGithubConfig());
});

// Mon–Fri recurring cadence, read live from the CSV in the knowledge-base repo
// (RECURRING_SCHEDULE_CSV_PATH) — edit the sheet, reload Daily View, see it there.
app.get('/api/recurring-schedule', (req, res) => {
  try {
    const schedule = getRecurringScheduleFromCsv();
    res.json({ schedule });
  } catch (err) {
    console.error('Error in GET /api/recurring-schedule:', err);
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

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Reddit poster server listening on http://localhost:${port}`));
