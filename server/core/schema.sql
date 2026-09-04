-- The database this app runs on, in full.
--
-- It started life in the sibling knowledge-base repo, as the schema that
-- repo's loader applied when `npm run kb:import` seeded the CSVs into
-- SQLite. That made sense while the CSVs were the source of truth and the
-- database was a copy of them. It is the other way round now: nothing in
-- server/ reads a CSV, every write lands here first, and this file is the
-- only description of the shape those writes go into — so it lives with the
-- app that owns it.
--
-- Used by `npm run db:init`, which creates an empty database from it. An
-- existing database is brought up to this shape by server/core/migrations.js
-- instead, which runs on every open; the two must be kept in step, and the
-- note at the top of that file says how.
--
-- Conventions worth knowing before editing:
--   * item is the spine. A material, a menu dish, a sub-recipe and a smoked
--     product are all items; the subject tables hold only what is specific to
--     that kind, and bom_line joins any parent to any child.
--   * Booleans are INTEGER 0/1 with a CHECK, dates and timestamps are TEXT in
--     ISO order, money is REAL INR. server/core/kbViews.js translates all
--     three back into the shapes the screens were written against.
--   * A CHECK constraint here is business logic that must not be bypassed —
--     a yield over 100%, a session that finished before it started, a
--     purchase of a material with no material id. Prefer adding one to
--     re-deriving the rule in JavaScript.

CREATE TABLE b2b_client (
    client_id           TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    business_type       TEXT,
    stage               TEXT NOT NULL DEFAULT 'lead',
    contact_name        TEXT,
    contact_role        TEXT,
    phone               TEXT,
    email               TEXT,
    area                TEXT,
    address             TEXT,
    gstin               TEXT,
    lead_source         TEXT,
    order_day           TEXT,
    sample_sent_on      TEXT,
    sample_items        TEXT,
    sample_feedback     TEXT,
    sample_outcome      TEXT,
    onboarding_steps    TEXT,
    price_list          TEXT,
    payment_terms       TEXT,
    onboarded_on        TEXT,
    lost_reason         TEXT,
    odoo_partner_id     INTEGER,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    -- How many days after delivery an invoice for this account falls due.
    -- The house term is 15 days, which is why that is the default rather
    -- than something the caller has to supply on every sale; an account that
    -- negotiated 30 overrides it here, once, instead of on every invoice.
    -- Numeric and separate from `payment_terms` because that column is free
    -- text ("Net 15, NEFT") meant for a human, and a due date cannot be
    -- computed from prose.
    payment_terms_days  INTEGER NOT NULL DEFAULT 15 CHECK (payment_terms_days >= 0),
    -- The Odoo pricelist that decides what this account pays per product.
    -- One pricelist per client is how the rates are actually kept — e.g.
    -- "Jango — B2B Wholesale", a set of fixed per-product rules — so this is
    -- the link that makes an invoice line price itself.
    --
    -- The id rather than the rates: the rules live in Odoo and are read from
    -- there on demand (server/integrations/odoo.js fetchPricelistRules), so a
    -- rate changed in Odoo is in effect here immediately and there is no
    -- second copy to go stale. The name is cached alongside purely so a
    -- screen can say which pricelist is attached without an Odoo round trip.
    odoo_pricelist_id   INTEGER,
    odoo_pricelist_name TEXT
);

CREATE TABLE b2b_client_demand (
    demand_id  TEXT PRIMARY KEY,
    client_id  TEXT NOT NULL REFERENCES b2b_client(client_id) ON DELETE CASCADE,
    category   TEXT NOT NULL,
    qty_kg     REAL CHECK (qty_kg > 0),
    cadence    TEXT,
    notes      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What a B2B account was actually billed, and whether they have paid yet.
--
-- Separate from `sales_order`, which mirrors Odoo's order lifecycle for the
-- packing board: that table tracks a parcel through the kitchen and knows
-- nothing about money. This one is the book of B2B revenue and receivables,
-- entered by hand — a wholesale delivery is invoiced on a cycle rather than
-- paid at checkout the way a B2C weekend order is, so the number that
-- matters is not "was it delivered" but "was it delivered, and has the
-- fifteenth day since passed".
--
-- `payment_due_on` is stored rather than derived on read. It is delivered_on
-- plus the client's payment_terms_days at the moment the sale was entered,
-- and it has to stay that: renegotiating an account to 30-day terms must not
-- retroactively un-overdue every invoice already sitting past its date.
--
-- Part payments are one running total (`amount_paid_inr`) rather than a
-- child table of receipts. A wholesale account pays an invoice once, or
-- occasionally in two goes against the same reference; a full receipts
-- ledger would be a second book to keep for a case that resolves in days.
-- `paid_on` is the date it was settled in full, so it is NULL for anything
-- part-paid — "how much is still out" is the amount columns' job, and
-- "is this closed" is this one's.
CREATE TABLE b2b_sale (
    sale_id         TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES b2b_client(client_id) ON DELETE CASCADE,
    delivered_on    TEXT NOT NULL,
    amount_inr      REAL NOT NULL CHECK (amount_inr > 0),
    payment_due_on  TEXT NOT NULL,
    amount_paid_inr REAL NOT NULL DEFAULT 0 CHECK (amount_paid_inr >= 0),
    paid_on         TEXT,
    invoice_number  TEXT,
    order_ref       TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    -- The Odoo invoice this sale was billed on, once one has been raised.
    -- Null until someone presses the button: a sale can be logged, chased and
    -- paid without Odoo ever being involved, and that has to keep working.
    --
    -- `odoo_access_token` is the portal share token, set by this app when it
    -- creates the invoice. It is what makes the PDF fetchable at all: Odoo
    -- Online refuses an API key for a web session, so the report endpoints
    -- that need one are closed to us, and the customer-portal URL — the same
    -- link Odoo emails to a client — is the only route to the file. The token
    -- IS the credential for that URL, so it never leaves the server; the
    -- download is proxied (see server/index.js).
    odoo_invoice_id    INTEGER,
    odoo_invoice_state TEXT,
    odoo_access_token  TEXT,
    -- The last failure, kept rather than thrown away so a sale whose invoice
    -- did not go through says why on its own row instead of only in a toast
    -- that has since been dismissed. Cleared by the next success.
    odoo_error         TEXT,
    -- Money in cannot exceed money billed. An overpayment is a data entry
    -- slip, and left unchecked it shows up as negative outstanding quietly
    -- cancelling out somebody else's genuine overdue amount in the rollup.
    CONSTRAINT b2b_sale_not_overpaid CHECK (amount_paid_inr <= amount_inr),
    -- An invoice cannot fall due before it was delivered.
    CONSTRAINT b2b_sale_due_after_delivery CHECK (payment_due_on >= delivered_on),
    -- Settled means settled: a paid_on date with money still outstanding
    -- would drop the row out of the receivables list while it is still owed.
    CONSTRAINT b2b_sale_paid_in_full CHECK (paid_on IS NULL OR amount_paid_inr >= amount_inr)
);

-- The lines an invoice is made of: what was sold, how much of it, at what
-- rate. A child table rather than a packed cell because these are pushed to
-- Odoo one `account.move.line` each, and because the rate on a line is the
-- record of what this client was charged for this product — which is what
-- the next invoice for them pre-fills from.
--
-- A sale does not have to have lines. One logged as a lump sum (already
-- invoiced elsewhere, or paid in cash) has none, and b2b_sale.amount_inr is
-- then the figure somebody typed. As soon as a sale has lines, that column
-- becomes their sum and is maintained by the store — the two must never
-- disagree, because one is what the receivables are chased on and the other
-- is what the client was actually billed.
--
-- `line_total` is stored rather than derived. Rounding quantity * unit_price
-- per line and summing is not the same number as summing and rounding once,
-- and the invoice total here has to match the one Odoo prints to the paisa.
CREATE TABLE b2b_sale_line (
    line_id         TEXT PRIMARY KEY,
    sale_id         TEXT NOT NULL REFERENCES b2b_sale(sale_id) ON DELETE CASCADE,
    -- Position on the invoice, so the order the lines were entered in is the
    -- order they print in.
    position        INTEGER NOT NULL DEFAULT 0,
    -- The Odoo product this line bills, when it came from the catalogue.
    -- Null for a free-text line, which is a real case — a delivery charge, a
    -- one-off item nobody has set up in Odoo yet — and Odoo takes a line with
    -- a description and no product perfectly well.
    odoo_product_id INTEGER,
    description     TEXT NOT NULL,
    unit_label      TEXT,
    quantity        REAL NOT NULL CHECK (quantity > 0),
    unit_price      REAL NOT NULL CHECK (unit_price >= 0),
    line_total      REAL NOT NULL CHECK (line_total >= 0)
);

CREATE TABLE bom_line (
    line_id       TEXT PRIMARY KEY,
    parent_id     TEXT NOT NULL REFERENCES item(item_id) ON DELETE CASCADE,
    child_id      TEXT NOT NULL REFERENCES item(item_id),
    -- The amount, twice. `quantity` is what a cook would say; `base_quantity`
    -- is what every planner multiplies by the order count, and it wins
    -- wherever both are set.
    quantity      REAL CHECK (quantity >= 0),
    base_quantity REAL CHECK (base_quantity >= 0),
    is_to_taste   INTEGER NOT NULL DEFAULT 0 CHECK (is_to_taste IN (0,1)),
    status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','corrected','needs_confirmation')),
    notes         TEXT,
    -- Whether those two numbers are one amount said once or two figures kept
    -- apart on purpose. 0 means the editor shows a single input and a save
    -- writes both columns, so a base_quantity that has drifted from the
    -- quantity beside it gets re-linked, which is the whole reason the recipe
    -- editor exists. 1 means they are separate and a save may only change the
    -- one it was given.
    --
    -- This used to be read off a unit column beside each amount -- 110 g and
    -- 120 g were the same thing said twice, 2 sheets and 0.0667 of a roll were
    -- not. Units of measure are no longer recorded, and the two numbers alone
    -- cannot tell those cases apart, so the answer the units used to give is
    -- stored directly. The migration that dropped those columns set this from
    -- them on the way past, so no row lost the distinction.
    base_is_separate INTEGER NOT NULL DEFAULT 0 CHECK (base_is_separate IN (0,1)),
    CONSTRAINT bom_no_self_reference CHECK (parent_id <> child_id),
    CONSTRAINT bom_unique_edge       UNIQUE (parent_id, child_id),
    CONSTRAINT bom_qty_accounted_for CHECK (quantity IS NOT NULL OR is_to_taste = 1
                                            OR status = 'needs_confirmation')
);

CREATE TABLE inventory_adjustment (
    adjustment_id   TEXT PRIMARY KEY,
    adjustment_date TEXT,
    material_id     TEXT REFERENCES material(item_id),
    item_name       TEXT,
    quantity        REAL NOT NULL,
    reason          TEXT,
    created_at      TEXT
);

CREATE TABLE item (
    item_id   TEXT PRIMARY KEY,
    kind      TEXT NOT NULL CHECK (kind IN ('raw_material','intermediate','sub_recipe','menu_item')),
    name      TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    notes     TEXT
);

CREATE TABLE material (
    item_id             TEXT PRIMARY KEY REFERENCES item(item_id) ON DELETE CASCADE,
    category            TEXT,
    reorder_level       REAL CHECK (reorder_level >= 0),
    default_vendor_id   TEXT REFERENCES vendor(vendor_id),
    standard_cost_inr   REAL CHECK (standard_cost_inr >= 0),
    cost_basis          TEXT,
    shelf_life_days     INTEGER CHECK (shelf_life_days > 0),
    storage             TEXT,
    order_multiple      REAL CHECK (order_multiple > 0),
    quantity_on_hand    REAL NOT NULL DEFAULT 0,
    last_updated        TEXT,
    last_movement_ref   TEXT,
    stock_status        TEXT NOT NULL DEFAULT 'never_counted'
                             CHECK (stock_status IN ('ok','never_counted','negative_balance')),
    stock_notes         TEXT,
    odoo_product_id     INTEGER
);

-- What marketing cost, as opposed to what it brought in. The other half of
-- every number on the Marketing ROI screen; the revenue half lives in Odoo
-- and is never copied here (see server/marketing/marketingRoi.js).
--
-- Hand-entered rather than synced, because the spend that matters to this
-- business mostly has no API behind it. A boosted Instagram post does, but a
-- Swiggy commission, a pop-up stall fee, a food blogger paid in cash and a
-- print run of flyers do not, and a dashboard that only knew the boosted
-- post would report a return several times the real one. The columns are
-- shaped so an automatic ad-spend feed can later write rows into this same
-- table -- `source` says which rows came from where -- without a migration.
--
-- Spend is a period, not a date. That is the one structural decision here
-- worth knowing: an Instagram budget is set for a month, a stall fee belongs
-- to the weekend it was paid for, and neither is a single day. So a row
-- carries `period_start`/`period_end`, and a query for a narrower window
-- gets the overlapping fraction of it by days rather than all or nothing --
-- otherwise a month's budget would count in full against one week's revenue
-- and make that week look four times worse than it was. The screen shows the
-- fraction it used whenever a row is only partly in range.
--
-- `channel` is the join key onto revenue, and it must be one of the values
-- Odoo's own x_order_source selection offers (Instagram / Reddit / WhatsApp /
-- Website / Swiggy / Zomato / Friends & Family / B2B / Catering / Pop-up
-- Event). That list is not repeated as a CHECK here: it is a Studio
-- selection, it will grow, and a CHECK would then reject a channel Odoo
-- itself accepts. The server reads the live list out of Odoo and validates
-- against that instead.
--
-- `campaign` is optional and deliberately so. Most spend is a standing
-- channel budget with no campaign behind it, and forcing a name would mean
-- inventing one. A row with a campaign rolls up under it; a row without
-- rolls up under the channel alone.
CREATE TABLE marketing_budget (
    budget_id    TEXT PRIMARY KEY,
    period_start TEXT NOT NULL,
    period_end   TEXT NOT NULL,
    channel      TEXT NOT NULL,
    campaign     TEXT,
    -- What kind of money this was, so "we spent too much on X" can be
    -- answered by kind as well as by channel. Constrained, unlike channel,
    -- because these are our own categories and a typo'd one would silently
    -- start its own bucket in the rollup.
    category     TEXT NOT NULL DEFAULT 'ads'
                      CHECK (category IN ('ads','commission','influencer','print','event','tooling','other')),
    amount_inr   REAL NOT NULL CHECK (amount_inr >= 0),
    -- Who was paid. Free text, not a vendor(vendor_id) reference: the
    -- purchasing vendor book is the raw-materials supplier list, and putting
    -- Meta and a food blogger in it would corrupt the low-stock reordering
    -- screens that read it.
    vendor       TEXT,
    notes        TEXT,
    -- 'manual' for a row somebody typed, or the connector id for one an
    -- ad-spend feed wrote. Kept so a future sync can replace only its own
    -- rows and never overwrite a hand-entered figure.
    source       TEXT NOT NULL DEFAULT 'manual',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    -- A period that ends before it starts would take a negative share of
    -- itself into every overlap calculation below it.
    CONSTRAINT marketing_budget_period_order CHECK (period_end >= period_start)
);

CREATE INDEX marketing_budget_period_idx  ON marketing_budget(period_start, period_end);
CREATE INDEX marketing_budget_channel_idx ON marketing_budget(channel);

-- Every tracked link and QR code we have published, kept because a printed
-- QR code cannot be edited.
--
-- A link built for an Instagram bio can be rebuilt from memory if the row is
-- lost; a QR code printed onto three hundred packaging stickers cannot, and
-- people go on scanning it whether or not we still know what it points at.
-- So this table is the record of what was published, and rows are kept after
-- a campaign ends rather than tidied away.
--
-- The full URL is NOT stored -- see shapeRow in
-- server/marketing/trackedLinks.js. It is derived from the columns below,
-- and a stored copy is the one that silently goes stale after any change to
-- how links are built, on exactly the oldest rows.
--
-- utm_source has no CHECK for the same reason marketing_budget.channel has
-- none: the useful sources grow (a new marketplace, a new kind of printed
-- thing), and a constraint here would reject a source GA4 is perfectly happy
-- to report on. The server offers presets built from orderAttribution.js's
-- CHANNELS and says, per link, whether the source maps to a channel the ROI
-- screen can roll revenue up to.
CREATE TABLE marketing_link (
    link_id      TEXT PRIMARY KEY,
    -- What this link is for, in human words ("Sept brisket weekend, IG
    -- story"). Optional: the UTM parts already describe it, and forcing a
    -- name would mostly produce a worse copy of them.
    label        TEXT,
    -- Where the link points before any tagging. Kept separately from the
    -- parameters so the same destination can be re-tagged for a new campaign
    -- without retyping it, and so a change of domain is one visible column.
    destination  TEXT NOT NULL,
    -- The only required parameter. Without it the click carries nothing at
    -- all and the link is just a URL.
    utm_source   TEXT NOT NULL,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The placement key: destination + source + medium + campaign + content is
-- what makes one link one link. Unique, so re-saving a batch after fixing a
-- typo updates the row instead of filling the library with near-identical
-- copies that split their own campaign's link count.
--
-- Over ifnull(), not over the columns themselves. SQLite treats NULLs as
-- distinct in a unique index, so a plain index would let two rows that both
-- have no campaign coexist -- which is precisely the untagged-link case this
-- is meant to catch.
CREATE UNIQUE INDEX marketing_link_placement_idx ON marketing_link(
    destination, utm_source, ifnull(utm_medium, ''), ifnull(utm_campaign, ''), ifnull(utm_content, '')
);
CREATE INDEX marketing_link_campaign_idx ON marketing_link(utm_campaign);

CREATE TABLE menu_item (
    item_id         TEXT PRIMARY KEY REFERENCES item(item_id) ON DELETE CASCADE,
    category        TEXT NOT NULL,
    protein         TEXT,
    main_product_id TEXT REFERENCES item(item_id),
    portion_size    REAL CHECK (portion_size > 0),
    price_inr       REAL CHECK (price_inr >= 0),
    currency        TEXT NOT NULL DEFAULT 'INR',
    channel         TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
    description     TEXT,
    odoo_product_id INTEGER
);

CREATE TABLE purchase (
    purchase_id        TEXT PRIMARY KEY,
    purchase_date      TEXT NOT NULL,
    channel            TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
    client_id          TEXT,
    client_name        TEXT,
    smoking_session_id TEXT,
    vendor_id          TEXT NOT NULL REFERENCES vendor(vendor_id),
    item_type          TEXT CHECK (item_type IS NULL OR item_type IN ('material','service')),
    material_id        TEXT REFERENCES item(item_id),
    item_name          TEXT NOT NULL,
    quantity_purchased REAL NOT NULL CHECK (quantity_purchased > 0),
    unit_price         REAL CHECK (unit_price IS NULL OR unit_price >= 0),
    total_cost         REAL CHECK (total_cost IS NULL OR total_cost >= 0),
    currency           TEXT NOT NULL DEFAULT 'INR',
    expense_category   TEXT,
    odoo_po_id         INTEGER,
    odoo_po_line_id    INTEGER,
    notes              TEXT,
    -- What one of `quantity_purchased` weighs, for the things bought by the
    -- piece whose weight is the number that actually matters downstream: a
    -- whole chicken is four birds AND 6.4 kg, and the kitchen needs both.
    -- The quantity stays the count (that is what moves stock, and what the
    -- vendor invoices), so the weight rides alongside rather than replacing
    -- it; total weight is quantity_purchased * this, derived in
    -- server/core/kbViews.js rather than stored twice.
    --
    -- Null for everything sold by weight already — a 5 kg pork shoulder line
    -- has no "per piece" to record — and null for a piece-bought line logged
    -- before anyone put it on a scale, which is a real answer, not a gap to
    -- fill with a guess.
    weight_per_unit_kg REAL CHECK (weight_per_unit_kg IS NULL OR weight_per_unit_kg > 0),
    CONSTRAINT purchase_material_required
        CHECK (item_type <> 'material' OR material_id IS NOT NULL)
);

CREATE TABLE recipe (
    item_id                 TEXT PRIMARY KEY REFERENCES item(item_id) ON DELETE CASCADE,
    kind                    TEXT NOT NULL,
    source_material_id      TEXT REFERENCES item(item_id),
    output_quantity         REAL CHECK (output_quantity > 0),
    portion_size            REAL CHECK (portion_size > 0),
    portions_per_batch      REAL CHECK (portions_per_batch > 0),
    yield_pct               REAL CHECK (yield_pct > 0 AND yield_pct <= 100),
    raw_weight_per_piece_g  REAL CHECK (raw_weight_per_piece_g > 0),
    min_buy_unit_kg         REAL CHECK (min_buy_unit_kg > 0),
    batch_prep_day          TEXT,
    prepared_by             TEXT,
    shelf_life_days         INTEGER CHECK (shelf_life_days > 0),
    storage                 TEXT,
    ingredients_recorded    TEXT NOT NULL DEFAULT 'no' CHECK (ingredients_recorded IN ('yes','no','n/a'))
);

CREATE TABLE recipe_applies_to (
    recipe_id TEXT NOT NULL REFERENCES recipe(item_id) ON DELETE CASCADE,
    item_id   TEXT NOT NULL REFERENCES item(item_id),
    PRIMARY KEY (recipe_id, item_id)
);

CREATE TABLE sales_order (
    order_id            INTEGER PRIMARY KEY,
    order_name          TEXT NOT NULL UNIQUE,
    channel             TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
    status              TEXT NOT NULL,
    delivery_person     TEXT,
    in_smoker_at        TEXT,
    prepping_at         TEXT,
    packed_at           TEXT,
    finding_partner_at  TEXT,
    assigned_partner_at TEXT,
    out_for_delivery_at TEXT,
    delivered_at        TEXT,
    invoice_number      TEXT,
    invoice_id          INTEGER,
    invoice_url         TEXT,
    invoice_error       TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scheduled_task (
    task_id           TEXT PRIMARY KEY,
    day               TEXT NOT NULL,
    time_of_day       TEXT,
    task              TEXT NOT NULL,
    assigned_to       TEXT,
    category          TEXT,
    related_vendor_id TEXT REFERENCES vendor(vendor_id),
    related_recipe_id TEXT REFERENCES recipe(item_id),
    related_sop       TEXT,
    notes             TEXT,
    -- Position within the day, as Daily View's edit mode leaves it. Rank
    -- rather than rowid order: dragging a task up the list has to survive,
    -- and rowid is fixed at insert. Ties (two rows sharing a rank, which a
    -- hand-written INSERT can produce) fall back to rowid.
    sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE side_prep_status (
    weekend_start TEXT NOT NULL REFERENCES weekend(weekend_start) ON DELETE CASCADE,
    weekend_end   TEXT,
    side_key      TEXT NOT NULL,
    side_name     TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','making','done')),
    started_at    TEXT,
    done_at       TEXT,
    PRIMARY KEY (weekend_start, side_key),
    CONSTRAINT side_prep_order CHECK (done_at IS NULL OR started_at IS NULL OR done_at >= started_at)
);

CREATE TABLE smoking_session (
    session_id                      TEXT PRIMARY KEY,
    session_date                    TEXT NOT NULL,
    channel                         TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
    client_id                       TEXT REFERENCES b2b_client(client_id),
    client_name                     TEXT,
    session_purpose                 TEXT,
    source_material_id              TEXT REFERENCES item(item_id),
    source_purchase_id              TEXT REFERENCES purchase(purchase_id),
    output_product_id               TEXT REFERENCES item(item_id),
    output_type                     TEXT,
    pitmaster                       TEXT,
    brine_recipe_id                 TEXT REFERENCES recipe(item_id),
    brine_start                     TEXT,
    brine_end                       TEXT,
    rub_recipe_id                   TEXT REFERENCES recipe(item_id),
    rub_start                       TEXT,
    rub_end                         TEXT,
    raw_weight_kg                   REAL CHECK (raw_weight_kg > 0),
    smoking_start                   TEXT,
    smoking_end                     TEXT,
    finished_weight_with_bone_kg    REAL CHECK (finished_weight_with_bone_kg > 0),
    finished_weight_without_bone_kg REAL CHECK (finished_weight_without_bone_kg > 0),
    yield_pct                       REAL CHECK (yield_pct > 0 AND yield_pct <= 100),
    rest_start                      TEXT,
    rest_end                        TEXT,
    shred_start                     TEXT,
    shred_end                       TEXT,
    tenderness_notes                TEXT,
    -- 'Yes' | 'Partial' | 'No', the three the pitmaster is actually offered.
    -- It was a 0/1 flag when the CSVs were loaded, which had no room for the
    -- middle answer — and a partial ring is the interesting one, because it
    -- is what a cook that nearly worked looks like.
    smoke_rings_formed              TEXT,
    bark_notes                      TEXT,
    juiciness                       TEXT,
    stage                           TEXT NOT NULL DEFAULT 'planned',
    data_quality_notes              TEXT,
    CONSTRAINT smk_brine_order CHECK (brine_end   IS NULL OR brine_start   IS NULL OR brine_end   >= brine_start),
    CONSTRAINT smk_rub_order   CHECK (rub_end     IS NULL OR rub_start     IS NULL OR rub_end     >= rub_start),
    CONSTRAINT smk_smoke_order CHECK (smoking_end IS NULL OR smoking_start IS NULL OR smoking_end >= smoking_start),
    CONSTRAINT smk_rest_order  CHECK (rest_end    IS NULL OR rest_start    IS NULL OR rest_end    >= rest_start),
    CONSTRAINT smk_shred_order CHECK (shred_end   IS NULL OR shred_start   IS NULL OR shred_end   >= shred_start),
    CONSTRAINT smk_yield_sane  CHECK (finished_weight_with_bone_kg IS NULL OR raw_weight_kg IS NULL
                                      OR finished_weight_with_bone_kg <= raw_weight_kg)
);

CREATE TABLE smoking_session_order (
    session_id TEXT    NOT NULL REFERENCES smoking_session(session_id) ON DELETE CASCADE,
    order_id   INTEGER NOT NULL REFERENCES sales_order(order_id),
    PRIMARY KEY (session_id, order_id)
);

CREATE TABLE task_completion (
    week_key    TEXT NOT NULL,
    task_id     TEXT NOT NULL REFERENCES scheduled_task(task_id) ON DELETE CASCADE,
    done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
    assigned_to TEXT,
    time_of_day TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (week_key, task_id)
);

CREATE TABLE vendor (
    vendor_id           TEXT PRIMARY KEY,
    vendor_name         TEXT NOT NULL,
    vendor_type         TEXT,
    supplies_category   TEXT,
    contact_person      TEXT,
    phone               TEXT,
    email               TEXT,
    address             TEXT,
    lead_time_days      INTEGER CHECK (lead_time_days >= 0),
    payment_terms       TEXT,
    account_owner       TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    notes               TEXT
);

CREATE TABLE weekend (
    weekend_start   TEXT PRIMARY KEY,
    weekend_end     TEXT NOT NULL,
    kitchen_status  TEXT CHECK (kitchen_status IN ('open','closed')),
    decision_reason TEXT,
    decided_by      TEXT,
    decided_at      TEXT,
    prep_status     TEXT CHECK (prep_status IN ('planned','prepped','done','closed')),
    marked_at       TEXT,
    notes           TEXT,
    CONSTRAINT weekend_span CHECK (weekend_end >= weekend_start)
);

-- The two questions the sales book is asked: one account's history, and
-- "what is overdue right now" across every account.
CREATE INDEX b2b_sale_client_idx ON b2b_sale(client_id);

CREATE INDEX b2b_sale_line_sale_idx ON b2b_sale_line(sale_id);

-- "What did we last charge this client for this product" — the lookup every
-- new invoice line pre-fills its rate from.
CREATE INDEX b2b_sale_line_product_idx ON b2b_sale_line(odoo_product_id);

CREATE INDEX b2b_sale_due_idx    ON b2b_sale(payment_due_on);

CREATE INDEX bom_child_idx  ON bom_line(child_id);

CREATE INDEX bom_parent_idx ON bom_line(parent_id);

CREATE INDEX inv_adj_date_idx     ON inventory_adjustment(adjustment_date);

CREATE INDEX inv_adj_material_idx ON inventory_adjustment(material_id);

CREATE INDEX item_kind_idx ON item(kind);

CREATE INDEX material_status_idx ON material(stock_status);

CREATE INDEX material_vendor_idx ON material(default_vendor_id);

CREATE INDEX purchase_date_idx     ON purchase(purchase_date);

CREATE INDEX purchase_material_idx ON purchase(material_id);

CREATE INDEX purchase_vendor_idx   ON purchase(vendor_id);

CREATE INDEX smk_date_idx ON smoking_session(session_date);

CREATE INDEX so_status_idx ON sales_order(status);


CREATE VIEW v_bom_explosion AS
WITH RECURSIVE tree AS (
    SELECT  b.parent_id AS root_id, b.child_id, b.quantity, b.base_quantity,
            b.status, 1 AS depth,
            b.parent_id || ' > ' || b.child_id AS path
    FROM bom_line b
    UNION ALL
    SELECT  t.root_id, b.child_id, b.quantity, b.base_quantity,
            b.status, t.depth + 1,
            t.path || ' > ' || b.child_id
    FROM tree t
    JOIN bom_line b ON b.parent_id = t.child_id
    WHERE t.depth < 10
)
SELECT t.root_id, r.name AS root_name, t.child_id, c.name AS child_name,
       c.kind AS child_kind, t.base_quantity, t.status, t.depth, t.path
FROM tree t
JOIN item r ON r.item_id = t.root_id
JOIN item c ON c.item_id = t.child_id;

CREATE VIEW v_data_gaps AS
SELECT 'recipe has no ingredients' AS gap, r.item_id AS ref, i.name AS detail
FROM recipe r JOIN item i ON i.item_id = r.item_id
WHERE r.ingredients_recorded = 'no'
UNION ALL
SELECT 'bom line needs confirmation', b.line_id, b.parent_id || ' -> ' || b.child_id
FROM bom_line b WHERE b.status = 'needs_confirmation'
UNION ALL
SELECT 'menu item has no recipe', m.item_id, i.name
FROM menu_item m JOIN item i ON i.item_id = m.item_id
WHERE NOT EXISTS (SELECT 1 FROM bom_line b WHERE b.parent_id = m.item_id)
UNION ALL
SELECT 'material has no standard cost', mt.item_id, i.name
FROM material mt JOIN item i ON i.item_id = mt.item_id
WHERE mt.standard_cost_inr IS NULL;

CREATE VIEW v_menu_cost AS
SELECT  mi.item_id, i.name, mi.price_inr,
        round(sum(e.base_quantity * mt.standard_cost_inr), 2) AS known_cost_inr,
        count(*) FILTER (WHERE mt.standard_cost_inr IS NULL)  AS lines_missing_cost,
        count(*)                                              AS total_leaf_lines
FROM menu_item mi
JOIN item i ON i.item_id = mi.item_id
LEFT JOIN v_bom_explosion e ON e.root_id = mi.item_id AND e.child_kind = 'raw_material'
LEFT JOIN material mt ON mt.item_id = e.child_id
GROUP BY mi.item_id, i.name, mi.price_inr;

CREATE VIEW v_stock_alert AS
SELECT  i.item_id, i.name, m.category, m.quantity_on_hand, m.reorder_level,
        m.stock_status, v.vendor_name AS default_vendor, v.lead_time_days,
        CASE
            WHEN m.stock_status = 'negative_balance' THEN 'negative â€” unrecorded purchase'
            WHEN m.stock_status = 'never_counted'    THEN 'never counted'
            WHEN m.reorder_level IS NOT NULL
                 AND m.quantity_on_hand <= m.reorder_level THEN 'at or below reorder level'
        END AS alert
FROM material m
JOIN item i ON i.item_id = m.item_id
LEFT JOIN vendor v ON v.vendor_id = m.default_vendor_id
WHERE m.stock_status <> 'ok'
   OR (m.reorder_level IS NOT NULL AND m.quantity_on_hand <= m.reorder_level);

-- ---------------------------------------------------------------------------
-- Append-only history
--
-- Both tables took over from a knowledge-base CSV (smoking_stage_log.csv and
-- the repurposed Kitchen/packing_log.csv) when the last modules moved onto
-- SQLite. Neither carries a foreign key back to the thing it describes, on
-- purpose: the whole point of a trail is that it survives the row it is about.
-- A deleted smoking session still has a "to_stage = deleted" entry explaining
-- where it went, and a weekend that gets cleared out keeps the record of what
-- the kitchen actually made that week.
-- ---------------------------------------------------------------------------

CREATE TABLE smoking_stage_log (
    log_id               INTEGER PRIMARY KEY,
    changed_at           TEXT NOT NULL,
    session_id           TEXT NOT NULL,
    session_date         TEXT,
    channel              TEXT,
    purpose              TEXT,
    from_stage           TEXT,
    to_stage             TEXT,
    source_material_name TEXT,
    output_type          TEXT,
    pitmaster            TEXT,
    detail               TEXT
);

CREATE TABLE side_prep_log (
    log_id        INTEGER PRIMARY KEY,
    changed_at    TEXT NOT NULL,
    channel       TEXT,
    side_key      TEXT NOT NULL,
    side_name     TEXT,
    from_status   TEXT,
    to_status     TEXT,
    weekend_start TEXT,
    weekend_end   TEXT,
    source        TEXT
);

CREATE INDEX smoking_stage_log_session_idx ON smoking_stage_log(session_id);
CREATE INDEX smoking_stage_log_changed_idx ON smoking_stage_log(changed_at);
CREATE INDEX side_prep_log_weekend_idx     ON side_prep_log(weekend_start);
CREATE INDEX purchase_session_idx          ON purchase(smoking_session_id);
