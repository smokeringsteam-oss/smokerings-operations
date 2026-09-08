// Generates the VAPID key pair push notifications are signed with.
//
//   npm run push:keys
//
// Run once, paste the output into .env, restart the API server. The pair is
// this server's identity to the browser's push service: the public half is
// baked into every subscription a phone creates, and the private half signs
// each send.
//
// Which is why regenerating them is not a free action. Every existing
// subscription was created against the old public key and cannot be signed
// with a new one, so all of them stop working at once and every phone has to
// turn notifications on again. This refuses to overwrite a pair that is
// already set for exactly that reason.
import 'dotenv/config';
import webpush from 'web-push';

const existing = (process.env.VAPID_PUBLIC_KEY || '').trim();
const force = process.argv.includes('--force');

if (existing && !force) {
  console.log('VAPID keys are already set in .env.\n');
  console.log(`  VAPID_PUBLIC_KEY=${existing.slice(0, 12)}…`);
  console.log('\nGenerating a new pair would invalidate every phone that has');
  console.log('notifications turned on — each would have to re-enable them.');
  console.log('Re-run with --force if that is genuinely what you want.');
  process.exit(0);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('Add these three lines to .env, then restart `node server/index.js`:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:smokerings.team@gmail.com');
console.log('\nThe private key never leaves this machine. The public one is');
console.log('handed to every browser that subscribes, and is meant to be.');

if (force && existing) {
  console.log('\n--force was passed: every current subscription is now dead.');
  console.log('Turn notifications off and on again on each phone.');
}
