import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

// CSV Editor — a general-purpose spreadsheet-style editor for any local CSV
// file, independent of the app's own knowledge-base data. Opens via the
// File System Access API where available (Chrome/Edge) so "Save" writes
// straight back to the same file on disk; everywhere else it falls back to
// a plain <input type="file"> for opening and a download for saving.
//
// The grid is windowed (only the rows scrolled into view are mounted) so
// files with tens of thousands of rows stay responsive — column count is
// left unvirtualized since real-world CSVs rarely run wide enough to matter.

// ---- Minimal File System Access API surface (not yet in TS's default DOM
// lib on this project's TS version) — declared locally rather than widening
// global types, and always reached through a feature-detect first.
type FsWritable = { write: (data: string) => Promise<void>; close: () => Promise<void> };
type FsFileHandle = { getFile: () => Promise<File>; createWritable: () => Promise<FsWritable>; name: string };
type FsWindow = {
  showOpenFilePicker?: (opts: unknown) => Promise<FsFileHandle[]>;
  showSaveFilePicker?: (opts: unknown) => Promise<FsFileHandle>;
};

const fsWindow = () => window as unknown as FsWindow;
const canPickFiles = () => typeof fsWindow().showOpenFilePicker === 'function';
const canSaveAs = () => typeof fsWindow().showSaveFilePicker === 'function';
const isAbort = (err: unknown) => (err as { name?: string })?.name === 'AbortError';

// ---- RFC4180 parse/serialize. Self-contained: this tool opens whatever CSV
// you point it at, and is the only thing in the app that touches one — kept
// browser-only (no `fs`) and array-of-arrays shaped for a live-editable grid.
function parseCsvText(text: string): { headers: string[]; rows: string[][] } {
  const table: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    table.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\r') {
      // swallow — paired \n (or lone \r) handled below
    } else if (c === '\n') pushRow();
    else field += c;
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const nonEmpty = table.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };

  const [headers, ...dataRows] = nonEmpty;
  const width = headers.length;
  const rows = dataRows.map((r) => {
    if (r.length === width) return r;
    const copy = r.slice(0, width);
    while (copy.length < width) copy.push('');
    return copy;
  });
  return { headers, rows };
}

const needsQuoting = (value: string) => /[",\r\n]/.test(value);
const encodeField = (value: string) => (needsQuoting(value) ? `"${value.replace(/"/g, '""')}"` : value);

function serializeCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(encodeField).join(','), ...rows.map((r) => r.map(encodeField).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const ROW_HEIGHT = 34;
const COL_WIDTH = 190;
const ROWNUM_WIDTH = 60;
const VIEWPORT_HEIGHT = 460;
const OVERSCAN = 10;
const LARGE_FILE_BYTES = 25 * 1024 * 1024;

const CsvEditor = () => {
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [filterText, setFilterText] = useState('');
  const [scrollTop, setScrollTop] = useState(0);

  const fileHandleRef = useRef<FsFileHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Warn before leaving the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const hasFile = headers.length > 0 || rows.length > 0 || fileName !== '';

  const loadFromFile = async (file: File) => {
    setError('');
    setStatus('');
    setBusy(true);
    try {
      if (file.size > LARGE_FILE_BYTES) {
        setStatus(`Reading a large file (${formatBytes(file.size)}) — this may take a moment…`);
      }
      const text = await file.text();
      const parsed = parseCsvText(text);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      setFileName(file.name);
      setFileSize(file.size);
      setDirty(false);
      setFilterText('');
      setScrollTop(0);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setStatus(`Loaded ${parsed.rows.length.toLocaleString()} rows × ${parsed.headers.length} columns (${formatBytes(file.size)}).`);
    } catch (err) {
      setError(`Couldn't read that file: ${String((err as Error).message || err)}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmDiscardIfDirty = () => {
    if (!dirty) return true;
    return window.confirm('You have unsaved changes that will be lost. Continue?');
  };

  const handleOpenClick = async () => {
    if (!confirmDiscardIfDirty()) return;
    if (canPickFiles()) {
      try {
        const [handle] = await fsWindow().showOpenFilePicker!({
          types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }],
          excludeAcceptAllOption: false,
          multiple: false,
        });
        const file = await handle.getFile();
        fileHandleRef.current = handle;
        await loadFromFile(file);
        return;
      } catch (err) {
        if (isAbort(err)) return;
        setError(`Couldn't open that file: ${String((err as Error).message || err)}`);
        return;
      }
    }
    fileInputRef.current?.click();
  };

  const handleFileInputChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    fileHandleRef.current = null;
    await loadFromFile(file);
  };

  const downloadCsv = (text: string, name: string) => {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'edited.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleSave = async () => {
    if (!hasFile || busy) return;
    setError('');
    setStatus('');
    const text = serializeCsv(headers, rows);
    try {
      if (fileHandleRef.current) {
        const writable = await fileHandleRef.current.createWritable();
        await writable.write(text);
        await writable.close();
        setDirty(false);
        setStatus(`Saved ${fileName}.`);
        return;
      }
      downloadCsv(text, fileName || 'edited.csv');
      setDirty(false);
      setStatus(`Downloaded ${fileName || 'edited.csv'} to your downloads folder.`);
    } catch (err) {
      if (isAbort(err)) return;
      setError(`Couldn't save: ${String((err as Error).message || err)}`);
    }
  };

  const handleSaveAs = async () => {
    if (!hasFile || busy) return;
    setError('');
    setStatus('');
    const text = serializeCsv(headers, rows);
    if (canSaveAs()) {
      try {
        const handle = await fsWindow().showSaveFilePicker!({
          suggestedName: fileName || 'edited.csv',
          types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        fileHandleRef.current = handle;
        setFileName(handle.name);
        setDirty(false);
        setStatus(`Saved ${handle.name}.`);
        return;
      } catch (err) {
        if (isAbort(err)) return;
        setError(`Couldn't save: ${String((err as Error).message || err)}`);
        return;
      }
    }
    downloadCsv(text, fileName || 'edited.csv');
    setDirty(false);
  };

  const handleCloseFile = () => {
    if (!confirmDiscardIfDirty()) return;
    fileHandleRef.current = null;
    setFileName('');
    setFileSize(0);
    setHeaders([]);
    setRows([]);
    setDirty(false);
    setError('');
    setStatus('');
    setFilterText('');
    setScrollTop(0);
  };

  const updateCell = (rowIndex: number, colIndex: number, value: string) => {
    setRows((prev) => {
      const next = prev.slice();
      const r = next[rowIndex].slice();
      r[colIndex] = value;
      next[rowIndex] = r;
      return next;
    });
    setDirty(true);
  };

  const updateHeader = (colIndex: number, value: string) => {
    setHeaders((prev) => {
      const next = prev.slice();
      next[colIndex] = value;
      return next;
    });
    setDirty(true);
  };

  const addRow = () => {
    setRows((prev) => [...prev, new Array(headers.length).fill('')]);
    setDirty(true);
  };

  const deleteRow = (rowIndex: number) => {
    setRows((prev) => prev.filter((_, i) => i !== rowIndex));
    setDirty(true);
  };

  const addColumn = () => {
    const name = window.prompt('New column name', `Column ${headers.length + 1}`);
    if (name === null) return;
    setHeaders((prev) => [...prev, name || `Column ${prev.length + 1}`]);
    setRows((prev) => prev.map((r) => [...r, '']));
    setDirty(true);
  };

  const deleteColumn = (colIndex: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== colIndex));
    setRows((prev) => prev.map((r) => r.filter((_, i) => i !== colIndex)));
    setDirty(true);
  };

  const visibleRows = useMemo(() => {
    const indexed = rows.map((cells, index) => ({ index, cells }));
    const needle = filterText.trim().toLowerCase();
    if (!needle) return indexed;
    return indexed.filter(({ cells }) => cells.some((c) => c.toLowerCase().includes(needle)));
  }, [rows, filterText]);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(visibleRows.length, startIndex + visibleCount);
  const windowRows = visibleRows.slice(startIndex, endIndex);
  const topPad = startIndex * ROW_HEIGHT;
  const bottomPad = (visibleRows.length - endIndex) * ROW_HEIGHT;

  const handleFilterChange = (value: string) => {
    setFilterText(value);
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  return (
    <div className="wizard-page csv-editor-page">
      <div className="wizard-header">
        <h1>CSV Editor</h1>
        <p>Open any CSV from your computer, edit it like a spreadsheet, and save it back — no size limit, no upload.</p>
      </div>

      <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="csv-hidden-input" onChange={handleFileInputChange} />

      <div className="wizard-card csv-toolbar">
        <div className="csv-toolbar-left">
          <button type="button" className="primary-button" onClick={handleOpenClick} disabled={busy}>
            📂 Open CSV…
          </button>
          {hasFile && (
            <>
              <button type="button" className="secondary-button" onClick={handleSave} disabled={busy}>
                💾 Save
              </button>
              <button type="button" className="secondary-button" onClick={handleSaveAs} disabled={busy}>
                Save As…
              </button>
              <button type="button" className="secondary-button" onClick={handleCloseFile} disabled={busy}>
                Close
              </button>
            </>
          )}
        </div>
        {hasFile && (
          <div className="csv-toolbar-right">
            <span className="csv-file-name">
              {fileName || 'Untitled.csv'}
              {dirty && <span className="csv-dirty-dot" title="Unsaved changes">●</span>}
            </span>
            <span className="csv-file-meta">
              {rows.length.toLocaleString()} rows × {headers.length} cols
              {fileSize > 0 ? ` · ${formatBytes(fileSize)}` : ''}
            </span>
          </div>
        )}
      </div>

      {error && <p className="chat-error">{error}</p>}
      {status && !error && <p className="status-message">{status}</p>}
      {!canPickFiles() && hasFile && (
        <p className="inv-note">
          Your browser doesn't support saving straight back to the original file, so Save downloads an updated copy instead.
        </p>
      )}

      {!hasFile ? (
        <div className="empty-state">
          <div className="empty-state-icon">🗂️</div>
          <h3>No file open</h3>
          <p>Open a CSV file to start editing. Files stay on your computer — nothing is uploaded.</p>
        </div>
      ) : (
        <div className="wizard-card csv-editor-card">
          <div className="csv-grid-controls">
            <input
              className="csv-filter-input"
              type="text"
              placeholder="Filter rows…"
              value={filterText}
              onChange={(e) => handleFilterChange(e.target.value)}
            />
            <div className="csv-grid-controls-right">
              <button type="button" className="secondary-button small" onClick={addRow}>
                + Row
              </button>
              <button type="button" className="secondary-button small" onClick={addColumn}>
                + Column
              </button>
            </div>
          </div>
          {filterText && (
            <p className="inv-note-inline">
              Showing {visibleRows.length.toLocaleString()} of {rows.length.toLocaleString()} rows matching "{filterText}".
            </p>
          )}

          <div
            className="csv-grid-wrap"
            ref={scrollRef}
            style={{ height: VIEWPORT_HEIGHT }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <table className="csv-table" style={{ width: ROWNUM_WIDTH + headers.length * COL_WIDTH }}>
              <colgroup>
                <col style={{ width: ROWNUM_WIDTH }} />
                {headers.map((_, i) => (
                  <col key={i} style={{ width: COL_WIDTH }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="csv-rownum-col">#</th>
                  {headers.map((h, colIndex) => (
                    <th key={colIndex}>
                      <div className="csv-header-cell">
                        <input value={h} onChange={(e) => updateHeader(colIndex, e.target.value)} />
                        <button type="button" className="csv-col-delete" title="Delete column" onClick={() => deleteColumn(colIndex)}>
                          ✕
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topPad > 0 && (
                  <tr style={{ height: topPad }} aria-hidden="true">
                    <td colSpan={headers.length + 1} />
                  </tr>
                )}
                {windowRows.map(({ index, cells }) => (
                  <tr key={index} style={{ height: ROW_HEIGHT }}>
                    <td className="csv-rownum-col">
                      <span>{index + 1}</span>
                      <button type="button" className="csv-row-delete" title="Delete row" onClick={() => deleteRow(index)}>
                        🗑
                      </button>
                    </td>
                    {cells.map((val, colIndex) => (
                      <td key={colIndex}>
                        <input value={val} onChange={(e) => updateCell(index, colIndex, e.target.value)} />
                      </td>
                    ))}
                  </tr>
                ))}
                {bottomPad > 0 && (
                  <tr style={{ height: bottomPad }} aria-hidden="true">
                    <td colSpan={headers.length + 1} />
                  </tr>
                )}
                {visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={headers.length + 1} className="csv-no-rows">
                      No rows match that filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default CsvEditor;
