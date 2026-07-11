const { JSDOM } = require('jsdom');
const fs = require('fs');

async function testPage(file, extraGlobals) {
  const html = fs.readFileSync(require('path').join(__dirname,'..',file), 'utf-8');
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://saranya-cmyk.github.io/installation-app/' + file + (file==='portal.html' ? '?key=test123' : ''),
    beforeParse(window) {
      // mock fetch — ตอบ JSON เปล่าๆ ทุก endpoint
      window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ jobs: [], log: [], problems: [], repairs: [], error: null }) });
      window.navigator.geolocation = { getCurrentPosition: (ok, err) => err && err() };
      window.alert = () => {}; window.confirm = () => true;
      window.L = new Proxy(function(){}, { get: () => new Proxy(function(){ return window.L; }, { get: () => window.L, apply: () => window.L }), apply: () => window.L });
      window.AudioContext = function(){ this.state='running'; this.resume=()=>{}; this.createOscillator=()=>({connect:()=>{},start:()=>{},stop:()=>{},type:'',frequency:{value:0}}); this.createGain=()=>({connect:()=>{},gain:{setValueAtTime:()=>{},exponentialRampToValueAtTime:()=>{}}}); this.currentTime=0; this.destination={}; };
      window.Notification = function(){}; window.Notification.permission = 'denied';
      window.onerror = (msg) => { errors.push(String(msg)); };
      window.addEventListener('error', e => errors.push(String(e.message || e.error)));
      window.addEventListener('unhandledrejection', e => errors.push('rejection: ' + e.reason));
    }
  });
  await new Promise(r => setTimeout(r, 1500)); // ให้ init + fetch mock ทำงาน
  console.log((errors.length ? '❌' : '✅') + ' ' + file + (errors.length ? '\n   ' + errors.slice(0,5).join('\n   ') : ' — โหลดสะอาด ไม่มี error'));
  dom.window.close();
}

(async () => {
  await testPage('index.html');
  await testPage('admin.html');
  await testPage('portal.html');
  process.exit(0);
})();
