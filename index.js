import puppeteer from "puppeteer";
import cron from "node-cron";
import 'dotenv/config';

const USERNAME = process.env.MYCLASS_USER;
const PASSWORD = process.env.MYCLASS_PASS;

// helper: wait for X ms
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function joinMeeting(startTime) {
  console.log(`⏳ Meeting scheduled at ${startTime}. Waiting 4 minutes before join...`);
//   await sleep(4 * 60 * 1000); // wait 4 min

//   const browser = await puppeteer.launch({
//     headless: true,
//     args: [
//       "--no-sandbox",
//       "--disable-setuid-sandbox",
//       "--disable-dev-shm-usage",
//       "--disable-gpu",
//     ],
//   });

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ["--start-maximized"]
});

  try {
    const page = await browser.newPage();
    await page.goto("https://myclass.lpu.in/", { waitUntil: "networkidle2" });

    // --- Login ---
    await page.type("input[aria-label='user name']", USERNAME);
    await page.type("input[aria-label='password']", PASSWORD);
    await page.click("button.ghost-round.full-width");

    await page.waitForSelector("a[aria-label='View Classes and Meetings']");
    await page.click("a[aria-label='View Classes and Meetings']");

    // --- Select the meeting by start time ---
    const meetingSelector = `div.fc-time[data-start='${startTime}']`;
    await page.waitForSelector(meetingSelector, { visible: true });
    await page.click(meetingSelector);

    // --- Join meeting ---
    await page.waitForSelector("a.joinBtn", { visible: true });
    await page.click("a.joinBtn");

    // --- Switch into iframe ---
    await page.waitForSelector("iframe");
    const iframeElement = await page.$("iframe");
    const frame = await iframeElement.contentFrame();

    // --- Click "Listen only" ---
    await frame.waitForSelector("button[aria-label='Listen only']", { visible: true });
    await frame.click("button[aria-label='Listen only']");

    console.log(`✅ Successfully joined meeting (${startTime}) after 4 min delay`);

    // --- Stay in class (~2h) ---
    // await page.waitForTimeout(2 * 60 * 60 * 1000);
    // --- Stay in class (~2h10m) ---
    await new Promise(resolve => setTimeout(resolve, 130 * 60 * 1000));

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await browser.close();
  }
}

// ─── CRON JOBS ───

// Mon–Wed: 9-11, 11-12, 1-3
// cron.schedule("0 9 * * 1-3", () => joinMeeting("9:00"), { timezone: "Asia/Kolkata" });
// cron.schedule("0 11 * * 1-3", () => joinMeeting("11:00"), { timezone: "Asia/Kolkata" });
// cron.schedule("0 13 * * 1-3", () => joinMeeting("1:00"), { timezone: "Asia/Kolkata" });

// // Thu–Fri: 9-11, 1-3, 4-5
// cron.schedule("0 9 * * 4-5", () => joinMeeting("9:00"), { timezone: "Asia/Kolkata" });
// cron.schedule("0 13 * * 4-5", () => joinMeeting("1:00"), { timezone: "Asia/Kolkata" });
// cron.schedule("0 16 * * 4-5", () => joinMeeting("4:00"), { timezone: "Asia/Kolkata" });

// console.log("🕒 Scheduler running... waiting for classes");

joinMeeting('1:00')
