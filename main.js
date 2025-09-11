import puppeteer from "puppeteer";

const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;

async function joinMeeting() {
//   const browser = await puppeteer.launch({
//     headless: true,
//     args: ["--no-sandbox", "--disable-setuid-sandbox"],
//   });
//   const page = await browser.newPage();
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ["--start-maximized"]
});


  console.log("🌐 Opening LPU MyClass...");
  await page.goto("https://myclass.lpu.in/", { waitUntil: "networkidle2" });

  // --- Login ---
  await page.type("input[aria-label='user name']", USERNAME);
  await page.type("input[aria-label='password']", PASSWORD);
  await page.click("button.ghost-round.full-width");
  await page.waitForNavigation({ waitUntil: "networkidle2" });

  console.log("✅ Logged in");

  // --- Go to meetings ---
  await page.click("a[aria-label='View Classes and Meetings']");
  await page.waitForSelector(".fc-time-grid-event", { timeout: 15000 });

  // --- Figure out today ---
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ... 6=Sat

  let todayMeetings = [];
  if ([1, 2, 3].includes(day)) {
    todayMeetings = ["9:00", "11:00", "1:00"];
  } else if ([4, 5].includes(day)) {
    todayMeetings = ["9:00", "1:00", "4:00"];
  } else {
    console.log("📅 No meetings today.");
    await browser.close();
    return;
  }

  // --- Pick next meeting based on current time ---
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  let meetingToJoin = null;
  for (let start of todayMeetings) {
    let [hourStr, minStr] = start.split(":");
    let hour = parseInt(hourStr);
    let min = parseInt(minStr) || 0;

    // Convert 12hr "1:00" / "4:00" to 24hr
    if (hour < 9) hour += 12;

    if (currentHour < hour || (currentHour === hour && currentMinute <= min + 5)) {
      meetingToJoin = start;
      break;
    }
  }

  if (!meetingToJoin) {
    console.log("⏸ No upcoming meeting right now.");
    await browser.close();
    return;
  }

  console.log(`🎯 Targeting meeting at ${meetingToJoin}`);

  // --- Find and click meeting ---
  const meeting = await page.$x(`//div[@class='fc-time' and @data-start='${meetingToJoin}']/ancestor::a`);
  if (meeting.length > 0) {
    await meeting[0].click();
  } else {
    console.log("❌ Could not find meeting link");
    await browser.close();
    return;
  }

  await page.waitForSelector("a.joinBtn", { timeout: 20000 });
  await page.click("a.joinBtn");
  console.log("🔗 Clicked Join Now");

  // --- Audio: Listen only ---
  try {
    await page.waitForSelector("button[aria-label='Listen only']", { timeout: 15000 });
    await page.click("button[aria-label='Listen only']");
    console.log("🎧 Connected with Listen only");
  } catch (e) {
    console.log("⚠️ Could not auto-connect audio");
  }

  // --- Stay in meeting for 2h10m ---
  console.log("⏳ Staying in meeting for 2h10m...");
  await new Promise(resolve => setTimeout(resolve, 130 * 60 * 1000));

  await browser.close();
  console.log("👋 Left meeting");
}

joinMeeting();
