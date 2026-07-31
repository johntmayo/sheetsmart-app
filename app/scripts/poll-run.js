const runId = Number(process.argv[2]);
if (!runId) {
  console.error('Usage: node scripts/poll-run.js <runId>');
  process.exit(1);
}
const { execSync } = require('child_process');
const fs = require('fs');

function status() {
  execSync('curl.exe -s -b cookies.txt http://localhost:3001/api/status -o status.json');
  return JSON.parse(fs.readFileSync('status.json', 'utf8'));
}

let i = 0;
const timer = setInterval(() => {
  i += 1;
  try {
    const s = status();
    const r = s.recentRuns.find((x) => x.id === runId);
    console.log(new Date().toISOString(), r?.status || 'missing', (r?.summary_json || '').slice(0, 180));
    if (r && (r.status === 'succeeded' || r.status === 'failed')) {
      clearInterval(timer);
      execSync(`curl.exe -s -b cookies.txt http://localhost:3001/api/runs/${runId} -o run-detail.json`);
      const detail = JSON.parse(fs.readFileSync('run-detail.json', 'utf8'));
      if (r.status === 'failed') console.log('ERROR:', detail.job?.error);
      else console.log('SUMMARY:', detail.run?.summary_json);
      process.exit(r.status === 'succeeded' ? 0 : 1);
    }
    if (i > 240) {
      clearInterval(timer);
      console.log('timeout');
      process.exit(2);
    }
  } catch (error) {
    console.log('poll err', error.message);
  }
}, 10000);
