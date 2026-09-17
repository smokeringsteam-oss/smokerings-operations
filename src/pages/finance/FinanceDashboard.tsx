import SpendVsSales from './SpendVsSales';
import ItemSales from './ItemSales';
import PurchaseLogger from './PurchaseLogger';
import UnitEconomics from './UnitEconomics';

// Finance — the money view of the business, as against the operational one.
//
// It is its own sidebar section rather than a tab inside Ops or Marketing
// because the question it answers cuts across both: the spending is Ops'
// purchasing plus Marketing's ad ledger, and the sales are B2C's weekend plus
// B2B's invoices. Hanging it off either parent would file a whole-business
// figure under half of the business.
//
// Four tools, in the order a question gets asked. Spending vs Sales says
// whether the week paid; Sales by Item says what it was that sold and which
// dishes are moving; Cost to Make turns that into what those sales cost to
// produce; the Purchase Logger is where the other half of the first answer
// comes from — what the money actually went on, which until it existed was
// recorded only as B2C or B2B and nothing more.
//
// The money view comes first because it is the one that decides whether to
// look closer, and the rest are what you look closer with. Cost to Make sits
// directly after Sales by Item because it is that screen's numbers multiplied
// by a cost — same dishes, same Odoo feed, same weeks.
//
// The obvious next neighbour — a cash-flow view built on payment dates rather
// than delivery dates — belongs beside these and nowhere else.
export type FinanceSub = 'spendVsSales' | 'itemSales' | 'unitEconomics' | 'purchaseLogger';

export const financeTools: { id: FinanceSub; label: string; icon: string }[] = [
  { id: 'spendVsSales', label: 'Spending vs Sales', icon: '⚖️' },
  { id: 'itemSales', label: 'Sales by Item', icon: '🍖' },
  { id: 'unitEconomics', label: 'Cost to Make', icon: '🧮' },
  { id: 'purchaseLogger', label: 'Purchase Logger', icon: '🧾' },
];

const FinanceDashboard = ({ activeTool }: { activeTool: FinanceSub }) => {
  const renderTool = () => {
    switch (activeTool) {
      case 'itemSales':
        return <ItemSales />;
      case 'unitEconomics':
        return <UnitEconomics />;
      case 'purchaseLogger':
        return <PurchaseLogger />;
      case 'spendVsSales':
      default:
        return <SpendVsSales />;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>Finance</h2>
        <p>
          What the business spent against what it sold, what it was that sold, and what that cost to make. Purchases,
          recipes and wholesale invoices come from this app&apos;s own books; the B2C side comes from Odoo.
        </p>
      </header>

      <div className="marketing-content">{renderTool()}</div>
    </div>
  );
};

export default FinanceDashboard;
