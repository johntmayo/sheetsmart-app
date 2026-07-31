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
    const r = s.recentRuns.find((x) => x.id === 15);
    const summary = (r?.summary_json || '').slice(0, 160);
    console.log(new Date().toISOString(), r?.status || 'missing', summary);
    if (r && (r.status === 'succeeded' || r.status === 'failed')) {
      clearInterval(timer);
      if (r.status === 'failed') {
        execSync('curl.exe -s -b cookies.txt http://localhost:3001/api/runs/15 -o run15.json');
        console.log(fs.readFileSync('run15.json', 'utf8').slice(0, 2000));
      }
      process.exit(r.status === 'succeeded' ? 0 : 1);
    }
    if (i > 180) {
      clearInterval(timer);
      console.log('timeout');
      process.exit(2);
    }
  } catch (error) {
    console.log('poll err', error.message);
  }
}, 10000);
