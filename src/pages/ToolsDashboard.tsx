import CsvEditor from './CsvEditor';

export type ToolsSub = 'csvEditor';

export const toolsTools: { id: ToolsSub; label: string; icon: string }[] = [{ id: 'csvEditor', label: 'CSV Editor', icon: '🗂️' }];

const ToolsDashboard = ({ activeTool }: { activeTool: ToolsSub }) => {
  const renderTool = () => {
    switch (activeTool) {
      case 'csvEditor':
        return <CsvEditor />;
      default:
        return null;
    }
  };

  return (
    <div className="marketing-dashboard">
      <header>
        <h2>Tools</h2>
        <p>Small standalone utilities that don't belong to a specific workflow.</p>
      </header>

      <div className="marketing-content">{renderTool()}</div>
    </div>
  );
};

export default ToolsDashboard;
