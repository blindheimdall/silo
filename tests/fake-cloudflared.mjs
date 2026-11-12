// Stands in for cloudflared in tests: prints what the real one prints and stays up. It forwards nothing;
// the tests send "tunneled" requests themselves, with the headers Cloudflare adds.
const args = process.argv.slice(2);
const log = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
if (args.includes('run')) {
  if (!process.env.TUNNEL_TOKEN) { log('ERR Unauthorized: Invalid tunnel secret'); process.exit(1); }
} else {
  log('INF Requesting new quick Tunnel on trycloudflare.com...');
  log('INF +--------------------------------------------------------------------------------------------+');
  log('INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');
  log('INF |  https://fake-quiet-river.trycloudflare.com                                                |');
  log('INF +--------------------------------------------------------------------------------------------+');
}
setTimeout(() => log('INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=otp01 protocol=quic'), 150);
setInterval(() => {}, 1 << 30);
