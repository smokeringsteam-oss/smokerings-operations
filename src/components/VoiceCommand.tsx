import { useEffect, useRef, useState } from 'react';
import { readNotesAuthor, useSharedNotes } from '../lib/useSharedNotes';
import { startRecording, type Recording } from '../lib/voiceRecorder';
import { createScheduleTask } from '../pages/sprint/recurringSchedule';
import { TEAM } from './NotesBubble';

// The mic button beside the note bubble: say what was bought or what needs
// doing, check what it heard, confirm.
//
// At the app shell for the same reason the note bubble is — the purchase gets
// unloaded and the to-do occurs to you on whatever screen you happen to be on,
// usually with your hands full.
//
// It never saves what it heard on its own. The server hands back a draft (see
// server/ops/shared/voiceCommand.js), every field of it is editable here, and
// Confirm writes through the same endpoints the typed screens use: a purchase
// through POST /api/purchasing/purchases, a one-off to-do onto the shared note
// board, a repeating one into the weekly cadence. Speech over a smoker's fan
// mishears a 15 as a 50 often enough that a confirm step is the whole design.

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// A command is a sentence. Past a minute it is a meeting, and the cap is also
// what stops a forgotten open mic from recording the rest of service.
const MAX_SECONDS = 60;

type DraftLine = { materialId: string; itemName: string; unit: string; quantity: number; unitPrice: number };

type DraftPurchase = {
  vendorName: string;
  // What was said, when it matched no vendor in the book.
  vendorText: string;
  purchaseDate: string;
  channel: 'B2C' | 'B2B';
  lines: DraftLine[];
  skipped: { itemName: string; reason: string }[];
};

type DraftTask = { title: string; assignee: string; repeatsWeekly: boolean; day: string; time: string };

type Draft = { transcript: string; notes: string; purchase: DraftPurchase | null; tasks: DraftTask[] };

type Phase = 'idle' | 'recording' | 'thinking' | 'review' | 'saving';

const todayIso = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const todayName = () => new Date().toLocaleDateString('en-US', { weekday: 'long' });

async function readJson(resp: Response) {
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body?.error || `Request failed (${resp.status})`);
  return body;
}

const VoiceCommand = () => {
  const { addNote, assignNote } = useSharedNotes();
  const [phase, setPhase] = useState<Phase>('idle');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [vendors, setVendors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // What the last Confirm actually wrote, one line per thing.
  const [saved, setSaved] = useState<string[]>([]);
  const [typed, setTyped] = useState('');

  const recordingRef = useRef<Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  // An open mic must not outlive the component.
  useEffect(
    () => () => {
      clearTimer();
      recordingRef.current?.cancel();
    },
    [],
  );

  const interpret = async (body: FormData) => {
    setPhase('thinking');
    setError(null);
    try {
      body.append('team', JSON.stringify(TEAM));
      const [result, vendorList] = await Promise.all([
        fetch('/api/voice/command', { method: 'POST', body }).then(readJson),
        // Only the names, for the vendor picker. A failure here leaves the
        // picker with just the matched vendor rather than failing the command.
        fetch('/api/purchasing/vendors')
          .then(readJson)
          .then((data) => (data.vendors || []).map((v: { vendor_name: string }) => v.vendor_name))
          .catch(() => [] as string[]),
      ]);
      setVendors(vendorList);
      const heard = result as Draft;
      if (heard.purchase && !heard.purchase.purchaseDate) heard.purchase.purchaseDate = todayIso();
      setDraft(heard);
      setPhase('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };

  const stopAndSend = async () => {
    clearTimer();
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (!recording) return;
    setPhase('thinking');
    try {
      const clip = await recording.stop();
      const body = new FormData();
      body.append('audio', clip, 'command.wav');
      await interpret(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };

  const begin = async () => {
    setOpen(true);
    setError(null);
    setSaved([]);
    setDraft(null);
    try {
      recordingRef.current = await startRecording();
      setPhase('recording');
      timerRef.current = setTimeout(() => void stopAndSend(), MAX_SECONDS * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };

  const close = () => {
    clearTimer();
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setOpen(false);
    setPhase('idle');
    setDraft(null);
    setError(null);
    setSaved([]);
  };

  const onMic = () => {
    if (phase === 'recording') void stopAndSend();
    else if (phase === 'idle' || phase === 'review') void begin();
  };

  const sendTyped = () => {
    const text = typed.trim();
    if (!text) return;
    const body = new FormData();
    body.append('text', text);
    setSaved([]);
    setTyped('');
    void interpret(body);
  };

  const patchPurchase = (patch: Partial<DraftPurchase>) =>
    setDraft((d) => (d && d.purchase ? { ...d, purchase: { ...d.purchase, ...patch } } : d));

  const patchLine = (index: number, patch: Partial<DraftLine>) =>
    setDraft((d) =>
      d && d.purchase
        ? { ...d, purchase: { ...d.purchase, lines: d.purchase.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) } }
        : d,
    );

  const removeLine = (index: number) =>
    setDraft((d) => {
      if (!d || !d.purchase) return d;
      const lines = d.purchase.lines.filter((_, i) => i !== index);
      return { ...d, purchase: lines.length ? { ...d.purchase, lines } : null };
    });

  const patchTask = (index: number, patch: Partial<DraftTask>) =>
    setDraft((d) => (d ? { ...d, tasks: d.tasks.map((t, i) => (i === index ? { ...t, ...patch } : t)) } : d));

  const removeTask = (index: number) =>
    setDraft((d) => (d ? { ...d, tasks: d.tasks.filter((_, i) => i !== index) } : d));

  // Saves the purchase, then each task, dropping every piece from the draft as
  // it lands. A failure part-way leaves exactly what is still unsaved on
  // screen, so a second Confirm cannot log the pork twice.
  const confirm = async () => {
    if (!draft || phase !== 'review') return;
    const { purchase } = draft;
    if (purchase?.lines.length) {
      if (!purchase.vendorName) {
        setError('Pick the vendor this was bought from.');
        return;
      }
      const empty = purchase.lines.find((line) => !line.itemName.trim() || !(line.quantity > 0));
      if (empty) {
        setError(`"${empty.itemName.trim() || 'One line'}" needs a name and a quantity above 0 — fix it or remove the line.`);
        return;
      }
    }
    setPhase('saving');
    setError(null);
    const done: string[] = [];
    try {
      if (purchase?.lines.length) {
        const result = await fetch('/api/purchasing/purchases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vendorName: purchase.vendorName,
            purchaseDate: purchase.purchaseDate,
            channel: purchase.channel,
            lines: purchase.lines.map(({ materialId, itemName, quantity, unitPrice }) => ({
              materialId,
              itemName: itemName.trim(),
              quantity,
              // Blank rather than 0 when no price was said: the log can hold
              // "unknown", and a ₹0 buy would drag the item's average cost.
              unitPrice: unitPrice > 0 ? unitPrice : '',
            })),
          }),
        }).then(readJson);
        const unstocked = (result.inventorySkipped || []).length;
        done.push(
          `Logged ${purchase.lines.length} purchase ${purchase.lines.length === 1 ? 'line' : 'lines'} from ${purchase.vendorName}` +
            (unstocked ? ` — ${unstocked} not in the catalogue, so no stock moved; finish in Weekly Purchasing.` : '.'),
        );
        setDraft((d) => (d ? { ...d, purchase: null } : d));
      }

      for (const task of draft.tasks) {
        const title = task.title.trim();
        if (title) {
          if (task.repeatsWeekly) {
            const day = task.day || todayName();
            await createScheduleTask({ day, label: title.slice(0, 140), time: task.time, assignedTo: task.assignee });
            done.push(`Added “${title}” to every ${day}.`);
          } else {
            const note = await addNote(title, readNotesAuthor());
            if (task.assignee) await assignNote(note.id, task.assignee);
            done.push(`Added “${title}” to the board${task.assignee ? ` for ${task.assignee}` : ''}.`);
          }
        }
        setDraft((d) => (d ? { ...d, tasks: d.tasks.filter((t) => t !== task) } : d));
      }

      setSaved(done);
      setDraft(null);
      setPhase('idle');
    } catch (err) {
      setSaved(done);
      setError(err instanceof Error ? err.message : String(err));
      setPhase('review');
    }
  };

  const purchase = draft?.purchase ?? null;
  const tasks = draft?.tasks ?? [];
  const nothingHeard = phase === 'review' && !purchase && tasks.length === 0;
  const vendorOptions =
    purchase?.vendorName && !vendors.includes(purchase.vendorName) ? [...vendors, purchase.vendorName] : vendors;
  const purchaseTotal = purchase ? purchase.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0) : 0;

  return (
    <div className="voice-root">
      <button
        type="button"
        className={`notes-toggle voice-toggle${phase === 'recording' ? ' is-recording' : ''}`}
        aria-label={phase === 'recording' ? 'Stop and send the voice command' : 'Give a voice command'}
        disabled={phase === 'thinking' || phase === 'saving'}
        onClick={onMic}
      >
        <span aria-hidden="true">{phase === 'recording' ? '⏹' : '🎙️'}</span>
      </button>

      {open ? (
        <div className="notes-panel voice-panel" role="dialog" aria-label="Voice command">
          <header className="notes-panel-head">
            <div>
              <h2>Voice command</h2>
              <p>
                {phase === 'recording'
                  ? 'Listening — tap the button again when you are done'
                  : phase === 'thinking'
                    ? 'Working out what you said…'
                    : phase === 'saving'
                      ? 'Saving…'
                      : phase === 'review'
                        ? 'Check it, then confirm'
                        : 'Log a purchase or add a task'}
              </p>
            </div>
            <button type="button" className="notes-close" aria-label="Close voice command" onClick={close}>
              <span aria-hidden="true">✕</span>
            </button>
          </header>

          {error ? <p className="notes-alert">{error}</p> : null}

          <div className="voice-body">
            {phase === 'recording' ? (
              <p className="voice-hint">
                Try “bought 5 kg pork shoulder from SK Pork at 540 a kilo” or “remind Sowmya to call the gas vendor”.
              </p>
            ) : null}

            {saved.map((line) => (
              <p key={line} className="voice-saved" role="status">
                ✓ {line}
              </p>
            ))}

            {draft?.transcript ? <p className="voice-transcript">“{draft.transcript}”</p> : null}
            {draft?.notes ? <p className="voice-hint">{draft.notes}</p> : null}
            {nothingHeard ? (
              <p className="voice-hint">
                No purchase or task in that. Tap the mic and try again, or type it below.
              </p>
            ) : null}

            {purchase ? (
              <section className="voice-section">
                <h3>Purchase</h3>
                <div className="notes-task-fields">
                  <select
                    value={purchase.vendorName}
                    aria-label="Vendor"
                    onChange={(event) => patchPurchase({ vendorName: event.target.value })}
                  >
                    <option value="">Pick vendor…</option>
                    {vendorOptions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={purchase.channel}
                    aria-label="Bought for"
                    onChange={(event) => patchPurchase({ channel: event.target.value as 'B2C' | 'B2B' })}
                  >
                    <option value="B2C">B2C</option>
                    <option value="B2B">B2B</option>
                  </select>
                </div>
                {!purchase.vendorName ? (
                  <p className="voice-hint">
                    {purchase.vendorText
                      ? `Heard “${purchase.vendorText}”, which is not in the vendor book — pick the vendor, or add it under Vendors first.`
                      : 'No vendor was said — pick one.'}
                  </p>
                ) : null}
                <div className="notes-task-fields">
                  <input
                    type="date"
                    value={purchase.purchaseDate}
                    aria-label="Purchase date"
                    onChange={(event) => patchPurchase({ purchaseDate: event.target.value })}
                  />
                </div>

                {purchase.lines.map((line, index) => (
                  // Index keys are safe here: rows are only ever removed by
                  // the ✕ on the row itself, never reordered.
                  <div key={index} className="voice-line">
                    <input
                      type="text"
                      className="voice-line-name"
                      value={line.itemName}
                      aria-label="Item"
                      // Retyping the name makes it a different item, so the
                      // catalogue link no longer applies.
                      onChange={(event) => patchLine(index, { itemName: event.target.value, materialId: '' })}
                    />
                    <label>
                      <span>Qty{line.unit ? ` (${line.unit})` : ''}</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={line.quantity || ''}
                        onChange={(event) => patchLine(index, { quantity: Number(event.target.value) || 0 })}
                      />
                    </label>
                    <label>
                      <span>₹ / unit</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={line.unitPrice || ''}
                        onChange={(event) => patchLine(index, { unitPrice: Number(event.target.value) || 0 })}
                      />
                    </label>
                    <button
                      type="button"
                      className="notes-item-delete"
                      aria-label={`Remove ${line.itemName || 'line'}`}
                      onClick={() => removeLine(index)}
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                    {!line.materialId ? <p className="voice-line-flag">Not in the catalogue — logs the spend, moves no stock.</p> : null}
                  </div>
                ))}
                {purchase.skipped.map((skip) => (
                  <p key={`${skip.itemName}-${skip.reason}`} className="voice-hint">
                    Left out “{skip.itemName || 'a line'}” — {skip.reason}
                  </p>
                ))}
                {purchaseTotal > 0 ? <p className="voice-total">Total ₹{purchaseTotal.toLocaleString('en-IN')}</p> : null}
              </section>
            ) : null}

            {tasks.length ? (
              <section className="voice-section">
                <h3>{tasks.length === 1 ? 'Task' : 'Tasks'}</h3>
                {tasks.map((task, index) => (
                  <div key={index} className="voice-task">
                    <div className="notes-composer-row">
                      <textarea
                        rows={2}
                        value={task.title}
                        aria-label="Task"
                        onChange={(event) => patchTask(index, { title: event.target.value })}
                      />
                      <button
                        type="button"
                        className="notes-item-delete"
                        aria-label={`Remove task ${task.title}`}
                        onClick={() => removeTask(index)}
                      >
                        <span aria-hidden="true">✕</span>
                      </button>
                    </div>
                    <div className="notes-task-fields">
                      <select
                        value={task.assignee}
                        aria-label="Assigned to"
                        onChange={(event) => patchTask(index, { assignee: event.target.value })}
                      >
                        <option value="">Nobody in particular</option>
                        {TEAM.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      {task.repeatsWeekly ? (
                        <select
                          value={task.day || todayName()}
                          aria-label="Repeats on"
                          onChange={(event) => patchTask(index, { day: event.target.value })}
                        >
                          {WEEKDAYS.map((day) => (
                            <option key={day} value={day}>
                              Every {day}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                    <label className="notes-repeat">
                      <input
                        type="checkbox"
                        checked={task.repeatsWeekly}
                        onChange={(event) => patchTask(index, { repeatsWeekly: event.target.checked })}
                      />
                      <span>Repeats weekly</span>
                    </label>
                  </div>
                ))}
              </section>
            ) : null}
          </div>

          {phase === 'review' && (purchase || tasks.length) ? (
            <div className="voice-actions">
              <button type="button" className="voice-cancel" onClick={close}>
                Discard
              </button>
              <button type="button" className="notes-send" onClick={() => void confirm()}>
                Confirm
              </button>
            </div>
          ) : null}

          {/* The same command, typed — for a browser with no microphone, or a
              kitchen too loud for one. */}
          {phase === 'idle' || nothingHeard ? (
            <form
              className="notes-composer"
              onSubmit={(event) => {
                event.preventDefault();
                sendTyped();
              }}
            >
              <div className="notes-composer-row">
                <input
                  type="text"
                  value={typed}
                  placeholder="…or type the command"
                  aria-label="Type the command"
                  onChange={(event) => setTyped(event.target.value)}
                />
                <button type="submit" className="notes-send" disabled={!typed.trim()}>
                  Go
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default VoiceCommand;
