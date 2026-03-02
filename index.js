import puppeteer from "puppeteer";
import 'dotenv/config';

const USERNAME = process.env.MYCLASS_USER;
const PASSWORD = process.env.MYCLASS_PASS;

// Step 0: Define schedule
const schedule = {
    1: [{ time: "7:00 PM", duration: 60 }], // 7pm to 8pm <- Monday
    2: [{ time: "7:00 PM", duration: 60 }], // 7pm to 8pm <- Tuesday
    3: [{ time: "7:00 PM", duration: 60 }], // 7pm to 8pm <- Wednesday
    4: [{ time: "7:00 PM", duration: 60 }], // 7pm to 8pm <- Thursday
    6: [{ time: "10:00 AM", duration: 120 }], // 10am to 12pm <- Saturday
    // 0=Sunday, 5=Friday have no meetings
};

// parse 12-hour time string into 24-hour hour & minute
function parseTimeString(timeStr) {
    let [time, meridiem] = timeStr.split(" "); // ["7:00", "PM"]
    let [hourStr, minStr] = time.split(":");
    let hour = parseInt(hourStr);
    const min = parseInt(minStr) || 0;

    if (meridiem?.toUpperCase() === "PM" && hour !== 12) hour += 12;
    if (meridiem?.toUpperCase() === "AM" && hour === 12) hour = 0;

    return { hour, min };
}

// auto-check meeting time
function getNextMeeting() {
    const now = new Date();
    const day = now.getDay();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const todayMeetings = schedule[day] || [];
    for (let { time, duration } of todayMeetings) {
        const { hour, min } = parseTimeString(time);
        if (currentHour < hour || (currentHour === hour && currentMinute <= min)) {
            return { time, duration }; // next upcoming meeting's start time and duration
        }
    }
    return null; // no upcoming meetings
}

// check if the meeting time is close or not -> to avoid unnecessary reloads if not close
function getDelayUntilMeeting(timeStr) {
    const now = new Date();
    const { hour, min } = parseTimeString(timeStr);
    const meetingTime = new Date(now);
    meetingTime.setHours(hour, min, 0, 0);
    return meetingTime - now; // milliseconds
}

// helper: wait for X ms
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ["--start-maximized"]
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000); // default timeout for waits
    return { browser, page };
}

async function loginToMyClass(page) {
    await page.goto("https://myclass.lpu.in/", { waitUntil: "networkidle2" });
    await page.type("input[aria-label='user name']", USERNAME);
    await page.type("input[aria-label='password']", PASSWORD);
    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2" }),
        page.click("button.ghost-round.full-width")
    ]);
    console.log("✅ Logged in");
}

async function navigateToMeetings(page) {
    await page.waitForSelector("a[aria-label='View Classes and Meetings']", { visible: true });
    await page.click("a[aria-label='View Classes and Meetings']");
}

function formatForDataStart(timeStr) {
    return timeStr.split(" ")[0]; // "7:00 PM" → "7:00"
}
async function selectMeeting(page, startTime) {
    const dataStart = formatForDataStart(startTime);
    const meetingSelector = `div.fc-time[data-start='${dataStart}']`;
    await page.waitForSelector(meetingSelector, { visible: true });
    await page.click(meetingSelector);
}

async function joinMeetingFrame(page) {
    await page.waitForSelector("iframe", { visible: true });
    const iframeElement = await page.$("iframe");
    const frame = await iframeElement.contentFrame();
    return frame;
}

async function pollForAudio(frame, intervalMs = 2000) {
    let connected = false;
    while (!connected) {
        const btn = await frame.$("button[aria-label='Listen only']");
        if (btn) {
            await btn.click();
            connected = true;
            console.log("🎧 Connected to audio in Listen-only mode");
        } else {
            console.log("Couldn't connect to audio. Retrying...");
            await sleep(intervalMs);
        }
    }
}

// async function connectAudio(frame) {
//     await frame.waitForSelector("button[aria-label='Listen only']", { visible: true });
//     await frame.click("button[aria-label='Listen only']");
//     console.log("🎧 Connected in Listen only mode");
// }

async function stayInMeeting(durationMinutes) {
    console.log(`⏳ Staying in meeting for ${durationMinutes} minutes...`);
    await sleep(durationMinutes * 60 * 1000);
}

async function pollForMeetingStart(page, intervalMs = 4000) {
    console.log("⏳ Waiting for the meeting to start...");
    let joined = false;
    while (!joined) {
        const btn = await page.$("a.joinBtn"); // check if the button is there
        if (btn) {
            await btn.click(); // click to join the meeting
            joined = true;
            console.log("🔗 Join button detected! Joining now...");
        } else {
            console.log(`⏱ Meeting not ready yet, reloading in ${intervalMs/1000} seconds...`);
            await sleep(intervalMs);
            try {
                await page.reload({ waitUntil: "networkidle2" });
            } catch(e) {
                console.log("⚠️ Reload failed, retrying...");
            }
        }
    }
}

async function main() {
    const nextMeeting = getNextMeeting();
    if (!nextMeeting) {
        console.log("📅 No upcoming meetings today.");
        return;
    }
    const { time: startTime, duration } = nextMeeting;
    console.log(`🎯 Next meeting at: ${startTime}, Duration: ${duration} minutes`);

    // check delay until meeting to avoid unnecessary reloads
    const delay = getDelayUntilMeeting(startTime);
    if (delay > 2 * 60 * 1000) { // more than 2 minutes away
        const waitTime = delay - (2 * 60 * 1000);
        console.log(`⏳ Sleeping for ${(waitTime / 60000).toFixed(1)} minutes until near meeting time...`);
        await sleep(waitTime);
    }

    // browser launches ONLY near meeting time
    const { browser, page } = await launchBrowser();

    try {
        await loginToMyClass(page);
        await navigateToMeetings(page);
        await selectMeeting(page, startTime);

        await pollForMeetingStart(page); // poll until join button appears
        const frame = await joinMeetingFrame(page);
        await pollForAudio(frame); // keep trying until "Listen only" button appears

        console.log(`✅ Successfully joined meeting at ${startTime}`);
        await stayInMeeting(duration); // stay as long as the meeting goes on
    }
    catch (err) {
        console.error("❌ Error:", err.message);
    }
    finally {
        await browser.close();
    }
}

main(); // automatically join meeting