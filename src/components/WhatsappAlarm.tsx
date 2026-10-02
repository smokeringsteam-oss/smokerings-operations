import { useEffect } from 'react';
import { retry, stop, useWhatsappAlarm } from '../lib/whatsappAlarm';

// The banner the alarm puts on screen while it is sounding.
//
// It exists mostly to be the OFF switch. An alarm that loops until dismissed
// needs somewhere obvious to dismiss it from, and "obvious" here means: on
// top of whatever screen you were on, wide, and reachable without reading
// anything — because the hands holding the phone have probably just come off
// a brisket.
//
// It also carries the one piece of context worth having before you decide
// whether to stop it or go and look: who messaged, and the first line of what
// they said.
//
// Fixed to the top rather than the bottom on purpose: the bottom of a phone
// screen is where the thumb already is, and a Stop button living there would
// be hit by accident while scrolling a packing list.

type Props = {
  // Switches the app to the WhatsApp Inbox. Passed in rather than imported,
  // because the sidebar's active tool is App's state and the banner has no
  // business reaching into it.
  onOpenInbox: () => void;
};

const WhatsappAlarm = ({ onOpenInbox }: Props) => {
  const alarm = useWhatsappAlarm();

  // The banner is fixed, so without this it covers the sidebar logo and the
  // page heading it appears over. A class on <body> rather than a wrapper
  // element, because the thing that has to move is the app shell — which is
  // this component's parent, not its child.
  useEffect(() => {
    document.body.classList.toggle('wa-alarm-open', alarm.active);
    return () => document.body.classList.remove('wa-alarm-open');
  }, [alarm.active]);

  if (!alarm.active) return null;

  const openInbox = () => {
    // Opening the conversation IS dealing with it, so the noise stops. Leaving
    // it running while you read the message would just mean hunting for the
    // Stop button with the laugh still going.
    stop();
    onOpenInbox();
  };

  return (
    <div className="wa-alarm" role="alert" aria-live="assertive">
      <div className="wa-alarm-body">
        <span className="wa-alarm-icon" aria-hidden="true">
          💬
        </span>
        <div className="wa-alarm-text">
          <strong>{alarm.customer || 'New WhatsApp message'}</strong>
          {alarm.body ? <span className="wa-alarm-preview">{alarm.body}</span> : null}
          {alarm.blocked ? <span className="wa-alarm-blocked">{alarm.blocked}</span> : null}
        </div>
      </div>
      <div className="wa-alarm-actions">
        {/* Only when autoplay was refused — otherwise it is a button that does
            nothing visible, next to an alarm that is already sounding. */}
        {alarm.blocked ? (
          <button type="button" className="wa-alarm-btn wa-alarm-btn-sound" onClick={retry}>
            🔊 Sound it
          </button>
        ) : null}
        <button type="button" className="wa-alarm-btn" onClick={openInbox}>
          Open inbox
        </button>
        <button type="button" className="wa-alarm-btn wa-alarm-btn-stop" onClick={stop}>
          Stop
        </button>
      </div>
    </div>
  );
};

export default WhatsappAlarm;
