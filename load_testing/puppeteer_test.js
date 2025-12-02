import puppeteer from "puppeteer";

const NUM_CLIENTS = 5;
const APP_URL = "http://localhost:5173/p2p-mesh-sharing/"; // adjust to your dev server

const browsers = [];
const pages = [];

console.log("Launching clients...");

for (let i = 0; i < NUM_CLIENTS; i++) {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  browsers.push(browser);
  pages.push(page);

  await page.goto(APP_URL);
  console.log(`Client ${i} started`);
}

console.log("\nSending test mesh from Client 0...");

await pages[0].evaluate(() => {
  // Example testing hook
  window.sendTestMesh();
});

// 4. Confirm all clients receive the mesh
console.log("\nVerifying mesh reception...");

for (let i = 0; i < NUM_CLIENTS; i++) {
  const events = await pages[i].evaluate(() => window.p2pEvents);
  const gotMesh = events.some(e => e === "mesh:test_model_1.glb");
  console.log(`Client ${i} received mesh: ${gotMesh}`);
}

// Done
console.log("\nLoad test complete.");

await Promise.all(browsers.map(b => b.close()));
