import puppeteer from "puppeteer";
import "dotenv/config";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function acquireLock() {
  const lockPath = "/tmp/auto-meet.lock";
  try {
    if (fs.existsSync(lockPath)) {
      const pid = fs.readFileSync(lockPath, "utf8").trim();
      try {
        process.kill(parseInt(pid), 0);
        console.error("❌ Another instance is already running (PID:", pid, ")");
        process.exit(1);
      } catch (e) {
        console.log("⚠️ Stale lock file found, removing...");
        fs.unlinkSync(lockPath);
      }
    }
    fs.writeFileSync(lockPath, process.pid.toString());
    process.on("exit", () => {
      try {
        if (fs.readFileSync(lockPath, "utf8").trim() === process.pid.toString())
          fs.unlinkSync(lockPath);
      } catch (e) {}
    });
    process.on("SIGINT", () => {
      try {
        if (fs.readFileSync(lockPath, "utf8").trim() === process.pid.toString())
          fs.unlinkSync(lockPath);
      } catch (e) {}
      process.exit(1);
    });
    process.on("SIGTERM", () => {
      try {
        if (fs.readFileSync(lockPath, "utf8").trim() === process.pid.toString())
          fs.unlinkSync(lockPath);
      } catch (e) {}
      process.exit(1);
    });
  } catch (e) {
    console.error("⚠️ Failed to acquire lock:", e.message);
  }
}

const USERNAME = process.env.MYCLASS_USER;
const PASSWORD = process.env.MYCLASS_PASS;
if (!USERNAME || !PASSWORD) {
  throw new Error("Missing MYCLASS_USER or MYCLASS_PASS in .env");
}

const SCHEDULE_PATH = process.env.SCHEDULE_PATH || "./schedule.json";
const resolvedSchedulePath = SCHEDULE_PATH.startsWith("/")
  ? SCHEDULE_PATH
  : new URL(SCHEDULE_PATH, import.meta.url).pathname;
const schedule = JSON.parse(fs.readFileSync(resolvedSchedulePath, "utf8"));

function parseTimeString(timeStr) {
  let [time, meridiem] = timeStr.split(" ");
  let [hourStr, minStr] = time.split(":");
  let hour = parseInt(hourStr);
  const min = parseInt(minStr) || 0;

  if (meridiem?.toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (meridiem?.toUpperCase() === "AM" && hour === 12) hour = 0;

  return { hour, min };
}

function getMeetingEndTime(startTimeStr, durationMinutes) {
  const { hour, min } = parseTimeString(startTimeStr);
  const end = new Date();
  end.setHours(hour, min, 0, 0);
  end.setMinutes(end.getMinutes() + durationMinutes);
  return end;
}

function isMeetingStillValid(
  startTimeStr,
  durationMinutes,
  bufferSeconds = 60,
) {
  const now = new Date();
  const end = getMeetingEndTime(startTimeStr, durationMinutes);
  return now < end.getTime() + bufferSeconds * 1000;
}

function getAllMeetingsForDay(day) {
  return schedule[day] || [];
}

function getUpcomingMeetingsForDay(day) {
  const now = new Date();
  const todayMeetings = getAllMeetingsForDay(day);
  const upcoming = [];
  for (let meeting of todayMeetings) {
    const end = getMeetingEndTime(meeting.time, meeting.duration);
    if (now < end) {
      upcoming.push(meeting);
    }
  }
  return upcoming.sort((a, b) => {
    const aStart = new Date();
    const { hour: ha, min: ma } = parseTimeString(a.time);
    aStart.setHours(ha, ma, 0, 0);
    const bStart = new Date();
    const { hour: hb, min: mb } = parseTimeString(b.time);
    bStart.setHours(hb, mb, 0, 0);
    return aStart - bStart;
  });
}

function getNextMeetingForDay(day) {
  const upcoming = getUpcomingMeetingsForDay(day);
  return upcoming.length > 0 ? upcoming[0] : null;
}

function getDelayUntilMeeting(timeStr, leadMinutes = 1) {
  const now = new Date();
  const { hour, min } = parseTimeString(timeStr);
  const meetingTime = new Date(now);
  meetingTime.setHours(hour, min, 0, 0);
  const target = meetingTime.getTime() - leadMinutes * 60 * 1000;
  return Math.max(0, target - now.getTime());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, options = {}) {
  const {
    retries = 5,
    retryDelay = 2000,
    backoff = 1.5,
    maxRetryDelay = 30000,
    name = "operation",
  } = options;
  let lastError;
  let delay = retryDelay;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === retries) break;
      console.log(
        `⚠️ ${name} failed (attempt ${i + 1}/${retries + 1}): ${err.message}`,
      );
      await sleep(delay);
      delay = Math.min(delay * backoff, maxRetryDelay);
    }
  }
  throw lastError;
}

async function launchBrowser() {
  let executablePath;
  if (process.platform === "linux") {
    const candidates = [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/snap/bin/chromium",
      "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    ];
    executablePath = candidates.find((p) => fs.existsSync(p));
    if (!executablePath) {
      console.log(
        "ℹ️ No known Chromium binary found, falling back to puppeteer's bundled Chromium",
      );
    }
  } else if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    executablePath = candidates.find((p) => fs.existsSync(p));
  } else if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    ];
    executablePath = candidates.find((p) => fs.existsSync(p));
  } else {
    executablePath = undefined;
  }
  const browser = await puppeteer.launch({
    headless: false,
    executablePath,
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--use-fake-ui-for-media-stream",
      "--disable-features=site-per-process",
      "--disable-popup-blocking",
    ],
    ignoreHTTPSErrors: true,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  return { browser, page };
}

async function closeBrowser(browser) {
  if (!browser) return;
  try {
    const pages = await browser.pages();
    await Promise.all(pages.map((p) => p.close().catch(() => {})));
    await browser.close();
  } catch (e) {
    console.log("⚠️ Cleanup warning:", e.message);
  }
}

async function loginToMyClass(page) {
  await page.goto("https://myclass.lpu.in/", {
    waitUntil: "networkidle2",
    timeout: 90000,
  });
  await page.waitForSelector("input[aria-label='user name']", {
    visible: true,
    timeout: 30000,
  });
  await page.type("input[aria-label='user name']", USERNAME, { delay: 100 });
  await page.type("input[aria-label='password']", PASSWORD, { delay: 100 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 }),
    page.click("button.ghost-round.full-width"),
  ]);
  console.log("✅ Logged in");
}

async function navigateToMeetings(page) {
  await page.waitForSelector("a[aria-label='View Classes and Meetings']", {
    visible: true,
    timeout: 30000,
  });
  await page.click("a[aria-label='View Classes and Meetings']");
  await sleep(3000);
}

function formatForDataStart(timeStr) {
  return timeStr.split(" ")[0];
}

async function selectMeeting(page, startTime) {
  const dataStart = formatForDataStart(startTime);
  const meetingSelector = `div.fc-time[data-start='${dataStart}']`;
  await page.waitForSelector(meetingSelector, {
    visible: true,
    timeout: 60000,
  });
  await page.click(meetingSelector);
  await sleep(2000);
}

async function joinMeetingFrame(page) {
  await page.waitForSelector("iframe", { visible: true, timeout: 60000 });
  const iframeElement = await page.$("iframe");
  if (!iframeElement) throw new Error("Iframe not found");
  const frame = await iframeElement.contentFrame();
  if (!frame) throw new Error("Failed to get frame content");
  return frame;
}

async function pollForMeetingStart(page, maxAttempts = 30, intervalMs = 4000) {
  console.log("⏳ Waiting for the meeting to start...");
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      const btn = await page.$("a.joinBtn");
      if (btn) {
        const isVisible = await btn.isIntersectingViewport().catch(() => true);
        if (isVisible) {
          console.log("🔗 Join button detected! Joining now...");
          await Promise.all([
            page
              .waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 })
              .catch(() => {}),
            btn.click(),
          ]);
          return true;
        }
      }
    } catch (e) {
      console.log(`⚠️ Check failed: ${e.message}`);
    }
    attempts++;
    console.log(
      `⏱️ Meeting not ready yet, reloading in ${intervalMs / 1000}s... (attempt ${attempts}/${maxAttempts})`,
    );
    await sleep(intervalMs);
    try {
      await page.reload({ waitUntil: "networkidle2", timeout: 90000 });
      await sleep(3000);
    } catch (e) {
      console.log(`⚠️ Reload failed: ${e.message}`);
    }
  }
  throw new Error("Join button did not appear within timeout");
}

async function pollForAudio(page, intervalMs = 2500, maxMinutes = 10) {
  let connected = false;
  const maxAttempts = Math.floor((maxMinutes * 60 * 1000) / intervalMs);
  let attempts = 0;
  while (!connected && attempts < maxAttempts) {
    try {
      const frame = await joinMeetingFrame(page);
      const micBtn = await frame.$("button[aria-label='Microphone']");
      if (micBtn) {
        await micBtn.click().catch(() => {});
        console.log(
          "🎤 Selected audio in Microphone mode. Waiting for echo test...",
        );
        try {
          await frame.waitForSelector("button[aria-label='Echo is audible']", {
            visible: true,
            timeout: 15000,
          });
          const yesBtn = await frame.$("button[aria-label='Echo is audible']");
          if (yesBtn) {
            await yesBtn.click().catch(() => {});
            console.log("🗣️ Echo test confirmed");
            console.log("🎧🎤 Connected to audio in Microphone mode");
            connected = true;
            break;
          }
        } catch (e) {
          console.log("⚠️ Echo test not available yet");
        }
      }
      const listenOnlyBtn = await frame.$("button[aria-label='Listen only']");
      if (listenOnlyBtn && !connected) {
        await listenOnlyBtn.click().catch(() => {});
        console.log("🎧 Connected to audio in Listen-only mode");
        connected = true;
        break;
      }
    } catch (e) {
      console.log(`⚠️ Frame not ready: ${e.message}`);
    }
    if (!connected) {
      console.log("⚠️ Couldn't connect to audio. Retrying...");
      await sleep(intervalMs);
      attempts++;
    }
  }
  if (!connected) {
    throw new Error("Failed to connect audio within timeout");
  }
}

async function stayInMeeting(startTime, duration) {
  const now = new Date();
  const { hour, min } = parseTimeString(startTime);
  const start = new Date(now);
  start.setHours(hour, min, 0, 0);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + duration);
  const totalMs = end - start;

  console.log(
    `⏳ Staying until meeting ends at ${end.toLocaleTimeString()}...`,
  );
  const interval = 5000;
  while (true) {
    const nowTs = Date.now();
    if (nowTs >= end.getTime()) break;
    const elapsed = nowTs - start.getTime();
    const progress = Math.min(elapsed / totalMs, 1);
    const barLength = 20;
    const filled = Math.round(progress * barLength);
    const bar = "█".repeat(filled) + "▒".repeat(barLength - filled);
    const percent = (progress * 100).toFixed(2);
    process.stdout.write(`\r\x1b[K[${bar}] ${percent}%`);
    await sleep(interval);
  }
  process.stdout.write(`\r\x1b[K[${"█".repeat(20)}] 100%\n`);
  console.log("\n✅ Meeting finished");
}

async function attendSingleMeeting(
  meeting,
  browser = null,
  page = null,
  shouldRecreateBrowser = true,
) {
  let ownBrowser = false;
  let currentBrowser = browser;
  let currentPage = page;
  const { time: startTime, duration } = meeting;

  if (!currentBrowser && shouldRecreateBrowser) {
    const launched = await launchBrowser();
    currentBrowser = launched.browser;
    currentPage = launched.page;
    ownBrowser = true;
  }

  try {
    if (ownBrowser) {
      await withRetry(() => loginToMyClass(currentPage), {
        name: "login",
        retries: 3,
      });
      await withRetry(() => navigateToMeetings(currentPage), {
        name: "navigate",
        retries: 3,
      });
      await withRetry(() => selectMeeting(currentPage, startTime), {
        name: "selectMeeting",
        retries: 3,
      });
    } else if (currentPage) {
      try {
        await currentPage
          .goto("https://myclass.lpu.in/student", {
            waitUntil: "networkidle2",
            timeout: 45000,
          })
          .catch(() => {});
      } catch (e) {}
    }

    await withRetry(() => pollForMeetingStart(currentPage), {
      name: "pollStart",
      retries: 2,
      retryDelay: 5000,
    });
    await withRetry(() => pollForAudio(currentPage), {
      name: "pollAudio",
      retries: 2,
      retryDelay: 5000,
    });

    console.log(`✅ Successfully joined meeting at ${startTime}`);
    await stayInMeeting(startTime, duration);
    return { success: true };
  } catch (err) {
    console.error(`❌ Failed to attend meeting at ${startTime}:`, err.message);
    return { success: false, error: err.message };
  } finally {
    if (ownBrowser && currentBrowser) {
      await closeBrowser(currentBrowser);
    }
  }
}

async function handleDayMeetings(day) {
  console.log(`📅 Handling meetings for day ${day}...`);
  let attempted = 0;
  while (true) {
    const upcoming = getUpcomingMeetingsForDay(day);
    if (upcoming.length === 0) {
      console.log("📅 No more meetings today.");
      break;
    }
    const currentMeeting = upcoming[0];
    console.log(
      `\n🎯 Next meeting: ${currentMeeting.time}, Duration: ${currentMeeting.duration} min`,
    );
    const delay = getDelayUntilMeeting(currentMeeting.time, 1);
    if (delay > 0) {
      console.log(
        `⏳ Waiting ${(delay / 60000).toFixed(2)} minutes until 1 min before ${currentMeeting.time}...`,
      );
      await sleep(delay);
    }

    const now = new Date();
    if (
      !isMeetingStillValid(currentMeeting.time, currentMeeting.duration, -300)
    ) {
      console.log("⚠️ Meeting window appears to have passed, skipping...");
      continue;
    }

    attempted++;
    const result = await attendSingleMeeting(currentMeeting);
    if (!result.success) {
      console.log(
        `⚠️ Recovery logic: will try to re-attempt if meeting still valid...`,
      );
      if (
        isMeetingStillValid(currentMeeting.time, currentMeeting.duration, 120)
      ) {
        console.log("🔄 Meeting still valid, retrying once after cleanup...");
        await sleep(30000);
        const retryResult = await attendSingleMeeting(currentMeeting);
        if (!retryResult.success) {
          console.log(
            "❌ Second attempt failed; moving to next meeting if any...",
          );
        }
      } else {
        console.log("⏰ Meeting no longer valid after failure");
      }
    }
    const postWait = 5000;
    await sleep(postWait);
  }
  console.log("✅ Finished all meetings for today");
}

async function main() {
  acquireLock();
  try {
    const now = new Date();
    let day = now.getDay();
    if (
      process.env.FORCE_DAY !== undefined &&
      process.env.FORCE_DAY !== null &&
      process.env.FORCE_DAY !== ""
    ) {
      const forced = parseInt(process.env.FORCE_DAY);
      if (!isNaN(forced)) {
        day = forced;
        console.log(`🔧 FORCED_DAY=${forced} active`);
      }
    }
    console.log(`🕒 Current time: ${now.toLocaleString()}`);
    console.log(`📅 Day: ${day} (0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat)`);
    await runForDay(day);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
  }
}
main();

async function runForDay(day) {
  console.log(`📅 Handling meetings for day ${day}...`);
  while (true) {
    const upcoming = getUpcomingMeetingsForDay(day);
    if (upcoming.length === 0) {
      console.log("📅 No more meetings today.");
      break;
    }
    const currentMeeting = upcoming[0];
    console.log(
      `\n🎯 Next meeting: ${currentMeeting.time}, Duration: ${currentMeeting.duration} min`,
    );
    const delay = getDelayUntilMeeting(currentMeeting.time, 1);
    if (delay > 0) {
      console.log(
        `⏳ Waiting ${(delay / 60000).toFixed(2)} minutes until 1 min before ${currentMeeting.time}...`,
      );
      await sleep(delay);
    }
    if (
      !isMeetingStillValid(currentMeeting.time, currentMeeting.duration, -300)
    ) {
      console.log("⚠️ Meeting window appears to have passed, skipping...");
      continue;
    }
    const result = await attendSingleMeeting(currentMeeting);
    if (!result.success) {
      console.log(
        `⚠️ Recovery logic: will try to re-attempt if meeting still valid...`,
      );
      if (
        isMeetingStillValid(currentMeeting.time, currentMeeting.duration, 120)
      ) {
        console.log("🔄 Meeting still valid, retrying once after cleanup...");
        await sleep(30000);
        await attendSingleMeeting(currentMeeting).catch((e) => {
          console.log("❌ Second attempt failed:", e.message);
        });
      } else {
        console.log("⏰ Meeting no longer valid after failure");
      }
    }
    await sleep(5000);
  }
  console.log("✅ Finished all meetings for requested day");
}
