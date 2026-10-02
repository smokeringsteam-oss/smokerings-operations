// The "remind me on this device" switch, which lives next to the day filters
// in Daily View.
//
// Per device, not per person — that is the thing worth understanding about it.
// A push subscription belongs to one browser on one handset, so turning this on
// from the phone does nothing for the desktop and vice versa. The label says
// "this device" for that reason rather than to be chatty.
//
// Everything that can go wrong here goes wrong on a phone, where nobody is
// going to open a console, so every failure is surfaced as text on the page.
import React, { useCallback, useEffect, useState } from 'react';
import {
  disablePush,
  enablePush,
  getDiagnostics,
  getPushState,
  sendAlarmTest,
  sendTestPush,
  showLocalTestNotification,
  type PushState,
} from '../../lib/push';

const PushToggle: React.FC = () => {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [digestTime, setDigestTime] = useState('');
  // What the device says about itself, shown only when asked for — see the
  // "Why not?" button below.
  const [diagnostics, setDiagnostics] = useState<Record<string, string> | null>(null);
  // Null until the server answers, so the control renders nothing rather than
  // flashing "not set up" at someone whose server is fine.
  const [configured, setConfigured] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    setState(await getPushState());
  }, []);

  useEffect(() => {
    refresh();
    fetch('/api/push/status')
      .then((r) => r.json())
      .then((data) => {
        setConfigured(!!data.configured);
        setDigestTime(data.digestTime || '');
      })
      .catch(() => setConfigured(false));
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await action();
      await refresh();
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!state || configured === null) return null;

  // Nothing to offer on a browser that cannot do this, or a server with no
  // keys — but say which, because the two look identical from the outside.
  if (!state.supported || !configured) {
    return (
      <p className="inv-section-hint">
        🔕{' '}
        {!configured
          ? 'Reminders are not set up on the server yet — run `npm run push:keys` and add the keys to .env.'
          : state.blockedReason}
      </p>
    );
  }

  const on = state.subscribed && state.permission === 'granted';

  return (
    <>
      <div className="daily-view-filter-actions">
        <button
          type="button"
          className="secondary-button small"
          aria-pressed={on}
          disabled={busy || state.permission === 'denied'}
          onClick={() => run(on ? disablePush : enablePush)}
        >
          {busy ? 'Working…' : on ? '🔔 Reminders on' : '🔕 Remind me on this device'}
        </button>

        {on && (
          <button
            type="button"
            className="secondary-button small"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setNote(await sendTestPush());
              })
            }
          >
            Send now
          </button>
        )}

        {on && (
          <button
            type="button"
            className="secondary-button small"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setNote(await sendAlarmTest());
              })
            }
          >
            🚨 Test alarm
          </button>
        )}
      </div>

      {on && !error && !note && (
        <p className="inv-section-hint">
          This device gets a summary of what's still pending
          {digestTime ? ` at ${digestTime}` : ' each morning'}, and a nudge as each timed task comes up.
          Reminders only go out while the dashboard's server is running on legion.
        </p>
      )}
      {state.blockedReason && <p className="inv-section-hint">🔕 {state.blockedReason}</p>}
      {note && <p className="inv-section-hint">{note}</p>}
      {error && <p className="chat-error">{error}</p>}

      {/* Always reachable, not only after a failure.
          It was gated on there being an error, which got it exactly backwards:
          once the toggle succeeded there was no error, so the button vanished —
          and "it says it is on but nothing arrives" is precisely the state that
          needs these. On a phone this is the only way to see any of it, since
          there is no console to open. */}
      <div className="daily-view-filter-actions">
        <button
          type="button"
          className="secondary-button small"
          onClick={async () => setDiagnostics(diagnostics ? null : await getDiagnostics())}
        >
          {diagnostics ? 'Hide details' : 'Troubleshoot'}
        </button>
        {diagnostics && (
          <button
            type="button"
            className="secondary-button small"
            onClick={() =>
              run(async () => {
                setNote(await showLocalTestNotification());
              })
            }
          >
            Test without push
          </button>
        )}
      </div>

      {diagnostics && (
        <pre className="inv-section-hint" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {Object.entries(diagnostics)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n')}
        </pre>
      )}
    </>
  );
};

export default PushToggle;
