const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'shutdown') process.exit(0);
  const text = request.params?.input?.text || '';
  process.stdout.write(JSON.stringify({
    id: request.id,
    result: { text }
  }) + '\n');
});
