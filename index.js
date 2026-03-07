import puppeteer from "puppeteer";
import 'dotenv/config';
import fs from 'fs';

const USERNAME = process.env.MYCLASS_USER;
const PASSWORD = process.env.MYCLASS_PASS;
if (!USERNAME || !PASSWORD) {
    throw new Error("Missing MYCLASS_USER or MYCLASS_PASS in .env");
}

/* step 0: define schedule in schedule.json
Example:
{
    "1": [{ "time": "8:30 PM", "duration": 60 }],
    "2": [{ "time": "8:30 PM", "duration": 60 }],
    "3": [{ "time": "8:30 PM", "duration": 60 }],
    "4": [{ "time": "8:30 PM", "duration": 60 }],
    "5": [{ "time": "8:30 PM", "duration": 60 }],
    "6": [{ "time": "10:00 AM", "duration": 120 }]
}
> 'time' -> meeting start time
> duration -> in minutes
*/

// parse schedule
const schedule = JSON.parse(fs.readFileSync('./schedule.json', 'utf8'));

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
    // const currentHour = now.getHours();
    // const currentMinute = now.getMinutes();
    
    const todayMeetings = schedule[day] || [];
    for (let { time, duration } of todayMeetings) {
        const { hour, min } = parseTimeString(time);
        // if (currentHour < hour || (currentHour === hour && currentMinute <= min)) {
        //     return { time, duration }; // next upcoming meeting's start time and duration
        // }
        const start = new Date(now);
        start.setHours(hour, min, 0, 0);
        const end = new Date(start);
        end.setMinutes(end.getMinutes() + duration);
        if (now < end) {
            return {time, duration};
        }
    }
    return null; // no upcoming meetings
}

// check if the meeting time is close or not -> to avoid unnecessary reloads if not near the meeting time
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
    if (!iframeElement) throw new Error("Iframe not found");
    const frame = await iframeElement.contentFrame();
    if (!frame) throw new Error("Failed to get frame content");
    return frame;
}

async function pollForAudio(page, intervalMs = 2000) {
    let connected = false;
    while (!connected) {
        try {
            const frame = await joinMeetingFrame(page);
            const btn = await frame.$("button[aria-label='Listen only']");
            if (btn) {
                await btn.click();
                console.log("🎧 Connected to audio in Listen-only mode");
                connected = true;
            } else {
                console.log("Couldn't connect to audio. Retrying...");
                await sleep(intervalMs);
            }
        }
        catch (e) {
            console.log("⚠️ Frame not ready, retrying...");
            await sleep(intervalMs);
        }
    }
}

// async function connectAudio(frame) {
//     await frame.waitForSelector("button[aria-label='Listen only']", { visible: true });
//     await frame.click("button[aria-label='Listen only']");
//     console.log("🎧 Connected in Listen only mode");
// }

// stay only as long as the meeting goes on
async function stayInMeeting(startTime, duration) {
    const now = new Date();
    const {hour, min} = parseTimeString(startTime);

    const start = new Date(now);
    start.setHours(hour, min, 0, 0);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + duration);
    
    const totalMs = end - start;
    // const remainingMs = Math.max(0, end - now);
    
    console.log(`⏳ Staying until meeting ends...`);
    
    const interval = 5000; // update progress bar every 5s

    while (true) {
        const now = Date.now();
        if (now>=end) break;
        const elapsed = now - start;
        const progress = Math.min(elapsed/totalMs, 1);
        const barLength = 20;
        const filled = Math.round(progress*barLength);
        const bar = "🟢".repeat(filled) + "-".repeat(barLength-filled);
        const percent = (progress*100).toFixed(2);

        process.stdout.write(`\r[${bar}] ${percent}%`);

        await sleep(interval);
    }
    process.stdout.write(`\r[${"🟢".repeat(20)}] 100%\n`);
    console.log("\n✅ Meeting finished");
}

async function pollForMeetingStart(page, intervalMs = 4000) {
    console.log("⏳ Waiting for the meeting to start...");
    let joined = false;
    while (!joined) {
        const btn = await page.$("a.joinBtn"); // check if the button is there
        if (btn) {
            console.log("🔗 Join button detected! Joining now...");
            await Promise.all([
                page.waitForNavigation({ waitUntil: "networkidle2" }),
                btn.click() // click to join the meeting
            ]);
            joined = true;
        } else {
            console.log(`⏱️ Meeting not ready yet, reloading in ${intervalMs/1000} seconds...`);
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
    if (delay > 1 * 60 * 1000) { // more than 1 minute away
        const waitTime = delay - (1 * 60 * 1000);
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
        await pollForAudio(page); // keep trying until "Listen only" button appears

        console.log(`✅ Successfully joined meeting at ${startTime}`);

        await stayInMeeting(startTime, duration);
    }
    catch (err) {
        console.error("❌ Error:", err.message);
    }
    finally {
        await browser.close();
    }
}

main(); // automatically join meeting