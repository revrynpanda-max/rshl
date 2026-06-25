const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true
  });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    console.log(`[BROWSER CONSOLE] ${msg.type()}: ${msg.text()}`);
  });
  
  page.on('pageerror', err => {
    console.log(`[BROWSER ERROR] ${err.toString()}`);
  });
  
  page.on('requestfailed', req => {
    console.log(`[NETWORK FAIL] ${req.url()} - ${req.failure().errorText}`);
  });

  console.log("Navigating to http://localhost:3001...");
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle2' });
  console.log("Page loaded. Waiting 2 seconds for potential async errors...");
  await new Promise(r => setTimeout(r, 2000));
  
  await browser.close();
})();
