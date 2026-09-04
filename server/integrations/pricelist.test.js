// Odoo pricelist evaluation, reimplemented on this side.
//
// It has to be reimplemented because Odoo will not do it for us: every method
// that evaluates a pricelist is private, and a private method cannot be called
// remotely. The rule rows themselves read back fine, so what is tested here is
// whether this code draws the same conclusion from them that Odoo would.
//
// The shapes below are the real ones. "Jango — B2B Wholesale" is eight
// `fixed` rules applied on `1_product`, which is the case that has to be exact
// — it is what every invoice line for that account is priced from.
import { describe, it, expect } from 'vitest';
import { priceFromRules } from './odoo.js';

// A product as fetchSellableProducts hands it over: the variant id, its
// template (which is what a '1_product' rule is written against) and its
// category.
const pulledPork = { id: 138, templateId: 138, categoryId: 5, listPrice: 1970 };
const chicken = { id: 137, templateId: 137, categoryId: 5, listPrice: 1120 };

const rule = (over = {}) => ({
  appliedOn: '1_product',
  productId: null,
  templateId: 138,
  categoryId: null,
  computePrice: 'fixed',
  fixedPrice: 2000,
  percentPrice: 0,
  discount: 0,
  surcharge: 0,
  round: 0,
  minMargin: 0,
  maxMargin: 0,
  base: 'list_price',
  minQuantity: 0,
  dateStart: null,
  dateEnd: null,
  ...over,
});

describe('priceFromRules', () => {
  it('takes the fixed rate off a per-product rule', () => {
    // Jango's actual pricelist: Pulled Pork (Bulk 1kg) at ₹2000, against a
    // ₹1970 list price.
    expect(priceFromRules([rule()], pulledPork)).toEqual({ price: 2000, source: 'pricelist' });
  });

  it('falls back to the list price for a product no rule covers', () => {
    // And says so, rather than quietly reporting a list price as though the
    // pricelist had chosen it.
    expect(priceFromRules([rule()], chicken)).toEqual({ price: 1120, source: 'list' });
  });

  it('prices off an empty pricelist as list', () => {
    expect(priceFromRules([], pulledPork)).toEqual({ price: 1970, source: 'list' });
  });

  it('prefers the most specific rule that matches', () => {
    // Odoo's own precedence: variant beats template beats category beats
    // global. This is what makes "everything at -10%, except this one at a
    // fixed rate" behave the way whoever set it up expects.
    const rules = [
      rule({ appliedOn: '3_global', templateId: null, computePrice: 'percentage', percentPrice: 10 }),
      rule({ appliedOn: '2_product_category', templateId: null, categoryId: 5, fixedPrice: 1500 }),
      rule({ appliedOn: '1_product', fixedPrice: 2000 }),
      rule({ appliedOn: '0_product_variant', templateId: null, productId: 138, fixedPrice: 1800 }),
    ];
    expect(priceFromRules(rules, pulledPork).price).toBe(1800);
    // Drop the variant rule and the template rule takes over, and so on down.
    expect(priceFromRules(rules.slice(0, 3), pulledPork).price).toBe(2000);
    expect(priceFromRules(rules.slice(0, 2), pulledPork).price).toBe(1500);
    expect(priceFromRules(rules.slice(0, 1), pulledPork).price).toBe(1773);
  });

  it('applies a percentage rule as a discount off the list price', () => {
    expect(priceFromRules([rule({ computePrice: 'percentage', percentPrice: 25 })], pulledPork)).toEqual({
      price: 1477.5,
      source: 'pricelist',
    });
  });

  it('works a formula rule through discount, surcharge and rounding', () => {
    const formula = rule({ computePrice: 'formula', discount: 10, surcharge: 23, round: 5 });
    // 1970 - 10% = 1773, +23 = 1796, rounded to the nearest 5 = 1795.
    expect(priceFromRules([formula], pulledPork)).toEqual({ price: 1795, source: 'pricelist' });
  });

  it('honours a formula rule margin floor', () => {
    const formula = rule({ computePrice: 'formula', discount: 50, minMargin: -100 });
    // Half of 1970 is 985, but the floor holds it at list minus 100.
    expect(priceFromRules([formula], pulledPork).price).toBe(1870);
  });

  it('ignores a rule below its minimum quantity', () => {
    const bulk = rule({ minQuantity: 10, fixedPrice: 1800 });
    expect(priceFromRules([bulk], pulledPork, { quantity: 5 })).toEqual({ price: 1970, source: 'list' });
    expect(priceFromRules([bulk], pulledPork, { quantity: 10 }).price).toBe(1800);
  });

  it('ignores a rule outside its date window', () => {
    const promo = rule({ dateStart: '2026-08-01', dateEnd: '2026-08-31', fixedPrice: 1500 });
    expect(priceFromRules([promo], pulledPork, { onDate: '2026-07-31' }).source).toBe('list');
    expect(priceFromRules([promo], pulledPork, { onDate: '2026-08-15' }).price).toBe(1500);
    expect(priceFromRules([promo], pulledPork, { onDate: '2026-09-01' }).source).toBe('list');
  });

  it('says when a rule matched but could not be evaluated, instead of guessing', () => {
    // The important behaviour. A formula based on cost, or chained to another
    // pricelist, is not something this code can work out — and putting a
    // number on an invoice that Odoo itself would disagree with is worse than
    // saying so. The list price stands in, and the source names the problem.
    const chained = rule({ computePrice: 'formula', base: 'pricelist' });
    expect(priceFromRules([chained], pulledPork)).toEqual({
      price: 1970,
      source: 'unsupported',
      rule: 'formula',
    });

    const onCost = rule({ computePrice: 'formula', base: 'standard_price' });
    expect(priceFromRules([onCost], pulledPork).source).toBe('unsupported');
  });

  it('never prices below zero', () => {
    expect(priceFromRules([rule({ computePrice: 'percentage', percentPrice: 150 })], pulledPork).price).toBe(0);
  });
});
