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

CREATE TABLE aiseo_prompt (
    prompt_id   TEXT PRIMARY KEY,
    prompt_text TEXT NOT NULL,
    intent      TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT
);

CREATE TABLE aiseo_run (
    run_id           TEXT PRIMARY KEY,
    prompt_id        TEXT REFERENCES aiseo_prompt(prompt_id) ON DELETE SET NULL,
    prompt_text      TEXT,
    engine           TEXT,
    source           TEXT,
    ran_at           TEXT,
    mentioned        INTEGER CHECK (mentioned IN (0,1)),
    position         INTEGER CHECK (position IS NULL OR position > 0),
    total_brands     INTEGER CHECK (total_brands IS NULL OR total_brands >= 0),
    sentiment        TEXT,
    framing          TEXT,
    competitors      TEXT,
    citation_domains TEXT,
    citation_urls    TEXT,
    recommendation   TEXT,
    answer_excerpt   TEXT,
    CONSTRAINT aiseo_position_within_total
        CHECK (position IS NULL OR total_brands IS NULL OR position <= total_brands)
);

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
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE bom_line (
    line_id       TEXT PRIMARY KEY,
    parent_id     TEXT NOT NULL REFERENCES item(item_id) ON DELETE CASCADE,
    child_id      TEXT NOT NULL REFERENCES item(item_id),
    quantity      REAL CHECK (quantity >= 0),
    unit          TEXT REFERENCES uom(code),
    base_quantity REAL CHECK (base_quantity >= 0),
    base_unit     TEXT REFERENCES uom(code),
    is_to_taste   INTEGER NOT NULL DEFAULT 0 CHECK (is_to_taste IN (0,1)),
    status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','corrected','needs_confirmation')),
    notes         TEXT,
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
    unit_of_measure TEXT,
    reason          TEXT,
    created_at      TEXT
);

CREATE TABLE item (
    item_id   TEXT PRIMARY KEY,
    kind      TEXT NOT NULL CHECK (kind IN ('raw_material','intermediate','sub_recipe','menu_item')),
    name      TEXT NOT NULL,
    uom_code  TEXT REFERENCES uom(code),
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
                             CHECK (stock_status IN ('ok','never_counted','negative_balance','unit_mismatch')),
    stock_notes         TEXT,
    odoo_product_id     INTEGER
);

CREATE TABLE menu_item (
    item_id         TEXT PRIMARY KEY REFERENCES item(item_id) ON DELETE CASCADE,
    category        TEXT NOT NULL,
    protein         TEXT,
    main_product_id TEXT REFERENCES item(item_id),
    portion_size    REAL CHECK (portion_size > 0),
    portion_unit    TEXT REFERENCES uom(code),
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
    unit_of_measure    TEXT,
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
    output_unit             TEXT REFERENCES uom(code),
    portion_size            REAL CHECK (portion_size > 0),
    portion_unit            TEXT REFERENCES uom(code),
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
    notes             TEXT
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

CREATE TABLE uom (
    code        TEXT PRIMARY KEY,
    description TEXT
);

CREATE TABLE uom_conversion (
    conversion_id          TEXT PRIMARY KEY,
    from_unit              TEXT NOT NULL REFERENCES uom(code),
    to_unit                TEXT NOT NULL REFERENCES uom(code),
    factor                 REAL CHECK (factor > 0),
    applies_to_material_id TEXT REFERENCES item(item_id),
    applies_to_item        TEXT,
    confidence             TEXT NOT NULL DEFAULT 'estimate'
                                CHECK (confidence IN ('standard','measured','estimate','needs_confirmation','superseded')),
    notes                  TEXT
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

CREATE INDEX aiseo_run_prompt_idx ON aiseo_run(prompt_id);

CREATE INDEX aiseo_run_ran_idx    ON aiseo_run(ran_at);

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

CREATE INDEX uom_conv_lookup_idx ON uom_conversion(from_unit, to_unit, applies_to_material_id);

CREATE VIEW v_bom_explosion AS
WITH RECURSIVE tree AS (
    SELECT  b.parent_id AS root_id, b.child_id, b.quantity, b.base_quantity,
            b.base_unit, b.status, 1 AS depth,
            b.parent_id || ' > ' || b.child_id AS path
    FROM bom_line b
    UNION ALL
    SELECT  t.root_id, b.child_id, b.quantity, b.base_quantity,
            b.base_unit, b.status, t.depth + 1,
            t.path || ' > ' || b.child_id
    FROM tree t
    JOIN bom_line b ON b.parent_id = t.child_id
    WHERE t.depth < 10
)
SELECT t.root_id, r.name AS root_name, t.child_id, c.name AS child_name,
       c.kind AS child_kind, t.base_quantity, t.base_unit, t.status, t.depth, t.path
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
WHERE mt.standard_cost_inr IS NULL
UNION ALL
SELECT 'unit conversion unconfirmed', u.conversion_id, u.from_unit || ' -> ' || u.to_unit
FROM uom_conversion u WHERE u.confidence IN ('estimate','needs_confirmation');

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
        i.uom_code, m.stock_status, v.vendor_name AS default_vendor, v.lead_time_days,
        CASE
            WHEN m.stock_status = 'negative_balance' THEN 'negative â€” unrecorded purchase'
            WHEN m.stock_status = 'unit_mismatch'    THEN 'unit mismatch'
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
